#!/usr/bin/env python3
"""Generates real 16x16, 48x48, and 128x128 RGBA PNG icons with zero external dependencies."""

import math
import os
import struct
import zlib


def make_chunk(chunk_type: bytes, data: bytes) -> bytes:
    chunk = chunk_type + data
    crc = zlib.crc32(chunk) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + chunk + struct.pack(">I", crc)


def encode_png(width: int, height: int, rgba_bytes: bytes) -> bytes:
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # Filter type 0 (None)
        start = y * stride
        raw.extend(rgba_bytes[start : start + stride])

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), level=9)
    return (
        b"\x89PNG\r\n\x1a\n"
        + make_chunk(b"IHDR", ihdr)
        + make_chunk(b"IDAT", idat)
        + make_chunk(b"IEND", b"")
    )


def signed_distance_rounded_rect(x: float, y: float, half_w: float, half_h: float, radius: float) -> float:
    dx = abs(x) - (half_w - radius)
    dy = abs(y) - (half_h - radius)
    outside = math.hypot(max(dx, 0.0), max(dy, 0.0))
    inside = min(max(dx, dy), 0.0)
    return outside + inside - radius


def render_icon(size: int) -> bytes:
    pixels = bytearray(size * size * 4)
    center = (size - 1) / 2.0
    half = size * 0.45
    radius = size * 0.22

    # Play/add glyph geometry normalized to [-1, 1]
    for py in range(size):
        for px in range(size):
            nx = (px - center) / half
            ny = (py - center) / half

            dist = signed_distance_rounded_rect(px - center, py - center, half, half, radius)
            if dist > 1.0:
                alpha = 0.0
            elif dist > 0.0:
                alpha = 1.0 - dist
            else:
                alpha = 1.0

            # Gradient background: deep obsidian (#12131f) -> rich violet (#5e3df0)
            t = max(0.0, min(1.0, (nx + ny + 2.0) / 4.0))
            bg_r = 22 + t * (112 - 22)
            bg_g = 20 + t * (72 - 20)
            bg_b = 44 + t * (245 - 44)

            # Subtle inner highlight border
            if -1.5 <= dist <= 0.0:
                bg_r = min(255.0, bg_r + 36.0)
                bg_g = min(255.0, bg_g + 32.0)
                bg_b = min(255.0, bg_b + 55.0)

            # Stylized "N" ribbon + "+" badge in crisp white/cyan
            in_left_bar = -0.46 <= nx <= -0.24 and -0.48 <= ny <= 0.48
            in_right_bar = 0.16 <= nx <= 0.38 and -0.48 <= ny <= 0.48
            diag_dist = abs((ny - (-0.42)) - ((0.42 - (-0.42)) / (0.28 - (-0.36))) * (nx - (-0.36)))
            in_diag = -0.38 <= nx <= 0.30 and -0.48 <= ny <= 0.48 and diag_dist <= 0.24

            # Small "+" badge on bottom-right corner for larger icons
            in_plus_h = 0.28 <= nx <= 0.68 and 0.38 <= ny <= 0.56
            in_plus_v = 0.39 <= nx <= 0.57 and 0.27 <= ny <= 0.67

            if in_left_bar or in_right_bar or in_diag:
                r, g, b = 248.0, 250.0, 255.0
            elif size >= 32 and (in_plus_h or in_plus_v):
                r, g, b = 56.0, 232.0, 200.0
            else:
                r, g, b = bg_r, bg_g, bg_b

            idx = (py * size + px) * 4
            pixels[idx] = int(max(0, min(255, round(r))))
            pixels[idx + 1] = int(max(0, min(255, round(g))))
            pixels[idx + 2] = int(max(0, min(255, round(b))))
            pixels[idx + 3] = int(max(0, min(255, round(alpha * 255))))

    return encode_png(size, size, bytes(pixels))


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    icons_dir = os.path.join(root, "icons")
    os.makedirs(icons_dir, exist_ok=True)

    for size in (16, 48, 128):
        out_path = os.path.join(icons_dir, f"icon-{size}.png")
        with open(out_path, "wb") as fh:
            fh.write(render_icon(size))
        print(f"Generated {out_path} ({size}x{size})")


if __name__ == "__main__":
    main()
