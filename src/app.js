/*!
 * HF WEATHER FAX — single-file web app.
 *
 * Everything ships inside index.html: no build step, no server, no network.
 * This file is a *template*: tools/build.py splices src/hffax.js into it at the
 * `__HFFAX_ENGINE__` marker and writes the finished dist/index.html.
 */
/* eslint-env browser */
(function () {
  'use strict';

  var H = window.HFFAX;
  var PRESETS = H.PRESETS;
  var DEFAULTS = H.DEFAULT_CONFIG;

  /* ===================================================================
   * Small helpers
   * ================================================================= */

  function $(id) { return document.getElementById(id); }

  function setText(id, text) {
    var el = $(id);
    if (el) el.textContent = text;
  }

  function fmtSeconds(s) {
    if (!isFinite(s)) return '—';
    var m = Math.floor(s / 60);
    var sec = s - m * 60;
    return (m > 0 ? m + ' 分 ' : '') + sec.toFixed(1) + ' 秒';
  }

  function fmtBytes(b) {
    if (!isFinite(b)) return '—';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KiB';
    return (b / 1048576).toFixed(2) + ' MiB';
  }

  function toast(message, kind, ms) {
    var box = $('toast');
    var div = document.createElement('div');
    div.className = 'toast-item ' + (kind || 'info');
    div.textContent = message;
    box.appendChild(div);
    setTimeout(function () {
      div.classList.add('out');
      setTimeout(function () { if (div.parentNode) div.parentNode.removeChild(div); }, 400);
    }, ms || 3600);
  }

  /* ===================================================================
   * State
   * ================================================================= */

  var state = {
    image: null,          // {width, height, data: Uint8ClampedArray} in RGBA form
    imageName: '',
    sourceMeanLuminance: 127.5,   // mean brightness of the loaded picture
    crop: null,           // {x, y, w, h} in source pixels, or null for the whole image
    lastResult: null,     // {blob, url, stats, config, name, raster}
    signResult: null,     // last polarity self-check
    encoding: false,
    abort: false
  };

  var cfg = H.config({});
  var previewRaster = null;
  var previewToken = 0;

  /* ===================================================================
   * Loading a picture
   * ================================================================= */

  function loadImageFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type) && !/\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name || '')) {
      toast('请选择 PNG / JPEG / WebP / BMP 图片（浏览器无法直接解码 PDF）', 'warn', 5200);
      return;
    }
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      var canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      var data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      URL.revokeObjectURL(url);
      state.image = { width: canvas.width, height: canvas.height, data: data };
      state.imageName = file.name || 'clipboard.png';
      // Mean luminance of the *source* picture. The polarity self-check judges
      // the transmission against this, so switching the invert option on cannot
      // hide an inversion from the check.
      state.sourceMeanLuminance = meanLuminanceOfImage(data);
      state.crop = null;
      setCropInputs(null);
      invalidatePreview();
      setText('srcInfo', canvas.width + ' × ' + canvas.height + ' px · ' + state.imageName);
      $('btnClear').disabled = false;
      updateAll();
      toast('已载入 ' + canvas.width + '×' + canvas.height + ' 图像', 'ok');
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      toast('这个文件浏览器无法解码（PNG / JPEG / WebP / BMP 可以）', 'warn', 5200);
    };
    img.src = url;
  }

  function invalidatePreview() {
    previewRaster = null;
    previewToken++;
  }

  /** Mean Rec.601 luminance (0…255) of an RGBA pixel buffer. */
  function meanLuminanceOfImage(data) {
    if (!data || !data.length) return 127.5;
    var sum = 0;
    var n = 0;
    // Sample every 16th pixel: plenty for a mean, and instant on a 20 MP photo.
    for (var i = 0; i + 3 < data.length; i += 64) {
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      n++;
    }
    return n ? sum / n : 127.5;
  }

  function setCropInputs(crop) {
    var ids = ['cropX', 'cropY', 'cropW', 'cropH'];
    var keys = ['x', 'y', 'w', 'h'];
    for (var i = 0; i < ids.length; i++) {
      var el = $(ids[i]);
      if (!el) continue;
      el.value = crop ? crop[keys[i]] : '';
    }
  }

  function readCropInputs() {
    if (!state.image) return null;
    var x = parseFloat($('cropX').value);
    var y = parseFloat($('cropY').value);
    var w = parseFloat($('cropW').value);
    var h = parseFloat($('cropH').value);
    if (![x, y, w, h].every(function (v) { return isFinite(v) && v > 0 || v === 0; })) return null;
    if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return null;
    x = Math.max(0, Math.min(state.image.width - 1, x || 0));
    y = Math.max(0, Math.min(state.image.height - 1, y || 0));
    w = Math.min(state.image.width - x, w);
    h = Math.min(state.image.height - y, h);
    return { x: x, y: y, w: w, h: h };
  }

  /* ===================================================================
   * Configuration from the form
   * ================================================================= */

  function num(id, fallback) {
    var el = $(id);
    if (!el) return fallback;
    var v = parseFloat(el.value);
    return isFinite(v) ? v : fallback;
  }

  function bool(id) {
    var el = $(id);
    return !!(el && el.checked);
  }

  function str(id, fallback) {
    var el = $(id);
    return el ? el.value : fallback;
  }

  function readConfig() {
    var preset = PRESETS[str('preset', 'ioc576')] || {};
    var overrides = {
      sampleRate: num('sampleRate', DEFAULTS.sampleRate),
      lineRateLpm: num('lineRateLpm', DEFAULTS.lineRateLpm),
      ioc: num('ioc', DEFAULTS.ioc),
      width: num('width', DEFAULTS.width),
      maxLines: num('maxLines', DEFAULTS.maxLines),
      whiteHz: num('whiteHz', DEFAULTS.whiteHz),
      blackHz: num('blackHz', DEFAULTS.blackHz),
      modulation: str('modulation', DEFAULTS.modulation),
      polarity: str('polarity', DEFAULTS.polarity),
      outputLevel: num('outputLevel', DEFAULTS.outputLevel),
      pixelClock: str('pixelClock', DEFAULTS.pixelClock),
      phasingEnabled: bool('phasingEnabled'),
      phasingBlackPercent: num('phasingBlackPercent', DEFAULTS.phasingBlackPercent),
      startToneEnabled: bool('startToneEnabled'),
      startToneSeconds: num('startToneSeconds', DEFAULTS.startToneSeconds),
      startToneHz: num('startToneHz', DEFAULTS.startToneHz),
      stopToneEnabled: bool('stopToneEnabled'),
      stopToneSeconds: num('stopToneSeconds', DEFAULTS.stopToneSeconds),
      stopToneHz: num('stopToneHz', DEFAULTS.stopToneHz),
      stopBlackLines: num('stopBlackLines', DEFAULTS.stopBlackLines),
      preserveAspect: bool('preserveAspect'),
      autoContrast: bool('autoContrast'),
      invert: bool('invert'),
      gamma: num('gamma', DEFAULTS.gamma),
      dither: str('dither', DEFAULTS.dither),
      lowPassEnabled: bool('lowPassEnabled'),
      lowPassCutoffHz: num('lowPassCutoffHz', DEFAULTS.lowPassCutoffHz)
    };
    return H.config(overrides);
  }

  /* ===================================================================
   * Preview: exactly the raster that will be transmitted
   * ================================================================= */

  function renderPreview() {
    var canvas = $('preview');
    var ctx = canvas.getContext('2d');

    if (!state.image) {
      canvas.width = 640;
      canvas.height = 360;
      ctx.fillStyle = '#0a1120';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#5b6b85';
      ctx.font = '16px system-ui, "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('尚未载入图像 —— 拖入、粘贴或点击左上角选择图片', canvas.width / 2, canvas.height / 2);
      return null;
    }

    if (previewRaster) return previewRaster;

    var raster;
    try {
      raster = H.prepareRaster(state.image, {
        crop: state.crop ? [state.crop.x, state.crop.y, state.crop.w, state.crop.h] : null
      }, cfg);
    } catch (err) {
      toast('图像处理失败：' + (err && err.message ? err.message : err), 'warn', 6000);
      return null;
    }

    canvas.width = raster.width;
    canvas.height = raster.height;
    var idata = ctx.createImageData(raster.width, raster.height);
    var d = idata.data;
    for (var i = 0, p = 0; i < raster.data.length; i++, p += 4) {
      var v = raster.data[i];
      d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255;
    }
    ctx.putImageData(idata, 0, 0);

    previewRaster = raster;
    return raster;
  }

  /* ===================================================================
   * Estimates and warnings
   * ================================================================= */

  function updateAll() {
    cfg = readConfig();
    if (!previewRaster) renderPreview();
    var raster = previewRaster;

    if (raster) {
      var lineSamples = Math.round(cfg.samplesPerLine);
      var lines = raster.height;
      var samples = lineSamples * (lines + cfg.stopBlackLines) +
        (cfg.phasingEnabled ? lineSamples : 0) +
        (cfg.startToneEnabled ? Math.round(cfg.sampleRate * cfg.startToneSeconds) : 0) +
        (cfg.stopToneEnabled ? Math.round(cfg.sampleRate * cfg.stopToneSeconds) : 0);
      setText('estLines', lines + ' 行');
      setText('estCanvas', raster.width + ' × ' + raster.height + ' px');
      setText('estDuration', fmtSeconds(samples / cfg.sampleRate));
      setText('estSize', fmtBytes(samples * 2 + 44));
    } else {
      setText('estLines', '—');
      setText('estCanvas', '—');
      setText('estDuration', '—');
      setText('estSize', '—');
    }

    setText('estRate', (cfg.pixelRate / 1000).toFixed(2) + ' kpx/s · ' +
      cfg.linePeriodMs.toFixed(0) + ' ms/行 · ' + cfg.samplesPerPixel.toFixed(2) + ' 采样/像素');
    setText('estSpectrum', cfg.whiteHz + '–' + cfg.blackHz + ' Hz · 中心 ' +
      ((cfg.whiteHz + cfg.blackHz) / 2).toFixed(0) + ' Hz · 带宽 ' + cfg.bandwidthHz +
      ' Hz · 鼓周期 ' + ((cfg.ioc * 60) / cfg.lineRateLpm).toFixed(0) + ' s');

    var warn = [];
    if (cfg.sampleRate < 2 * Math.max(cfg.whiteHz, cfg.blackHz)) {
      warn.push('采样率 ' + cfg.sampleRate + ' Hz 不足以容纳 ' + Math.max(cfg.whiteHz, cfg.blackHz) +
        ' Hz 的视频信号（奈奎斯特要求 ≥ ' + 2 * Math.max(cfg.whiteHz, cfg.blackHz) +
        ' Hz），会产生混叠；建议 11025 Hz 以上，常用 48000 Hz');
    } else if (cfg.sampleRate < 11025) {
      warn.push('采样率 ' + cfg.sampleRate + ' Hz 可用但偏低，建议 11025 Hz 以上');
    }
    if (cfg.samplesPerPixel < 4) {
      warn.push('每像素只有 ' + cfg.samplesPerPixel.toFixed(2) +
        ' 个采样，量化噪声偏大：请提高采样率或减少每行像素数');
    }
    if (!cfg.phasingEnabled) {
      warn.push('未启用相位信号：多数接收机无法锁定行的起始位置');
    }
    if (cfg.phasingBlackPercent <= 0 || cfg.phasingBlackPercent >= 100) {
      warn.push('相位黑条比例应在 0–100 % 之间（WMO：IOC 576 用 5 %，IOC 288 用 10 %）');
    }
    if (cfg.startToneEnabled && cfg.startToneHz >= cfg.whiteHz) {
      warn.push('起始音 ' + cfg.startToneHz + ' Hz 落在视频频带内，接收机会把它当成图像');
    }
    if (cfg.stopToneEnabled && cfg.stopToneHz >= cfg.whiteHz) {
      warn.push('停止音 ' + cfg.stopToneHz + ' Hz 落在视频频带内');
    }
    if (cfg.lineRateLpm !== 60 && cfg.lineRateLpm !== 120) {
      warn.push('标准行速只有 60 与 120 行/分（当前 ' + cfg.lineRateLpm + '）');
    }
    if (cfg.outputLevel >= 0.99) {
      warn.push('输出电平接近满量程，容易削顶；建议 0.6–0.8');
    }

    var warnBox = $('warnings');
    warnBox.innerHTML = '';
    warn.forEach(function (w) {
      var d = document.createElement('div');
      d.className = 'warn-item';
      d.textContent = w;
      warnBox.appendChild(d);
    });
    warnBox.style.display = warn.length ? 'block' : 'none';

    $('btnEncode').disabled = !state.image || state.encoding;
  }

  /* ===================================================================
   * Encoding
   * ================================================================= */

  function encodeNow() {
    if (!state.image || state.encoding) return;
    cfg = readConfig();
    state.encoding = true;
    state.abort = false;
    $('btnEncode').disabled = true;
    $('btnCancel').disabled = false;
    $('progressWrap').classList.add('on');
    setProgress(0, '正在准备图像…');

    setTimeout(function () {
      var t0 = performance.now();
      try {
        var sink = new H.ChunkSink(1 << 19);
        var raster = H.prepareRaster(state.image, {
          crop: state.crop ? [state.crop.x, state.crop.y, state.crop.w, state.crop.h] : null
        }, cfg);
        var enc = new H.Encoder(cfg, {
          onProgress: function (done, total) {
            setProgress(done / total, '编码中 ' + fmtSeconds(done / cfg.sampleRate) +
              ' / ' + fmtSeconds(total / cfg.sampleRate));
          },
          shouldAbort: function () { return state.abort; }
        });
        var stats = enc.encodeRaster(raster, sink);
        if (state.abort) {
          toast('已取消编码', 'warn');
          resetEncodeUi();
          return;
        }
        var chunks = sink.finish();
        var parts = [H.wavHeader(stats.samples * 2, cfg.sampleRate, 1)].concat(chunks);
        var blob = new Blob(parts, { type: 'audio/wav' });
        finishEncode(blob, stats, cfg, performance.now() - t0, {
          raster: raster, chunks: chunks
        });
      } catch (err) {
        console.error(err);
        toast('编码失败：' + (err && err.message ? err.message : err), 'warn', 6000);
        resetEncodeUi();
      }
    }, 40);
  }

  function finishEncode(blob, stats, usedCfg, elapsedMs, extras) {
    extras = extras || {};
    if (state.lastResult && state.lastResult.url) URL.revokeObjectURL(state.lastResult.url);
    stopAudio();

    var url = URL.createObjectURL(blob);
    var base = (state.imageName || 'weatherfax').replace(/\.[^.]+$/, '');
    var name = base + '_' + usedCfg.lineRateLpm + 'lpm_' + usedCfg.whiteHz + '-' +
      usedCfg.blackHz + 'Hz.wav';

    state.lastResult = {
      blob: blob, url: url, stats: stats, config: usedCfg, name: name,
      raster: extras.raster || null, chunks: extras.chunks || null
    };
    $('btnDownload').disabled = false;
    $('btnShare').disabled = false;
    $('btnPlay').disabled = false;
    $('btnSignCheck').disabled = false;
    $('btnFlipPolarity').disabled = false;
    state.signResult = null;
    setSignReport('尚未检查。点上面的按钮会直接判定：这段音频在正常接收机上会不会显示成负像。', '');
    setText('resultName', name);
    setText('resSummary', stats.lines + ' 行 · ' + fmtSeconds(stats.seconds) + ' · ' +
      fmtBytes(blob.size) + ' · 峰值 ' + stats.peak.toFixed(3));
    setText('resTiming', '行周期 ' + stats.linePeriodMs.toFixed(0) + ' ms · 像素率 ' +
      (stats.pixelRate / 1000).toFixed(2) + ' kpx/s · 采样 ' + stats.samples.toLocaleString() +
      ' · 编码耗时 ' + Math.round(elapsedMs) + ' ms（' +
      (stats.seconds / (elapsedMs / 1000)).toFixed(0) + '× 实时）');
    $('result').classList.add('on');
    setProgress(1, '完成');
    resetEncodeUi();
    if (stats.clipped > 0) {
      toast('有 ' + stats.clipped + ' 个采样削顶，建议把输出电平降到 0.7 以下', 'warn', 6000);
    }
    toast('编码完成：' + stats.lines + ' 行 / ' + fmtSeconds(stats.seconds), 'ok');
  }

  function resetEncodeUi() {
    state.encoding = false;
    $('btnEncode').disabled = !state.image;
    $('btnCancel').disabled = true;
    setTimeout(function () { $('progressWrap').classList.remove('on'); }, 900);
  }

  function setProgress(frac, label) {
    var f = Math.max(0, Math.min(1, frac));
    $('progressBar').style.width = (f * 100).toFixed(2) + '%';
    if (label) setText('progressLabel', label);
    setText('progressPct', (f * 100).toFixed(1) + ' %');
  }

  /* ===================================================================
   * Black / white polarity self-check
   * =================================================================== */

  function setSignReport(html, cls) {
    var el = $('signReport');
    el.className = 'signreport' + (cls ? ' ' + cls : '');
    el.innerHTML = html;
  }

  /** Concatenate the chunk list of the last result into one Int16Array. */
  function pcmOfLastResult() {
    var r = state.lastResult;
    if (!r || !r.chunks) return null;
    var n = 0;
    for (var i = 0; i < r.chunks.length; i++) n += r.chunks[i].length;
    var pcm = new Int16Array(n);
    var off = 0;
    for (var j = 0; j < r.chunks.length; j++) { pcm.set(r.chunks[j], off); off += r.chunks[j].length; }
    return pcm;
  }

  /** The image-area sample range of the last result (skips phasing and tones). */
  function imageRangeOf(used, length) {
    var line = Math.round(used.samplesPerLine);
    return {
      imageStart: (used.startToneEnabled ? Math.round(used.sampleRate * used.startToneSeconds) : 0) +
        (used.phasingEnabled ? line : 0),
      imageEnd: length - Math.round(used.sampleRate * (used.stopToneEnabled ? used.stopToneSeconds : 0))
    };
  }

  function runSignCheck() {
    var r = state.lastResult;
    if (!r) return;
    var cfgUsed = r.config;
    var pcm = pcmOfLastResult();
    if (!pcm) {
      setSignReport('这段结果没有保留音频数据，请重新编码后再检查。', 'unknown');
      return;
    }
    var res = H.checkPolarity(pcm, cfgUsed, r.raster,
      imageRangeOf(cfgUsed, pcm.length), state.sourceMeanLuminance);
    state.signResult = res;

    var detail = '图像区黑/白能量比 ' + (res.blackFraction * 100).toFixed(1) + ' %' +
      ' · 主电平 ' + res.dominantLevel + '/255' +
      ' · 图像平均亮度 ' + res.referenceLuminance.toFixed(0) + '/255';

    if (res.confidence === 'low') {
      setSignReport('无法判定：' + (res.note || '画面接近中灰，正负像在信号上本就不可区分。') +
        '<br><span class="hint">' + detail + '</span>', 'unknown');
      return;
    }
    if (res.inverted) {
      setSignReport(
        '<strong>这段音频是负像</strong> —— 正常接收机会显示成底片效果。<br>' +
        '点「反色并重编」立刻修正；或者保持现状，改由接收端打开图像反相。<br>' +
        '<span class="hint">' + detail + '</span>', 'bad');
    } else {
      setSignReport(
        '<strong>极性正常</strong> —— 这是一幅正像，接收机应按正常黑白显示。<br>' +
        '<span class="hint">' + detail + '</span>', 'ok');
    }
  }

  /**
   * Make the next transmission the opposite of what was just produced. The
   * button always delivers an inversion, so this is a deliberate toggle, not a
   * "fix if broken" action: when the check says the audio is already a negative
   * the inversion is turned *off*, otherwise it is turned on.
   */
  function flipPolarityAndReencode() {
    var r = state.lastResult;
    if (!r) return;
    var used = r.config;
    var pcm = pcmOfLastResult();
    var res = pcm ? H.checkPolarity(pcm, used, r.raster,
      imageRangeOf(used, pcm.length), state.sourceMeanLuminance) : null;

    var want;
    if (res && res.inverted === true) want = false;       // already a negative -> back to positive
    else if (res && res.inverted === false) want = true;  // positive -> make a negative
    else want = !$('invert').checked;                     // undecidable -> just toggle

    $('invert').checked = want;
    invalidatePreview();
    updateAll();
    toast(want ? '已勾选反相，正在重新编码…' : '已取消反相，正在重新编码…', 'ok');
    encodeNow();
  }

  /* ===================================================================
   * Playback
   * ================================================================= */

  var audioCtx = null;
  var sourceNode = null;

  function stopAudio() {
    if (sourceNode) {
      try { sourceNode.stop(); } catch (e) { /* already stopped */ }
      sourceNode = null;
    }
    var btn = $('btnPlay');
    if (btn) btn.textContent = '▶ 试听';
  }

  function playEncoded() {
    if (!state.lastResult) return;
    if (sourceNode) { stopAudio(); setText('playNote', ''); return; }
    if (!audioCtx) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) { toast('此浏览器不支持 Web Audio', 'warn'); return; }
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    setText('playNote', '正在解码 WAV…');
    var reader = new FileReader();
    reader.onload = function () {
      audioCtx.decodeAudioData(reader.result, function (decoded) {
        var gain = audioCtx.createGain();
        gain.gain.value = 0.85;
        gain.connect(audioCtx.destination);
        sourceNode = audioCtx.createBufferSource();
        sourceNode.buffer = decoded;
        sourceNode.connect(gain);
        sourceNode.onended = function () { stopAudio(); setText('playNote', '播放结束'); };
        sourceNode.start();
        $('btnPlay').textContent = '■ 停止';
        setText('playNote', '正在播放整段传真音频（' + fmtSeconds(decoded.duration) + '）');
      }, function () {
        setText('playNote', '浏览器无法解码这段音频，请保存后用播放器试听');
      });
    };
    reader.readAsArrayBuffer(state.lastResult.blob);
  }

  /* ===================================================================
   * Saving and sharing
   * ================================================================= */

  function downloadResult() {
    if (!state.lastResult) return;
    var a = document.createElement('a');
    a.href = state.lastResult.url;
    a.download = state.lastResult.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast('已保存：' + state.lastResult.name, 'ok', 5000);
  }

  function shareResult() {
    if (!state.lastResult) return;
    var file = new File([state.lastResult.blob], state.lastResult.name, { type: 'audio/wav' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({
        files: [file],
        title: state.lastResult.name,
        text: 'HF 气象传真音频（' + state.lastResult.config.lineRateLpm + ' lpm，' +
          state.lastResult.config.whiteHz + '–' + state.lastResult.config.blackHz + ' Hz）'
      }).then(function () {
        toast('已分享', 'ok');
      }).catch(function (err) {
        if (!err || err.name !== 'AbortError') toast('分享被取消或失败，请改用“保存 WAV”', 'warn');
      });
    } else {
      toast('此浏览器不支持分享文件，请改用“保存 WAV”', 'warn', 5000);
    }
  }

  /* ===================================================================
   * Presets and wiring
   * ================================================================= */

  function fillFormFrom(source) {
    Object.keys(source).forEach(function (k) {
      var el = $(k);
      if (!el) return;
      var v = source[k];
      if (el.type === 'checkbox') el.checked = !!v;
      else if (v !== undefined && v !== null) el.value = v;
    });
  }

  function applyPreset(name, quiet) {
    var p = PRESETS[name];
    if (!p) return;
    // Start from the library defaults, then let the preset override them, so a
    // preset can never silently inherit a value left over from another preset.
    fillFormFrom(DEFAULTS);
    fillFormFrom(p);
    $('preset').value = name;
    invalidatePreview();
    updateAll();
    if (!quiet) toast('已应用预设：' + p.label, 'ok');
  }

  function init() {
    var sel = $('preset');
    Object.keys(PRESETS).forEach(function (key) {
      var opt = document.createElement('option');
      opt.value = key;
      opt.textContent = PRESETS[key].label;
      sel.appendChild(opt);
    });
    applyPreset('ioc576', true);

    // ---- live re-computation -------------------------------------------
    var debounce = null;
    function onChange(ev) {
      if (!ev.target.closest('#panel')) return;
      if (ev.target.id === 'preset') return;
      if (['cropX', 'cropY', 'cropW', 'cropH'].indexOf(ev.target.id) >= 0) {
        state.crop = readCropInputs();
        setCropInputs(state.crop);
      }
      invalidatePreview();
      clearTimeout(debounce);
      debounce = setTimeout(updateAll, 120);
    }
    $('panel').addEventListener('input', onChange);
    $('panel').addEventListener('change', onChange);
    sel.addEventListener('change', function () { applyPreset(this.value); });

    // ---- picture input --------------------------------------------------
    $('fileInput').addEventListener('change', function () {
      if (this.files && this.files[0]) loadImageFile(this.files[0]);
    });
    var drop = $('dropZone');
    ['dragenter', 'dragover'].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('hot'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('hot'); });
    });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        loadImageFile(e.dataTransfer.files[0]);
      }
    });
    window.addEventListener('paste', function (e) {
      if (!e.clipboardData) return;
      for (var i = 0; i < e.clipboardData.items.length; i++) {
        var it = e.clipboardData.items[i];
        if (it.type && it.type.indexOf('image') === 0) {
          loadImageFile(it.getAsFile());
          break;
        }
      }
    });

    $('btnClear').addEventListener('click', function () {
      state.image = null;
      state.imageName = '';
      state.crop = null;
      invalidatePreview();
      setCropInputs(null);
      setText('srcInfo', '未载入图像');
      $('btnClear').disabled = true;
      $('btnDownload').disabled = true;
      $('btnShare').disabled = true;
      $('btnPlay').disabled = true;
      $('btnSignCheck').disabled = true;
      $('btnFlipPolarity').disabled = true;
      state.lastResult = null;
      state.signResult = null;
      setSignReport('尚未检查。点上面的按钮会直接判定：这段音频在正常接收机上会不会显示成负像。', '');
      $('result').classList.remove('on');
      stopAudio();
      updateAll();
    });

    $('btnAutoLines').addEventListener('click', function () {
      if (!state.image) return;
      var plan = H.planLines(state.image.width, state.image.height, readConfig());
      $('maxLines').value = plan.lines;
      $('preserveAspect').checked = true;
      invalidatePreview();
      updateAll();
      toast('按图像比例自动设为 ' + plan.lines + ' 行', 'ok');
    });

    $('btnCropAll').addEventListener('click', function () {
      state.crop = null;
      setCropInputs(null);
      invalidatePreview();
      updateAll();
      toast('已恢复为整幅图像', 'ok');
    });

    $('btnEncode').addEventListener('click', encodeNow);
    $('btnCancel').addEventListener('click', function () {
      state.abort = true;
      setText('progressLabel', '正在取消…');
    });
    $('btnDownload').addEventListener('click', downloadResult);
    $('btnShare').addEventListener('click', shareResult);
    $('btnPlay').addEventListener('click', playEncoded);
    $('btnSignCheck').addEventListener('click', runSignCheck);
    $('btnFlipPolarity').addEventListener('click', flipPolarityAndReencode);

    // ---- keyboard -------------------------------------------------------
    window.addEventListener('keydown', function (e) {
      var tag = e.target && e.target.tagName;
      if (tag && /INPUT|TEXTAREA|SELECT/.test(tag)) return;
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); encodeNow(); }
      else if (e.key.toLowerCase() === 's' && (e.ctrlKey || e.metaKey) && state.lastResult) {
        e.preventDefault(); downloadResult();
      } else if (e.key === ' ') { e.preventDefault(); playEncoded(); }
    });

    var caps = [];
    caps.push('Web Audio ' + ((window.AudioContext || window.webkitAudioContext) ? '✓' : '✗'));
    caps.push('分享文件 ' + (navigator.canShare ? '✓' : '✗'));
    caps.push('FileReader ✓');
    caps.push('完全离线 ✓');
    setText('caps', caps.join(' · '));

    updateAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
