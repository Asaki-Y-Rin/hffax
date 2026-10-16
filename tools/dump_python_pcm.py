#!/usr/bin/env python3
"""Dump the Python reference PCM for the golden vector to a raw file.

Used by the test harness so that tests/run.js can compare the JavaScript
encoder against the Python reference sample by sample instead of only checking
a frozen hash. Deterministic: two runs must produce identical files.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools" / "golden"))
import reference_encoder as ref  # noqa: E402


def main() -> int:
    vector = sys.argv[1] if len(sys.argv) > 1 else str(
        ROOT / "tests" / "vectors" / "basic_ioc576.json")
    out_path = sys.argv[2] if len(sys.argv) > 2 else str(
        ROOT / "tests" / "vectors" / "python_pcm.raw")

    _, cfg, image = ref.load_vector(Path(vector))
    collected = bytearray()
    enc = ref.Encoder(cfg, lambda b: collected.extend(b))
    stats = enc.run(image)
    Path(out_path).write_bytes(bytes(collected))
    print(f"python reference: {len(collected)} bytes, {stats['samples']} samples -> {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
