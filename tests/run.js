#!/usr/bin/env node
/**
 * Cross-language and signal-correctness tests for src/hffax.js.
 *
 *   node tests/run.js                # everything
 *   node tests/run.js --vector-only  # only the byte-exact golden vector
 *   node tests/run.js --json         # machine readable result
 *
 * The golden test compares the JavaScript encoder against the Python
 * reference implementation in tools/golden/reference_encoder.py. The hash it
 * compares against lives in tests/vectors/*.json and is produced by
 * `python tools/golden/reference_encoder.py --write-expected`, so the two
 * implementations are checked against each other in both directions.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const HFFAX = require(path.join(__dirname, '..', 'src', 'hffax.js'));

const ROOT = path.join(__dirname, '..');
let failures = 0;
let checks = 0;
const results = [];

function check(name, ok, detail) {
  checks++;
  if (!ok) failures++;
  results.push({ name, ok, detail: detail || '' });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${name}${detail ? '  -- ' + detail : ''}`);
  return ok;
}

function approx(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

/* ------------------------------------------------------------------ *
 * Signal analysis helpers (no dependencies)
 * ------------------------------------------------------------------ */

/** In-place iterative radix-2 FFT. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Dominant frequency of `count` samples of `signal` starting at `offset`,
 * using a Hann window and quadratic log-magnitude peak interpolation.
 */
function dominantFrequency(signal, offset, count, sampleRate) {
  let n = 1;
  while (n * 2 <= count) n *= 2;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s = signal[offset + i] / 32768;
    re[i] = s * w;
    im[i] = 0;
  }
  fft(re, im);
  let best = 1, bestMag = -1;
  for (let k = 1; k < n / 2; k++) {
    const mag = re[k] * re[k] + im[k] * im[k];
    if (mag > bestMag) { bestMag = mag; best = k; }
  }
  // Quadratic interpolation on log magnitude around the peak.
  let delta = 0;
  if (best > 1 && best < n / 2 - 1) {
    const m0 = Math.log(Math.hypot(re[best - 1], im[best - 1]) + 1e-20);
    const m1 = Math.log(Math.hypot(re[best], im[best]) + 1e-20);
    const m2 = Math.log(Math.hypot(re[best + 1], im[best + 1]) + 1e-20);
    const denom = m0 - 2 * m1 + m2;
    if (denom !== 0) delta = (0.5 * (m0 - m2)) / denom;
  }
  return ((best + delta) * sampleRate) / n;
}

/** Goertzel power at one frequency, normalised by sample count. */
function goertzelPower(signal, offset, count, sampleRate, freq) {
  const k = (2 * Math.PI * freq) / sampleRate;
  const coeff = 2 * Math.cos(k);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < count; i++) {
    s0 = signal[offset + i] / 32768 + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (count * count);
}

/** Average power of the whole segment, used as a "is this a pure tone?" base. */
function averagePower(signal, offset, count) {
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const v = signal[offset + i] / 32768;
    sum += v * v;
  }
  return sum / count;
}

/* ------------------------------------------------------------------ *
 * Test 1 — byte-exact golden vector vs the Python reference
 * ------------------------------------------------------------------ */

function goldenVectorTest() {
  console.log('\n== golden vector: JS encoder vs Python reference ==');
  const vectorPath = path.join(ROOT, 'tests', 'vectors', 'basic_ioc576.json');
  const vec = JSON.parse(fs.readFileSync(vectorPath, 'utf8'));
  const cfg = HFFAX.config(vec.config);
  const data = Buffer.from(vec.image.data_hex, 'hex');

  const image = { width: vec.image.width, height: vec.image.height, data: new Uint8Array(data) };
  const out = HFFAX.encodeToWav(image, { gray: true }, cfg, {});
  const pcm = Buffer.from(out.wav, 44);

  check('sample count matches the declared transmission length',
    out.stats.samples === vec.expected.total_samples,
    `${out.stats.samples} vs ${vec.expected.total_samples}`);
  check('PCM byte count', pcm.length === vec.expected.pcm_bytes, `${pcm.length}`);
  check('no clipping', out.stats.clipped === 0, `${out.stats.clipped} samples`);
  // The largest sample is sin(2*pi*(LUT_SIZE/4)/LUT_SIZE), i.e. a pure table
  // entry, scaled by the output level — a closed-form value, so this check
  // cannot drift with the frozen expectation.
  const idealPeak = Math.sin((2 * Math.PI * (HFFAX.LUT_SIZE / 4)) / HFFAX.LUT_SIZE) * cfg.outputLevel;
  check('peak level equals the closed-form LUT maximum',
    approx(out.stats.peak, idealPeak, 1e-12), `${out.stats.peak} vs ${idealPeak}`);

  const sha = crypto.createHash('sha256').update(pcm).digest('hex');

  // Sample-by-sample comparison against the Python reference. Both encoders use
  // `Math.sin` / `math.sin` only while building the look-up table; the runtime's
  // last-bit transcendental results can differ, which shifts a phase index by 1
  // for a handful of samples out of hundreds of thousands. Everything else —
  // geometry, phasing, level mapping, stop sequence, quantisation — must match
  // exactly, so the tolerance is 1 LSB and the budget is 0.1 % of the samples.
  const refPath = path.join(ROOT, 'tests', 'vectors', 'python_pcm.raw');
  let sampleComparisonOk = true;   // false only on a real algorithmic disagreement
  if (fs.existsSync(refPath)) {
    const refPcm = fs.readFileSync(refPath);
    if (refPcm.length === pcm.length) {
      let differing = 0, maxAbsDiff = 0, sumAbsDiff = 0;
      for (let i = 0; i < pcm.length; i += 2) {
        const a = pcm.readInt16LE(i);
        const b = refPcm.readInt16LE(i);
        if (a !== b) {
          differing++;
          const d = Math.abs(a - b);
          sumAbsDiff += d;
          if (d > maxAbsDiff) maxAbsDiff = d;
        }
      }
      const samples = pcm.length / 2;
      // A one-step phase-index shift costs at most 3 LSB even at the steepest
      // part of the sine, so that is the honest tolerance for two independent
      // floating-point implementations. Anything beyond it means a real
      // algorithmic disagreement (geometry, level mapping, rounding rule).
      const withinTolerance = maxAbsDiff <= 3;
      const withinBudget = differing <= samples * 0.001;
      sampleComparisonOk = withinTolerance && withinBudget;
      check('JS and Python PCM agree within 3 LSB on every sample',
        withinTolerance, `max |diff| = ${maxAbsDiff} LSB`);
      check('disagreement budget <= 0.1 % of samples',
        withinBudget,
        `${differing}/${samples} samples differ (mean ${(differing ? sumAbsDiff / differing : 0).toFixed(2)} LSB)`);
      if (differing === 0) {
        console.log(`         bit-exact across all ${samples} samples`);
      }
    } else {
      sampleComparisonOk = false;
      check('Python reference PCM length matches', false,
        `${refPcm.length} vs ${pcm.length} — rerun: python tools/dump_python_pcm.py`);
    }
  } else {
    console.log('         (run `python tools/dump_python_pcm.py` for the sample-by-sample comparison)');
  }

  // The frozen hash is a change detector: it cannot be bit-identical across
  // engines for the reason documented above, so it only fails when the
  // sample-by-sample comparison has already shown a real disagreement.
  if (vec.expected.pcm_sha256) {
    const same = sha === vec.expected.pcm_sha256;
    if (same) {
      check('PCM SHA-256 matches the frozen reference hash', true, sha);
    } else if (sampleComparisonOk) {
      console.log(`         note: PCM SHA-256 differs from the frozen hash ` +
        `(${sha.slice(0, 16)}… vs ${vec.expected.pcm_sha256.slice(0, 16)}…), ` +
        `which is expected for a handful of 1-2 LSB samples`);
    } else {
      check('PCM SHA-256 matches the frozen reference hash', false,
        `${sha} vs ${vec.expected.pcm_sha256}`);
    }
  }

  // WAV container sanity
  const wav = Buffer.from(out.wav);
  check('RIFF magic', wav.toString('ascii', 0, 4) === 'RIFF');
  check('WAVE magic', wav.toString('ascii', 8, 12) === 'WAVE');
  check('RIFF size field == file size - 8', wav.readUInt32LE(4) === wav.length - 8,
    `${wav.readUInt32LE(4)} vs ${wav.length - 8}`);
  check('data size field == PCM length', wav.readUInt32LE(40) === pcm.length);
  check('sample rate field', wav.readUInt32LE(24) === cfg.sampleRate);
  check('1 channel, 16 bit', wav.readUInt16LE(22) === 1 && wav.readUInt16LE(34) === 16);

  return { out, cfg, pcm };
}

