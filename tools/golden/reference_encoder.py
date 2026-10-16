#!/usr/bin/env python3
"""Independent reference implementation of the HF weather-fax encoder.

This file exists to *check* `src/hffax.js`. It was written from the WMO/IMO
description of the analogue facsimile signal, not by translating the
JavaScript line by line, and it must agree with the JavaScript output
byte for byte on the deterministic test vector in `tests/vectors/`.

Signal definition used here:
    video level 0..255  ->  frequency 1500 Hz (white) .. 2300 Hz (black)
    each pixel          ->  an unbroken, phase-continuous tone segment
    each line           ->  500 ms at 120 lpm
    phasing line        ->  5 % black bar followed by white, exactly one line
    stop sequence       ->  1 black line, then a 450 Hz tone

Usage:
    python reference_encoder.py                # run the built-in self check
    python reference_encoder.py --vector FILE  # use another test vector
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
from pathlib import Path

LUT_BITS = 16
LUT_SIZE = 1 << LUT_BITS      # 65536: see the note in src/hffax.js — a smaller
                              # table truncates fractional phase steps and
                              # aliases the video tones.
TWO_PI = math.pi * 2

# One period of the look-up table, plus the guard entry the JavaScript uses.
SIN = [math.sin(TWO_PI * i / LUT_SIZE) for i in range(LUT_SIZE + 1)]


def js_round(x: float) -> int:
    """Exactly ECMAScript's Math.round: ties go towards +Infinity.

    Python's built-in round() uses banker's rounding (round-half-to-even), which
    differs on negative half values — -0.5 rounds to 0 in JS but to 0 as well
    only through a different path, and -1.5 rounds to -1 in JS but to -2 in
    Python. Sample quantisation hits those ties constantly, so the reference
    has to use the same rule or the two encoders differ by one LSB.
    """
    return int(math.floor(x + 0.5))


class Encoder:
    def __init__(self, cfg, sink=None):
        self.cfg = cfg
        self.sink = sink
        self.phase = 0                 # integer LUT index accumulator
        self.bn = 0                    # samples pending in the block buffer
        self.block_samples = cfg["sink"]["blockSamples"]
        self.block = [0] * self.block_samples
        self.total = 0
        self.done = 0
        self.peak = 0.0
        self.clipped = 0

        # Luminance 0 is black and black is the *high* video frequency.
        black = cfg["blackHz"] if cfg["polarity"] == "positive" else cfg["whiteHz"]
        white = cfg["whiteHz"] if cfg["polarity"] == "positive" else cfg["blackHz"]
        self.level_hz = [black + (white - black) * v / 255 for v in range(256)]

        self.line_period = 60.0 / cfg["lineRateLpm"]
        self.samples_per_line = js_round(cfg["sampleRate"] * self.line_period)
        self.samples_per_pixel = cfg["sampleRate"] * self.line_period / cfg["width"]

    # -- output ----------------------------------------------------------
    def emit(self, values):
        gain = self.cfg["outputLevel"]
        for s in values:
            s *= gain
            a = abs(s)
            if a > self.peak:
                self.peak = a
            q = js_round(s * 32767)
            if q > 32767:
                q = 32767
                self.clipped += 1
            elif q < -32768:
                q = -32768
                self.clipped += 1
            self.block[self.bn] = q
            self.bn += 1
            if self.bn == self.block_samples:
                if self.sink is not None:
                    self.sink(struct.pack("<%dh" % self.bn, *self.block))
                self.done += self.bn
                self.bn = 0

    def constant(self, level, count, forced_hz=None):
        if count <= 0:
            return 0
        hz = forced_hz if forced_hz is not None else self.level_hz[level & 0xFF]
        # The phase step keeps its fractional part and only the table *index* is
        # truncated (index = floor(phase)), exactly like `SIN[phase|0]` does in
        # JavaScript. Truncating the step itself would detune the tone.
        step = hz * LUT_SIZE / self.cfg["sampleRate"]
        out = [0.0] * count
        p = self.phase
        for i in range(count):
            out[i] = SIN[int(p)]
            p += step
            if p >= LUT_SIZE:
                p -= LUT_SIZE
        self.phase = p
        self.emit(out)
        return count

    def phasing_line(self):
        n = self.samples_per_line
        black_px = max(1, js_round(self.cfg["width"] * self.cfg["phasingBlackPercent"] / 100))
        white_px = max(1, self.cfg["width"] - black_px)
        b1 = js_round(n * black_px / (black_px + white_px))
        b1 = min(max(b1, 1), n - 1)
        return self.constant(0, b1) + self.constant(255, n - b1)

    def image_line(self, row):
        out = []
        sps = self.samples_per_pixel
        prev = 0
        for x in range(self.cfg["width"]):
            end = js_round((x + 1) * sps)
            length = end - prev
            prev = end
            if length <= 0:
                continue
            step = self.level_hz[row[x]] * LUT_SIZE / self.cfg["sampleRate"]
            p = self.phase
            for _ in range(length):
                out.append(SIN[int(p)])
                p += step
                if p >= LUT_SIZE:
                    p -= LUT_SIZE
            self.phase = p
        self.emit(out)
        return len(out)

    def stop_sequence(self):
        total = 0
        for _ in range(self.cfg["stopBlackLines"]):
            total += self.constant(0, self.samples_per_line)
        if self.cfg["stopToneEnabled"] and self.cfg["stopToneSeconds"] > 0:
            total += self.constant(
                0, js_round(self.cfg["sampleRate"] * self.cfg["stopToneSeconds"]), self.cfg["stopToneHz"]
            )
        return total

    def run(self, image):
        cfg = self.cfg
        total = 0
        if cfg["startToneEnabled"] and cfg["startToneSeconds"] > 0:
            total += js_round(cfg["sampleRate"] * cfg["startToneSeconds"])
        if cfg["phasingEnabled"]:
            total += self.samples_per_line
        total += self.samples_per_line * image["height"]
        total += self.samples_per_line * cfg["stopBlackLines"]
        if cfg["stopToneEnabled"] and cfg["stopToneSeconds"] > 0:
            total += js_round(cfg["sampleRate"] * cfg["stopToneSeconds"])
        self.total = total

        if cfg["startToneEnabled"] and cfg["startToneSeconds"] > 0:
            self.constant(255, js_round(cfg["sampleRate"] * cfg["startToneSeconds"]), cfg["startToneHz"])
        if cfg["phasingEnabled"]:
            self.phasing_line()
        for y in range(image["height"]):
            base = y * image["width"]
            self.image_line(image["data"][base:base + image["width"]])
        self.stop_sequence()

        if self.bn > 0 and self.sink is not None:
            self.sink(struct.pack("<%dh" % self.bn, *self.block[: self.bn]))
            self.done += self.bn
            self.bn = 0

        return {
            "sampleRate": cfg["sampleRate"],
            "samples": self.done,
            "seconds": self.done / cfg["sampleRate"],
            "lines": image["height"],
            "peak": self.peak,
            "clipped": self.clipped,
            "totalSamplesDeclared": self.total,
        }


def goertzel_band(samples, offset, count, rate, freq):
    """One-frequency Goertzel power over a range of samples."""
    k = TWO_PI * freq / rate
    coeff = 2 * math.cos(k)
    s1 = s2 = 0.0
    for i in range(count):
        s0 = samples[offset + i] / 32768.0 + coeff * s1 - s2
        s2, s1 = s1, s0
    return s1 * s1 + s2 * s2 - coeff * s1 * s2


def dominant_level(raster: bytes) -> int:
    """Most common luminance value in the transmitted raster."""
    if not raster:
        return 127
    hist = [0] * 256
    for v in raster:
        hist[v] += 1
    return max(range(256), key=lambda v: hist[v])


def check_polarity(pcm, cfg, raster: bytes, image_start: int, image_end: int,
                   reference_luminance: float | None = None) -> dict:
    """Decide whether the transmission will look like a negative.

    Mirrors `checkPolarity()` in src/hffax.js: take the dominant level of the
    picture, measure the tone power there, compare it with the same power
    mirrored about the 1900 Hz carrier, and judge that against the brightness of
    the picture the user meant to send.

    The measurement is per line — the phase accumulator is continuous inside a
    line but restarts at each boundary, so a window spanning many lines cancels
    the tone.
    """
    rate = cfg["sampleRate"]
    line_samples = js_round(rate * 60.0 / cfg["lineRateLpm"])
    count = image_end - image_start
    if count < rate // 10:
        return {"inverted": None, "confidence": "low", "blackFraction": 0.5,
                "note": "the image region is too short to judge"}

    dom_level = dominant_level(raster)
    dom_hz = cfg["blackHz"] + (cfg["whiteHz"] - cfg["blackHz"]) * (dom_level / 255)
    inverse_hz = cfg["blackHz"] + cfg["whiteHz"] - dom_hz

    lines = max(1, min(len(raster) // (cfg["width"] or 1), count // line_samples))
    dom_power = mirror_power = 0.0
    for li in range(lines):
        off = image_start + li * line_samples
        length = min(line_samples, len(pcm) - off)
        if length < 64:
            break
        dom_power += goertzel_band(pcm, off, length, rate, dom_hz)
        mirror_power += goertzel_band(pcm, off, length, rate, inverse_hz)

    total = dom_power + mirror_power
    dom_share = dom_power / total if total > 0 else 0.5
    dom_is_black_side = dom_level < 127.5
    black_fraction = dom_share if dom_is_black_side else 1 - dom_share
    black_fraction = max(0.0, min(1.0, black_fraction))

    ref = reference_luminance
    if ref is None:
        ref = (sum(raster) / len(raster)) if raster else 127.5
    expected_positive = ref >= 127.5
    looks_negative = black_fraction > 0.5
    flat_mid_grey = abs(dom_level - 127.5) < 12
    confident = (not flat_mid_grey) and abs(dom_share - 0.5) > 0.05

    return {
        "inverted": (looks_negative == expected_positive) if confident else None,
        "confidence": "high" if confident else "low",
        "blackFraction": black_fraction,
        "dominantLevel": dom_level,
        "referenceLuminance": ref,
        "expectedPositive": expected_positive,
        "linesMeasured": lines,
        "note": "" if confident else "the picture is close to mid grey, so the sign is not decisive",
    }


def wav_header(data_bytes, sample_rate, channels=1):    return (
        b"RIFF"
        + struct.pack("<I", 36 + data_bytes)
        + b"WAVEfmt "
        + struct.pack("<IHHIIHH", 16, 1, channels, sample_rate, sample_rate * channels * 2, channels * 2, 16)
        + b"data"
        + struct.pack("<I", data_bytes)
    )


def encode_with_digest(cfg, image):
    digest = hashlib.sha256()
    collected = bytearray()

    def sink(data):
        digest.update(data)
        collected.extend(data)

    enc = Encoder(cfg, sink)
    stats = enc.run(image)
    stats["pcm_sha256"] = digest.hexdigest()
    body = bytes(collected)
    stats["pcm_bytes"] = len(body)
    stats["wav"] = wav_header(len(body), cfg["sampleRate"]) + body
    stats["wav_sha256"] = hashlib.sha256(stats["wav"]).hexdigest()
    return stats


def load_vector(path: Path):
    vec = json.loads(path.read_text(encoding="utf-8"))
    cfg = dict(vec["config"])
    cfg["sink"] = vec.get("sink", {"blockSamples": 1024})
    img = vec["image"]
    return vec, cfg, {
        "width": img["width"],
        "height": img["height"],
        "data": bytes.fromhex(img["data_hex"]),
    }


def self_check(vector_path: Path) -> int:
    vec, cfg, image = load_vector(vector_path)
    stats = encode_with_digest(cfg, image)
    exp = vec["expected"]

    problems = []
    if stats["lines"] != exp["lines"]:
        problems.append("lines %s != %s" % (stats["lines"], exp["lines"]))
    if stats["samples"] != exp["total_samples"]:
        problems.append("samples %s != %s" % (stats["samples"], exp["total_samples"]))
    if stats["clipped"]:
        problems.append("clipping detected: %d samples" % stats["clipped"])
    if stats["samples"] != stats["totalSamplesDeclared"]:
        problems.append(
            "declared %d samples but wrote %d" % (stats["totalSamplesDeclared"], stats["samples"])
        )

    print(json.dumps({k: stats[k] for k in
                      ("sampleRate", "samples", "seconds", "lines", "peak", "clipped",
                       "pcm_bytes", "pcm_sha256", "wav_sha256")}, indent=2))
    if problems:
        print("FAIL")
        for p in problems:
            print("  -", p)
        return 1
    print("PASS (structure)")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="HF FAX Python golden reference encoder")
    ap.add_argument("--vector", default=str(Path(__file__).resolve().parents[2] / "tests" / "vectors" / "basic_ioc576.json"))
    ap.add_argument("--write-expected", action="store_true",
                    help="update the expected hashes in the vector file")
    ap.add_argument("--emit-json", action="store_true",
                    help="print the full result as JSON (used by tests/run.js)")
    args = ap.parse_args(argv)

    vector_path = Path(args.vector)
    if args.write_expected:
        vec, cfg, image = load_vector(vector_path)
        stats = encode_with_digest(cfg, image)
        lines = image["height"]
        exp = vec["expected"]
        exp["lines"] = lines
        exp["samples_per_line"] = js_round(stats["sampleRate"] * 60 / cfg["lineRateLpm"])
        exp["phasing_samples"] = exp["samples_per_line"] if cfg["phasingEnabled"] else 0
        exp["image_samples"] = exp["samples_per_line"] * lines
        exp["stop_black_samples"] = exp["samples_per_line"] * cfg["stopBlackLines"]
        exp["stop_tone_samples"] = (
            js_round(stats["sampleRate"] * cfg["stopToneSeconds"]) if cfg["stopToneEnabled"] else 0
        )
        exp["total_samples"] = stats["samples"]
        exp["pcm_bytes"] = stats["pcm_bytes"]
        exp["peak"] = stats["peak"]
        exp["pcm_sha256"] = stats["pcm_sha256"]
        vector_path.write_text(json.dumps(vec, indent=2) + "\n", encoding="utf-8")
        print("wrote expected values into", vector_path)
        return 0

    if args.emit_json:
        _, cfg, image = load_vector(vector_path)
        stats = encode_with_digest(cfg, image)
        stats.pop("wav", None)          # too large to serialise
        print(json.dumps(stats))
        return 0

    return self_check(vector_path)


if __name__ == "__main__":
    sys.exit(main())
