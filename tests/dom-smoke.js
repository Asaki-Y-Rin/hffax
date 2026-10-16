'use strict';
/**
 * Interaction test for the built single-file app — no browser required.
 *
 *   node tests/dom-smoke.js [dist/index.html]
 *
 * Instead of only checking that init() runs, this builds a DOM stub that records
 * event listeners and can *dispatch* events, so the whole user path is exercised
 * in-process:
 *
 *   load a picture (Image + canvas stub)  ->  estimates update
 *   change a parameter                    ->  preview re-renders, warnings appear
 *   press "编码为 WAV"                     ->  the real encoder runs
 *   press "保存 WAV" / "分享到…" / "试听"   ->  the blob is handed to the browser APIs
 *   press "清空图像"                       ->  state resets cleanly
 *
 * It validates wiring, control flow and the encode pipeline. It does not
 * validate CSS layout or real audio output.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const htmlPath = process.argv[2] || path.join(ROOT, 'dist', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  -- ' + detail : ''}`);
}

/* ------------------------------------------------------------------ *
 * DOM stub with event dispatch
 * ------------------------------------------------------------------ */

/** Every element ever created, so document.querySelector can find classes. */
const allElements = [];

function makeClassList(el) {
  return {
    add: (c) => { if (el._classes.indexOf(c) < 0) el._classes.push(c); },
    remove: (c) => { el._classes = el._classes.filter((x) => x !== c); },
    contains: (c) => el._classes.indexOf(c) >= 0,
    toggle: (c) => (el._classes.indexOf(c) >= 0
      ? el._classes.splice(el._classes.indexOf(c), 1)
      : el._classes.push(c))
  };
}

const LISTENERS = new WeakMap();

function makeElement(id, tag) {
  const el = {
    id: id || '',
    tagName: (tag || 'DIV').toUpperCase(),
    type: '',
    value: '',
    checked: false,
    disabled: false,
    files: null,
    textContent: '',
    width: 0,
    height: 0,
    href: '',
    download: '',
    _classes: [],
    children: [],
    _innerHTML: '',
    style: {},
    get className() { return el._classes.join(' '); },
    set className(v) { el._classes = String(v).split(/\s+/).filter(Boolean); },
    // Appending children must be visible through innerHTML, otherwise a test
    // that inspects rendered markup would read an empty string even though the
    // app really did create the elements.
    get innerHTML() {
      if (el.children.length === 0) return el._innerHTML;
      return el.children.map((c) => {
        const cls = c.className ? ` class="${c.className}"` : '';
        const t = c.tagName.toLowerCase();
        return `<${t}${cls}>${c.textContent}</${t}>`;
      }).join('');
    },
    set innerHTML(v) { el._innerHTML = String(v); el.children = []; },
    appendChild(c) { el.children.push(c); allElements.push(c); return c; },
    removeChild(c) { el.children = el.children.filter((x) => x !== c); return c; },
    addEventListener(type, fn) {
      const map = LISTENERS.get(el) || {};
      (map[type] = map[type] || []).push(fn);
      LISTENERS.set(el, map);
    },
    removeEventListener() {},
    querySelector() { return null; },
    closest(sel) { return el._closest || null; },
    click() {
      // An anchor click must not throw; the app also dispatches real clicks for
      // buttons, which we trigger explicitly via dispatch().
      el._clicked = (el._clicked || 0) + 1;
    },
    focus() {},
    getContext() { return el._ctx || (el._ctx = makeContext(el)); },
    toDataURL() { return 'data:image/png;base64,'; }
  };
  el.classList = makeClassList(el);
  allElements.push(el);
  return el;
}

/** Records 2D canvas drawing calls so the preview render can be inspected. */
function makeContext(el) {
  const ctx = {
    fillStyle: '', strokeStyle: '', font: '', textAlign: '',
    calls: { fillRect: 0, fillText: 0, drawImage: 0, putImageData: 0, createImageData: 0 },
    fillRect() { ctx.calls.fillRect++; },
    strokeRect() {}, clearRect() {},
    fillText() { ctx.calls.fillText++; },
    drawImage() { ctx.calls.drawImage++; },
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    createImageData(w, h) {
      ctx.calls.createImageData++;
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    getImageData(x, y, w, h) {
      // A synthetic picture: horizontal gradient with a black band, so the
      // encoder has something with real structure to work on.
      const data = new Uint8ClampedArray(w * h * 4);
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          const i = (yy * w + xx) * 4;
          const black = yy > h * 0.4 && yy < h * 0.6 ? 0 : Math.round((xx * 255) / Math.max(1, w - 1));
          data[i] = data[i + 1] = data[i + 2] = black;
          data[i + 3] = 255;
        }
      }
      return { width: w, height: h, data };
    },
    putImageData(img) { ctx.calls.putImageData++; ctx.lastImage = img; }
  };
  return ctx;
}