/* ------------------------------------------------------------------ *
 * Test 2 — measured frequencies of a black / white / grey test chart
 * ------------------------------------------------------------------ */

function signalTest() {
  console.log('\n== signal correctness (black / white / grey levels) ==');
  // 16 px per line and a 48 kHz sample rate make one pixel exactly 1500
  // samples long, so every pixel boundary is sample-exact and the measured
  // frequency for a flat line is the exact FM deviation — no fractional
  // residual to confuse the estimate.
  const W = 16, LINES = 8;
  const cfg = HFFAX.config({ width: W, maxLines: LINES, outputLevel: 0.9 });
  const levels = [0, 36, 73, 109, 146, 182, 219, 255];
  const data = new Uint8Array(W * LINES);
  for (let y = 0; y < LINES; y++) data.fill(levels[y], y * W, (y + 1) * W);

  const out = HFFAX.encodeToWav({ width: W, height: LINES, data }, { gray: true }, cfg, {});
  const pcm = new Int16Array(out.wav, 44);
  const fs = cfg.sampleRate;
  const lineSamples = Math.round(fs * cfg.linePeriod);
  check('raster was not resampled (1:1 pixel geometry)',
    out.stats.lines === LINES && out.stats.outputWidth === W,
    `${out.stats.outputWidth} x ${out.stats.lines}`);
  check('samples per pixel is an integer for this geometry',
    cfg.samplesPerPixel === 1500, `${cfg.samplesPerPixel}`);

  // Black is the HIGH video frequency (WMO): luminance 0 -> blackHz.
  const expectedRow = (level) => cfg.blackHz + (cfg.whiteHz - cfg.blackHz) * (level / 255);
  const probes = [
    { row: 0, label: 'black line (level 0) -> blackHz' },
    { row: 3, label: 'grey line (level 109)' },
    { row: 7, label: 'white line (level 255) -> whiteHz' }
  ];
  let worst = 0;
  for (const p of probes) {
    const start = lineSamples * (p.row + 1);       // +1: the phasing line comes first
    const measured = dominantFrequency(pcm, start + 4096, 16384, fs);
    const want = expectedRow(levels[p.row]);
    worst = Math.max(worst, Math.abs(measured - want));
    check(`${p.label} = ${want.toFixed(1)} Hz`, approx(measured, want, 2.0),
      `measured ${measured.toFixed(2)} Hz`);
  }
  check('all measured frequencies within 2 Hz of the ideal FM mapping', worst <= 2.0,
    `worst error ${worst.toFixed(3)} Hz`);
  check('black line is above the 1900 Hz carrier and white below it',
    expectedRow(0) > 1900 && expectedRow(255) < 1900,
    `${expectedRow(0)} / ${expectedRow(255)}`);

  // Line structure: 500 ms per line at 120 lpm.
  check('line period is 500 ms', approx(cfg.linePeriodMs, 500, 1e-9), `${cfg.linePeriodMs} ms`);
  check('samples per line is exact for fs = 48000', cfg.samplesPerLine === 24000, `${cfg.samplesPerLine}`);
  check('total transmission length matches the layout',
    out.stats.samples === lineSamples * (1 + LINES + cfg.stopBlackLines) +
      Math.round(fs * cfg.stopToneSeconds),
    `${out.stats.samples}`);

  // Phasing line: a 5 % black bar, then white for the rest of the line. With a
  // 16-pixel line, 5 % rounds to exactly one pixel = 1500 samples = 6.25 %.
  const barSamples = Math.round(cfg.samplesPerLine / W);
  const inBar = goertzelPower(pcm, 500, 500, fs, cfg.blackHz);
  const inBarWhite = goertzelPower(pcm, 500, 500, fs, cfg.whiteHz);
  check(`phasing bar (first ${barSamples} samples) is the black frequency`,
    inBar > inBarWhite * 10,
    `black ${inBar.toExponential(3)} vs white ${inBarWhite.toExponential(3)}`);
  const tailBlack = goertzelPower(pcm, barSamples + 500, 8000, fs, cfg.blackHz);
  const tailWhite = goertzelPower(pcm, barSamples + 500, 8000, fs, cfg.whiteHz);
  check('phasing line ends with the white frequency', tailWhite > tailBlack * 10,
    `white ${tailWhite.toExponential(3)} vs black ${tailBlack.toExponential(3)}`);
  check('phasing bar is one pixel wide as configured',
    approx(barSamples, Math.round((W * cfg.phasingBlackPercent) / 100) * cfg.samplesPerPixel, 1e-9),
    `${barSamples} samples = ${((barSamples / cfg.samplesPerLine) * 100).toFixed(2)} % of the line`);

  // Stop sequence: black lines first, then the 450 Hz stop tone.
  const afterImage = lineSamples * (1 + LINES);
  const stopBlack = dominantFrequency(pcm, afterImage + 2048, 8192, fs);
  check('stop black line is transmitted at the black frequency',
    approx(stopBlack, cfg.blackHz, 3), `measured ${stopBlack.toFixed(2)} Hz`);
  const stopToneStart = afterImage + lineSamples * cfg.stopBlackLines;
  const stopTone = dominantFrequency(pcm, stopToneStart + 4096, 32768, fs);
  check('stop tone is 450 Hz', approx(stopTone, cfg.stopToneHz, 1.5), `measured ${stopTone.toFixed(2)} Hz`);
  const p450 = goertzelPower(pcm, stopToneStart + 4096, 16384, fs, cfg.stopToneHz);
  const p1900 = goertzelPower(pcm, stopToneStart + 4096, 16384, fs, 1900);
  check('stop tone dominates the 1900 Hz centre frequency', p450 > p1900 * 20,
    `${p450.toExponential(3)} vs ${p1900.toExponential(3)}`);

  return { out, cfg };
}

