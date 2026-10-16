/*!
 * HF WEATHER FAX ENCODER — core signal engine
 * ---------------------------------------------------------------------------
 * Encodes a greyscale image into the analogue facsimile signal defined by the
 * WMO/IMO recommendations for HF weather charts (also called "radio fax",
 * "WEFAX", "HF FAX", "chart facsimile"):
 *
 *   sub-carrier              1900 Hz
 *   white / black            1500 Hz / 2300 Hz  (150 Hz shift, 400 Hz dev.)
 *   occupied bandwidth       2550 Hz
 *   index of cooperation     576 (IOC 576)
 *   line rate                120 lines per minute  (500 ms per line)
 *   phasing                  5 % black + 95 % white, one line
 *   stop                     450 Hz tone (300 Hz start tone optional)
 *
 * The output is a mono 16-bit PCM RIFF/WAVE file. Nothing in this file touches
 * the DOM, so the very same module runs in a browser and under Node.js for
 * tests (see tests/).
 *
 * Dual use:
 *  * browser : include hffax.js with a script tag  ->  window.HFFAX
 *  * node    : const HFFAX = require('./hffax.js')
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;            // Node.js / CommonJS
  } else {
    root.HFFAX = api;                // browser global
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* =======================================================================
   * Constants and tables
   * ===================================================================== */

  /*
   * The phase accumulator is a float in [0, LUT_SIZE) and the sine look-up is
   * indexed with `phase|0`. The table must therefore be large enough that
   * fractional phase steps are *not* silently truncated: at 48 kHz a 4096-point
   * table quantises the 0.732 Hz-per-index grid and truncation aliases a
   * 2300 Hz tone down to 2.9 Hz. 65536 entries push that quantisation error to
   * -137 dB, which is far below the noise floor of any HF path.
   */
  var LUT_BITS = 16;
  var LUT_SIZE = 1 << LUT_BITS;      // 65536
  var TWO_PI = Math.PI * 2;

  /** sin(2*pi*i/LUT_SIZE) for i in 0..LUT_SIZE (one guard sample). */
  var SIN = new Float64Array(LUT_SIZE + 1);
  for (var _i = 0; _i <= LUT_SIZE; _i++) {
    SIN[_i] = Math.sin((TWO_PI * _i) / LUT_SIZE);
  }

  /** AM carrier look-up: one whole period of the centre frequency. */
  var AM_CARRIER = null;
  /** Fractional step through [AM_CARRIER] per audio sample (keeps the rate exact). */
  var AM_CARRIER_STEP = 1;

  function buildTables(cfg) {
    AM_CARRIER = null;
    AM_CARRIER_STEP = 1;
    if (cfg.modulation !== 'am') return;
    // Rounding the table length alone detuned the AM carrier by ~20 Hz; the DDS
    // step below carries the fraction so the carrier lands exactly on centreHz.
    var period = cfg.sampleRate / cfg.centreHz;     // samples per carrier cycle
    var n = Math.max(2, Math.round(period));
    AM_CARRIER = new Float64Array(n);
    for (var i = 0; i < n; i++) AM_CARRIER[i] = Math.sin((TWO_PI * i) / n);
    AM_CARRIER_STEP = n / period;
  }

  /**
   * Frequency for every possible 8-bit video level.
   *
   * The raster stores *luminance*: 0 = black, 255 = white. The WMO mapping is
   * the inverse of that — black is the high video frequency — so the table
   * descends from [blackHz] at level 0 to [whiteHz] at level 255 for positive
   * polarity. Kept as a float table so both endpoints stay exact.
   */
  var LEVEL_HZ = new Float64Array(256);
  /** Envelope magnitude for every level, AM only (black = full envelope). */
  var LEVEL_ENV = new Float64Array(256);
  for (var _v = 0; _v < 256; _v++) {
    LEVEL_ENV[_v] = 1 - _v / 255;
  }

  function buildLevelTable(cfg) {
    // 'positive' polarity = positive frequency shift for black, the WMO
    // convention: white 1500 Hz, black 2300 Hz.
    var black = cfg.polarity === 'positive' ? cfg.blackHz : cfg.whiteHz;
    var white = cfg.polarity === 'positive' ? cfg.whiteHz : cfg.blackHz;
    for (var v = 0; v < 256; v++) {
      LEVEL_HZ[v] = black + (white - black) * (v / 255);
    }
  }

  /* =======================================================================
   * Configuration
   * ===================================================================== */

  var DEFAULT_CONFIG = {
    sampleRate: 48000,
    lineRateLpm: 120,          // 120 or 60 lines per minute
    ioc: 576,                  // index of cooperation (lines per revolution)
    width: 1800,               // pixels per line
    maxLines: 576,             // maximum image lines to transmit
    whiteHz: 1500,
    blackHz: 2300,
    modulation: 'fm',          // 'fm' | 'am'
    polarity: 'positive',      // 'positive': white 1500 / black 2300
    outputLevel: 0.7,          // -3 dBFS; 1.0 = full scale
    pixelClock: 'exact',       // 'exact' | 'clocked'
    phasingEnabled: true,
    phasingBlackPercent: 5,    // WMO: 5 % for IOC 576, 10 % for IOC 288
    startToneEnabled: false,
    startToneSeconds: 5,
    startToneHz: 300,
    stopToneEnabled: true,
    stopToneSeconds: 5,
    stopToneHz: 450,
    stopBlackLines: 5,
    preserveAspect: true,
    gamma: 1.0,
    dither: 'none',            // 'none' | 'bayer4' | 'bayer8' | 'fs'
    autoContrast: true,
    invert: false,
    lowPassEnabled: false,
    lowPassCutoffHz: 2800
  };

  function config(overrides) {
    var c = {}, k;
    for (k in DEFAULT_CONFIG) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, k)) c[k] = DEFAULT_CONFIG[k];
    }
    if (overrides) {
      for (k in overrides) {
        if (overrides[k] !== undefined && overrides[k] !== null) c[k] = overrides[k];
      }
    }
    // Floor the sample rate at 8 kHz — below that the 1500-2300 Hz video band
    // cannot even be represented. Note 8 kHz is *still* not enough for this
    // band (Nyquist would be 4000 Hz, the band needs 4600 Hz), so callers must
    // check the 2x margin themselves; the app warns when it is not met.
    c.sampleRate = Math.max(8000, Math.round(c.sampleRate));
    c.width = Math.max(8, Math.round(c.width));
    c.maxLines = Math.max(1, Math.round(c.maxLines));
    c.lineRateLpm = Math.max(1, Number(c.lineRateLpm));
    c.ioc = Math.max(1, Math.round(c.ioc));
    c.whiteHz = Math.max(100, Math.round(c.whiteHz));
    c.blackHz = Math.max(100, Math.round(c.blackHz));

    // Derived geometry ----------------------------------------------------
    c.linePeriod = 60 / c.lineRateLpm;               // seconds per line
    c.linePeriodMs = c.linePeriod * 1000;
    c.pixelPeriod = c.linePeriod / c.width;          // seconds per pixel
    c.pixelRate = c.width / c.linePeriod;            // pixels per second
    c.samplesPerLine = c.sampleRate * c.linePeriod;  // fractional
    c.samplesPerPixel = c.sampleRate * c.pixelPeriod;
    c.bandwidthHz = Math.abs(c.blackHz - c.whiteHz);
    c.centreHz = (c.whiteHz + c.blackHz) / 2;
    c.samplesPerBlock = 8192;

    if (c.pixelClock !== 'clocked') c.pixelClock = 'exact';
    if (c.modulation !== 'am') c.modulation = 'fm';
    if (c.polarity !== 'negative') c.polarity = 'positive';
    return c;
  }

  /** Ready-made station profiles. */
  var PRESETS = {
    ioc576: {
      label: 'IOC 576 / 120 lpm — 标准气象传真 (JMH/JJC 等)',
      lineRateLpm: 120, ioc: 576, width: 1800, maxLines: 576,
      whiteHz: 1500, blackHz: 2300, phasingBlackPercent: 5, stopBlackLines: 5,
      startToneEnabled: false, stopToneEnabled: true
    },
    ioc288: {
      label: 'IOC 288 / 60 lpm — 低速远距离',
      lineRateLpm: 60, ioc: 288, width: 900, maxLines: 288,
      whiteHz: 1500, blackHz: 2300, phasingBlackPercent: 10, stopBlackLines: 10,
      startToneEnabled: false, stopToneEnabled: true
    },
    ioc576tone: {
      label: 'IOC 576 + 300 Hz 起始音 (完整发射格式)',
      lineRateLpm: 120, ioc: 576, width: 1800, maxLines: 576,
      startToneEnabled: true, startToneSeconds: 5, startToneHz: 300,
      stopToneEnabled: true, stopToneSeconds: 5, stopToneHz: 450
    },
    photo576: {
      label: 'IOC 576 / 抖动灰度 — 照片与图像',
      lineRateLpm: 120, ioc: 576, width: 1800, maxLines: 576,
      dither: 'bayer8', lowPassEnabled: true
    }
  };

  /* =======================================================================
   * Sample sinks
   * ===================================================================== */

  /**
   * Collects 16-bit samples into growable chunks. The browser app turns the
   * chunks straight into Blob parts, so four minutes of audio never needs a
   * single giant ArrayBuffer; the tests use it for byte-exact comparison.
   */
  function ChunkSink(blockSamples) {
    this.blockSamples = blockSamples || (1 << 19);
    this.chunks = [];
    this.cur = new Int16Array(this.blockSamples);
    this.n = 0;
    this.length = 0;
  }
  ChunkSink.prototype.write = function (block, offset, count) {
    var i = 0;
    while (i < count) {
      var space = this.cur.length - this.n;
      var take = Math.min(space, count - i);
      this.cur.set(block.subarray(offset + i, offset + i + take), this.n);
      this.n += take;
      i += take;
      this.length += take;
      if (this.n === this.cur.length) this._flushChunk();
    }
  };
  ChunkSink.prototype._flushChunk = function () {
    if (this.n > 0) {
      this.chunks.push(this.cur.subarray(0, this.n));
      this.cur = new Int16Array(this.blockSamples);
      this.n = 0;
    }
  };
  ChunkSink.prototype.finish = function () {
    this._flushChunk();
    return this.chunks;
  };

  /* =======================================================================
   * WAV (RIFF) helpers
   * ===================================================================== */

  function writeAscii(view, offset, text) {
    for (var i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i) & 0x7f);
    }
  }

  /**
   * Canonical 44-byte PCM WAVE header (16 bit).
   * @param {number} dataBytes
   * @param {number} sampleRate
   * @param {number} [channels]
   * @returns {ArrayBuffer}
   */
  function wavHeader(dataBytes, sampleRate, channels) {
    channels = channels || 1;
    var bytesPerFrame = channels * 2;
    var buf = new ArrayBuffer(44);
    var v = new DataView(buf);
    writeAscii(v, 0, 'RIFF');
    v.setUint32(4, 36 + dataBytes, true);
    writeAscii(v, 8, 'WAVE');
    writeAscii(v, 12, 'fmt ');
    v.setUint32(16, 16, true);                          // PCM fmt chunk size
    v.setUint16(20, 1, true);                           // format tag = PCM
    v.setUint16(22, channels, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * bytesPerFrame, true);   // byte rate
    v.setUint16(32, bytesPerFrame, true);                // block align
    v.setUint16(34, 16, true);                           // bits per sample
    writeAscii(v, 36, 'data');
    v.setUint32(40, dataBytes, true);
    return buf;
  }

  /** Header + all chunks as one ArrayBuffer. */
  function buildWav(chunks, sampleRate, channels) {
    var total = 0, i;
    for (i = 0; i < chunks.length; i++) total += chunks[i].byteLength;
    var header = wavHeader(total, sampleRate, channels);
    var out = new Uint8Array(header.byteLength + total);
    out.set(new Uint8Array(header), 0);
    var pos = header.byteLength;
    for (i = 0; i < chunks.length; i++) {
      out.set(new Uint8Array(chunks[i].buffer, chunks[i].byteOffset, chunks[i].byteLength), pos);
      pos += chunks[i].byteLength;
    }
    return out.buffer;
  }

  /* =======================================================================
   * The encoder
   * ===================================================================== */

  /**
   * @param {object} cfg  normalised configuration (see {@link config})
   * @param {object} [opts]
   * @param {function(number,number)} [opts.onProgress] (doneSamples, totalSamples)
   * @param {function()} [opts.shouldAbort] return true to stop encoding
   * @param {number} [opts.chunkSamples] samples per internal block
   */
  function Encoder(cfg, opts) {
    this.cfg = cfg;
    this.opts = opts || {};
    buildLevelTable(cfg);
    buildTables(cfg);
    // Per-instance copies: the module-level tables are shared by every encoder,
    // so reading them through `this` keeps the AM state unambiguous.
    this.amCarrier = AM_CARRIER;
    this.amStep = AM_CARRIER_STEP;

    this.blockSize = this.opts.chunkSamples || cfg.samplesPerBlock;
    this.block = new Int16Array(this.blockSize);
    this.bn = 0;                    // samples currently in this.block
    this.phase = 0;                 // FM phase accumulator, 0..LUT_SIZE-1
    this.lp = 0;                    // low-pass state
    this.lpA = 0;                   // low-pass coefficient
    this.peak = 0;                  // peak magnitude seen
    this.clipped = 0;               // samples that hit the rail
    this.totalSamples = 0;
    this.doneSamples = 0;
    this.aborted = false;
    this.sink = null;
    this.t0 = now();

    if (cfg.lowPassEnabled && cfg.modulation === 'fm') {
      // One-pole IIR whose -3 dB point is the cutoff: a = 1 - exp(-2*pi*fc/fs)
      this.lpA = 1 - Math.exp((-TWO_PI * cfg.lowPassCutoffHz) / cfg.sampleRate);
      if (this.lpA > 1) this.lpA = 1;
      if (this.lpA < 0) this.lpA = 0;
    }
  }

  function now() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
  }

  /** Scales raw signal values to Int16 and appends them to the block buffer. */
  Encoder.prototype._write = function (buf, count) {
    var out = this.block;
    var bn = this.bn;
    var gain = this.cfg.outputLevel;
    var lpA = this.lpA, lp = this.lp, useLp = lpA > 0;
    var peak = this.peak, clipped = this.clipped;

    for (var i = 0; i < count; i++) {
      var s = buf[i];
      if (useLp) {
        lp += lpA * (s - lp);
        s = lp;
      }
      s *= gain;
      var a = s < 0 ? -s : s;
      if (a > peak) peak = a;
      var q = Math.round(s * 32767);
      if (q > 32767) { q = 32767; clipped++; } else if (q < -32768) { q = -32768; clipped++; }
      out[bn++] = q;
      if (bn === out.length) {
        this.sink.write(out, 0, bn);
        this.doneSamples += bn;
        bn = 0;
        if (this._tick()) break;
      }
    }
    this.bn = bn;
    this.lp = lp;
    this.peak = peak;
    this.clipped = clipped;
  };

  /** Progress/abort hook; returns true when the caller asked to stop. */
  Encoder.prototype._tick = function () {
    if (this.opts.shouldAbort && this.opts.shouldAbort()) this.aborted = true;
    if (this.opts.onProgress && this.totalSamples > 0) {
      this.opts.onProgress(Math.min(this.doneSamples, this.totalSamples), this.totalSamples);
    }
    return this.aborted;
  };

  /**
   * Emits [count] samples of a *constant* video level, or of a pure tone when
   * [forcedHz] is given. Used for the phasing bar, the black stop lines and the
   * start/stop tones — exactly where the WMO text asks for a clean tone.
   */
  Encoder.prototype._constant = function (level, count, forcedHz) {
    if (count <= 0) return 0;
    var cfg = this.cfg;
    var buf = new Float64Array(count);
    var i;

    if (cfg.modulation === 'am') {
      // AM constant block: `count` here is a number of *samples* (a line period
      // or a tone duration), not a pixel count. The single level is spread over
      // that whole span while the carrier keeps running. (This branch was never
      // exercised until AM got its own test — it used to emit one sample per
      // pixel, which made an "AM line" 16 samples long.)
      var env = LEVEL_ENV[level & 0xff];
      if (forcedHz) {
        var k = (TWO_PI * forcedHz) / cfg.sampleRate;
        for (i = 0; i < count; i++) buf[i] = env * Math.sin(k * i);
      } else {
        var amcp = this.amCarrier;
        var amclen = amcp.length;
        var amStep = this.amStep;
        var amPhase = this.phase;
        for (i = 0; i < count; i++) {
          var ai = amPhase | 0;
          buf[i] = env * amcp[ai >= amclen ? amclen - 1 : ai];
          amPhase += amStep;
          if (amPhase >= amclen) amPhase -= amclen;
        }
        this.phase = amPhase;
      }
    } else {
      var hz = forcedHz || LEVEL_HZ[level & 0xff];
      var step = (hz * LUT_SIZE) / cfg.sampleRate;
      var p = this.phase;
      for (i = 0; i < count; i++) {
        buf[i] = SIN[p | 0];
        p += step;
        if (p >= LUT_SIZE) p -= LUT_SIZE;
      }
      this.phase = p;
    }
    this._write(buf, count);
    return count;
  };

  /** Emits the WMO line-phasing line; returns the samples produced. */
  Encoder.prototype._phasingLine = function (forcedBlackHz) {
    var cfg = this.cfg;
    var lineSamples = Math.round(cfg.samplesPerLine);
    var blackPx = Math.max(1, Math.round((cfg.width * cfg.phasingBlackPercent) / 100));
    var whitePx = Math.max(1, cfg.width - blackPx);
    var b1 = Math.round((lineSamples * blackPx) / (blackPx + whitePx));
    if (b1 < 1) b1 = 1;
    if (b1 > lineSamples - 1) b1 = lineSamples - 1;

    var total = 0;
    total += this._constant(0, b1, forcedBlackHz || null);        // black bar
    total += this._constant(255, lineSamples - b1, null);          // white rest
    return total;
  };

  /** Emits the stop sequence: a few black lines, then the 450 Hz stop tone. */
  Encoder.prototype._stopSequence = function () {
    var cfg = this.cfg;
    var total = 0;
    var lineSamples = Math.round(cfg.samplesPerLine);
    for (var i = 0; i < cfg.stopBlackLines; i++) {
      total += this._constant(0, lineSamples, null);
    }
    if (cfg.stopToneEnabled && cfg.stopToneSeconds > 0) {
      total += this._constant(0, Math.round(cfg.sampleRate * cfg.stopToneSeconds), cfg.stopToneHz);
    }
    return total;
  };

  /**
   * Emits one image line.
   * @param {Uint8Array} row  exactly `cfg.width` luminance values
   */
  Encoder.prototype._imageLine = function (row) {
    var cfg = this.cfg;
    var count = cfg.width;
    var lineSamples = Math.round(cfg.samplesPerLine);
    // One line of audio is `samplesPerLine` samples long, NOT `width` samples —
    // sizing this buffer by the pixel count silently zero-filled every line.
    var buf;
    var n = 0;
    var i, k, v;

    if (cfg.modulation === 'am') {
      // AM carries the video level in the envelope, sample by sample. This
      // branch used to emit one sample per *pixel*, which made an "AM line"
      // 16 samples long instead of a full line period; the envelope has to be
      // generated over the whole line duration, like the FM branch does.
      buf = new Float64Array(lineSamples + 2);
      var car = this.amCarrier;
      var clen = car.length;
      var amStep = this.amStep;
      var amPhase = this.phase;
      var envStep = cfg.samplesPerPixel > 0 ? 1 / cfg.samplesPerPixel : 1;
      var pos = 0;
      for (i = 0; i < lineSamples; i++) {
        v = row[pos < count ? pos : count - 1];
        var ci = amPhase | 0;
        buf[n++] = LEVEL_ENV[v] * car[ci >= clen ? clen - 1 : ci];
        amPhase += amStep;
        if (amPhase >= clen) amPhase -= clen;
        pos = (i + 1) * envStep | 0;
      }
      this.phase = amPhase;
      this._write(buf, n);
      return n;
    }

    var sps = cfg.samplesPerPixel;

    if (cfg.pixelClock === 'clocked') {
      // Strict sample-counted pixel clock: every sample takes the level of the
      // pixel active at its own instant. This introduces a sub-sample phase
      // discontinuity per pixel whenever the sample rate is not a whole
      // multiple of the pixel rate — which is what crystal-clocked drum
      // hardware does.
      buf = new Float64Array(lineSamples + 2);
      var p = this.phase;
      for (i = 0; i < count; i++) {
        v = row[i];
        var step = (LEVEL_HZ[v] * LUT_SIZE) / cfg.sampleRate;
        var npx = Math.round((i + 1) * sps) - Math.round(i * sps);
        for (k = 0; k < npx; k++) {
          buf[n++] = SIN[p | 0];
          p += step;
          if (p >= LUT_SIZE) p -= LUT_SIZE;
        }
      }
      this.phase = p;
      this._write(buf, n);
      return n;
    }

    // Exact pixel clock: pixel boundaries land on real sample boundaries and
    // every pixel is an unbroken, phase-continuous tone segment.
    buf = new Float64Array(lineSamples + 2);
    var prev = 0;
    for (i = 1; i <= count; i++) {
      var end = Math.round(i * sps);
      var len = end - prev;
      if (len > 0) {
        v = row[i - 1];
        var st = (LEVEL_HZ[v] * LUT_SIZE) / cfg.sampleRate;
        var ph = this.phase;
        for (k = 0; k < len; k++) {
          buf[n++] = SIN[ph | 0];
          ph += st;
          if (ph >= LUT_SIZE) ph -= LUT_SIZE;
        }
        this.phase = ph;
      }
      prev = end;
    }
    this._write(buf, n);
    return n;
  };

  /**
   * Encodes one image through the whole transmission.
   *
   * @param {object} raster  {width, height, data} — 8-bit grey, already
   *                         resampled to `cfg.width` × lines
   * @param {object} sink    object exposing write(Int16Array, offset, count)
   * @returns {object} statistics
   */
  Encoder.prototype.encodeRaster = function (raster, sink) {
    var cfg = this.cfg;
    this.sink = sink;
    var lines = raster.height;
    var lineSamples = Math.round(cfg.samplesPerLine);

    var total = 0;
    if (cfg.startToneEnabled && cfg.startToneSeconds > 0) {
      total += Math.round(cfg.sampleRate * cfg.startToneSeconds);
    }
    if (cfg.phasingEnabled) total += lineSamples;
    total += lineSamples * lines;
    total += lineSamples * cfg.stopBlackLines;
    if (cfg.stopToneEnabled && cfg.stopToneSeconds > 0) {
      total += Math.round(cfg.sampleRate * cfg.stopToneSeconds);
    }
    this.totalSamples = total;

    // Head -----------------------------------------------------------------
    if (cfg.startToneEnabled && cfg.startToneSeconds > 0) {
      this._constant(255, Math.round(cfg.sampleRate * cfg.startToneSeconds), cfg.startToneHz);
    }
    if (cfg.phasingEnabled && !this.aborted) this._phasingLine(null);

    // Image ----------------------------------------------------------------
    var row = new Uint8Array(cfg.width);
    for (var y = 0; y < lines && !this.aborted; y++) {
      row.set(raster.data.subarray(y * cfg.width, (y + 1) * cfg.width));
      this._imageLine(row);
    }

    // Tail -----------------------------------------------------------------
    if (!this.aborted) this._stopSequence();

    // Flush ----------------------------------------------------------------
    if (this.bn > 0 && !this.aborted) {
      this.sink.write(this.block, 0, this.bn);
      this.doneSamples += this.bn;
      this.bn = 0;
    }
    if (this.opts.onProgress) {
      this.opts.onProgress(Math.min(this.doneSamples, this.totalSamples), this.totalSamples);
    }

    return {
      sampleRate: cfg.sampleRate,
      samples: this.doneSamples,
      seconds: this.doneSamples / cfg.sampleRate,
      lines: lines,
      outputWidth: cfg.width,
      peak: this.peak,
      clipped: this.clipped,
      elapsedMs: now() - this.t0,
      aborted: this.aborted,
      linePeriodMs: cfg.linePeriodMs,
      pixelRate: cfg.pixelRate,
      bandwidthHz: cfg.bandwidthHz,
      centreHz: cfg.centreHz,
      byteLength: this.doneSamples * 2 + 44
    };
  };

  /* =======================================================================
   * Image conditioning
   * ===================================================================== */

  /**
   * Extracts an 8-bit greyscale raster from an RGBA or grey pixel buffer.
   * @param {{width:number,height:number,data:ArrayLike<number>}} image
   * @param {{gray?:boolean, crop?:number[], invert?:boolean}} [opts]
   */
  function extractGray(image, opts) {
    opts = opts || {};
    var crop = opts.crop;
    var x0 = 0, y0 = 0, w = image.width, h = image.height;
    if (crop && crop.length === 4) {
      x0 = Math.max(0, Math.min(image.width - 1, crop[0] | 0));
      y0 = Math.max(0, Math.min(image.height - 1, crop[1] | 0));
      w = Math.max(1, Math.min(image.width - x0, crop[2] | 0));
      h = Math.max(1, Math.min(image.height - y0, crop[3] | 0));
    }
    var out = new Uint8Array(w * h);
    var data = image.data;
    var grayIn = !!opts.gray;

    for (var y = 0; y < h; y++) {
      var sy = y0 + y;
      for (var x = 0; x < w; x++) {
        var si = sy * image.width + (x0 + x);
        var v;
        if (grayIn) {
          v = data[si];
        } else {
          var i4 = si * 4;
          var r = data[i4], g = data[i4 + 1], b = data[i4 + 2], a = data[i4 + 3];
          // Rec.601 luma, composited over white so transparency reads as blank.
          var lum = 0.299 * r + 0.587 * g + 0.114 * b;
          if (a !== undefined && a < 255) lum = (lum * a + 255 * (255 - a)) / 255;
          v = lum;
        }
        out[y * w + x] = v < 0 ? 0 : (v > 255 ? 255 : v);
      }
    }
    var img = { width: w, height: h, data: out };
    // NOTE: inversion is *not* applied here. Doing it in extractGray as well as
    // in prepareRaster flipped the picture twice whenever a caller passed
    // `invert` through both paths.
    return img;
  }

  function invertGray(img) {
    var d = img.data;
    for (var i = 0; i < d.length; i++) d[i] = 255 - d[i];
    return img;
  }

  /**
   * Auto-contrast with 0.5 % tail clipping. Scans and JPEG-compressed charts
   * rarely reach true black and white; the drum expects a full-scale video
   * signal, so stretching the range recovers the intended contrast.
   */
  function autoContrast(img) {
    var hist = new Uint32Array(256), d = img.data, i;
    for (i = 0; i < d.length; i++) hist[d[i]]++;
    var total = d.length, clip = Math.floor((total * 0.5) / 100);
    var lo = 0, acc = 0;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc > clip) { lo = i; break; } }
    var hi = 255; acc = 0;
    for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc > clip) { hi = i; break; } }
    if (hi <= lo) return img;
    var scale = 255 / (hi - lo);
    for (i = 0; i < d.length; i++) {
      var v = Math.round((d[i] - lo) * scale);
      d[i] = v < 0 ? 0 : (v > 255 ? 255 : v);
    }
    return img;
  }

  function gammaGray(img, gamma) {
    var lut = new Uint8Array(256);
    for (var i = 0; i < 256; i++) {
      lut[i] = Math.min(255, Math.max(0, Math.round(Math.pow(i / 255, gamma) * 255)));
    }
    var d = img.data;
    for (var j = 0; j < d.length; j++) d[j] = lut[d[j]];
    return img;
  }

  /** Recursive Bayer cell value, 0..(n*n-1) for n = 2,4,8. */
  function bayerValue(x, y, bits) {
    var v = 0;
    for (var bit = bits - 1; bit >= 0; bit--) {
      var xb = (x >> bit) & 1;
      var yb = (y >> bit) & 1;
      var part = (xb === 0 && yb === 0) ? 0 : (xb === 1 && yb === 0) ? 2 : (xb === 0 && yb === 1) ? 3 : 1;
      v = v * 4 + part;
    }
    return v;
  }

  /**
   * Halftones the grey raster. Call this *after* resampling to the transmitted
   * resolution — dithering a high-resolution scan and then scaling it down
   * averages the pattern away and just yields grey again.
   */
  function ditherGray(img, mode) {
    var w = img.width, h = img.height, d = img.data, x, y, i;
    if (mode === 'none') return img;

    if (mode === 'bayer4' || mode === 'bayer8') {
      var bits = mode === 'bayer4' ? 2 : 3;
      var n = 1 << bits;
      var levels = n * n;
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          i = y * w + x;
          var t = (bayerValue(x & (n - 1), y & (n - 1), bits) + 0.5) / levels;
          d[i] = d[i] >= t * 255 ? 255 : 0;
        }
      }
      return img;
    }

    if (mode === 'fs') {
      var err = new Float32Array(w + 2);
      var next = new Float32Array(w + 2);
      for (y = 0; y < h; y++) {
        next.fill(0);
        for (x = 0; x < w; x++) {
          i = y * w + x;
          var val = d[i] + err[x + 1];
          var outv = val < 128 ? 0 : 255;
          d[i] = outv;
          var e = val - outv;
          err[x + 2] += (e * 7) / 16;
          next[x] += (e * 3) / 16;
          next[x + 1] += (e * 5) / 16;
          next[x + 2] += (e * 1) / 16;
        }
        var tmp = err; err = next; next = tmp;
      }
      return img;
    }
    return img;
  }

  /** Bilinear resample of an 8-bit grey raster. */
  function resampleBilinear(img, dw, dh) {
    var out = new Uint8Array(dw * dh);
    var xr = img.width <= 1 ? 0 : (img.width - 1) / Math.max(1, dw - 1);
    var yr = img.height <= 1 ? 0 : (img.height - 1) / Math.max(1, dh - 1);
    for (var y = 0; y < dh; y++) {
      var sy = y * yr;
      var y0 = Math.floor(sy);
      var y1 = Math.min(y0 + 1, img.height - 1);
      var fy = sy - y0;
      for (var x = 0; x < dw; x++) {
        var sx = x * xr;
        var x0 = Math.floor(sx);
        var x1 = Math.min(x0 + 1, img.width - 1);
        var fx = sx - x0;
        var p00 = img.data[y0 * img.width + x0];
        var p10 = img.data[y0 * img.width + x1];
        var p01 = img.data[y1 * img.width + x0];
        var p11 = img.data[y1 * img.width + x1];
        var top = p00 + (p10 - p00) * fx;
        var bot = p01 + (p11 - p01) * fx;
        out[y * dw + x] = Math.round(top + (bot - top) * fy);
      }
    }
    return { width: dw, height: dh, data: out };
  }

  /** Box-filter (area average) resample — used when shrinking, to avoid aliasing. */
  function resampleArea(img, dw, dh) {
    var sw = img.width, sh = img.height, src = img.data;
    var out = new Uint8Array(dw * dh);
    var xScale = sw / dw, yScale = sh / dh;
    for (var y = 0; y < dh; y++) {
      var sy0 = Math.floor(y * yScale);
      var sy1 = Math.min(sh, Math.max(sy0 + 1, Math.ceil((y + 1) * yScale)));
      for (var x = 0; x < dw; x++) {
        var sx0 = Math.floor(x * xScale);
        var sx1 = Math.min(sw, Math.max(sx0 + 1, Math.ceil((x + 1) * xScale)));
        var sum = 0, cnt = 0;
        for (var yy = sy0; yy < sy1; yy++) {
          var base = yy * sw;
          for (var xx = sx0; xx < sx1; xx++) { sum += src[base + xx]; cnt++; }
        }
        out[y * dw + x] = cnt ? Math.round(sum / cnt) : 0;
      }
    }
    return { width: dw, height: dh, data: out };
  }

  /** Shrinks with a box filter, enlarges with bilinear interpolation. */
  function resampleGray(img, dw, dh) {
    if (img.width === dw && img.height === dh) return img;
    var shrinking = dw < img.width || dh < img.height;
    return shrinking ? resampleArea(img, dw, dh) : resampleBilinear(img, dw, dh);
  }

  function resampleRow(row, sw, dw) {
    var out = new Uint8Array(dw);
    if (sw === dw) { out.set(row); return out; }
    var ratio = sw <= 1 ? 0 : (sw - 1) / (dw - 1);
    for (var x = 0; x < dw; x++) {
      var sx = x * ratio;
      var x0 = Math.floor(sx);
      var x1 = Math.min(x0 + 1, sw - 1);
      out[x] = Math.round(row[x0] + (row[x1] - row[x0]) * (sx - x0));
    }
    return out;
  }

  /* =======================================================================
   * High level API
   * ===================================================================== */

  /** Number of transmitted lines for an image, honouring aspect ratio. */
  function planLines(imageWidth, imageHeight, cfg) {
    var lines = cfg.preserveAspect
      ? Math.max(1, Math.min(cfg.maxLines, Math.round(imageHeight * (cfg.width / imageWidth))))
      : cfg.maxLines;
    var lineSamples = Math.round(cfg.samplesPerLine);
    var samples = lineSamples * (lines + cfg.stopBlackLines) +
      (cfg.phasingEnabled ? lineSamples : 0) +
      (cfg.startToneEnabled ? Math.round(cfg.sampleRate * cfg.startToneSeconds) : 0) +
      (cfg.stopToneEnabled ? Math.round(cfg.sampleRate * cfg.stopToneSeconds) : 0);
    return {
      lines: lines,
      samples: samples,
      seconds: samples / cfg.sampleRate,
      imageSeconds: (lines * 60) / cfg.lineRateLpm,
      drumSeconds: (cfg.ioc * 60) / cfg.lineRateLpm,
      linePeriodMs: cfg.linePeriodMs,
      pixelsPerLine: cfg.width,
      pixelRate: cfg.pixelRate,
      bytes: samples * 2 + 44,
      bandwidthHz: cfg.bandwidthHz,
      centreHz: cfg.centreHz
    };
  }

  /**
   * Full pipeline: source pixels -> conditioned raster at the transmitted
   * resolution. Split out so the UI can show exactly what will be sent.
   */
  function prepareRaster(image, imageOpts, cfg) {
    var img = extractGray(image, imageOpts);
    // Negative / positive film. `invert` comes from the configuration (that is
    // where the UI reads the checkbox into) but older callers pass it as an
    // image option — so the two forms are XOR'd into a single inversion rather
    // than OR'd, which would apply it twice and cancel out. It runs *before*
    // auto-contrast: the stretch must see the image in the polarity it will be
    // transmitted in.
    var wantInvert = !!cfg.invert !== !!(imageOpts && imageOpts.invert);
    if (wantInvert) invertGray(img);
    if (cfg.autoContrast) autoContrast(img);
    if (cfg.gamma && cfg.gamma !== 1) gammaGray(img, cfg.gamma);
    var plan = planLines(img.width, img.height, cfg);
    var raster = resampleGray(img, cfg.width, plan.lines);
    if (cfg.dither && cfg.dither !== 'none') ditherGray(raster, cfg.dither);
    raster.lines = plan.lines;
    raster.sourceWidth = img.width;
    raster.sourceHeight = img.height;
    raster.luminance = luminanceHistogram(raster);
    return raster;
  }

  /** 256-bin histogram of the transmitted raster, used for UI diagnostics. */
  function luminanceHistogram(raster) {
    var hist = new Uint32Array(256);
    var d = raster.data;
    for (var i = 0; i < d.length; i++) hist[d[i]]++;
    return hist;
  }

  /**
   * Encodes to a complete WAV.
   * @returns {{wav:ArrayBuffer, chunks:Int16Array[], stats:object, config:object, raster:object}}
   */
  function encodeToWav(image, imageOpts, cfgOverrides, opts) {
    var cfg = config(cfgOverrides);
    // Only `gray` and `crop` describe the input *buffer*. Image conditioning
    // (invert / auto-contrast / gamma / dither) is part of the configuration so
    // that a caller reaching prepareRaster directly and a caller going through
    // this helper cannot end up with different pictures.
    var raster = prepareRaster(image, {
      gray: !!(imageOpts && imageOpts.gray),
      crop: imageOpts && imageOpts.crop,
      invert: imageOpts && imageOpts.invert
    }, cfg);
    var sink = new ChunkSink();
    var enc = new Encoder(cfg, opts);
    var stats = enc.encodeRaster(raster, sink);
    var chunks = sink.finish();
    stats.sourceWidth = raster.sourceWidth;
    stats.sourceHeight = raster.sourceHeight;
    stats.lines = raster.lines;
    return {
      wav: buildWav(chunks, cfg.sampleRate, 1),
      chunks: chunks,
      stats: stats,
      config: cfg,
      raster: raster
    };
  }

  /**
   * Measures the black/white polarity that was actually written into the audio.
   *
   * A receiver draws white where the video frequency is low and black where it
   * is high, so the sign is measurable from the transmitted signal alone: the
   * median instantaneous frequency of the image area sits below the 1900 Hz
   * carrier for a positive picture and above it for a negative one.
   *
   * The mean luminance of the raster says which sign the picture *should* have,
   * so the two together detect an accidental inversion (for example a negative
   * scan, or the invert option left on) without needing a receiver.
   *
   * @param {Int16Array|ArrayLike<number>} pcm  the encoded audio
   * @param {object} cfg  the configuration the audio was produced with
   * @param {object} raster  the transmitted raster
   * @param {object} [ranges] { imageStart, imageEnd } in samples, to skip the
   *        phasing line and the stop sequence
   * @param {number} [referenceLuminance] mean luminance of the picture the user
   *        *meant* to send (the original image, before any invert option). Pass
   *        this to find out whether the transmission will look like a negative
   *        of that picture; omit it to judge the signal on its own.
   * @returns {{inverted:boolean, medianHz:number, blackFraction:number,
   *            expectedPositive:boolean, confidence:string, sampled:number}}
   */
  function checkPolarity(pcm, cfg, raster, ranges, referenceLuminance) {
    var rate = cfg.sampleRate;
    var lineSamples = Math.round(cfg.samplesPerLine);
    var start = (ranges && ranges.imageStart != null)
      ? ranges.imageStart
      : (lineSamples + (cfg.startToneEnabled ? Math.round(rate * cfg.startToneSeconds) : 0));
    var end = (ranges && ranges.imageEnd != null)
      ? ranges.imageEnd
      : (pcm.length - (cfg.stopToneEnabled ? Math.round(rate * cfg.stopToneSeconds) : 0));
    var count = end - start;
    if (count < rate / 10) {
      return {
        inverted: null, medianHz: cfg.centreHz, blackFraction: 0.5,
        expectedPositive: true, confidence: 'low', sampled: 0,
        note: 'the image region is too short to judge'
      };
    }

    // Direct comparison of the two levels the picture is actually made of.
    // Measuring at the band *endpoints* is not enough: a grey chart sits in the
    // middle of the band (240/255 -> 1547 Hz), so neither 1500 nor 2300 Hz
    // carries its energy and their ratio says nothing. Instead take the
    // dominant level of the raster, measure the tone power there, and compare it
    // with the same power mirrored about the 1900 Hz carrier — which is exactly
    // what an equally sized picture in the opposite sense would produce.
    //
    // The measurement is done *line by line*: the phase accumulator is
    // continuous inside a line but restarts at each line boundary, so
    // transforming thousands of lines at once cancels the tone almost entirely
    // (a 24-line window reported 6.1e3 at 1500 Hz against 1.9e5 at the level the
    // picture actually uses).
    var domLevel = dominantLevel(raster);
    var domHz = cfg.blackHz + (cfg.whiteHz - cfg.blackHz) * (domLevel / 255);
    var inverseHz = cfg.blackHz + cfg.whiteHz - domHz;   // mirrored about 1900 Hz
    var domPower = 0;
    var mirrorPower = 0;
    var lines = Math.max(1, Math.min(
      (raster && raster.height) || Math.floor(count / lineSamples) || 1,
      Math.floor(count / lineSamples) || 1));
    for (var li = 0; li < lines; li++) {
      var off = start + li * lineSamples;
      var len = Math.min(lineSamples, pcm.length - off);
      if (len < 64) break;
      domPower += goertzelBand(pcm, off, len, rate, domHz);
      mirrorPower += goertzelBand(pcm, off, len, rate, inverseHz);
    }
    var blackPower = domPower;
    var whitePower = mirrorPower;
    var total = domPower + mirrorPower;
    var domShare = total > 0 ? domPower / total : 0.5;

    // The dominant level says which side of mid grey the picture is on, so the
    // dominant tone maps back to a black/white area fraction.
    var domIsBlackSide = domLevel < 127.5;
    var blackFraction = domIsBlackSide ? domShare : 1 - domShare;
    blackFraction = Math.max(0, Math.min(1, blackFraction));

    // Where the picture actually sits in the band, for reporting.
    var medianHz = cfg.whiteHz + blackFraction * (cfg.blackHz - cfg.whiteHz);

    // The reference is the picture the user meant to send. Judging against the
    // *raster* would be circular: switching the invert option on makes the
    // raster dark, so the "expected" sign would flip with it and the check
    // could never see the inversion.
    var meanLum = meanLuminance(raster);
    var referenceLum = (typeof referenceLuminance === 'number' && isFinite(referenceLuminance))
      ? referenceLuminance
      : meanLum;
    var expectedPositive = referenceLum >= 127.5;   // a bright picture = positive
    var looksNegative = blackFraction > 0.5;
    // A dominant level near 128 means the picture is a flat mid grey: the sign
    // of such a transmission is genuinely undefined.
    var flatMidGrey = Math.abs(domLevel - 127.5) < 12;
    var confident = !flatMidGrey && Math.abs(domShare - 0.5) > 0.05;
    return {
      inverted: confident ? (looksNegative === expectedPositive) : null,
      medianHz: medianHz,
      blackFraction: blackFraction,
      dominantLevel: domLevel,
      blackPower: blackPower,
      whitePower: whitePower,
      meanLuminance: meanLum,
      referenceLuminance: referenceLum,
      expectedPositive: expectedPositive,
      confidence: confident ? 'high' : 'low',
      sampled: count,
      note: confident ? '' : 'the picture is close to mid grey, so the sign is not decisive'
    };
  }

  /** Most common luminance level in a raster (its dominant grey). */
  function dominantLevel(raster) {
    var d = raster && raster.data ? raster.data : raster;
    if (!d || !d.length) return 127.5;
    var hist = new Uint32Array(256);
    for (var i = 0; i < d.length; i++) hist[d[i]]++;
    var best = 0;
    for (var v = 1; v < 256; v++) if (hist[v] > hist[best]) best = v;
    return best;
  }

  /** One-frequency Goertzel power over a sample range. */
  function goertzelBand(samples, offset, count, rate, freq) {
    var k = (TWO_PI * freq) / rate;
    var coeff = 2 * Math.cos(k);
    var s1 = 0, s2 = 0, s0 = 0;
    for (var i = 0; i < count; i++) {
      s0 = samples[offset + i] / 32768 + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return s1 * s1 + s2 * s2 - coeff * s1 * s2;
  }

  /** Mean luminance (0…255) of a raster, or of a raw grey buffer. */
  function meanLuminance(rasterOrBuffer) {
    var d = rasterOrBuffer && rasterOrBuffer.data ? rasterOrBuffer.data : rasterOrBuffer;
    if (!d || !d.length) return 127.5;
    var sum = 0;
    for (var i = 0; i < d.length; i++) sum += d[i];
    return sum / d.length;
  }

  /**
   * Encodes only the head of a transmission (start tone + phasing + a few
   * lines) so the browser can audition the settings without materialising a
   * four-minute file. The stop sequence is trimmed as well: an audition should
   * be dominated by the modulation, not by five seconds of 450 Hz.
   */
  function encodePreview(image, imageOpts, cfgOverrides, previewLines, opts) {
    var cfg = config(cfgOverrides);
    // Rewrite the incoming overrides (which may already be a normalised config)
    // instead of normalising twice, so previews keep the same conditioning as
    // the real encode.
    var preview = {};
    for (var k in cfg) {
      if (Object.prototype.hasOwnProperty.call(cfg, k)) preview[k] = cfg[k];
    }
    preview.maxLines = Math.max(1, Math.min(cfg.maxLines, previewLines || 12));
    preview.stopToneSeconds = Math.min(cfg.stopToneSeconds, 0.5);
    preview.stopBlackLines = Math.min(cfg.stopBlackLines, 1);
    if (preview.startToneSeconds > 1) preview.startToneSeconds = 1;
    return encodeToWav(image, imageOpts, preview, opts);
  }

  return {
    LUT_SIZE: LUT_SIZE,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    PRESETS: PRESETS,
    config: config,
    Encoder: Encoder,
    ChunkSink: ChunkSink,
    wavHeader: wavHeader,
    buildWav: buildWav,
    extractGray: extractGray,
    invertGray: invertGray,
    autoContrast: autoContrast,
    gammaGray: gammaGray,
    ditherGray: ditherGray,
    resampleGray: resampleGray,
    resampleRow: resampleRow,
    resampleArea: resampleArea,
    resampleBilinear: resampleBilinear,
    planLines: planLines,
    prepareRaster: prepareRaster,
    encodeToWav: encodeToWav,
    encodePreview: encodePreview,
    checkPolarity: checkPolarity,
    meanLuminance: meanLuminance
  };
});
