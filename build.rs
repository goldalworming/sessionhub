//! Put the logo inside the `.exe`.
//!
//! Windows takes an executable's icon from a resource in the PE file, and
//! nowhere else — the PNGs in `web/` are served over HTTP to a browser and the
//! shell never sees them. Without this, Explorer draws the generic console-app
//! icon on a program that has had a logo all along.
//!
//! What a resource compiler would do here is turn `assets/sessionhub.ico` into
//! a `.res` file and hand that to the linker. That is worth writing out rather
//! than depending on: `.res` is a flat list of records, the icon is already in
//! almost the right shape inside the `.ico`, and the alternative is a crate
//! plus a hunt for `rc.exe` on every machine that builds this. `cargo build`
//! stays the whole build, offline, with nothing installed.
//!
//! Regenerate the artwork with `python assets/make-icons.py`.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

/// Resource types, as the shell knows them.
const RT_ICON: u16 = 3;
const RT_GROUP_ICON: u16 = 14;

/// The group is looked up by the lowest name the file has, so the icon meant
/// for the program itself takes the first one.
const GROUP_NAME: u16 = 1;

const LANG_EN_US: u16 = 0x0409;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=assets/sessionhub.ico");

    // A resource is a PE thing, and the way it reaches the binary here is a
    // `.res` on the MSVC linker's command line. Anything else — macOS, or the
    // GNU toolchain, whose linker wants a COFF object instead — just builds.
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows")
        || env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc")
    {
        return;
    }

    let ico = Path::new("assets/sessionhub.ico");
    let Ok(bytes) = fs::read(ico) else {
        // Not fatal. An icon is worth a warning, not a build that cannot run.
        println!("cargo:warning=assets/sessionhub.ico is missing; building without an icon");
        return;
    };

    let res = match resource_file(&bytes) {
        Some(res) => res,
        None => {
            println!("cargo:warning=assets/sessionhub.ico is not an icon file; skipping it");
            return;
        }
    };

    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("sessionhub.res");
    fs::write(&out, res).expect("could not write the icon resource");
    println!("cargo:rustc-link-arg-bins={}", out.display());
}

/// Build the `.res` the linker reads: every image in the `.ico` as its own
/// `RT_ICON`, and one `RT_GROUP_ICON` listing them, which is what the shell
/// actually asks for when it wants "the icon of this program".
fn resource_file(ico: &[u8]) -> Option<Vec<u8>> {
    let images = parse_ico(ico)?;
    if images.is_empty() {
        return None;
    }

    // A `.res` opens with one empty record. Nothing reads it; a file without it
    // is rejected.
    let mut out = record(0, 0, 0, &[]);

    // `RT_ICON` names are ordinals counted from 1, and the group refers to each
    // image by that number rather than by any offset.
    for (i, img) in images.iter().enumerate() {
        out.extend(record(RT_ICON, i as u16 + 1, 0x1010, img.data));
    }

    let mut group = Vec::with_capacity(6 + images.len() * 14);
    group.extend((0u16).to_le_bytes()); // reserved
    group.extend((1u16).to_le_bytes()); // 1: icons, not cursors
    group.extend((images.len() as u16).to_le_bytes());
    for (i, img) in images.iter().enumerate() {
        group.push(img.width);
        group.push(img.height);
        group.push(img.colors);
        group.push(0); // reserved
        group.extend(img.planes.to_le_bytes());
        group.extend(img.bits.to_le_bytes());
        group.extend((img.data.len() as u32).to_le_bytes());
        // The one field that differs from the directory in the .ico: a name,
        // where the file had a byte offset.
        group.extend((i as u16 + 1).to_le_bytes());
    }
    out.extend(record(RT_GROUP_ICON, GROUP_NAME, 0x1030, &group));
    Some(out)
}

struct Image<'a> {
    width: u8,
    height: u8,
    colors: u8,
    planes: u16,
    bits: u16,
    data: &'a [u8],
}

/// `ICONDIR` followed by one `ICONDIRENTRY` per image. A width of 0 means 256 —
/// the field is one byte wide and 256 does not fit in it.
fn parse_ico(b: &[u8]) -> Option<Vec<Image<'_>>> {
    if b.len() < 6 || u16::from_le_bytes([b[0], b[1]]) != 0 || u16::from_le_bytes([b[2], b[3]]) != 1
    {
        return None;
    }
    let count = u16::from_le_bytes([b[4], b[5]]) as usize;
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let e = 6 + i * 16;
        let entry = b.get(e..e + 16)?;
        let size = u32::from_le_bytes(entry[8..12].try_into().ok()?) as usize;
        let at = u32::from_le_bytes(entry[12..16].try_into().ok()?) as usize;
        out.push(Image {
            width: entry[0],
            height: entry[1],
            colors: entry[2],
            planes: u16::from_le_bytes([entry[4], entry[5]]),
            bits: u16::from_le_bytes([entry[6], entry[7]]),
            data: b.get(at..at + size)?,
        });
    }
    Some(out)
}

/// One `.res` record: two sizes, an ordinal type and an ordinal name, a header
/// nothing modern reads, and the data. Both the header and the data end on a
/// four-byte boundary.
fn record(kind: u16, name: u16, memory_flags: u16, data: &[u8]) -> Vec<u8> {
    let mut head = Vec::with_capacity(32);
    head.extend((data.len() as u32).to_le_bytes());
    head.extend(0u32.to_le_bytes()); // header size, filled in below
    for ordinal in [kind, name] {
        // 0xFFFF says "a number follows" rather than a UTF-16 name.
        head.extend(0xFFFFu16.to_le_bytes());
        head.extend(ordinal.to_le_bytes());
    }
    while head.len() % 4 != 0 {
        head.push(0);
    }
    head.extend(0u32.to_le_bytes()); // data version
    head.extend(memory_flags.to_le_bytes());
    head.extend(LANG_EN_US.to_le_bytes());
    head.extend(0u32.to_le_bytes()); // version
    head.extend(0u32.to_le_bytes()); // characteristics
    let size = head.len() as u32;
    head[4..8].copy_from_slice(&size.to_le_bytes());

    head.extend_from_slice(data);
    while head.len() % 4 != 0 {
        head.push(0);
    }
    head
}