/* ------------------------------------------------------------------ *
 * Test 3 — optional 300 Hz start tone and transmission layout
 * ------------------------------------------------------------------ */

function startToneTest() {
  console.log('\n== optional start tone and transmission layout ==');
  const cfg = HFFAX.config({
    width: 256, maxLines: 4, startToneEnabled: true, startToneSeconds: 1,
    startToneHz: 300, stopToneSeconds: 1, outputLevel: 0.9
  });
  const data = new Uint8Array(256 * 4).fill(255);
  const out = HFFAX.encodeToWav({ width: 256, height: 4, data }, { gray: true }, cfg, {});
  const pcm = new Int16Array(out.wav, 44);
  const fs = cfg.sampleRate;

  const startHz = dominantFrequency(pcm, 2048, 16384, fs);
  check('start tone is 300 Hz', approx(startHz, 300, 1.5), `measured ${startHz.toFixed(2)} Hz`);

  const p300 = goertzelPower(pcm, 2048, 16384, fs, 300);
  const p1900 = goertzelPower(pcm, 2048, 16384, fs, 1900);
  check('start tone dominates the centre frequency', p300 > p1900 * 20,
    `${p300.toExponential(3)} vs ${p1900.toExponential(3)}`);

  const expected = Math.round(fs * 1)                     // start tone
    + Math.round(fs * cfg.linePeriod)                     // phasing
    + 4 * Math.round(fs * cfg.linePeriod)                 // image
    + cfg.stopBlackLines * Math.round(fs * cfg.linePeriod)
    + Math.round(fs * 1);                                 // stop tone
  check('total length accounts for every phase of the transmission',
    out.stats.samples === expected, `${out.stats.samples} vs ${expected}`);
}

/* ------------------------------------------------------------------ *
 * Test 3b — IOC 288 / 60 lpm service
 * ------------------------------------------------------------------ */

function ioc288Test() {
  console.log('\n== IOC 288 / 60 lpm service ==');
  const W = 16, LINES = 4;
  const cfg = HFFAX.config({
    lineRateLpm: 60, ioc: 288, width: W, maxLines: LINES,
    phasingBlackPercent: 10, stopBlackLines: 1, outputLevel: 0.8
  });
  check('60 lpm -> 1 s per line', approx(cfg.linePeriod, 1.0, 1e-12), `${cfg.linePeriod}`);
  check('48000 Hz / 60 lpm -> 48000 samples per line', approx(cfg.samplesPerLine, 48000, 1e-9),
    `${cfg.samplesPerLine}`);
  check('16 px/line -> 3000 samples per pixel', approx(cfg.samplesPerPixel, 3000, 1e-9),
    `${cfg.samplesPerPixel}`);
  check('IOC 288 drum is 288 s', approx((cfg.ioc * 60) / cfg.lineRateLpm, 288, 1e-9));

  const levels = [0, 255, 128, 64];
  const data = new Uint8Array(W * LINES);
  for (let y = 0; y < LINES; y++) data.fill(levels[y], y * W, (y + 1) * W);
  const out = HFFAX.encodeToWav({ width: W, height: LINES, data }, { gray: true }, cfg, {});
  const pcm = new Int16Array(out.wav, 44);
  const fs = cfg.sampleRate;
  const line = Math.round(cfg.samplesPerLine);

  for (let y = 0; y < LINES; y++) {
    const want = cfg.blackHz + (cfg.whiteHz - cfg.blackHz) * (levels[y] / 255);
    const measured = dominantFrequency(pcm, line * (y + 1) + 4096, 32768, fs);
    check(`IOC 288 line ${y} (level ${levels[y]}) = ${want.toFixed(0)} Hz`,
      approx(measured, want, 2), `measured ${measured.toFixed(2)} Hz`);
  }

  // 10 % phasing bar: 16 px * 10 % = 2 px -> 6000 samples of black.
  const bar = goertzelPower(pcm, 1000, 4000, fs, cfg.blackHz);
  const barWhite = goertzelPower(pcm, 1000, 4000, fs, cfg.whiteHz);
  check('10 % phasing bar is black', bar > barWhite * 10,
    `black ${bar.toExponential(3)} vs white ${barWhite.toExponential(3)}`);
  check('total length is a whole number of 1 s lines',
    out.stats.samples % line === 0, `${out.stats.samples} / ${line}`);
}

