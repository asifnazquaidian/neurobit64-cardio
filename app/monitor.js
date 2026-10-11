// NeuroBit64 Organ Monitor: shows the 16-byte reports of the three organ chips.
// Reports come from the chip model running in this page, from a Bluetooth serial module, or from
// a serial port. Everything on screen is computed from the reports, so all sources look the same.
// Copyright (c) 2026 Asif Mehmood.  SPDX-License-Identifier: Apache-2.0
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const MODELS = { cardio: window.NB64Cardio, pancreas: window.NB64Pancreas, kidney: window.NB64Kidney };
  const ORG = {
    cardio: { id: 1, title: 'Heart', legend: ['myocyte upstrokes', 'beta-neuron spikes', 'alpha-neuron spikes'], input: null },
    pancreas: { id: 2, title: 'Pancreas', legend: ['beta-cell spikes', 'alpha-cell spikes', 'delta-cell spikes'], input: { label: 'Glucose (mg/dL)', min: 40, max: 300, val: 100, cmd: 0x47 } },
    kidney: { id: 3, title: 'Kidney', legend: ['filtration spikes', 'alpha-1 neuron spikes', 'beta-1 neuron spikes'], input: { label: 'Perfusion pressure (mmHg)', min: 40, max: 200, val: 100, cmd: 0x50 } },
  };
  const COL = ['#0b6bcb', '#d9480f', '#7b2cbf'];
  const HIST = 600;
  const S = { organ: 'cardio', running: false, chip: null, raf: 0, hist: [], last: null, beats: [], lastIbi: -1, ras: [], port: null, dev: null, writer: null, tx: null, t0: 0, ticks: 0 };

  // ---------- what a report means, per organ
  function tilesFor(d) {
    if (d.organ === 1) {
      const bpm = d.m1 ? Math.round(60000 / d.m1) : 0;
      return [[bpm || '-', 'heart rate (beats/min)'], [d.m1 || '-', 'beat interval (ms)'], [d.m2 || '-', 'action potential duration (ms)'],
        [rmssd() === null ? '-' : rmssd().toFixed(0), 'RMSSD of the intervals (ms)'], [d.brain, 'brain drive']];
    }
    if (d.organ === 2) return [[d.m1, 'glucose given to the chip (mg/dL)'], [d.m2, 'glucose read from the cells (mg/dL)'], [Math.round(d.m3 / 2.55), 'insulin level (%)'],
      [d.countA, 'beta-cell spikes / 16 ms'], [d.countB, 'alpha-cell spikes / 16 ms'], [d.brain, 'brain drive']];
    return [[d.m1, 'working nephrons (of 1000)'], [(d.m2 & 255) + ' %', 'total filtration'], [d.m2 >> 8, 'perfusion pressure (mmHg)'],
      [Math.round(d.m3 / 2.55), 'renin level (%)'], [d.brain, 'brain drive']];
  }
  function rmssd() {
    const b = S.beats; if (b.length < 3) return null;
    let s = 0; for (let i = 1; i < b.length; i++) s += (b[i] - b[i - 1]) ** 2;
    return Math.sqrt(s / (b.length - 1));
  }

  // ---------- one report in
  function onPayload(p) {
    const d = NB64.decodePayload(p);
    if (d.organ !== ORG[S.organ].id) { $('msg').textContent = `The connected chip is a ${d.organName} chip; switch the tab to see it.`; return; }
    S.last = d; S.hist.push(d); if (S.hist.length > HIST) S.hist.shift();
    if (d.organ === 1 && d.m1 && d.m1 !== S.lastIbi) { S.lastIbi = d.m1; S.beats.push(d.m1); if (S.beats.length > 30) S.beats.shift(); }
  }

  // ---------- drawing
  function fit(c) { const r = c.getBoundingClientRect(), k = window.devicePixelRatio || 1; if (c.width !== Math.round(r.width * k)) { c.width = Math.round(r.width * k); c.height = Math.round(+c.getAttribute('height') * k); } return k; }
  function chart(c, series, lo, hi) {
    const k = fit(c), g = c.getContext('2d'), W = c.width, H = c.height, padL = 38 * k, padB = 14 * k;
    g.clearRect(0, 0, W, H); g.font = `${11 * k}px system-ui`; g.fillStyle = '#5b6777'; g.strokeStyle = '#dfe5ee'; g.lineWidth = 1;
    for (let i = 0; i <= 2; i++) { const y = (H - padB) * i / 2 + 4 * k * (i === 0); g.beginPath(); g.moveTo(padL, y); g.lineTo(W, y); g.stroke(); g.fillText(String(Math.round(hi - (hi - lo) * i / 2)), 2, Math.min(H - padB, y + 10 * k)); }
    series.forEach((s, si) => {
      g.strokeStyle = COL[si]; g.lineWidth = 1.6 * k; g.beginPath();
      s.forEach((v, i) => { const x = padL + (W - padL) * i / (HIST - 1), y = (H - padB) * (1 - (v - lo) / (hi - lo || 1)); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      g.stroke();
    });
  }
  function drawRaster() {
    const c = $('cRas'), k = fit(c), g = c.getContext('2d'), W = c.width, H = c.height;
    g.clearRect(0, 0, W, H); if (!S.chip) return;
    const span = 4000, t1 = S.ticks, N = S.chip.N; g.fillStyle = '#17202e';
    while (S.ras.length && S.ras[0] < t1 - span) S.ras.splice(0, 2);
    for (let i = 0; i < S.ras.length; i += 2) g.fillRect(W * (S.ras[i] - (t1 - span)) / span, H * S.ras[i + 1] / N, Math.max(1, k), Math.max(1, k));
  }
  function render() {
    const d = S.last, h = S.hist;
    if (d) {
      $('tiles').innerHTML = tilesFor(d).map(([v, l]) => `<div class="tile"><b>${v}</b><span>${l}</span></div>`).join('');
      const names = MODELS[S.organ].FLAGS;
      $('flags').innerHTML = names.map((n, i) => (n && i < 7 ? `<span class="flag ${d.flags >> i & 1 ? 'on' : ''}">${n}</span>` : '')).join('');
      const bad = d.flags & 0x80, v = $('verdict');
      const any = d.flags & 0x7f;
      v.textContent = bad ? 'Abnormal pattern detected' : any ? 'Reading out of the normal range' : 'Normal pattern'; v.className = 'verdict ' + (bad || any ? 'bad' : 'ok');
    }
    const sig = h.map((x) => x.signal); chart($('cSig'), [sig], Math.min(-70, ...sig), Math.max(-30, ...sig));
    const a = h.map((x) => x.countA), b = h.map((x) => x.countB), cc = h.map((x) => x.countC);
    chart($('cCnt'), [a, b, cc], 0, Math.max(10, ...a, ...b, ...cc));
    drawRaster();
  }

  // ---------- sources
  function startSim() {
    const M = MODELS[S.organ], link = $('link').checked;
    const nb = link ? new NB64.NeuroBit64S({ lif: 1, leak: 2, tsel: 4 }) : null;
    S.chip = new M.Chip({ cond: +$('cond').value, link: link ? 1 : 0, nb, keepFrames: false, raster: true, onFrame: (p) => onPayload(p) });
    S.ticks = 0; S.t0 = performance.now();
    const loop = () => {
      if (!S.running) return;
      const want = Math.min(S.ticks + 96, Math.floor(performance.now() - S.t0));    // real time, at most 96 ticks per frame
      while (S.ticks < want) { S.chip.tick(); S.ticks++; }
      if (performance.now() - S.t0 - S.ticks > 500) S.t0 = performance.now() - S.ticks;     // slow device: do not try to catch up
      const r = S.chip.raster; if (r.length) { for (let i = 0; i < r.length; i += 2) if ((r[i + 1] & 3) === 0 || S.organ === 'cardio') S.ras.push(S.ticks - ((S.chip.t - r[i]) & 0xffff), r[i + 1]); r.length = 0; }
      if (S.ras.length > 60000) S.ras.splice(0, S.ras.length - 60000);
      render(); S.raf = requestAnimationFrame(loop);
    };
    S.raf = requestAnimationFrame(loop);
  }
  const parser = new NB64.FrameParser((p) => { onPayload(p); });
  async function startBle() {
    if (!navigator.bluetooth) throw new Error('This browser has no Web Bluetooth. Use Chrome or Edge on Android, Windows or macOS.');
    const HM = 0xffe0, NUS = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
    S.dev = await navigator.bluetooth.requestDevice({ filters: [{ services: [HM] }, { services: [NUS] }], optionalServices: [HM, NUS] });
    const gatt = await S.dev.gatt.connect(); let rx, tx;
    try { const s = await gatt.getPrimaryService(HM); rx = tx = await s.getCharacteristic(0xffe1); }
    catch (e) { const s = await gatt.getPrimaryService(NUS); rx = await s.getCharacteristic('6e400003-b5a3-f393-e0a9-e50e24dcca9e'); tx = await s.getCharacteristic('6e400002-b5a3-f393-e0a9-e50e24dcca9e'); }
    rx.addEventListener('characteristicvaluechanged', (e) => { parser.push(new Uint8Array(e.target.value.buffer)); });
    await rx.startNotifications(); S.tx = (bytes) => tx.writeValueWithoutResponse(new Uint8Array(bytes));
    S.dev.addEventListener('gattserverdisconnected', () => stop('Bluetooth link lost.'));
    pump();
  }
  async function startSerial() {
    if (!navigator.serial) throw new Error('This browser has no Web Serial. Use Chrome or Edge on a PC.');
    S.port = await navigator.serial.requestPort(); await S.port.open({ baudRate: 115200 });
    const w = S.port.writable.getWriter(); S.tx = (bytes) => w.write(new Uint8Array(bytes)); S.writer = w;
    const rd = S.port.readable.getReader(); S.reader = rd;
    (async () => { try { for (;;) { const { value, done } = await rd.read(); if (done) break; parser.push(value); } } catch (e) { /* closed */ } })();
    pump();
  }
  function pump() { const loop = () => { if (!S.running) return; render(); S.raf = requestAnimationFrame(loop); }; S.raf = requestAnimationFrame(loop); }

  async function run() {
    $('msg').textContent = ''; S.hist = []; S.last = null; S.beats = []; S.lastIbi = -1; S.ras = [];
    const src = $('source').value;
    try {
      S.running = true;
      if (src === 'sim') startSim(); else if (src === 'ble') await startBle(); else await startSerial();
      $('run').disabled = true; $('stop').disabled = false;
      $('state').textContent = src === 'sim' ? 'simulated chip running' : 'receiving from hardware'; $('state').className = 'pill live';
    } catch (e) { S.running = false; $('msg').textContent = e.message || String(e); }
  }
  async function stop(why) {
    S.running = false; cancelAnimationFrame(S.raf); S.chip = null; S.tx = null;
    try { if (S.reader) { await S.reader.cancel(); S.reader.releaseLock(); } if (S.writer) S.writer.releaseLock(); if (S.port) await S.port.close(); } catch (e) { /* ignore */ }
    try { if (S.dev && S.dev.gatt.connected) S.dev.gatt.disconnect(); } catch (e) { /* ignore */ }
    S.reader = S.writer = S.port = S.dev = null;
    $('run').disabled = false; $('stop').disabled = true; $('state').textContent = 'stopped'; $('state').className = 'pill';
    if (typeof why === 'string') $('msg').textContent = why;
  }

  // ---------- controls
  function setOrgan(o) {
    if (S.running) stop();
    S.organ = o; S.hist = []; S.last = null;
    document.querySelectorAll('#organSeg button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.organ === o));
    $('cond').innerHTML = MODELS[o].COND.map((c, i) => `<option value="${i}">${i}: ${c.name}</option>`).filter((_, i) => o !== 'cardio' || i < 6).join('');
    $('vTitle').textContent = ORG[o].title + ' chip reading';
    $('legend').innerHTML = ORG[o].legend.map((l, i) => `<span><i style="background:${COL[i]}"></i>${l}</span>`).join('');
    const inp = ORG[o].input; $('inWrap').hidden = !inp;
    if (inp) { $('inLabel').textContent = inp.label; $('inVal').min = inp.min; $('inVal').max = inp.max; $('inVal').value = inp.val; $('inShow').textContent = 'built-in'; }
    $('tiles').innerHTML = '<div class="tile"><b>-</b><span>press Run</span></div>'; $('flags').innerHTML = ''; $('verdict').textContent = '';
    syncSource(); render();
  }
  function syncSource() { const sim = $('source').value === 'sim'; $('condWrap').hidden = !sim; $('linkWrap').hidden = !sim; $('rasterCard').hidden = !sim; }
  function sendInput(v) {
    const inp = ORG[S.organ].input; if (!inp) return;
    $('inShow').textContent = v === 0xffff ? 'built-in' : v;
    if (S.chip) S.chip.setInput(v); else if (S.tx) S.tx([inp.cmd, v & 255, v >> 8]);
  }
  document.querySelectorAll('#organSeg button').forEach((b) => b.addEventListener('click', () => setOrgan(b.dataset.organ)));
  $('source').addEventListener('change', () => { if (S.running) stop(); syncSource(); });
  $('cond').addEventListener('change', () => { if (S.running && $('source').value === 'sim') { stop(); run(); } });
  $('link').addEventListener('change', () => { if (S.running && $('source').value === 'sim') { stop(); run(); } });
  $('run').addEventListener('click', run); $('stop').addEventListener('click', () => stop());
  $('inVal').addEventListener('input', (e) => sendInput(+e.target.value));
  $('inAuto').addEventListener('click', () => sendInput(0xffff));
  window.addEventListener('resize', render);
  window.NB64Monitor = { S, run, stop, setOrgan };
  // Links can choose what is shown and start it:  ?organ=cardio|pancreas|kidney  &cond=0..7  &link=1  &run=0
  // (heart, glucose and nephron also work as organ names). The simulated chip starts by itself unless run=0.
  const Q = new URLSearchParams(location.search);
  const alias = { heart: 'cardio', cardio: 'cardio', pancreas: 'pancreas', glucose: 'pancreas', kidney: 'kidney', nephron: 'kidney' };
  setOrgan(alias[(Q.get('organ') || '').toLowerCase()] || 'cardio');
  const qc = parseInt(Q.get('cond'), 10);
  if (qc >= 0 && [...$('cond').options].some((o) => +o.value === qc)) $('cond').value = String(qc);
  if (Q.get('link') === '1') $('link').checked = true;
  if (Q.get('run') !== '0') run();
})();
