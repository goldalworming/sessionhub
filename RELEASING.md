# Releasing

Two binaries ship, and neither machine can make both. Windows cannot link a
Mach-O; the Mac often sits behind a VPN that blocks github.com, so it cannot
clone the source or upload the result. So the source goes to the Mac over the
LAN, and everything else happens here.

There is no CI. Nothing here needs a runner.

## The pieces

- **Helper scripts** live one level above this repo, beside `.ssh-mac` — they
  carry machine-local paths and credentials and are not part of the project:
  `push_to_mac.py`, `fetch_from_mac.py`, `put_to_mac.py`, `mac.py`,
  `create_release.py`, `upload_asset.py`.
- **The Mac** is reached by password over SSH; paramiko drives it, so no key is
  needed. Its address is the `HOST` line in `push_to_mac.py` and `mac.py` —
  **update both when the lease moves**. The build checkout is
  `~/data/code/sessionhub-build`; the build cache is
  `~/data/code/sessionhubd/target`, reused through `CARGO_TARGET_DIR` so a
  rebuild is seconds. That folder is an old copy of the source, not a checkout —
  leave it alone.
- **`git bundle`** carries the history over SFTP. The Mac's `origin` points at
  that bundle file, so re-running the push overwrites it and the next fetch
  sees the new commits with no config change.
- **crates.io** is the only thing the Mac still needs the internet for, and only
  when `Cargo.lock` changes.

## Steps

1. **Bump** `version` in `Cargo.toml` — the patch digit, however large it gets.
   Commit and push.

2. **Windows build.** If a daemon is running from `target/release`, it holds the
   file and the build fails with *Access is denied*; build elsewhere instead:

       CARGO_TARGET_DIR=<somewhere else> cargo build --release

3. **Mac build**, then bring the binary back:

       python ../push_to_mac.py --build
       python ../fetch_from_mac.py data/code/sessionhubd/target/release/sessionhubd <local path>

4. **The .app bundle** — a Mach-O has nowhere to keep an icon, so Finder needs
   this. Send the script and the icon over, build there, bring back the zip:

       python ../put_to_mac.py assets/make-app.sh data/code/make-app.sh assets/sessionhub.icns data/code/sessionhub.icns
       python ../mac.py 'cd ~/data/code && sh make-app.sh $HOME/data/code/sessionhubd/target/release/sessionhubd $HOME/data/code/sessionhub.icns <version> $HOME/data/code/appbuild'
       python ../fetch_from_mac.py data/code/appbuild/sessionhub-<version>-macos-arm64.app.zip <local path>

5. **The frontend bundle**, when `web/` moved since the last release. Raise
   `version` in `web/version.json` first:

       sessionhubd bundle-web sessionhub-web-<web version>.shweb

6. **Create the release**, then upload:

       python ../create_release.py v<version> <full commit sha> "<title>" <notes.md>
       python ../upload_asset.py <file> <asset name>

## Asset names

Parsed by the updater (`src/update.rs`), so they must be exact:

| name | |
| --- | --- |
| `sessionhubd-<version>-windows-x86_64.exe` | what self-update installs |
| `sessionhubd-<version>-macos-arm64` | likewise, on the Mac |
| `sessionhub-<version>-macos-arm64.app.zip` | beside the binary, never instead of it — the updater matches the suffix `macos-arm64` and cannot swap a zip into place |
| `sessionhub-web-<web version>.shweb` | installs from Settings, no restart |

**One `.shweb` per release.** Two leaves the updater choosing between them, so
delete the old one when a new one goes up.

Replacing an asset in place is fine — a rebuild of the same version needs no new
tag. GitHub refuses a duplicate name, so `upload_asset.py` deletes the old one
first.

## Notes on the artwork

`assets/make-icons.py` rebuilds `sessionhub.ico` and `sessionhub.icns` from
`web/icon-512.webp`. Run it only when the artwork changes; `build.rs` puts the
`.ico` into the `.exe` on every build, and the `.icns` goes into the bundle at
step 4.