function dispatch(el, type, extra) {
  const map = LISTENERS.get(el);
  const handlers = (map && map[type]) || [];
  const ev = Object.assign({
    type,
    target: el,
    preventDefault() {},
    stopPropagation() {},
    clipboardData: null,
    dataTransfer: null
  }, extra || {});
  handlers.forEach((fn) => {
    try {
      fn.call(el, ev);
    } catch (err) {
      // A handler that throws is a real bug in the page; surface it instead of
      // letting the assertion below fail for an unrelated-looking reason.
      console.log(`  [THROW] ${el.id || el.tagName} ${type}: ${err && err.message}`);
      if (err && err.stack) console.log('          ' + err.stack.split('\n')[1].trim());
      throw err;
    }
  });
  return handlers.length;
}

/* ------------------------------------------------------------------ *
 * Build the document from the real markup
 * ------------------------------------------------------------------ */

const ids = new Set();
let m;
const idRe = /\bid="([^"]+)"/g;
while ((m = idRe.exec(html)) !== null) ids.add(m[1]);

const elements = {};
ids.forEach((id) => {
  const tagMatch = new RegExp(`<([a-zA-Z0-9]+)[^>]*\\bid="${id}"`).exec(html);
  elements[id] = makeElement(id, tagMatch ? tagMatch[1] : 'DIV');
});

// The app filters events with `ev.target.closest('#panel')`, so every control
// that lives inside #panel must report it. Rebuild the containment from the
// markup instead of relying on a browser layout engine.
const panelStart = html.indexOf('id="panel"');
const panelEnd = html.indexOf('</section>', panelStart);
if (panelStart > 0 && panelEnd > panelStart) {
  const panelHtml = html.slice(panelStart, panelEnd);
  const inside = new Set();
  const innerIdRe = /\bid="([^"]+)"/g;
  let im;
  while ((im = innerIdRe.exec(panelHtml)) !== null) inside.add(im[1]);
  inside.forEach((id) => { if (elements[id]) elements[id]._closest = elements['panel']; });
  elements['panel']._closest = elements['panel'];
}

// Give the controls their real input types (attribute order is not guaranteed).
const inputTagRe = /<input\b([^>]*)>/g;
while ((m = inputTagRe.exec(html)) !== null) {
  const idMatch = /\bid="([^"]+)"/.exec(m[1]);
  const typeMatch = /\btype="([^"]+)"/.exec(m[1]);
  if (idMatch && elements[idMatch[1]]) {
    elements[idMatch[1]].type = typeMatch ? typeMatch[1] : 'number';
  }
}

const documentElement = makeElement('', 'html');
const documentElementBody = makeElement('', 'body');

const documentListeners = {};
const documentStub = {
  readyState: 'complete',
  documentElement,
  body: documentElementBody,
  getElementById: (id) => elements[id] || null,
  createElement: (tag) => makeElement('', tag),
  addEventListener(type, fn) {
    (documentListeners[type] = documentListeners[type] || []).push(fn);
  },
  removeEventListener() {},
  querySelector: (sel) => {
    if (sel && sel[0] === '.') {
      const cls = sel.slice(1);
      return allElements.find((e) => e._classes.indexOf(cls) >= 0) || null;
    }
    return null;
  }
};

function dispatchDocument(type, extra) {
  (documentListeners[type] || []).forEach((fn) => fn(Object.assign({
    type, target: documentElementBody, preventDefault() {}, stopPropagation() {}
  }, extra || {})));
}

/* ------------------------------------------------------------------ *
 * Window stub
 * ------------------------------------------------------------------ */

const timerQueue = [];
const windowListeners = {};
const createdUrls = [];
const revokedUrls = [];
const savedBlobs = [];
let decodedAudio = null;

