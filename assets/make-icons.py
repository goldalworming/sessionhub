"""Build the platform icon files from the one piece of artwork there is.

`web/icon-512.webp` is the master — it is what the installed web app already
wears, so the desktop cannot end up showing a different logo than the page.

Run this by hand when the artwork changes; the results are committed:

    python assets/make-icons.py

Windows reads its icon out of a resource inside the .exe, and that resource is
an .ico. macOS reads its icon out of an .app bundle, and that one is an .icns.
Neither will look at a PNG sitting in a folder, which is why the logo could be
right on the page and missing everywhere else.

Needs Pillow, and nothing at build time — `cargo build` never runs this.
"""

import struct
from io import BytesIO
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
MASTER = HERE.parent / "web" / "icon-512.webp"

# Every size Windows asks for, from the notification area to the 256px tile in
# Explorer.
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# macOS names each size by a four-letter chunk type rather than by number.
# 1024 is left out: the master is 512, and an upscale is not detail.
ICNS_CHUNKS = [
    ("ic11", 32),   # 16pt @2x
    ("ic12", 64),   # 32pt @2x
    ("ic07", 128),
    ("ic13", 256),  # 128pt @2x
    ("ic08", 256),
    ("ic14", 512),  # 256pt @2x
    ("ic09", 512),
]

# Frames at 128 and above are stored as PNG; the smaller ones as bitmaps.
PNG_FROM = 128


def frames(master):
    sizes = {*ICO_SIZES, *(s for _, s in ICNS_CHUNKS)}
    return {s: master.resize((s, s), Image.LANCZOS) for s in sizes}


def png_bytes(im):
    buf = BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def bmp_frame(im):
    """One frame in the layout Windows has understood since the beginning.

    A DIB header that lies about its height (it counts the mask as well), rows
    of BGRA bottom-up, and a 1-bit mask. Modern Windows decides transparency
    from the alpha channel and ignores the mask, but the shell is old in places
    and a frame without one can come out with a black box behind it.
    """
    w, h = im.size
    px = im.load()
    header = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, w * h * 4, 0, 0, 0, 0)

    body = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = px[x, y]
            body += bytes((b, g, r, a))

    stride = ((w + 31) // 32) * 4
    for y in range(h - 1, -1, -1):
        bits = bytearray(stride)
        for x in range(w):
            if px[x, y][3] == 0:
                bits[x // 8] |= 0x80 >> (x % 8)
        body += bits
    return header + bytes(body)


def write_ico(path, at):
    parts = [(s, png_bytes(at[s]) if s >= PNG_FROM else bmp_frame(at[s])) for s in ICO_SIZES]
    out = struct.pack("<HHH", 0, 1, len(parts))
    # 256 is written as 0: the field is one byte wide and 256 does not fit.
    offset = 6 + 16 * len(parts)
    for size, data in parts:
        out += struct.pack("<BBBBHHII", size & 0xFF, size & 0xFF, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    path.write_bytes(out + b"".join(d for _, d in parts))


def write_icns(path, at):
    body = b""
    for kind, size in ICNS_CHUNKS:
        png = png_bytes(at[size])
        body += kind.encode("ascii") + struct.pack(">I", len(png) + 8) + png
    path.write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)


def main():
    master = Image.open(MASTER).convert("RGBA")
    if master.size != (512, 512):
        raise SystemExit(f"expected a 512x512 master, found {master.size}")
    at = frames(master)

    ico = HERE / "sessionhub.ico"
    write_ico(ico, at)
    print(f"{ico.name}  {ico.stat().st_size} bytes  {ICO_SIZES}")

    icns = HERE / "sessionhub.icns"
    write_icns(icns, at)
    print(f"{icns.name} {icns.stat().st_size} bytes  {[k for k, _ in ICNS_CHUNKS]}")


main()