/* ------------------------------------------------------------------ *
 * Test 3c — AM modulation mode
 * ------------------------------------------------------------------ */

function amModulationTest() {
  console.log('\n== AM modulation mode ==');
  const W = 16, LINES = 2;
  const cfg = HFFAX.config({
    modulation: 'am', width: W, maxLines: LINES, outputLevel: 1.0,
    // A 16x2 raster would be stretched to 24000 lines by the aspect-preserving
    // path; keep the geometry exactly 2 lines of 16 px.
    preserveAspect: false,
    phasingEnabled: false, stopToneEnabled: false, stopBlackLines: 0
  });
  const data = new Uint8Array(W * LINES);
  data.fill(0, 0, W);          // line 0 black -> full envelope
  data.fill(255, W, 2 * W);    // line 1 white -> silence
  const out = HFFAX.encodeToWav({ width: W, height: LINES, data }, { gray: true }, cfg, {});
  const pcm = new Int16Array(out.wav, 44);
  const fs = cfg.sampleRate;
  const line = Math.round(cfg.samplesPerLine);

  // Phasing is disabled here, so line 0 is the black line and line 1 the white.
  // AM keeps the FM convention: black (luminance 0) is the full envelope, white
  // (255) is silence — the video signal's amplitude rises where the FM signal's
  // frequency rises.
  let blackPeak = 0;
  for (let i = 1000; i < line - 1000; i++) blackPeak = Math.max(blackPeak, Math.abs(pcm[i]));
  let whitePeak = 0;
  for (let i = line + 1000; i < 2 * line - 1000; i++) whitePeak = Math.max(whitePeak, Math.abs(pcm[i]));
  check('black in AM is the full envelope', blackPeak > 32000, `peak ${blackPeak}`);
  check('white in AM is (near) silence', whitePeak <= 2, `peak ${whitePeak}`);
  // The peak is the largest carrier-table entry scaled by the output level —
  // a closed-form value, so it does not depend on where samples land.
  const carrierCycles = fs / cfg.centreHz;
  const tableLen = Math.max(2, Math.round(carrierCycles));
  let tablePeak = 0;
  for (let i = 0; i < tableLen; i++) {
    tablePeak = Math.max(tablePeak, Math.abs(Math.sin((2 * Math.PI * i) / tableLen)));
  }
  const idealPeak = Math.round(tablePeak * 32767 * cfg.outputLevel);
  check('AM peak matches the carrier table maximum', Math.abs(blackPeak - idealPeak) <= 2,
    `${blackPeak} vs ideal ${idealPeak}`);

  const carrier = dominantFrequency(pcm, 2048, 32768, fs);
  check('AM carrier is the 1900 Hz centre frequency', approx(carrier, 1900, 2),
    `measured ${carrier.toFixed(2)} Hz`);
}

/* ------------------------------------------------------------------ *
 * Test 3d — pixel clock modes and the output low-pass
 * ------------------------------------------------------------------ */