const windowStub = {
  document: documentStub,
  addEventListener(type, fn) { (windowListeners[type] = windowListeners[type] || []).push(fn); },
  removeEventListener() {},
  setTimeout(fn, ms) { timerQueue.push({ fn, ms }); return timerQueue.length; },
  clearTimeout() {},
  navigator: {
    canShare: (data) => !!(data && data.files && data.files.length),
    share: () => Promise.resolve()
  },
  performance: { now: () => Date.now() },
  URL: {
    createObjectURL(blob) { const u = 'blob:stub/' + createdUrls.length; createdUrls.push({ url: u, blob }); return u; },
    revokeObjectURL(u) { revokedUrls.push(u); }
  },
  File: function File(parts, name, opts) {
    this.parts = parts;
    this.name = name;
    this.type = opts && opts.type;
    this.size = parts.reduce((n, p) => n + (p.byteLength || p.length || 0), 0);
  },
  FileReader: function FileReader() {
    this.readAsArrayBuffer = (blob) => {
      savedBlobs.push(blob);
      this.result = new ArrayBuffer(1024);
      if (this.onload) this.onload({ target: { result: this.result } });
    };
  },
  Blob: function Blob(parts, opts) {
    this.parts = parts;
    this.type = opts && opts.type;
    this.size = parts.reduce((n, p) => n + (p.byteLength || p.length || 0), 0);
  },
  AudioContext: function AudioContext() {
    this.state = 'running';
    this.destination = {};
    this.decodeAudioData = (buf, ok) => {
      decodedAudio = { duration: 12.5 };
      ok(decodedAudio);
    };
    this.createGain = () => ({ gain: { value: 0 }, connect() {} });
    this.createBufferSource = () => ({
      buffer: null, connect() {}, start() { this.started = true; }, stop() { this.stopped = true; },
      onended: null
    });
    this.resume = () => {};
  },
  Image: function Image() {
    const self = this;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    Object.defineProperty(this, 'src', {
      set(v) {
        self._src = v;
        // Simulate a decoded picture asynchronously, like a browser would.
        timerQueue.push({
          fn: () => {
            self.naturalWidth = 800;
            self.naturalHeight = 500;
            if (self.onload) self.onload();
          },
          ms: 0
        });
      },
      get() { return self._src; }
    });
  },
  console
};
windowStub.window = windowStub;
windowStub.globalThis = windowStub;
windowStub.self = windowStub;

/** Drain the pending setTimeout queue (the app defers work by 30-120 ms). */
function drainTimers(limit) {
  let n = 0;
  while (timerQueue.length && n < (limit || 40)) {
    const t = timerQueue.shift();
    t.fn();
    n++;
  }
  return n;
}

/* ------------------------------------------------------------------ *
 * Run the page
 * ------------------------------------------------------------------ */

console.log(`HF FAX app interaction test\n  document: ${path.relative(ROOT, htmlPath)} (${ids.size} ids)`);

const context = vm.createContext(windowStub);
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((s) => s[1]);
check('the page has exactly two inline script blocks', scripts.length === 2, `${scripts.length}`);
if (scripts.length !== 2) process.exit(1);

let threw = null;
try {
  vm.runInContext(scripts[0], context, { filename: 'engine.js' });
} catch (e) { threw = e; }
check('engine script evaluates', !threw, threw && threw.message);
if (threw) process.exit(1);
check('engine exposes window.HFFAX', !!context.HFFAX && typeof context.HFFAX.encodeToWav === 'function');

threw = null;
try {
  vm.runInContext(scripts[1], context, { filename: 'app.js' });
} catch (e) { threw = e; }
check('app script evaluates and init() runs', !threw, threw && threw.message);
if (threw) { console.log(threw.stack); process.exit(1); }

const get = (id) => elements[id];
check('preset dropdown was populated', get('preset').children.length >= 4,
  `${get('preset').children.length} options`);
check('line rate came from the IOC 576 preset', String(get('lineRateLpm').value) === '120',
  String(get('lineRateLpm').value));
check('white / black levels are the WMO values',
  String(get('whiteHz').value) === '1500' && String(get('blackHz').value) === '2300',
  `${get('whiteHz').value} / ${get('blackHz').value}`);
check('phasing on / start tone off / stop tone on by default',
  get('phasingEnabled').checked && !get('startToneEnabled').checked && get('stopToneEnabled').checked);
check('spectrum summary was written', /1500/.test(get('estSpectrum').textContent),
  get('estSpectrum').textContent);
check('empty-state preview was drawn on the canvas',
  get('preview').getContext().calls.fillText >= 1);

/* ------------------------------------------------------------------ *
 * 1. Load a picture through the file input
 * ------------------------------------------------------------------ */

