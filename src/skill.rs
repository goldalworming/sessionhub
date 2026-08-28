//! The skill that teaches an agent it can reach the other machines.
//!
//! `sessionhubd run` is useless to an agent that does not know it exists. A
//! paragraph in a project's `CLAUDE.md` works, but it has to be written into
//! every project by hand and it sits in the context of every conversation
//! whether or not another machine is involved. A skill is the shape that fits:
//! one file, read only when what is being asked sounds like it needs one.
//!
//! So the button writes it. The daemon already knows the home directory and
//! already knows the commands — asking someone to copy a block of text into a
//! folder they have to look up is the kind of small friction that means the
//! feature never gets used.

use std::io;
use std::path::PathBuf;

/// The folder name under `~/.claude/skills/`, and the skill's own name.
pub const NAME: &str = "sessionhub-machines";

/// Where it goes. Claude Code reads user-level skills from `~/.claude/skills`.
pub fn path() -> PathBuf {
    crate::config::home().join(".claude").join("skills").join(NAME).join("SKILL.md")
}

/// What is on disk, against what this version would write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Missing,
    /// There, and the same as what this version writes.
    Current,
    /// There, but written by a different version — or edited by hand.
    Stale,
}

pub fn state() -> State {
    match std::fs::read_to_string(path()) {
        Ok(found) if found == text() => State::Current,
        Ok(_) => State::Stale,
        Err(_) => State::Missing,
    }
}

/// Write it, making the folders on the way. Returns where it landed.
pub fn install() -> io::Result<PathBuf> {
    let file = path();
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&file, text())?;
    Ok(file)
}

/// The skill itself.
///
/// Written for the agent that will read it, not for a person browsing docs: what
/// the commands are, the two rules that are easy to get wrong (quoting, and that
/// a folder goes as a tar), and what each refusal means so a failure does not
/// turn into guessing.
pub fn text() -> String {
    format!(
        r#"---
name: {NAME}
description: >-
  Run a command, build something, or move files on ANOTHER computer through
  sessionhub. Use when asked to do something "on the other machine", "on the
  other computer", "di komputer lain", "di mesin lain", "build di sana"; when a
  build needs a toolchain this machine does not have (Android Studio, Xcode, a
  particular SDK, a GPU); or when a task names a machine that is not this one.
  Reaches Windows and macOS alike and needs no ssh, no keys, and no passwords —
  the machines are already paired.
---

# Working on another machine

`sessionhubd` is on PATH here. It talks to the sessionhub daemon on this
machine, which is already paired with the others and holds their credentials, so
nothing needs a password, a key, or a `known_hosts` entry.

## Find out what is reachable

```
sessionhubd machines
```

Prints one line per machine: name, address, the daemon version it runs. The
**name** is what every other command takes. If it prints nothing, no machine is
paired and none of this will work — say so rather than guessing at a name.

## Run something there

```
sessionhubd run --on NAME [--cwd DIR] [--timeout SECONDS] -- COMMAND…
```

- stdout comes back on stdout, stderr on stderr, and **the exit code is the far
  side's**, so `&&` and `||` mean what they always mean.
- `--cwd` is a path **on that machine**. Without it the command runs in that
  machine's home directory.
- `--timeout` defaults to 120 seconds and may go up to 600. A build needs to be
  told: `--timeout 600`. Past the deadline the command is killed and you get
  what it had printed so far, with exit code 124.
- Output is buffered — nothing arrives until it finishes. This is the same
  behaviour as a local shell command, so treat a long build as a long wait, not
  as a hang.
- Everything past 1 MB per stream is dropped with a marker at the end. If you
  need the whole log, redirect it to a file over there and fetch that file.

**Quoting follows the ssh rule: the far side re-parses.** When quoting matters,
pass the whole command as one argument:

```
sessionhubd run --on buildbox -- 'echo "two words"'
```

The shell there is PowerShell on Windows and the login shell on macOS — write
the command for whichever machine you are aiming at. `sessionhubd machines` does
not say which is which; if it matters, ask, or probe with something harmless
like `uname -s` and read the failure.

## Move files

```
sessionhubd push --on NAME <local file>  <path over there>
sessionhubd pull --on NAME <path over there> <local file>
```

One file each way. Folders are missing on purpose — send a **tar**, which also
puts the choice of what to leave out where it belongs:

```
tar -czf /tmp/src.tgz --exclude=node_modules --exclude=build .
sessionhubd push --on buildbox /tmp/src.tgz C:/work/src.tgz
sessionhubd run  --on buildbox --cwd C:/work -- tar -xzf src.tgz
sessionhubd run  --on buildbox --cwd C:/work --timeout 600 -- ./gradlew assembleDebug
sessionhubd pull --on buildbox C:/work/app/build/outputs/apk/debug/app-debug.apk ./app.apk
```

`tar` is already on Windows 10 1803+ and on macOS, so nothing needs installing.
On Windows paths, forward slashes work fine.

## When it refuses

- **`404 no paired machine called X`** — the name is wrong. Run
  `sessionhubd machines` and use what it prints.
- **`403 remote commands are turned off on that machine`** — that machine has
  refused unattended commands. It is a switch on *that* computer:
  Settings → Network access → Remote commands. You cannot turn it on from here;
  ask the person to.
- **`sessionhub is not running here`** — the local daemon is down; `sessionhubd
  start` fixes it.
- **`answered 404`** from the far side — that machine runs a daemon too old to
  know how to run commands. It needs updating.

## What to tell the person

Say which machine did the work and what it cost — "built on buildbox in 4m,
APK is at ./app.apk" — because from where they sit nothing looks different, and
a build that quietly happened somewhere else is worth naming.
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_skill_has_the_frontmatter_a_skill_needs() {
        let t = text();
        assert!(t.starts_with("---\n"), "must open with frontmatter");
        assert!(t.contains(&format!("name: {NAME}")));
        assert!(t.contains("description:"));
        // The frontmatter has to close before the body starts.
        let after = t.strip_prefix("---\n").unwrap();
        assert!(after.contains("\n---\n"), "frontmatter is never closed");
    }

    #[test]
    fn it_names_every_command_it_teaches() {
        let t = text();
        for c in ["sessionhubd machines", "sessionhubd run", "sessionhubd push", "sessionhubd pull"]
        {
            assert!(t.contains(c), "the skill never mentions `{c}`");
        }
    }

    #[test]
    fn it_lands_under_the_agents_own_skills_folder() {
        let p = path();
        assert!(p.ends_with("SKILL.md"));
        assert!(p.to_string_lossy().contains(".claude"));
        assert!(p.to_string_lossy().contains("skills"));
    }
}