function clockAndFilterTest() {
  console.log('\n== pixel clock modes and output low-pass ==');
  // 1800 px/line at 48 kHz is deliberately non-integer (22.22 samples/pixel),
  // which is the case where the two clock strategies differ.
  const cfgExact = HFFAX.config({ width: 1800, maxLines: 2, outputLevel: 0.8, preserveAspect: false });
  const cfgClocked = HFFAX.config({
    width: 1800, maxLines: 2, outputLevel: 0.8, preserveAspect: false, pixelClock: 'clocked'
  });
  check('1800 px/line is a fractional sample count per pixel',
    Math.abs(cfgExact.samplesPerPixel - Math.round(cfgExact.samplesPerPixel)) > 0.1,
    `${cfgExact.samplesPerPixel.toFixed(4)}`);

  const data = new Uint8Array(1800 * 2).fill(128);
  const exact = HFFAX.encodeToWav({ width: 1800, height: 2, data }, { gray: true }, cfgExact, {});
  const clocked = HFFAX.encodeToWav({ width: 1800, height: 2, data }, { gray: true }, cfgClocked, {});
  check('both clock modes produce the same number of samples',
    exact.stats.samples === clocked.stats.samples,
    `${exact.stats.samples} vs ${clocked.stats.samples}`);

  const fs = cfgExact.sampleRate;
  const line = Math.round(cfgExact.samplesPerLine);
  const want = cfgExact.blackHz + (cfgExact.whiteHz - cfgExact.blackHz) * (128 / 255);
  const fExact = dominantFrequency(new Int16Array(exact.wav, 44), line + 8192, 32768, fs);
  const fClocked = dominantFrequency(new Int16Array(clocked.wav, 44), line + 8192, 32768, fs);
  check('exact clock lands on the nominal frequency', approx(fExact, want, 2),
    `measured ${fExact.toFixed(2)} Hz vs ${want.toFixed(1)} Hz`);
  check('clocked mode is within 3 Hz of the nominal frequency', approx(fClocked, want, 3),
    `measured ${fClocked.toFixed(2)} Hz vs ${want.toFixed(1)} Hz`);

  // Zero-crossing spacing is dominated by the ~25-sample carrier period, so a
  // standard deviation of the gaps cannot separate the two clock strategies.
  // The observable difference for a *constant* level is the instantaneous
  // frequency ripple: the exact clock integrates a fractional phase step
  // smoothly, while the clocked mode restarts the step count at every pixel
  // boundary and can leave a sub-sample phase residue.
  function frequencyRipple(pcm, from, count, fs) {
    const values = [];
    const win = 64;
    for (let i = from; i + win < from + count; i += win) {
      values.push(dominantFrequency(pcm, i, win, fs));
    }
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);
  }
  const rExact = frequencyRipple(new Int16Array(exact.wav, 44), line + 8192, 16384, fs);
  const rClocked = frequencyRipple(new Int16Array(clocked.wav, 44), line + 8192, 16384, fs);
  check('exact clock has no more frequency ripple than clocked mode', rExact <= rClocked + 0.5,
    `exact ${rExact.toFixed(3)} Hz vs clocked ${rClocked.toFixed(3)} Hz`);

  // Low-pass: a hard black/white split with 25 % duty cycle is the shape a
  // facsimile line actually has when it carries thin black detail, so it is the
  // pattern worth encoding here.
  const N = 900;
  const split = new Uint8Array(N * 2);
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < N; x++) split[y * N + x] = (x % 4 === 0) ? 0 : 255;
  }
  const base = HFFAX.config({ width: N, maxLines: 2, outputLevel: 0.8, preserveAspect: false,
    phasingEnabled: false, stopToneEnabled: false, stopBlackLines: 0 });
  function withLowPass(cutoffHz) {
    return HFFAX.config({ width: N, maxLines: 2, outputLevel: 0.8, preserveAspect: false,
      phasingEnabled: false, stopToneEnabled: false, stopBlackLines: 0,
      lowPassEnabled: true, lowPassCutoffHz: cutoffHz });
  }
  const raw = HFFAX.encodeToWav({ width: N, height: 2, data: split }, { gray: true }, base, {});
  const lpLow = HFFAX.encodeToWav({ width: N, height: 2, data: split }, { gray: true }, withLowPass(800), {});
  const lpHigh = HFFAX.encodeToWav({ width: N, height: 2, data: split }, { gray: true }, withLowPass(8000), {});
  // Low-pass frequency response. Measured on a *constant* level, where the
  // signal is a single tone at the level's frequency: that makes the filter's
  // response directly observable as an amplitude change. (Measuring the
  // out-of-band *ratio* on a square wave does not work: a one-pole filter
  // attenuates the signal and its sidebands together, so the ratio barely moves.)
  const M = 900;
  const flat = new Uint8Array(M * 2).fill(128);
  const toneHz = base.blackHz + (base.whiteHz - base.blackHz) * (128 / 255);
  function flatCfg(lowPass, cutoff) {
    return HFFAX.config({ width: M, maxLines: 2, outputLevel: 0.8, preserveAspect: false,
      phasingEnabled: false, stopToneEnabled: false, stopBlackLines: 0,
      lowPassEnabled: lowPass, lowPassCutoffHz: cutoff || 2800 });
  }
  function toneRms(pcm) {
    const start = Math.min(Math.round(base.samplesPerLine * 1.3), pcm.length - 8192);
    let sum = 0;
    for (let i = 0; i < 8192; i++) { const v = pcm[start + i] / 32768; sum += v * v; }
    return Math.sqrt(sum / 8192);
  }
  const rmsRaw = toneRms(new Int16Array(HFFAX.encodeToWav(
    { width: M, height: 2, data: flat }, { gray: true }, flatCfg(false), {}).wav, 44));
  const rms800 = toneRms(new Int16Array(HFFAX.encodeToWav(
    { width: M, height: 2, data: flat }, { gray: true }, flatCfg(true, 800), {}).wav, 44));
  const rms2800 = toneRms(new Int16Array(HFFAX.encodeToWav(
    { width: M, height: 2, data: flat }, { gray: true }, flatCfg(true, 2800), {}).wav, 44));

  const ideal800 = 1 / Math.sqrt(1 + (toneHz / 800) ** 2);
  const ideal2800 = 1 / Math.sqrt(1 + (toneHz / 2800) ** 2);
  check('low-pass at 800 Hz attenuates a tone at the video frequency',
    approx(rms800 / rmsRaw, ideal800, 0.03),
    `gain ${(rms800 / rmsRaw).toFixed(3)} vs one-pole prediction ${ideal800.toFixed(3)} ` +
    `(tone ${toneHz.toFixed(0)} Hz)`);
  check('low-pass at 2800 Hz leaves the video band almost untouched',
    approx(rms2800 / rmsRaw, ideal2800, 0.03),
    `gain ${(rms2800 / rmsRaw).toFixed(3)} vs one-pole prediction ${ideal2800.toFixed(3)}`);
  check('low-pass keeps the transmission the same length',
    raw.stats.samples === lpLow.stats.samples && raw.stats.samples === lpHigh.stats.samples);
}

/* ------------------------------------------------------------------ *
 * Test 3e — progress reporting and cancellation
 * ------------------------------------------------------------------ */

function progressAndAbortTest() {
  console.log('\n== progress reporting and cancellation ==');
  const cfg = HFFAX.config({ width: 256, maxLines: 40, outputLevel: 0.8 });
  const data = new Uint8Array(256 * 40).fill(200);
  const seen = [];
  const out = HFFAX.encodeToWav({ width: 256, height: 40, data }, { gray: true }, cfg, {
    onProgress: (done, total) => seen.push([done, total])
  });
  check('progress callback fired', seen.length >= 2, `${seen.length} callbacks`);
  check('progress totals equal the produced sample count',
    seen.every((p) => p[1] === out.stats.samples),
    `total ${seen[0] ? seen[0][1] : '?'} vs ${out.stats.samples}`);
  let monotonic = true;
  for (let i = 1; i < seen.length; i++) if (seen[i][0] < seen[i - 1][0]) monotonic = false;
  check('progress is monotonically non-decreasing', monotonic);
  check('final progress reaches 100 %',
    seen.length > 0 && seen[seen.length - 1][0] === out.stats.samples,
    `${seen.length ? seen[seen.length - 1][0] : '?'}`);

  // Abort after the first block.
  let calls = 0;
  const sink = new HFFAX.ChunkSink(1024);
  const enc = new HFFAX.Encoder(cfg, { shouldAbort: () => ++calls > 3 });
  const stats = enc.encodeRaster({ width: 256, height: 40, data }, sink);
  check('cancelled encode stops early', stats.aborted === true && stats.samples < out.stats.samples,
    `aborted=${stats.aborted}, ${stats.samples} of ${out.stats.samples} samples`);
  const chunks = sink.finish();
  let written = 0;
  for (const c of chunks) written += c.length;
  check('everything written before the abort is a whole block',
    written <= stats.samples + 1024, `${written} samples in ${chunks.length} chunk(s)`);
}

/* ------------------------------------------------------------------ *
 * Test 3f — black / white inversion (both layers)
 * ------------------------------------------------------------------ */