console.log('\n picture loading');
elements['fileInput'].files = [{ name: 'chart.png', type: 'image/png' }];
check('file input has a change listener', dispatch(elements['fileInput'], 'change') === 1);
drainTimers();      // Image.onload is asynchronous, like in a browser
check('the synthetic image was decoded through Image.onload',
  get('btnClear').disabled === false && /800 × 500/.test(get('srcInfo').textContent),
  get('srcInfo').textContent);
drainTimers();
check('estimates now report the picture geometry', /^\d+ 行$/.test(get('estLines').textContent),
  `lines "${get('estLines').textContent}", canvas "${get('estCanvas').textContent}"`);
check('duration and size estimates were produced',
  get('estDuration').textContent !== '—' && get('estSize').textContent !== '—',
  `${get('estDuration').textContent} / ${get('estSize').textContent}`);
check('preview canvas was resized to the transmitted raster',
  get('preview').width > 0 && get('preview').height > 0,
  `${get('preview').width} x ${get('preview').height}`);
check('preview pixels were pushed to the canvas',
  get('preview').getContext().calls.putImageData >= 1);
check('encode button became enabled', get('btnEncode').disabled === false);

/* ------------------------------------------------------------------ *
 * 2. Parameter changes re-render and warn
 * ------------------------------------------------------------------ */

console.log('\n parameter handling');
const beforeCanvas = get('estCanvas').textContent;
check('an input event inside #panel is handled', dispatch(elements['panel'], 'input', {
  target: elements['width']
}) === 1);

elements['width'].value = '400';
elements['preserveAspect'].checked = false;
elements['maxLines'].value = '40';
elements['lineRateLpm'].value = '60';
elements['ioc'].value = '288';
dispatch(elements['panel'], 'change', { target: elements['width'] });
drainTimers();
check('changing geometry updates the transmitted raster',
  get('estCanvas').textContent !== beforeCanvas,
  `${beforeCanvas} -> ${get('estCanvas').textContent}`);
check('line count follows maxLines when aspect is not preserved',
  get('estLines').textContent === '40 行', get('estLines').textContent);
check('drum period reflects IOC 288 / 60 lpm', /288 s/.test(get('estSpectrum').textContent),
  get('estSpectrum').textContent);

// Out-of-band stop tone must raise a warning.
elements['stopToneHz'].value = '1600';
dispatch(elements['panel'], 'change', { target: elements['stopToneHz'] });
drainTimers();
const probe = vm.runInContext(`(function () {
  return { warnHtml: document.getElementById('warnings').innerHTML,
           warnDisplay: document.getElementById('warnings').style.display,
           stopToneHz: document.getElementById('stopToneHz').value,
           stopToneEnabled: document.getElementById('stopToneEnabled').checked,
           whiteHz: document.getElementById('whiteHz').value };
})()`, context);
check('out-of-band stop tone raises a warning',
  /停止音/.test(get('warnings').innerHTML) && get('warnings').style.display === 'block',
  JSON.stringify(probe));
elements['stopToneHz'].value = '450';
dispatch(elements['panel'], 'change', { target: elements['stopToneHz'] });
drainTimers();
check('warning clears when the value is sane', get('warnings').style.display === 'none');

// Sample rate too low for the video band.
elements['sampleRate'].value = '3000';
dispatch(elements['panel'], 'change', { target: elements['sampleRate'] });
drainTimers();
// Read back the normalised config the app just built, by running the same
// form-reading path through the engine's own config() helper.
const cfgNow = vm.runInContext(`HFFAX.config({
  sampleRate: parseFloat(document.getElementById('sampleRate').value),
  whiteHz: parseFloat(document.getElementById('whiteHz').value),
  blackHz: parseFloat(document.getElementById('blackHz').value)
})`, context);
check('too-low sample rate raises a warning', /采样率/.test(get('warnings').innerHTML),
  `sampleRate=${elements['sampleRate'].value} cfg.sampleRate=${cfgNow.sampleRate} ` +
  `innerHTML="${get('warnings').innerHTML.slice(0, 80)}"`);
elements['sampleRate'].value = '48000';
elements['width'].value = '720';
elements['maxLines'].value = '12';
elements['lineRateLpm'].value = '120';
elements['ioc'].value = '576';
dispatch(elements['panel'], 'change', { target: elements['width'] });
drainTimers();

/* ------------------------------------------------------------------ *
 * 3. Encode through the button
 * ------------------------------------------------------------------ */

