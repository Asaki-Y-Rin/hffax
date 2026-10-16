#!/usr/bin/env python3
"""Decode a generated HF FAX WAV back into an image (round-trip check).

    python tools/faxdecode.py samples/test-chart-demo.wav --width 720
    python tools/faxdecode.py out.wav --out decoded.png --compare chart.png

This is independent of the encoder's FM formula. It estimates the instantaneous
frequency of the audio with a Hilbert-transform phase derivative, converts
frequency back to a 0-255 video level using the WMO mapping (1500 Hz = white,
2300 Hz = black) and lays the samples out as lines. With --compare it also
reports the pixel error against the source picture, which is the actual
round-trip proof: the encoder put the image on the air in the format a receiver
expects.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from wavutil import frequencies_to_luminance, read_wav  # noqa: E402


def instantaneous_frequency(samples, rate: int, carrier: float = 1900.0,
                            lpf_hz: float = 700.0):
    """Per-sample instantaneous frequency of an FM facsimile signal.

    Quadrature demodulation around the sub-carrier: multiply by cos/sin of the
    carrier, low-pass both products to get the in-phase and quadrature baseband
    terms, then differentiate the phase. This is what an FM discriminator does
    and it makes no assumption about how the file was produced.

    The low-pass is two cascaded one-pole sections applied in both directions
    (zero phase). A single 1200 Hz pole is *not* enough: the 2*1900 = 3800 Hz
    image of the sub-carrier survives it, and because the phase derivative is
    non-linear that image makes the estimate alternate between two values a few
    hundred Hz apart from sample to sample. Two poles at 700 Hz put the image
    ~25 dB down while staying well above the 400 Hz video deviation.
    """
    n = len(samples)
    w = 2 * math.pi * carrier / rate
    a = 1 - math.exp(-2 * math.pi * lpf_hz / rate)

    i_f = [0.0] * n
    q_f = [0.0] * n
    acc_i = acc_q = 0.0
    for k in range(n):
        v = samples[k] / 32768.0
        acc_i += a * (v * math.cos(w * k) - acc_i)
        acc_q += a * (v * math.sin(w * k) - acc_q)
        i_f[k] = acc_i
        q_f[k] = acc_q

    # Second pole forward, then two poles backward: the cascaded response rolls
    # off at 12 dB/octave and the backward passes keep it zero-phase.
    for _ in range(1):
        for arr in (i_f, q_f):
            prev = 0.0
            for k in range(n):
                prev += a * (arr[k] - prev)
                arr[k] = prev

    # Two poles, backward, for a zero-phase result.
    for _ in range(2):
        for arr in (i_f, q_f):
            prev = 0.0
            for k in range(n - 1, -1, -1):
                prev += a * (arr[k] - prev)
                arr[k] = prev

    phases = [math.atan2(q_f[k], i_f[k]) for k in range(n)]
    two_pi = 2 * math.pi
    freqs = [carrier]
    for k in range(1, n):
        d = phases[k] - phases[k - 1]
        while d > math.pi:
            d -= two_pi
        while d < -math.pi:
            d += two_pi
        # The sign is fixed so that a higher audio frequency means a higher
        # video level *frequency* (black), i.e. the discriminator output is
        # +400 Hz for black and -400 Hz for white.
        freqs.append(carrier - d * rate / two_pi)
    return freqs


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Decode a HF FAX WAV back into a PNG")
    ap.add_argument("wav")
    ap.add_argument("--out", help="output PNG (default: <wav>-decoded.png)")
    ap.add_argument("--width", type=int, default=720,
                    help="pixels per line used when encoding (sets the pixel clock)")
    ap.add_argument("--decode-width", type=int, default=0,
                    help="output pixels per line (default: same as --width)")
    ap.add_argument("--lpm", type=float, default=120.0)
    ap.add_argument("--white", type=float, default=1500.0)
    ap.add_argument("--black", type=float, default=2300.0)
    ap.add_argument("--rows", type=int, default=0, help="limit decoded image lines (0 = all)")
    ap.add_argument("--start-tone", type=float, default=0.0)
    ap.add_argument("--stop-tone", type=float, default=0.0)
    ap.add_argument("--compare", help="source picture, to report the round-trip pixel error")
    ap.add_argument("--smooth", type=int, default=8,
                    help="averaging window in samples for the frequency estimate")
    ap.add_argument("--debug", action="store_true", help="dump per-row signal statistics")
    args = ap.parse_args(argv)

    try:
        from PIL import Image
    except ImportError:
        raise SystemExit("Pillow is required: pip install pillow")

    src = Path(args.wav)
    out = Path(args.out) if args.out else src.with_name(src.stem + "-decoded.png")

    info = read_wav(src)
    rate = info["sample_rate"]
    pcm = info["samples"]
    line_period = 60.0 / args.lpm
    # Integer sample counts: the encoder writes round(fs * linePeriod) samples
    # per line, and `head` must be an int or the sub-pixel offsets below are
    # silently truncated to the same sample for every pixel.
    samples_per_line = round(rate * line_period)
    out_width = args.decode_width or args.width      # output raster width

    print(f"{src}: {rate} Hz, {len(pcm)} samples, {len(pcm) / rate:.2f} s")
    print("demodulating (quadrature discriminator, zero-phase low-pass)…")
    # NOTE: keep the demodulated track in its own name — reusing `pcm` here
    # silently replaces the audio and produces a plausible but wrong picture.
    inst = instantaneous_frequency(pcm, rate)

    # Average the per-sample estimate over each output-pixel window. Everything
    # here must be in *samples*: the pixel advance is samples_per_line/out_width
    # (33 samples at 720 px/line and 48 kHz), not a fraction of one sample.
    head = int(args.start_tone * rate) + samples_per_line      # start tone + phasing
    available = (len(pcm) - head - int(args.stop_tone * rate)) // samples_per_line
    rows = args.rows if args.rows else max(0, available)
    out_pixel = samples_per_line / out_width
    print(f"decoding {rows} image lines x {out_width} px "
          f"({out_pixel * 1000 / rate:.3f} ms per output pixel, "
          f"{out_pixel:.2f} samples, source {args.width} px/line)")

    half = max(1, int(round(out_pixel / 8)))
    freqs = []
    for y in range(rows):
        base = head + y * samples_per_line
        for x in range(out_width):
            center = int(round(base + (x + 0.5) * out_pixel))
            lo = max(0, center - half)
            hi = min(len(inst), center + half)
            if hi <= lo:
                freqs.append(freqs[-1] if freqs else args.white)
                continue
            freqs.append(sum(inst[lo:hi]) / (hi - lo))

    lum = frequencies_to_luminance(freqs, args.white, args.black)
    if args.debug:
        print(f"DEBUG: freqs {len(freqs)} values, first 12 per row:")
        for y in (0, 200, 400):
            seg = freqs[y * out_width:(y + 1) * out_width][:12]
            lseg = lum[y * out_width:(y + 1) * out_width][:12]
            print(f"  freqs row {y}: " + " ".join(f"{v:.0f}" for v in seg))
            print(f"  lum   row {y}: " + " ".join(f"{v:.0f}" for v in lseg))
    img = Image.new("L", (out_width, rows), 255)
    px = img.load()
    for i, v in enumerate(lum):
        y, x = divmod(i, out_width)
        if y >= rows:
            break
        px[x, y] = int(round(v))
    img.save(out)
    print(f"wrote {out}  ({out_width} x {rows})")

    # ---- round-trip error against the source picture -------------------
    if args.compare:
        source = Image.open(args.compare).convert("L")
        # Reproduce the encoder's geometry: keep the aspect ratio, one line per
        # transmitted line, out_width pixels per line.
        ref = source.resize((out_width, rows), Image.LANCZOS)
        a = list(ref.tobytes())
        b = list(img.tobytes())
        diff = [abs(x - y) for x, y in zip(a, b)]
        rms = math.sqrt(sum(d * d for d in diff) / len(diff))
        mean = sum(diff) / len(diff)
        worst = max(diff)
        close = sum(1 for d in diff if d <= 24) / len(diff)
        print(f"\nround trip vs {args.compare}")
        print(f"  RMS error        {rms:6.2f} / 255  ({100 * rms / 255:.2f} %)")
        print(f"  mean abs error   {mean:6.2f} / 255")
        print(f"  worst pixel      {worst}")
        print(f"  pixels within 24 levels (10 %): {100 * close:.1f} %")
        side_by_side = out.with_name(out.stem + "-vs-source.png")
        combo = Image.new("L", (out_width * 2 + 20, rows), 60)
        combo.paste(ref, (0, 0))
        combo.paste(img, (out_width + 20, 0))
        combo.save(side_by_side)
        print(f"  side-by-side: {side_by_side}  (left = source, right = decoded)")
        return 0 if rms < 30 else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