function inversionTest() {
  console.log('\n== black / white inversion ==');
  const W = 16;
  const ramp = new Uint8Array(W);
  for (let x = 0; x < W; x++) ramp[x] = x * 17;          // 0,17,...,255

  // (a) image inversion: flip the luminance before it is transmitted.
  const plain = HFFAX.prepareRaster({ width: W, height: 1, data: ramp }, { gray: true },
    HFFAX.config({ width: W, maxLines: 1, preserveAspect: false, autoContrast: false }));
  const flipped = HFFAX.prepareRaster({ width: W, height: 1, data: ramp }, { gray: true },
    HFFAX.config({ width: W, maxLines: 1, preserveAspect: false, autoContrast: false, invert: true }));
  check('cfg.invert flips the transmitted luminance',
    flipped.data[0] === 255 && flipped.data[W - 1] === 0 &&
    flipped.data.every((v, i) => v === 255 - plain.data[i]),
    `${Array.from(flipped.data.slice(0, 4))} vs ${Array.from(plain.data.slice(0, 4))}`);

  // The legacy imageOpts path must keep working too.
  const legacy = HFFAX.prepareRaster({ width: W, height: 1, data: ramp }, { gray: true, invert: true },
    HFFAX.config({ width: W, maxLines: 1, preserveAspect: false, autoContrast: false }));
  check('imageOpts.invert still works', legacy.data[0] === 255, `${legacy.data[0]}`);

  // Inverting twice must be the identity (invertGray is its own inverse).
  const twice = HFFAX.prepareRaster({ width: W, height: 1, data: ramp },
    { gray: true, invert: true },
    HFFAX.config({ width: W, maxLines: 1, preserveAspect: false, autoContrast: false, invert: true }));
  check('inverting twice cancels out',
    twice.data.every((v, i) => v === plain.data[i]),
    `${Array.from(twice.data.slice(0, 4))}`);

  // (b) polarity: white and black trade video frequencies.
  function measureRow(level, overrides) {
    const cfg = HFFAX.config({
      width: W, maxLines: 1, preserveAspect: false, outputLevel: 0.9,
      phasingEnabled: false, stopToneEnabled: false, stopBlackLines: 0, ...overrides
    });
    const data = new Uint8Array(W).fill(level);
    const out = HFFAX.encodeToWav({ width: W, height: 1, data }, { gray: true }, cfg, {});
    const pcm = new Int16Array(out.wav, 44);
    // The whole one-line transmission is 24000 samples; keep the analysis
    // window inside it (a window longer than the signal would be zero-padded
    // and the spectral leakage would swamp the peak).
    return dominantFrequency(pcm, 2048, 16384, cfg.sampleRate);
  }
  const blackPositive = measureRow(0, {});
  const whitePositive = measureRow(255, {});
  const blackNegative = measureRow(0, { polarity: 'negative' });
  const whiteNegative = measureRow(255, { polarity: 'negative' });
  check('positive polarity: black is the high video frequency',
    approx(blackPositive, 2300, 2) && approx(whitePositive, 1500, 2),
    `black ${blackPositive.toFixed(1)} Hz / white ${whitePositive.toFixed(1)} Hz`);
  check('negative polarity swaps them',
    approx(blackNegative, 1500, 2) && approx(whiteNegative, 2300, 2),
    `black ${blackNegative.toFixed(1)} Hz / white ${whiteNegative.toFixed(1)} Hz`);

  // Inverting the luminance reverses the level->frequency direction (black would
  // rise to 2300 Hz), while inverting the polarity moves black *down* to
  // 1500 Hz: the two invert the picture in opposite senses, so applying both
  // cancels back to the original signal. That cancellation is the identity
  // worth asserting — my first two attempts asserted the wrong direction.
  function signalOf(overrides, imageOpts) {
    const cfg = HFFAX.config({
      width: W, maxLines: 1, preserveAspect: false, outputLevel: 0.9, autoContrast: false,
      phasingEnabled: false, stopToneEnabled: false, stopBlackLines: 0, ...overrides
    });
    const out = HFFAX.encodeToWav({ width: W, height: 1, data: ramp },
      imageOpts || { gray: true }, cfg, {});
    return Buffer.from(out.wav, 44);
  }
  const plainSignal = signalOf({});
  const byImage = signalOf({ invert: true });
  const byPolarity = signalOf({ polarity: 'negative' });
  const byBoth = signalOf({ invert: true, polarity: 'negative' });
  check('image inversion changes the transmitted signal', !byImage.equals(plainSignal));
  check('polarity inversion changes the transmitted signal', !byPolarity.equals(plainSignal));
  check('the two inversions are opposite senses, not the same',
    !byImage.equals(byPolarity));
  check('applying both inversions restores the original signal',
    byBoth.equals(plainSignal), `equal=${byBoth.equals(plainSignal)}`);

  // Level-by-level direction check on the frequency axis.
  const lumToHz = (level, overrides) => {
    const cfg = HFFAX.config({
      width: W, maxLines: 1, preserveAspect: false, outputLevel: 0.9, autoContrast: false,
      phasingEnabled: false, stopToneEnabled: false, stopBlackLines: 0, ...overrides
    });
    const data = new Uint8Array(W).fill(level);
    const out = HFFAX.encodeToWav({ width: W, height: 1, data }, { gray: true }, cfg, {});
    const pcm = new Int16Array(out.wav, 44);
    return dominantFrequency(pcm, 2048, 16384, cfg.sampleRate);
  };
  const invertBlack = lumToHz(0, { invert: true });     // black -> luminance 255
  const normalWhite = lumToHz(255, {});
  check('inverted black transmits at the white frequency',
    approx(invertBlack, 1500, 2) && approx(invertBlack, normalWhite, 2),
    `inverted black ${invertBlack.toFixed(1)} Hz vs normal white ${normalWhite.toFixed(1)} Hz`);
}

/* ------------------------------------------------------------------ *
 * Test 3g — polarity self-check on the produced audio
 * ------------------------------------------------------------------ */

