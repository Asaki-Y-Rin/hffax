#!/usr/bin/env python3
"""Shared helpers for the HF FAX tool suite.

Kept dependency-free on purpose (no numpy): these functions read the generated
WAV files and measure them, so they must run wherever the encoder runs.
"""

from __future__ import annotations

import cmath
import math
import struct
from pathlib import Path


# ------------------------------------------------------------------ container

def read_wav(path: Path) -> dict:
    """Parse a RIFF/WAVE file by hand. Raises SystemExit on anything unexpected."""
    raw = Path(path).read_bytes()
    if len(raw) < 44 or raw[0:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise SystemExit(f"not a RIFF/WAVE file: {path}")
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
        raise SystemExit(f"missing fmt or data chunk: {path}")
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
    """In-place iterative radix-2 FFT (returns the transformed list)."""
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


def power_spectrum(samples, offset: int, count: int, rate: int):
    """Hann-windowed power spectrum. Returns (magnitudes, fft_size)."""
    n = 1
    while n * 2 <= count:
        n *= 2
    win = [0.5 - 0.5 * math.cos(2 * math.pi * i / (n - 1)) for i in range(n)]
    buf = [samples[offset + i] / 32768.0 * win[i] for i in range(n)]
    spec = fft(buf)
    mags = [abs(spec[k]) ** 2 / (n * n) for k in range(n // 2 + 1)]
    return mags, n


def dominant(samples, offset: int, count: int, rate: int) -> float:
    """Dominant frequency, refined by quadratic interpolation in log magnitude."""
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


def goertzel(samples, offset: int, count: int, rate: int, freq: float) -> float:
    """Power at one frequency (Goertzel), normalised by the sample count."""
    k = 2 * math.pi * freq / rate
    coeff = 2 * math.cos(k)
    s1 = s2 = 0.0
    for i in range(count):
        s0 = samples[offset + i] / 32768.0 + coeff * s1 - s2
        s2, s1 = s1, s0
    return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (count * count)


def frequencies_to_luminance(freqs, white: float, black: float, clip: bool = True):
    """Inverse of the WMO mapping: 1500 Hz -> 255 (white), 2300 Hz -> 0 (black)."""
    span = black - white
    if span == 0:
        raise ValueError("white and black frequencies must differ")
    out = []
    for f in freqs:
        v = (black - f) / span * 255.0
        out.append(max(0.0, min(255.0, v)) if clip else v)
    return out
