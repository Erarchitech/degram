#!/usr/bin/env python3
"""Render the DeGram app icons (Phase 1301, F-04) over the upstream filenames.

The DeGram mark is the owner-supplied halftone hexagon (2026-10-06): a pointy-top
hexagon of 91 dots on a hexagonal lattice -- one centre dot and five rings of
6, 12, 18, 24 and 30 dots -- whose radius shrinks ring by ring. The geometry
below was measured from the owner's 494x508 artwork (lattice fit residual
0.08 px) and is drawn here as exact circles, so every size renders sharp
instead of resampling a raster.

Below 48 px the 91 dots blur into a grey patch, so 16/24/32 px use a reduced
mark (centre + two rings, 19 dots) at the same footprint.

Outputs replace the upstream Nous assets IN PLACE under the same filenames, so
no import site, builder setting or icon-resolution ladder changes:

  assets/icon.png, assets/icon-dark.png          1024 tile, light / dark
  assets/icon.ico, assets/icon-dark.ico          16, 24, 32, 48, 64, 128, 256
  assets/icon-mac.png                            824 tile centred in 1024
  assets/icon.icns, assets/icon-dark.icns        from the mac-grid tile
  public/apple-touch-icon.png                    1024 light tile (favicon)
  public/nous-girl.png, public/nous-girl-dark.png  256 in-app BrandMark tiles

Not rendered (DeGram does not build them): assets/appx/* MSIX tiles and the
macOS 26 Icon Composer package assets/icon.icon.

Usage, from apps/desktop:  python scripts/generate_degram_icons.py [--check]
Needs Pillow only. Do not run upstream scripts/generate_icons.py on the fork:
it would write the Nous artwork back over these files.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent

# Lattice: neighbouring dots in one vertical column are LATTICE apart. Radii are
# per ring (0 = centre), in the same units, as measured from the artwork.
LATTICE = 36.8436
RING_RADII = (13.9, 11.82, 10.29, 8.46, 6.65, 4.85)
SMALL_RING_RADII = (14.5, 11.0, 7.5)

LIGHT = {'tile': (255, 255, 255, 255), 'dot': (0, 0, 0, 255)}
DARK = {'tile': (13, 17, 23, 255), 'dot': (255, 255, 255, 255)}

TILE_CORNER = 231 / 1024  # corner radius of the upstream full-bleed tile
MARK_HEIGHT = 0.80  # mark height as a fraction of the tile
MAC_TILE = 824 / 1024  # Apple's icon grid: 824 px tile centred in 1024
SUPERSAMPLE = 8
SMALL_SIZES = (16, 24, 32)
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)


def mark(radii: tuple[float, ...]) -> list[tuple[float, float, float]]:
    """(x, y, r) of every dot, centred on the origin, for len(radii) - 1 rings."""
    rings = len(radii) - 1
    dx = LATTICE * math.sqrt(3) / 2
    dots = []
    for q in range(-rings, rings + 1):
        for r in range(-rings, rings + 1):
            ring = (abs(q) + abs(r) + abs(q + r)) // 2
            if ring <= rings:
                dots.append((q * dx, (r + q / 2) * LATTICE, radii[ring]))
    return dots


def tile(size: int, palette: dict, *, small: bool = False, inset: float = 1.0) -> Image.Image:
    """One square RGBA icon: rounded tile, inset within the canvas, mark centred."""
    s = size * SUPERSAMPLE
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    side = s * inset
    x0 = (s - side) / 2
    draw.rounded_rectangle([x0, x0, x0 + side - 1, x0 + side - 1], radius=side * TILE_CORNER, fill=palette['tile'])

    dots = mark(SMALL_RING_RADII if small else RING_RADII)
    half_height = max(abs(y) + r for _, y, r in dots)
    scale = (MARK_HEIGHT * side / 2) / half_height
    for x, y, r in dots:
        cx, cy, rr = s / 2 + x * scale, s / 2 + y * scale, r * scale
        draw.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=palette['dot'])

    return img.resize((size, size), Image.LANCZOS)


def ico_frames(palette: dict) -> list[Image.Image]:
    return [tile(n, palette, small=n in SMALL_SIZES) for n in ICO_SIZES]


def outputs() -> dict[Path, object]:
    light_1024 = tile(1024, LIGHT)
    return {
        ROOT / 'assets/icon.png': light_1024,
        ROOT / 'assets/icon-dark.png': tile(1024, DARK),
        ROOT / 'assets/icon.ico': ico_frames(LIGHT),
        ROOT / 'assets/icon-dark.ico': ico_frames(DARK),
        ROOT / 'assets/icon-mac.png': tile(1024, LIGHT, inset=MAC_TILE),
        ROOT / 'assets/icon.icns': tile(1024, LIGHT, inset=MAC_TILE),
        ROOT / 'assets/icon-dark.icns': tile(1024, DARK, inset=MAC_TILE),
        ROOT / 'public/apple-touch-icon.png': light_1024,
        ROOT / 'public/nous-girl.png': tile(256, LIGHT),
        ROOT / 'public/nous-girl-dark.png': tile(256, DARK),
    }


def write(path: Path, value: object) -> None:
    if path.suffix == '.ico':
        frames = value  # type: ignore[assignment]
        frames[-1].save(path, format='ICO', sizes=[f.size for f in frames], append_images=frames[:-1])
    elif path.suffix == '.icns':
        value.save(path, format='ICNS')  # type: ignore[union-attr]
    else:
        value.save(path, format='PNG', optimize=True)  # type: ignore[union-attr]


def check() -> list[str]:
    problems = []
    for path in outputs():
        if not path.exists():
            problems.append(f'missing {path}')
            continue
        img = Image.open(path)
        if path.suffix == '.ico':
            got = sorted(img.info.get('sizes', []))
            want = sorted((n, n) for n in ICO_SIZES)
            if got != want:
                problems.append(f'{path.name}: sizes {got} != {want}')
        elif path.suffix == '.png' and img.size[0] != img.size[1]:
            problems.append(f'{path.name}: not square {img.size}')
    return problems


def main(argv: list[str]) -> int:
    if '--check' in argv:
        problems = check()
        for problem in problems:
            print(f'[degram-icons] {problem}', file=sys.stderr)
        return 1 if problems else 0
    for path, value in outputs().items():
        write(path, value)
        print(f'[degram-icons] wrote {path.relative_to(ROOT)}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