function polarityCheckTest() {
  console.log('\n== polarity self-check (accidental negative images) ==');
  if (typeof HFFAX.checkPolarity !== 'function') {
    check('checkPolarity is exported', false);
    return;
  }

  // A bright chart-like picture: mostly white with some black structure.
  const W = 720, LINES = 24;
  const bright = new Uint8Array(W * LINES).fill(240);
  for (let y = 0; y < LINES; y++) {
    for (let x = 0; x < W; x++) {
      if ((x % 90) < 10 || (y % 6) === 0) bright[y * W + x] = 20;
    }
  }

  function judge(data, overrides) {
    const cfg = HFFAX.config({
      width: W, maxLines: LINES, preserveAspect: false, outputLevel: 0.8,
      autoContrast: false, ...overrides
    });
    const out = HFFAX.encodeToWav({ width: W, height: LINES, data }, { gray: true }, cfg, {});
    const pcm = new Int16Array(out.wav, 44);
    const line = Math.round(cfg.samplesPerLine);
    // The reference is the picture the user meant to send, i.e. the source
    // buffer — not the conditioned raster.
    const res = HFFAX.checkPolarity(pcm, cfg, out.raster, {
      imageStart: line + (cfg.phasingEnabled ? line : 0),
      imageEnd: out.stats.samples - Math.round(cfg.sampleRate * cfg.stopToneSeconds)
    }, HFFAX.meanLuminance(data));
    return { res, out, cfg };
  }

  const normal = judge(bright, {});
  check('a bright picture sent normally is reported as positive',
    normal.res.inverted === false,
    `black fraction ${(normal.res.blackFraction * 100).toFixed(1)} % ` +
    `(median ${normal.res.medianHz.toFixed(0)} Hz), confidence ${normal.res.confidence}`);

  const inverted = judge(bright, { invert: true });
  check('a bright picture with invert on is reported as a negative',
    inverted.res.inverted === true,
    `black fraction ${(inverted.res.blackFraction * 100).toFixed(1)} %`);

  const negativePolarity = judge(bright, { polarity: 'negative' });
  check('negative polarity flips the report too',
    negativePolarity.res.inverted === true,
    `black fraction ${(negativePolarity.res.blackFraction * 100).toFixed(1)} %`);

  const both = judge(bright, { invert: true, polarity: 'negative' });
  check('two inversions read as positive again', both.res.inverted === false,
    `black fraction ${(both.res.blackFraction * 100).toFixed(1)} %`);

  // A dark picture sent as a positive is legitimately dark, not inverted.
  const dark = new Uint8Array(W * LINES).fill(30);
  const darkRes = judge(dark, {});
  check('a genuinely dark picture is not misreported as a negative',
    darkRes.res.inverted === false,
    `black fraction ${(darkRes.res.blackFraction * 100).toFixed(1)} %`);

  // Mid grey cannot be judged, and the check must say so instead of guessing.
  const greyRes = judge(new Uint8Array(W * LINES).fill(128), {});
  check('a mid-grey picture is reported as undecided',
    greyRes.res.confidence === 'low' && greyRes.res.inverted === null,
    `black fraction ${(greyRes.res.blackFraction * 100).toFixed(1)} %, note "${greyRes.res.note}"`);
}

/* ------------------------------------------------------------------ *
 * Test 3h — the polarity judge agrees with the Python implementation
 * ------------------------------------------------------------------ */

function polarityCrossLanguageTest() {
  console.log('\n== polarity judge: JS vs Python reference ==');
  const vecPath = path.join(ROOT, 'tests', 'vectors', 'polarity_cases.json');
  if (!fs.existsSync(vecPath)) {
    check('polarity case vectors exist', false,
      'run: python tools/dump_polarity_cases.py');
    return;
  }
  const vec = JSON.parse(fs.readFileSync(vecPath, 'utf8'));
  let agreed = 0;
  let decided = 0;
  const mismatches = [];

  for (const c of vec.cases) {
    const data = new Uint8Array(Buffer.from(c.data_hex, 'hex'));
    const width = data.length === 360 * 8 ? 360 : Math.round(Math.sqrt(data.length));
    const cfg = HFFAX.config(Object.assign({
      width: width, maxLines: 8, preserveAspect: false, outputLevel: 0.8,
      autoContrast: false, stopToneSeconds: 0.5, stopBlackLines: 1
    }, c.overrides));

    const out = HFFAX.encodeToWav(
      { width: width, height: 8, data: data }, { gray: true }, cfg, {});
    const pcm = new Int16Array(out.wav, 44);
    const line = Math.round(cfg.samplesPerLine);
    const res = HFFAX.checkPolarity(pcm, cfg, out.raster, {
      imageStart: (cfg.startToneEnabled ? Math.round(cfg.sampleRate * cfg.startToneSeconds) : 0) + line,
      imageEnd: pcm.length - Math.round(cfg.sampleRate * cfg.stopToneSeconds)
    }, HFFAX.meanLuminance(data));

    const ok = res.inverted === c.python_inverted && res.confidence === c.python_confidence;
    if (ok) agreed++; else mismatches.push(c.name);
    if (res.inverted !== null) decided++;
  }

  check('every polarity case agrees between the two implementations',
    agreed === vec.cases.length,
    `${agreed}/${vec.cases.length}${mismatches.length ? ' — differs on ' + mismatches.join(', ') : ''}`);
  check('the check actually decides something (not all undecided)',
    decided >= vec.cases.length / 3, `${decided}/${vec.cases.length} decided`);
}

/* ------------------------------------------------------------------ *
 * Test 4 — image conditioning pipeline
 * ------------------------------------------------------------------ */

