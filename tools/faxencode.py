#!/usr/bin/env python3
"""Dependency-free command-line HF FAX encoder (PNG/JPEG/BMP -> WAV).

    python tools/faxencode.py chart.png                  # dist/chart.wav, IOC 576
    python tools/faxencode.py chart.png out.wav --lines 300
    python tools/faxencode.py chart.png --lpm 60 --ioc 288 --width 900
    python tools/faxencode.py chart.png --dither bayer8 --invert
    python tools/faxencode.py --test-chart               # write + encode a test chart

Use this when Node.js is not installed. It shares the exact signal code with the
browser app: this file only does image I/O (Pillow) and resampling, then calls
the same `Encoder` class from tools/golden/reference_encoder.py. The JavaScript
engine in src/hffax.js is verified against that class sample by sample, so both
paths produce the same signal.

Requires Pillow (`pip install pillow`) for image loading only.
"""

from __future__ import annotations

import argparse
import math
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools" / "golden"))

import reference_encoder as ref  # noqa: E402

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover
    Image = None


# ---------------------------------------------------------------- configuration

DEFAULTS = {
    "sampleRate": 48000,
    "lineRateLpm": 120,
    "ioc": 576,
    "width": 1800,
    "maxLines": 576,
    "whiteHz": 1500,
    "blackHz": 2300,
    "modulation": "fm",
    "polarity": "positive",
    "outputLevel": 0.7,
    "pixelClock": "exact",
    "phasingEnabled": True,
    "phasingBlackPercent": 5,
    "startToneEnabled": False,
    "startToneSeconds": 5,
    "startToneHz": 300,
    "stopToneEnabled": True,
    "stopToneSeconds": 5,
    "stopToneHz": 450,
    "stopBlackLines": 5,
    "preserveAspect": True,
    "dither": "none",
    "gamma": 1.0,
    "autoContrast": True,
    "invert": False,
    "lowPassEnabled": False,
    "lowPassCutoffHz": 2800,
}


def build_config(args) -> dict:
    cfg = dict(DEFAULTS)
    cfg.update({
        "sampleRate": args.sample_rate,
        "lineRateLpm": args.lpm,
        "ioc": args.ioc,
        "width": args.width,
        "maxLines": args.lines,
        "whiteHz": args.white,
        "blackHz": args.black,
        "outputLevel": args.level,
        "dither": args.dither,
        "gamma": args.gamma,
        "invert": args.invert,
        "polarity": args.polarity,
        "autoContrast": args.auto_contrast,
        "phasingEnabled": not args.no_phasing,
        "phasingBlackPercent": args.phasing_percent,
        "startToneEnabled": args.start_tone,
        "startToneSeconds": args.start_tone_seconds,
        "startToneHz": args.start_tone_hz,
        "stopToneEnabled": not args.no_stop_tone,
        "stopToneSeconds": args.stop_tone_seconds,
        "stopToneHz": args.stop_tone_hz,
        "stopBlackLines": args.stop_black_lines,
        "preserveAspect": not args.stretch,
        "lowPassEnabled": args.low_pass,
        "lowPassCutoffHz": args.low_pass_cutoff,
    })
    cfg["sink"] = {"blockSamples": 1 << 13}
    return cfg


# ------------------------------------------------------------------- image I/O

def prepare_raster(path: Path, cfg: dict, height_override: int | None = None):
    """Load an image, condition it (contrast/gamma/invert), resample to the
    transmitted geometry and return the 8-bit grey raster plus its size."""
    if Image is None:
        raise SystemExit("Pillow is required: pip install pillow")

    img = Image.open(path)
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        background = Image.new("RGBA", img.size, (255, 255, 255, 255))
        img = Image.alpha_composite(background, img)
    gray = img.convert("L")

    width = cfg["width"]
    if cfg["preserveAspect"] and height_override is None:
        lines = max(1, min(cfg["maxLines"], round(gray.height * (width / gray.width))))
    else:
        lines = height_override or cfg["maxLines"]

    # Pillow's LANCZOS is a good area-ish filter for the down-scaling that
    # weather charts usually need.
    resized = gray.resize((width, lines), Image.LANCZOS)
    data = bytearray(resized.tobytes())

    if cfg["autoContrast"]:
        _auto_contrast(data)
    if cfg["invert"]:
        for i in range(len(data)):
            data[i] = 255 - data[i]
    if cfg["gamma"] != 1.0:
        _apply_gamma(data, cfg["gamma"])
    if cfg["dither"] != "none":
        _dither(data, width, lines, cfg["dither"])
    return bytes(data), width, lines