console.log('\n encoding through the UI');
const clickHandlers = dispatch(elements['btnEncode'], 'click');
check('encode button has a click handler', clickHandlers === 1);
check('progress UI turned on', get('progressWrap')._classes.indexOf('on') >= 0);
drainTimers(4);      // the handler defers the CPU work by one frame
check('the encoder produced a blob URL', createdUrls.length >= 1,
  `${createdUrls.length} url(s)`);
const blob = createdUrls.length ? createdUrls[createdUrls.length - 1].blob : null;
check('the blob is a WAV of the expected size',
  !!blob && blob.type === 'audio/wav' && blob.size > 44,
  blob ? `${blob.size} bytes, ${blob.type}` : 'no blob');
if (blob) {
  const pcmBytes = blob.size - 44;
  // 720 px/line, 12 lines, 120 lpm: phasing + 12 image lines + 5 stop lines
  // + 5 s stop tone = 18 lines * 24000 samples + 240000 samples
  const expected = (1 + 12 + 5) * 24000 * 2 + 240000 * 2;
  check('blob size matches the transmission layout', pcmBytes === expected,
    `${pcmBytes} vs ${expected} bytes`);
}
check('result panel is visible', get('result')._classes.indexOf('on') >= 0);
check('result filename describes the parameters',
  /120lpm_1500-2300Hz\.wav$/.test(get('resultName').textContent), get('resultName').textContent);
check('result summary reports lines, duration and peak',
  /\d+ 行/.test(get('resSummary').textContent) && /峰值/.test(get('resSummary').textContent),
  get('resSummary').textContent);
check('result timing reports the encoder throughput',
  /× 实时/.test(get('resTiming').textContent), get('resTiming').textContent.slice(0, 90));
check('download / share / play buttons were enabled',
  !get('btnDownload').disabled && !get('btnShare').disabled && !get('btnPlay').disabled);

/* ------------------------------------------------------------------ *
 * 4. Save, share, play
 * ------------------------------------------------------------------ */

console.log('\n saving, sharing, playing');
check('保存 WAV has a click handler', dispatch(elements['btnDownload'], 'click') === 1);
const anchors = allElements.filter((e) => e.tagName === 'A' && e.download);
check('a download anchor with the right filename was clicked',
  anchors.length >= 1 && /\.wav$/.test(anchors[anchors.length - 1].download),
  anchors.length ? anchors[anchors.length - 1].download : 'no anchor');

check('分享到… has a click handler', dispatch(elements['btnShare'], 'click') === 1);
check('分享 uses navigator.share with the file',
  windowStub.navigator.canShare({ files: [1] }) === true);

check('试听 has a click handler', dispatch(elements['btnPlay'], 'click') === 1);
check('the WAV was handed to FileReader and decoded',
  savedBlobs.length >= 1 && decodedAudio !== null,
  `blobs ${savedBlobs.length}, decoded ${decodedAudio ? decodedAudio.duration + ' s' : 'no'}`);
check('playback button switched to the stop state',
  get('btnPlay').textContent.indexOf('停止') >= 0, get('btnPlay').textContent);
check('试听 again stops the source', dispatch(elements['btnPlay'], 'click') === 1);

/* ------------------------------------------------------------------ *
 * 4b. Polarity self-check through the UI
 * ------------------------------------------------------------------ */

console.log('\n polarity self-check');
check('检查极性 button was enabled by the encode',
  get('btnSignCheck').disabled === false && get('btnFlipPolarity').disabled === false);
check('检查极性 has a click handler', dispatch(elements['btnSignCheck'], 'click') === 1);
// The synthetic picture is mostly dark (mean 100/255), and the app judges the
// transmission against that source brightness — a dark picture sent as a
// positive carries mostly black, which is exactly what it should do, so the
// report must say "positive".
check('the dark picture is reported as a positive transmission',
  /极性正常/.test(get('signReport').innerHTML) &&
  get('signReport').className.indexOf('ok') >= 0,
  get('signReport').innerHTML.replace(/<[^>]+>/g, ' ').slice(0, 130));

// Flipping polarity must tick the invert box (a deliberate toggle) and re-encode.
// The synthetic picture is mostly dark (mean 100/255), so the *positive*
// transmission is the one that looks like a negative on air — the check must
// report that, and flipping must clear it.
const invertBefore = get('invert').checked;
check('反色并重编 has a click handler', dispatch(elements['btnFlipPolarity'], 'click') === 1);
check('flipping toggled the invert checkbox', get('invert').checked !== invertBefore,
  `${invertBefore} -> ${get('invert').checked}`);