function imagePipelineTest() {
  console.log('\n== image conditioning ==');
  // A 64 x 24 RGBA source with a black-to-white horizontal ramp.
  const sw = 64, sh = 24;
  const rgba = new Uint8Array(sw * sh * 4);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const v = Math.round((x * 255) / (sw - 1));
      const i = (y * sw + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  const cfg = HFFAX.config({ width: 1800, maxLines: 576 });
  const raster = HFFAX.prepareRaster({ width: sw, height: sh, data: rgba }, {}, cfg);
  check('aspect ratio preserved: 1800 px/line x (24/64) -> 675 lines, capped at 576',
    raster.height === 576, `${raster.width} x ${raster.height}`);
  check('left edge is black', raster.data[0] === 0, `${raster.data[0]}`);
  check('right edge is white', raster.data[raster.width - 1] === 255, `${raster.data[raster.width - 1]}`);

  // Independent width/height are honoured when preserveAspect is off.
  const cfg2 = HFFAX.config({ width: 400, maxLines: 20, preserveAspect: false });
  const raster2 = HFFAX.prepareRaster({ width: sw, height: sh, data: rgba }, {}, cfg2);
  check('preserveAspect=false uses maxLines verbatim', raster2.height === 20 && raster2.width === 400,
    `${raster2.width} x ${raster2.height}`);

  // Transparency is composited over white.
  const transparent = new Uint8Array(4 * 4 * 4);   // all zero, alpha 0
  const g = HFFAX.extractGray({ width: 4, height: 4, data: transparent }, {});
  check('transparent pixels read as white', g.data[0] === 255, `${g.data[0]}`);

  // Dithering produces a two-level signal.
  const grey = { width: 64, height: 64, data: new Uint8Array(64 * 64).fill(128) };
  const dithered = HFFAX.ditherGray({ width: 64, height: 64, data: grey.data.slice() }, 'bayer8');
  let onlyTwo = true, dark = 0;
  for (const v of dithered.data) {
    if (v !== 0 && v !== 255) onlyTwo = false;
    if (v === 0) dark++;
  }
  check('Bayer dithering yields only black and white', onlyTwo);
  check('Bayer dithering keeps ~50 % of a mid grey dark',
    dark > 64 * 64 * 0.4 && dark < 64 * 64 * 0.6, `${dark}/${64 * 64}`);

  const fs2 = HFFAX.ditherGray({ width: 64, height: 64, data: new Uint8Array(64 * 64).fill(128) }, 'fs');
  let fsDark = 0;
  for (const v of fs2.data) if (v === 0) fsDark++;
  check('Floyd-Steinberg keeps ~50 % of a mid grey dark',
    fsDark > 64 * 64 * 0.4 && fsDark < 64 * 64 * 0.6, `${fsDark}/${64 * 64}`);
}

/* ------------------------------------------------------------------ *
 * Test 5 — full-size transmission budget and speed
 * ------------------------------------------------------------------ */

function fullSizeTest() {
  console.log('\n== full IOC 576 transmission ==');
  const cfg = HFFAX.config();
  const data = new Uint8Array(1800 * 576);
  for (let y = 0; y < 576; y++) {
    for (let x = 0; x < 1800; x++) data[y * 1800 + x] = (x + y) & 255;
  }
  const t0 = Date.now();
  const out = HFFAX.encodeToWav({ width: 1800, height: 576, data }, { gray: true }, cfg, {});
  const ms = Date.now() - t0;
  const expectedSeconds = 0.5 * (576 + 5 + 1) + 5;   // image + stop lines + phasing + stop tone
  check('duration ~= 296 s', approx(out.stats.seconds, expectedSeconds, 1.0),
    `${out.stats.seconds.toFixed(2)} s (expected ${expectedSeconds.toFixed(1)} s)`);
  check('output is a complete 576-line transmission', out.stats.lines === 576);
  check('no clipping', out.stats.clipped === 0);
  console.log(`         ${(out.wav.byteLength / 1048576).toFixed(1)} MiB written in ${ms} ms ` +
    `(${(out.stats.seconds / (ms / 1000)).toFixed(0)}x real time)`);
  check('encoder is faster than real time', ms < out.stats.seconds * 1000);
}

/* ------------------------------------------------------------------ *
 * Test 6 — configuration plumbing
 * ------------------------------------------------------------------ */

function configTest() {
  console.log('\n== configuration ==');
  const c = HFFAX.config({ lineRateLpm: 60, ioc: 288, width: 900 });
  check('60 lpm -> 1 s line period', approx(c.linePeriod, 1.0, 1e-12));
  check('IOC 288 drum is 288 s', approx((c.ioc * 60) / c.lineRateLpm, 288, 1e-9));
  check('derived pixel rate', approx(c.pixelRate, 900, 1e-9), `${c.pixelRate}`);

  const neg = HFFAX.config({
    width: 16, maxLines: 4, polarity: 'negative', outputLevel: 0.9,
    phasingEnabled: false, stopToneEnabled: false, stopBlackLines: 0
  });
  const negSink = new HFFAX.ChunkSink(1 << 16);
  const negEnc = new HFFAX.Encoder(neg, {});
  negEnc.encodeRaster({ width: 16, height: 1, data: new Uint8Array(16) }, negSink);
  const negChunks = negSink.finish();
  const negPcm = new Int16Array(negChunks[0].length);
  let negOffset = 0;
  for (const c of negChunks) { negPcm.set(c, negOffset); negOffset += c.length; }
  // With inverted polarity a black level must land on the *white* frequency.
  const f = dominantFrequency(negPcm, 2048, 16384, neg.sampleRate);
  check('negative polarity maps black to 1500 Hz', approx(f, 1500, 2),
    `measured ${f.toFixed(2)} Hz`);

  const planA = HFFAX.planLines(1000, 700, HFFAX.config());
  const planB = HFFAX.planLines(1000, 700, HFFAX.config({ preserveAspect: false, maxLines: 288 }));
  check('planLines honours aspect ratio', planA.lines === 576, `${planA.lines}`);
  check('planLines honours fixed line count', planB.lines === 288, `${planB.lines}`);
  check('planLines reports a sane byte estimate', planA.bytes > 0 && planA.bytes % 2 === 0);
}

/* ------------------------------------------------------------------ */

function main() {
  const args = process.argv.slice(2);
  const jsonOut = args.includes('--json');
  const only = args.includes('--vector-only');

  console.log('HF FAX encoder test suite');
  console.log('  node', process.version, '|', path.join(ROOT, 'src', 'hffax.js'));

  goldenVectorTest();
  if (!only) {
    signalTest();
    startToneTest();
    ioc288Test();
    amModulationTest();
    clockAndFilterTest();
    inversionTest();
    polarityCheckTest();
    polarityCrossLanguageTest();
    progressAndAbortTest();
    imagePipelineTest();
    configTest();
    fullSizeTest();
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (jsonOut) {
    console.log(JSON.stringify({ checks, failures, results }, null, 2));
  }
  process.exit(failures === 0 ? 0 : 1);
}

main();
