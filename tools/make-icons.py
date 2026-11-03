#!/usr/bin/env python3
"""Generate the Claude Safari extension icons for both variants.

Usage:
  python3 tools/make-icons.py [--preview-dir DIR]

Writes extension/icons/terminal/icon-<size>.png and extension/icons/panel/icon-<size>.png
for sizes 48, 96, 128, 256 and 512. Each tile is drawn at 4x and downscaled with LANCZOS.
With --preview-dir, also writes the 512 px previews icon-terminal.png and icon-panel.png there.
"""
import argparse
import math
import os

from PIL import Image, ImageDraw

SIZES = [48, 96, 128, 256, 512]
SUPERSAMPLE = 4
SPARK_COLOUR = (0xD9, 0x77, 0x57, 255)  # Claude terracotta
VARIANTS = {
    "terminal": (0x1F, 0x1E, 0x1D, 255),  # dark tile
    "panel": (0xF4, 0xEF, 0xE6, 255),     # cream tile
}
# Hand-drawn feel: 12 rays, lengths 0.74..1.0 of R, angles ~30 deg apart with up to +-4 deg jitter.
RAY_LENGTHS = [1.0, .80, .92, .76, .98, .84, .94, .74, 1.0, .82, .90, .78]
ANGLE_JITTER_DEG = [2.5, -3.5, 1.0, 4.0, -2.0, 3.0, -4.0, 1.5, -1.0, 3.5, -3.0, 0.5]
SPARK_RADIUS_RATIO = 0.36   # spark diameter = 72% of the tile
TILE_CORNER_RATIO = 0.22    # rounded-square corner radius
HUB_RATIO = 0.16            # solid centre disc radius (fraction of R)
BASE_WIDTH = 0.088          # ray half-width at 0.15R (fraction of R)
TIP_WIDTH = 0.056          # ray half-width just before the tip (fraction of R)
SMALL_BOOST = 1.0           # raise to fatten rays on small tiles if they ever blur


def draw_spark(draw, cx, cy, radius, colour, boost=1.0):
    """Draw 12 tapered wedges from one shared centre, each with a round tip cap, plus a solid hub."""
    base_half = radius * BASE_WIDTH * boost
    tip_half = radius * TIP_WIDTH * boost
    r0 = 0.15 * radius
    for i, length in enumerate(RAY_LENGTHS):
        angle = math.radians(i * 30.0 + ANGLE_JITTER_DEG[i] - 90.0)
        ux, uy = math.cos(angle), math.sin(angle)   # ray direction
        px, py = -uy, ux                            # perpendicular
        tip_dist = radius * length - tip_half       # cap centre; cap outer edge hits radius*length
        tx, ty = cx + ux * tip_dist, cy + uy * tip_dist
        bx, by = cx + ux * r0, cy + uy * r0
        draw.polygon(
            [
                (cx, cy),
                (bx + px * base_half, by + py * base_half),
                (tx + px * tip_half, ty + py * tip_half),
                (tx - px * tip_half, ty - py * tip_half),
                (bx - px * base_half, by - py * base_half),
            ],
            fill=colour,
        )
        draw.ellipse([tx - tip_half, ty - tip_half, tx + tip_half, ty + tip_half], fill=colour)
    hub = radius * HUB_RATIO
    draw.ellipse([cx - hub, cy - hub, cx + hub, cy + hub], fill=colour)


def render_tile(size, background):
    """Render one tile at SUPERSAMPLE x and downscale to size with LANCZOS."""
    canvas = size * SUPERSAMPLE
    img = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle(
        [0, 0, canvas - 1, canvas - 1],
        radius=round(canvas * TILE_CORNER_RATIO),
        fill=background,
    )
    boost = SMALL_BOOST if size <= 64 else 1.0
    draw_spark(draw, canvas / 2, canvas / 2, canvas * SPARK_RADIUS_RATIO, SPARK_COLOUR, boost)
    return img.resize((size, size), Image.LANCZOS)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--preview-dir", help="also write 512 px previews here")
    args = parser.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for variant, background in VARIANTS.items():
        out_dir = os.path.join(root, "extension", "icons", variant)
        os.makedirs(out_dir, exist_ok=True)
        for size in SIZES:
            tile = render_tile(size, background)
            tile.save(os.path.join(out_dir, f"icon-{size}.png"), "PNG", optimize=True)
        print(f"wrote {out_dir}: {', '.join(str(s) for s in SIZES)}")
        if args.preview_dir:
            os.makedirs(args.preview_dir, exist_ok=True)
            preview = os.path.join(args.preview_dir, f"icon-{variant}.png")
            render_tile(512, background).save(preview, "PNG")
            print(f"preview: {preview}")


if __name__ == "__main__":
    main()
