#!/usr/bin/env python3
"""Regenerate the synthetic test-vector rasters.

The vectors under tests/vectors/*.json embed their input rasters as hex so that
both the JavaScript encoder and the Python reference read byte-identical input.
This tool writes those hex strings from the documented formulas, so a vector can
be regenerated instead of hand-edited.

    python tools/make_vectors.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VECTORS = ROOT / "tests" / "vectors"


def gray_ramp_16x12() -> bytes:
    """v(x, y) = (x*16 + y*4) & 255 — row 0 covers 0..240, so one line exercises
    almost the whole video band."""
    return bytes(((x * 16 + y * 4) & 0xFF) for y in range(12) for x in range(16))


def texture_16x12() -> bytes:
    """v(x, y) = ((x*4) ^ (y*3)) & 255 — a synthetic texture with no structure
    that could accidentally match a constant line."""
    return bytes((((x * 4) ^ (y * 3)) & 0xFF) for y in range(12) for x in range(16))


TARGETS = {
    "basic_ioc576.json": ("data_hex", gray_ramp_16x12()),
    "pipeline_ioc576.json": ("data_hex", texture_16x12()),
}


def main() -> int:
    for name, (field, data) in TARGETS.items():
        path = VECTORS / name
        if not path.exists():
            print(f"skip {name} (missing)")
            continue
        vec = json.loads(path.read_text(encoding="utf-8"))
        image = vec["image"]
        expected_len = image["width"] * image["height"]
        if len(data) != expected_len:
            print(f"ERROR: {name}: generated {len(data)} bytes for a "
                  f"{image['width']}x{image['height']} raster")
            return 1
        vec["image"][field] = data.hex()
        path.write_text(json.dumps(vec, indent=2) + "\n", encoding="utf-8")
        print(f"{name}: {field} = {len(data)} bytes for {image['width']}x{image['height']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