def _auto_contrast(data: bytearray, clip_percent: float = 0.5) -> None:
    hist = [0] * 256
    for v in data:
        hist[v] += 1
    total = len(data)
    clip = int(total * clip_percent / 100)
    low, acc = 0, 0
    for i in range(256):
        acc += hist[i]
        if acc > clip:
            low = i
            break
    high, acc = 255, 0
    for i in range(255, -1, -1):
        acc += hist[i]
        if acc > clip:
            high = i
            break
    if high <= low:
        return
    scale = 255.0 / (high - low)
    for i in range(len(data)):
        data[i] = min(255, max(0, ref.js_round((data[i] - low) * scale)))


def _apply_gamma(data: bytearray, gamma: float) -> None:
    lut = [min(255, max(0, ref.js_round(((i / 255) ** gamma) * 255))) for i in range(256)]
    for i in range(len(data)):
        data[i] = lut[data[i]]


def _dither(data: bytearray, width: int, height: int, mode: str) -> None:
    if mode in ("bayer4", "bayer8"):
        bits = 2 if mode == "bayer4" else 3
        n = 1 << bits
        levels = n * n
        for y in range(height):
            for x in range(width):
                i = y * width + x
                t = (_bayer(x & (n - 1), y & (n - 1), bits) + 0.5) / levels
                data[i] = 255 if data[i] >= t * 255 else 0
        return
    if mode == "fs":
        err = [0.0] * (width + 2)
        for y in range(height):
            nxt = [0.0] * (width + 2)
            for x in range(width):
                i = y * width + x
                val = data[i] + err[x + 1]
                out = 0 if val < 128 else 255
                data[i] = out
                e = val - out
                err[x + 2] += e * 7 / 16
                nxt[x] += e * 3 / 16
                nxt[x + 1] += e * 5 / 16
                nxt[x + 2] += e * 1 / 16
            err = nxt
        return
    raise SystemExit(f"unknown dither mode: {mode}")


def _bayer(x: int, y: int, bits: int) -> int:
    v = 0
    for bit in range(bits - 1, -1, -1):
        xb = (x >> bit) & 1
        yb = (y >> bit) & 1
        part = 0 if (xb == 0 and yb == 0) else 2 if (xb == 1 and yb == 0) else 3 if (xb == 0 and yb == 1) else 1
        v = v * 4 + part
    return v


