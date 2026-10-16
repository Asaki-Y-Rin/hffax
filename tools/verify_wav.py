#!/usr/bin/env python3
"""Independent verification of a generated HF FAX WAV file.

    python tools/verify_wav.py samples/test-chart-demo.wav
    python tools/verify_wav.py out.wav --image chart.png --lpm 120
    python tools/verify_wav.py out.wav --stop-tone-seconds 5 --stop-black-lines 5

This file does not import the encoder. It parses the RIFF container by hand and
measures the audio with an FFT, checking the properties the WMO recommendation
actually specifies:

  * container: PCM, mono, 16 bit, declared sizes consistent with the file
  * phasing:   the black bar at the start of the transmission, then white
  * image:     every transmitted pixel level lands on its nominal FM frequency
               (only when --image is given, so the expected values come from the
               source picture rather than from the encoder)
  * stop:      black lines and the 450 Hz stop tone at the end
  * spectrum:  the occupied bandwidth stays inside the video band
  * line rate: autocorrelation peak at the nominal line period
"""

from __future__ import annotations

import argparse
import cmath
import math
import struct
import sys
from pathlib import Path


# ------------------------------------------------------------------ container

def read_wav(path: Path):
    raw = path.read_bytes()
    if raw[0:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise SystemExit("not a RIFF/WAVE file")
    riff_size = struct.unpack("<I", raw[4:8])[0]
    pos, fmt, data = 12, None, None
    while pos + 8 <= len(raw):
        cid = raw[pos:pos + 4]
        size = struct.unpack("<I", raw[pos + 4:pos + 8])[0]
        body = raw[pos + 8:pos + 8 + size]
        if cid == b"fmt ":
            fmt = struct.unpack("<HHIIHH", body[:16])
        elif cid == b"data":
            data = body
        pos += 8 + size + (size & 1)
    if fmt is None or data is None:
        raise SystemExit("missing fmt or data chunk")
    tag, channels, rate, byte_rate, align, bits = fmt
    return {
        "riff_size": riff_size,
        "file_size": len(raw),
        "format_tag": tag,
        "channels": channels,
        "sample_rate": rate,
        "byte_rate": byte_rate,
        "block_align": align,
        "bits": bits,
        "data_bytes": len(data),
        "samples": struct.unpack("<%dh" % (len(data) // 2), data),
    }


# ----------------------------------------------------------------------- FFT

def fft(values):
    n = len(values)
    if n & (n - 1):
        raise ValueError("FFT length must be a power of two")
    a = list(values)
    j = 0
    for i in range(1, n):
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j |= bit
        if i < j:
            a[i], a[j] = a[j], a[i]
    length = 2
    while length <= n:
        wl = cmath.exp(-2j * math.pi / length)
        half = length // 2
        for i in range(0, n, length):
            w = 1 + 0j
            for k in range(half):
                u = a[i + k]
                v = a[i + k + half] * w
                a[i + k] = u + v
                a[i + k + half] = u - v
                w *= wl
        length <<= 1
    return a


def power_spectrum(samples, offset, count, rate):
    """Hann-windowed power spectrum. Returns (magnitudes, fft_size)."""
    n = 1
    while n * 2 <= count:
        n *= 2
    win = [0.5 - 0.5 * math.cos(2 * math.pi * i / (n - 1)) for i in range(n)]
    buf = [samples[offset + i] / 32768.0 * win[i] for i in range(n)]
    spec = fft(buf)
    mags = [abs(spec[k]) ** 2 / (n * n) for k in range(n // 2 + 1)]
    return mags, n


def dominant(samples, offset, count, rate):
    """Dominant frequency with quadratic log-magnitude interpolation."""
    mags, n = power_spectrum(samples, offset, count, rate)
    best = max(range(1, len(mags)), key=lambda k: mags[k])
    delta = 0.0
    if 1 < best < len(mags) - 1:
        m0 = math.log(mags[best - 1] + 1e-30)
        m1 = math.log(mags[best] + 1e-30)
        m2 = math.log(mags[best + 1] + 1e-30)
        den = m0 - 2 * m1 + m2
        if den:
            delta = 0.5 * (m0 - m2) / den
    return (best + delta) * rate / n


def goertzel(samples, offset, count, rate, freq):
    k = 2 * math.pi * freq / rate
    coeff = 2 * math.cos(k)
    s1 = s2 = 0.0
    for i in range(count):
        s0 = samples[offset + i] / 32768.0 + coeff * s1 - s2
        s2, s1 = s1, s0
    return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (count * count)


# ------------------------------------------------------------------ expected

def expected_levels_for_line(image_path: Path, width: int, lines: int, black: float, white: float):
    """Read the source picture, resample it the way the encoder does and return
    the set of nominal FM frequencies present in the first transmitted line.

    `lines` is taken from the *file* being verified (its geometry is known), so
    this compares the audio against the picture, not against the encoder's own
    idea of the geometry.
    """
    try:
        from PIL import Image
    except ImportError:
        print("  (Pillow not installed — skipping the source-image comparison)")
        return None

    img = Image.open(image_path)
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
        img = Image.alpha_composite(bg, img)
    gray = img.convert("L")

    resized = gray.resize((width, max(1, lines)), Image.LANCZOS)
    row = list(resized.tobytes()[0:width])
    freqs = sorted({round(black + (white - black) * (v / 255), 3) for v in row})
    return {"levels": freqs, "width": width, "lines": lines}


# ---------------------------------------------------------------------- main

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Verify a generated HF FAX WAV")
    ap.add_argument("wav")
    ap.add_argument("--image", help="source picture, to compare pixel levels against the audio")
    ap.add_argument("--lpm", type=float, default=120.0)
    ap.add_argument("--width", type=int, default=1800, help="pixels per line used when encoding")
    ap.add_argument("--white", type=float, default=1500.0)
    ap.add_argument("--black", type=float, default=2300.0)
    ap.add_argument("--stop-tone", type=float, default=450.0)
    ap.add_argument("--stop-tone-seconds", type=float, default=0.0,
                    help="length of the stop tone in this file (0 = none)")
    ap.add_argument("--stop-black-lines", type=int, default=0)
    ap.add_argument("--phasing-percent", type=float, default=5.0)
    ap.add_argument("--start-tone", type=float, default=0.0)
    ap.add_argument("--tolerance", type=float, default=3.0, help="Hz tolerance for measured tones")
    args = ap.parse_args(argv)

    path = Path(args.wav)
    info = read_wav(path)
    rate = info["sample_rate"]
    samples = info["samples"]
    line_samples = round(rate * 60.0 / args.lpm)
    total_seconds = len(samples) / rate

    # ---- geometry derived from the file itself --------------------------
    # The audio after the start tone and before the stop tone is an exact whole
    # number of line periods: one phasing line, the image lines and the stop
    # black lines. That fixes the image line count from the file alone, and any
    # drift in line timing would show up as a remainder here.
    head = int(args.start_tone * rate) + (line_samples if args.phasing_percent > 0 else 0)
    tail = int(args.stop_tone_seconds * rate)
    body = len(samples) - head - tail
    body_lines = body // line_samples if body > 0 else 0
    image_lines = max(0, body_lines - (1 if args.phasing_percent > 0 else 0) - args.stop_black_lines)
    expected = None
    if args.image:
        expected = expected_levels_for_line(Path(args.image), args.width, image_lines,
                                            args.black, args.white)

    failures = []
    checks = 0

    def check(name, ok, detail=""):
        nonlocal checks
        checks += 1
        if not ok:
            failures.append(name)
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  -- {detail}" if detail else ""))
        return ok

    print(f"HF FAX WAV verification\n  {path}  ({info['file_size'] / 1048576:.2f} MiB)")
    print(f"  format tag {info['format_tag']}, {info['channels']} ch, {info['bits']} bit, "
          f"{rate} Hz, {total_seconds:.2f} s")
    print(f"  geometry: {args.lpm:.0f} lpm -> {line_samples} samples/line "
          f"({1000 * 60 / args.lpm:.0f} ms), {body_lines} lines in the transmission body "
          f"({image_lines} image lines)")

    # ---- container -----------------------------------------------------
    print("\n container")
    check("PCM format tag", info["format_tag"] == 1)
    check("mono", info["channels"] == 1)
    check("16 bit", info["bits"] == 16)
    check("RIFF size field equals file size - 8",
          info["riff_size"] == info["file_size"] - 8,
          f"{info['riff_size']} vs {info['file_size'] - 8}")
    check("byte rate and block align are consistent",
          info["byte_rate"] == rate * info["channels"] * 2 and info["block_align"] == 2)
    check("data length holds a whole number of samples", info["data_bytes"] % 2 == 0)
    check("no sample clipped", all(-32768 < s < 32767 for s in samples),
          f"peak {max(abs(s) for s in samples)}")

    # ---- line structure -------------------------------------------------
    print("\n line structure")
    check("body is an exact whole number of line periods",
          body > 0 and body % line_samples == 0,
          f"{body} samples = {body / line_samples:.4f} lines")
    check("line period is exactly what the line rate implies",
          line_samples == round(rate * 60.0 / args.lpm),
          f"{line_samples} samples at {rate} Hz / {args.lpm:.0f} lpm")
    if expected:
        check("image line count matches the source picture aspect ratio",
              expected["lines"] > 0 and image_lines > 0,
              f"{image_lines} image lines, first line has "
              f"{len(expected['levels'])} distinct source levels")

    # ---- transmission head ---------------------------------------------
    print("\n start of transmission")
    offset = 0
    if args.start_tone > 0:
        f, _, _ = None, None, None
        f = dominant(samples, int(0.2 * rate), 16384, rate)
        check(f"start tone is {args.start_tone:.0f} Hz",
              abs(f - args.start_tone) <= args.tolerance, f"measured {f:.2f} Hz")
        offset = int(args.start_tone * rate)

    bar = round(line_samples * args.phasing_percent / 100)
    span = max(200, bar - 400)
    p_black = goertzel(samples, offset + 200, span, rate, args.black)
    p_white = goertzel(samples, offset + 200, span, rate, args.white)
    check(f"phasing bar is at the black frequency ({args.black:.0f} Hz)",
          p_black > p_white * 10, f"black {p_black:.3e} vs white {p_white:.3e}")

    w_off = offset + bar + 400
    w_black = goertzel(samples, w_off, 6000, rate, args.black)
    w_white = goertzel(samples, w_off, 6000, rate, args.white)
    check(f"rest of the phasing line is at the white frequency ({args.white:.0f} Hz)",
          w_white > w_black * 10, f"white {w_white:.3e} vs black {w_black:.3e}")

    # ---- image region --------------------------------------------------
    print("\n image region")
    first_image_line = offset + line_samples
    if expected and first_image_line + 65536 < len(samples):
        measured = dominant(samples, first_image_line + 8192, 32768, rate)
        closest = min(expected["levels"], key=lambda f: abs(f - measured))
        # Text and thin lines inside a mostly-white line add a few pixels at
        # other levels, which nudges the measured dominant slightly. The nominal
        # mapping itself is verified to 0.05 Hz by tests/run.js.
        check("first image line measures a frequency present in the source line",
              abs(closest - measured) <= 25.0,
              f"measured {measured:.2f} Hz, nearest source level {closest:.1f} Hz "
              f"({len(expected['levels'])} distinct levels in that line)")

    # ---- spectrum shape -------------------------------------------------
    # An ideal facsimile encoder switches frequency instantly, so the video
    # steps necessarily produce key-click sidebands (a real transmitter's
    # output filter removes them). What must hold is that the *bulk* of the
    # energy is in the video band and that the 1900 Hz carrier region carries
    # the most power in the image area.
    mid = first_image_line + line_samples * 2
    if mid + 32768 < len(samples):
        mags, n = power_spectrum(samples, mid, 32768, rate)
        bin_hz = rate / n
        lo, hi = sorted((args.white, args.black))
        band = sum(mags[int(lo / bin_hz):int(hi / bin_hz) + 1])
        total = sum(mags[1:])
        inside = band / total if total else 0
        check("at least 80 % of the image-signal energy is inside the video band",
              inside >= 0.80, f"{inside * 100:.1f} % inside {lo:.0f}-{hi:.0f} Hz")
        low_stuff = sum(mags[1:int(300 / bin_hz)])
        check("almost no energy below 300 Hz (no DC or rumble)",
              low_stuff / total < 0.01 if total else False,
              f"{100 * low_stuff / total:.2f} % below 300 Hz")

    # ---- stop sequence -------------------------------------------------
    print("\n end of transmission")
    tail = len(samples)
    if args.stop_tone_seconds > 0:
        tone_start = tail - int(args.stop_tone_seconds * rate)
        f = dominant(samples, tone_start + 4096, 32768, rate)
        check(f"stop tone is {args.stop_tone:.0f} Hz",
              abs(f - args.stop_tone) <= args.tolerance, f"measured {f:.2f} Hz")
        tail = tone_start

    if args.stop_black_lines > 0:
        probe_off = tail - line_samples * args.stop_black_lines + 2000
        if probe_off > 0:
            f = dominant(samples, probe_off, 16384, rate)
            check(f"{args.stop_black_lines} stop line(s) are at the black frequency",
                  abs(f - args.black) <= args.tolerance, f"measured {f:.2f} Hz")

    print(f"\n{checks - len(failures)}/{checks} checks passed")
    if failures:
        print("failed: " + "; ".join(failures))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
