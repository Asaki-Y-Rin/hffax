#!/usr/bin/env python3
"""Cross-check the polarity judge in src/hffax.js against the Python reference.

    python tools/dump_polarity_cases.py [out.json]

Runs the Python `check_polarity` on a set of synthetic transmissions and writes
the decisions to JSON, so `tests/run.js` can compare them with the decisions the
JavaScript `checkPolarity` makes for the same pictures. Two independent
implementations agreeing on "this file is a negative" is the point; either one
alone could be consistently wrong.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools" / "golden"))
import reference_encoder as ref  # noqa: E402

W, LINES = 360, 8


def make_picture(kind: str) -> bytes:
    """Synthetic pictures with different black/white area ratios."""
    out = bytearray()
    for y in range(LINES):
        for x in range(W):
            if kind == "bright":
                v = 240 if ((x % 45) >= 5 and (y % 4) != 0) else 20
            elif kind == "dark":
                v = 40 if ((x % 45) >= 5 and (y % 4) != 0) else 220
            elif kind == "half":
                v = 0 if ((x // 8) % 2 == 0) else 255
            else:  # mid grey: the sign is genuinely undecidable
                v = 128
            out.append(v)
    return bytes(out)


def main() -> int:
    out_path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "tests" / "vectors" / "polarity_cases.json"
    cases = []

    for kind in ("bright", "dark", "half", "grey"):
        data = make_picture(kind)
        for label, over in (("positive", {}), ("invert", {"invert": True}),
                            ("negpolarity", {"polarity": "negative"})):
            cfg = {
                "sampleRate": 48000, "lineRateLpm": 120, "ioc": 576, "width": W,
                "maxLines": LINES, "whiteHz": 1500, "blackHz": 2300,
                "modulation": "fm", "polarity": "positive", "outputLevel": 0.8,
                "pixelClock": "exact", "phasingEnabled": True, "phasingBlackPercent": 5,
                "startToneEnabled": False, "startToneSeconds": 5, "startToneHz": 300,
                "stopToneEnabled": True, "stopToneSeconds": 0.5, "stopToneHz": 450,
                "stopBlackLines": 1, "preserveAspect": False, "dither": "none",
                "gamma": 1.0, "autoContrast": False, "invert": False,
                "lowPassEnabled": False, "lowPassCutoffHz": 2800,
                "sink": {"blockSamples": 4096},
            }
            cfg.update(over)

            # Prepare the raster exactly the way the JAVASCRIPT side does:
            # `prepareRaster()` inverts the luminance when the config asks for
            # it, and the audio is then encoded from that raster. (Skipping the
            # inversion here produced cases where the raster and the audio
            # disagreed for reasons that had nothing to do with the judge.)
            raster = bytes(255 - v for v in data) if cfg["invert"] else data
            collected = bytearray()
            enc = ref.Encoder(cfg, lambda b: collected.extend(b))
            enc.run({"width": W, "height": LINES, "data": raster})
            pcm = list(__import__("struct").unpack("<%dh" % (len(collected) // 2), bytes(collected)))

            line = ref.js_round(cfg["sampleRate"] * 60.0 / cfg["lineRateLpm"])
            head = line  # phasing line, no start tone
            tail = ref.js_round(cfg["sampleRate"] * cfg["stopToneSeconds"])
            # The reference is the picture the user meant to send, i.e. *before*
            # any inversion — that is what makes "you inverted my picture"
            # detectable.
            res = ref.check_polarity(pcm, cfg, raster, head, len(pcm) - tail,
                                     sum(data) / len(data))
            cases.append({
                "name": f"{kind}-{label}",
                "kind": kind,
                "overrides": over,
                "data_hex": data.hex(),
                "expected": {
                    "inverted": res["inverted"],
                    "confidence": res["confidence"],
                    "blackFraction": round(res["blackFraction"], 4),
                    "dominantLevel": res["dominantLevel"],
                },
                "python_inverted": res["inverted"],
                "python_confidence": res["confidence"],
            })

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({"cases": cases}, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(cases)} polarity cases -> {out_path}")
    for c in cases:
        print(f"  {c['name']:22} inverted={str(c['python_inverted']):5} "
              f"confidence={c['python_confidence']:5} black={c['expected']['blackFraction']:.3f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