def write_test_chart(path: Path, width: int = 1600, height: int = 1100) -> None:
    """A WMO-flavoured test chart: greyscale ramp, resolution wedges, grid,
    phasing reference and labels. Useful to eyeball a receiver's output."""
    if Image is None:
        raise SystemExit("Pillow is required: pip install pillow")
    img = Image.new("L", (width, height), 255)
    d = ImageDraw.Draw(img)
    m = 40

    # frame
    d.rectangle([m, m, width - m, height - m], outline=0, width=3)

    # grey ramp
    ramp_top = m + 100
    for i in range(16):
        x0 = m + 20 + i * ((width - 2 * m - 40) // 16)
        d.rectangle([x0, ramp_top, x0 + (width - 2 * m - 40) // 16 - 4, ramp_top + 90],
                    fill=int(i * 255 / 15))

    # resolution wedges
    for k, bar_w in enumerate((2, 4, 6, 8, 12, 16)):
        y0 = ramp_top + 150 + k * 60
        x = m + 30
        while x < width // 2:
            d.rectangle([x, y0, x + bar_w, y0 + 34], fill=0)
            x += bar_w * 2
        d.text((width // 2 + 20, y0 + 8), f"{bar_w}px line pairs", fill=0)

    # grid
    for x in range(m, width - m, 100):
        d.line([(x, height - m - 220), (x, height - m - 20)], fill=128)
    for y in range(height - m - 220, height - m - 20, 50):
        d.line([(m, y), (width - m, y)], fill=128)

    # phasing reference strip
    d.rectangle([m + 10, height - m - 210, m + 10 + 30, height - m - 30], fill=0)

    d.text((m + 20, m + 20), "HF WEATHER FAX TEST CHART  /  WMO IOC 576 120 lpm", fill=0)
    d.text((m + 20, m + 48), "white 1500 Hz   black 2300 Hz   centre 1900 Hz   BW 2550 Hz", fill=0)
    d.text((m + 20, m + 76), "phasing 5% black + 95% white   stop 450 Hz", fill=0)
    d.text((m + 60, height - m - 190), "PHASING", fill=255)
    img.save(path)
    print(f"wrote test chart {path}")


# ------------------------------------------------------------------------ main

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Encode an image into a WMO HF weather-fax WAV.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument("image", nargs="?", help="input image (PNG / JPEG / BMP / TIFF)")
    ap.add_argument("output", nargs="?", help="output WAV (default: input name + .wav in ./dist)")
    ap.add_argument("--test-chart", action="store_true", help="generate a synthetic test chart and encode it")
    ap.add_argument("--sample-rate", type=int, default=DEFAULTS["sampleRate"])
    ap.add_argument("--lpm", type=int, default=DEFAULTS["lineRateLpm"], help="lines per minute (60 or 120)")
    ap.add_argument("--ioc", type=int, default=DEFAULTS["ioc"], help="index of cooperation (576 or 288)")
    ap.add_argument("--width", type=int, default=DEFAULTS["width"], help="pixels per line")
    ap.add_argument("--lines", type=int, default=DEFAULTS["maxLines"], help="max transmitted lines")
    ap.add_argument("--white", type=int, default=DEFAULTS["whiteHz"])
    ap.add_argument("--black", type=int, default=DEFAULTS["blackHz"])
    ap.add_argument("--level", type=float, default=DEFAULTS["outputLevel"], help="output level 0..1")
    ap.add_argument("--dither", choices=("none", "bayer4", "bayer8", "fs"), default="none")
    ap.add_argument("--gamma", type=float, default=1.0)
    ap.add_argument("--invert", action="store_true", help="send the negative of the picture")
    ap.add_argument("--polarity", choices=("positive", "negative"), default="positive",
                    help="positive: black is the high video frequency (WMO standard)")
    ap.add_argument("--no-auto-contrast", dest="auto_contrast", action="store_false")
    ap.add_argument("--stretch", action="store_true", help="stretch to --lines instead of keeping aspect ratio")
    ap.add_argument("--no-phasing", dest="no_phasing", action="store_true")
    ap.add_argument("--phasing-percent", type=float, default=5.0)
    ap.add_argument("--start-tone", action="store_true")
    ap.add_argument("--start-tone-seconds", type=float, default=5.0)
    ap.add_argument("--start-tone-hz", type=int, default=300)
    ap.add_argument("--no-stop-tone", dest="no_stop_tone", action="store_true")
    ap.add_argument("--stop-tone-seconds", type=float, default=5.0)
    ap.add_argument("--stop-tone-hz", type=int, default=450)
    ap.add_argument("--stop-black-lines", type=int, default=5)
    ap.add_argument("--low-pass", action="store_true")
    ap.add_argument("--low-pass-cutoff", type=float, default=2800)
    ap.add_argument("--sign", action="store_true",
                    help="measure the polarity of the produced WAV and say whether a "
                         "receiver would show it as a negative")
    ap.add_argument("--dump-raster", metavar="PNG",
                    help="also write the prepared (transmitted) raster, for round-trip checks")
    args = ap.parse_args(argv)

    if args.test_chart:
        chart = ROOT / "samples" / "test-chart.png"
        chart.parent.mkdir(parents=True, exist_ok=True)
        write_test_chart(chart)
        args.image = str(chart)
        args.output = args.output or str(ROOT / "samples" / "test-chart-ioc576.wav")

    if not args.image:
        ap.error("an input image is required (or use --test-chart)")

    src = Path(args.image)
    if not src.exists():
        raise SystemExit(f"input image not found: {src}")
    out_path = Path(args.output) if args.output else ROOT / "dist" / (src.stem + ".wav")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    cfg = build_config(args)
    raster, width, lines = prepare_raster(src, cfg)
    image = {"width": width, "height": lines, "data": raster}

    if args.dump_raster:
        # Save exactly what goes on the air. Comparing a decoder against the
        # *original* picture is misleading: fine detail below the pixel clock is
        # already gone after resampling, and the 400 Hz video deviation cannot
        # carry it either.
        from PIL import Image as _Image
        out_raster = Path(args.dump_raster)
        out_raster.parent.mkdir(parents=True, exist_ok=True)
        _Image.frombytes("L", (width, lines), raster).save(out_raster)
        print(f"raster     : {out_raster} ({width} x {lines}, the transmitted bitmap)")

    print(f"input      : {src} ({width} x {lines} transmitted pixels)")
    print(f"standard   : IOC {cfg['ioc']}, {cfg['lineRateLpm']} lpm, "
          f"{cfg['whiteHz']}-{cfg['blackHz']} Hz, {cfg['sampleRate']} Hz audio")

    with open(out_path, "wb") as fh:
        fh.write(b"\0" * 44)                  # header placeholder, patched below
        enc = ref.Encoder(cfg, fh.write)
        stats = enc.run(image)
        fh.seek(0)
        fh.write(ref.wav_header(stats["samples"] * 2, cfg["sampleRate"]))

    secs = stats["samples"] / cfg["sampleRate"]
    print(f"output     : {out_path}")
    print(f"             {stats['lines']} lines, {stats['samples']} samples, "
          f"{secs:.1f} s, {out_path.stat().st_size / 1048576:.2f} MiB")
    print(f"             peak {stats['peak']:.3f}, clipped {stats['clipped']}")
    if stats["clipped"]:
        print("             WARNING: clipping — lower --level (try 0.6)")

    if args.sign:
        report_sign(out_path, cfg, raster, width, lines)
    return 0


def report_sign(wav_path: Path, cfg: dict, raster: bytes, width: int, lines: int) -> None:
    """Say whether the produced audio is a positive or a negative picture.

    Uses the same measurement as the web app (`check_polarity` in the reference
    encoder, which mirrors `checkPolarity` in src/hffax.js): the black/white
    energy balance of the image area, judged against the brightness of the
    picture the user meant to send. The phasing bar cannot answer this question
    — it is always transmitted as black, so the image inversion does not touch
    it (an earlier version of this check got that wrong).
    """
    line = round(cfg["sampleRate"] * 60.0 / cfg["lineRateLpm"])
    head = (round(cfg["sampleRate"] * cfg["startToneSeconds"]) if cfg["startToneEnabled"] else 0) \
        + (line if cfg["phasingEnabled"] else 0)
    tail = round(cfg["sampleRate"] * cfg["stopToneSeconds"]) if cfg["stopToneEnabled"] else 0

    with open(wav_path, "rb") as fh:
        raw = fh.read()
    pcm = struct.unpack("<%dh" % ((len(raw) - 44) // 2), raw[44:])

    body_lines = (len(pcm) - head - tail + line) / line
    print("sign check :")
    print(f"             body = {body_lines:.4f} lines of {line} samples (must be a whole number)")

    # The reference the audio should be judged against is the raster that was
    # actually transmitted: with --invert that raster is already the inverted
    # picture, and the signal is expected to match it.
    ref_lum = (sum(raster) / len(raster)) if raster else 127.5
    res = ref.check_polarity(pcm, cfg, bytes(raster), head, len(pcm) - tail, ref_lum)

    print(f"             image area black/white energy balance {res['blackFraction'] * 100:.1f} %, "
          f"dominant level {res['dominantLevel']}/255, {res['linesMeasured']} line(s) measured")
    if res["confidence"] == "low":
        print(f"             UNDECIDED — {res['note']}")
        return
    if res["inverted"]:
        print("             INVERTED — a normal receiver will show this as a NEGATIVE.")
        print("             Fix it with --invert (or send negative polarity), or flip the")
        print("             receive software's image-invert / polarity setting.")
    else:
        print("             OK — the picture is transmitted as a positive image")


if __name__ == "__main__":
    sys.exit(main())