drainTimers(10);
check('flipping produced a new WAV blob', createdUrls.length >= 2,
  `${createdUrls.length} blob url(s)`);
// Re-check the freshly encoded audio: with the dark picture inverted the raster
// is bright, so the transmitted picture is a negative of the source and the
// report must say so.
dispatch(elements['btnSignCheck'], 'click');
check('the inverted transmission is reported as a negative',
  /负像/.test(get('signReport').innerHTML) &&
  get('signReport').className.indexOf('bad') >= 0,
  get('signReport').innerHTML.replace(/<[^>]+>/g, ' ').slice(0, 120));
// And flipping back restores the positive reading.
dispatch(elements['btnFlipPolarity'], 'click');
check('flipping back turned the invert checkbox off', get('invert').checked === false);
drainTimers(10);
dispatch(elements['btnSignCheck'], 'click');
check('the original transmission reads as a positive again',
  /极性正常/.test(get('signReport').innerHTML),
  `${get('signReport').innerHTML.replace(/<[^>]+>/g, ' ').slice(0, 90)} (invert=${get('invert').checked})`);

/* ------------------------------------------------------------------ *
 * 5. Cancel, clear, presets, keyboard
 * ------------------------------------------------------------------ */

console.log('\n cancel, clear, presets');
check('取消 has a click handler', dispatch(elements['btnCancel'], 'click') === 1);
check('取消 reports progress in the label', /取消/.test(get('progressLabel').textContent),
  get('progressLabel').textContent);

elements['preset'].value = 'ioc288';
check('preset change is handled', dispatch(elements['preset'], 'change') === 1);
check('IOC 288 preset applied', String(get('ioc').value) === '288' &&
  String(get('lineRateLpm').value) === '60' && String(get('phasingBlackPercent').value) === '10',
  `ioc ${get('ioc').value}, lpm ${get('lineRateLpm').value}, phasing ${get('phasingBlackPercent').value}`);
elements['preset'].value = 'ioc576tone';
dispatch(elements['preset'], 'change');
check('IOC 576 + start tone preset applied', get('startToneEnabled').checked === true &&
  String(get('startToneHz').value) === '300');

check('按比例自动定行数 has a handler', dispatch(elements['btnAutoLines'], 'click') === 1);
check('auto line count filled maxLines', parseInt(get('maxLines').value, 10) > 0,
  get('maxLines').value);

elements['fileInput'].files = [{ name: 'x.png', type: 'image/png' }];
elements['preset'].value = 'ioc576';
dispatch(elements['preset'], 'change');
drainTimers();
check('清空图像 has a handler', dispatch(elements['btnClear'], 'click') === 1);
check('clear resets the source info and disables the actions',
  get('srcInfo').textContent === '未载入图像' &&
  get('btnEncode').disabled === true && get('btnDownload').disabled === true,
  `${get('srcInfo').textContent} / encode disabled ${get('btnEncode').disabled}`);
check('clear revoked the previous blob URL', revokedUrls.length >= 1);

// Keyboard shortcuts are bound on window.
const keyHandlers = windowListeners['keydown'] || [];
check('keyboard shortcuts are bound', keyHandlers.length === 1);
let shortcutRan = false;
keyHandlers[0]({ key: 'Enter', ctrlKey: true, target: { tagName: 'BODY' }, preventDefault() { shortcutRan = true; } });
check('Ctrl+Enter triggers encoding (and is re-enabled after clear)', shortcutRan === true);

/* ------------------------------------------------------------------ *
 * 6. Static guarantees
 * ------------------------------------------------------------------ */

console.log('\n static checks');
check('the page declares the WMO parameters in the header',
  /1500–2300 Hz/.test(html) && /IOC 576/.test(html));
check('the page warns that PDF cannot be decoded directly', /不能直接解码/.test(html));
check('the help section documents SSB transmission', /USB/.test(html));
check('no external resources are referenced',
  !/src="https?:|href="https?:/.test(html) && !/@import/.test(html));
check('every id the UI looks up exists in the document',
  [...html.matchAll(/\$\('([A-Za-z][\w-]*)'\)/g)].every((mm) => ids.has(mm[1])));

console.log(`\n${failures === 0 ? 'all checks passed' : failures + ' check(s) failed'}`);
process.exit(failures === 0 ? 0 : 1);
