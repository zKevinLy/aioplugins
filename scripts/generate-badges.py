#!/usr/bin/env python3
"""Renders public/badges/<id>.png for every badge in src/providers/badge-pack.ts.

Run from the repository root: python3 scripts/generate-badges.py
Needs Pillow and a bold sans font (Poppins, DejaVu Sans or Inter).
"""
import re
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SOURCE = (ROOT / "src/providers/badge-pack.ts").read_text()
OUT = ROOT / "public/badges"
OUT.mkdir(parents=True, exist_ok=True)

groups = dict(re.findall(r'id: "(\w+)", name: "[^"]+", color: "(#[0-9A-Fa-f]{6})"', SOURCE))
badges = re.findall(r'\{ id: "([\w-]+)", label: "([^"]+)", group: "(\w+)"', SOURCE)

FONTS = [
    "/usr/share/fonts/truetype/google-fonts/Poppins-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]
font_path = next(p for p in FONTS if Path(p).exists())

SCALE, HEIGHT, FONT_SIZE, PAD = 3, 24, 13, 9
font = ImageFont.truetype(font_path, FONT_SIZE * SCALE)

for badge_id, label, group in badges:
    color = groups[group]
    width = int(font.getlength(label)) + 2 * PAD * SCALE
    width = max(width, 34 * SCALE)
    image = Image.new("RGBA", (width, HEIGHT * SCALE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, width - 1, HEIGHT * SCALE - 1), radius=6 * SCALE, fill=color)
    draw.text((width / 2, HEIGHT * SCALE / 2 + SCALE), label, font=font, fill="white", anchor="mm")
    image.save(OUT / f"{badge_id}.png", optimize=True)

print(f"wrote {len(badges)} badges to {OUT}")
