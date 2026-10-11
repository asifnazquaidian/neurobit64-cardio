// Shared parts of the NeuroBit64 organ chips (Cardio, Pancreas, Kidney): integer helpers, the
// NeuroBit64-S neuron model, the brain link, the telemetry frame and the Bluetooth LE advertising
// packet. Runs in Node.js and in a browser (the monitor app loads this same file).
// Copyright (c) 2026 Asif Mehmood.  SPDX-License-Identifier: Apache-2.0
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NB64 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const sat = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  const xs32 = (x) => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x | 0; };
  // fixed 4-bit "random" number of a cell, made from its index (no storage on the chip)
  const rhash = (ci) => (((ci & 1) << 3) | ((ci & 2) << 1) | ((ci & 4) >> 1) | ((ci & 8) >> 3)) ^ ((ci >> 4) & 15) ^ ((ci >> 8) & 3);

  // ---- NeuroBit64-S, one call per slot (8 clocks). Same arithmetic as tinytapeout/src/project.v
  class NeuroBit64S {
    constructor(o) {
      o = o || {};
      this.lif = o.lif ? 1 : 0; this.leak = o.leak | 0; this.tsel = o.tsel | 0;
      const tbase = (256 - (1 << this.tsel)) & 255;
      this.thresh = this.lif ? (248 - 16 * this.tsel) << this.leak : tbase;
      this.vm = new Int32Array(64); this.ch = 0; this.snapAt = o.snapAt || 0; this.snap = null;
      this.words = 0; this.ones = 0; this.lo = 0; this.hi = 0; this.sigLo = 0; this.sigHi = 0;
    }
    step(sample) {                       // returns the decision bit of channel this.ch
      const ch = this.ch, sum = (this.lif ? this.vm[ch] - (this.vm[ch] >>> this.leak) : 0) + sample;
      const fire = sum >= this.thresh ? 1 : 0;
      this.vm[ch] = fire ? 0 : sum;
      if (fire) { if (ch < 32) this.lo |= 1 << ch; else this.hi |= 1 << (ch - 32); this.ones++; }
      if (ch === 63) {
        const w = this.words;
        const nLo = ((this.sigLo << 1) | (this.sigHi >>> 31)) ^ this.lo ^ (w >>> 0);
        const nHi = ((this.sigHi << 1) | (this.sigLo >>> 31)) ^ this.hi ^ Math.floor(w / 4294967296);
        this.sigLo = nLo; this.sigHi = nHi; this.lo = 0; this.hi = 0; this.words++;
        if (this.words === this.snapAt) this.snap = { words: this.words, ones: this.ones, sig: this.signature() };
      }
      this.ch = (ch + 1) & 63;
      return fire;
    }
    signature() { const h = (a) => (a >>> 0).toString(16).padStart(8, '0'); return h(this.sigHi) + h(this.sigLo); }
  }

  // ---- brain link between an organ chip and NeuroBit64-S (both step one slot of 8 clocks at a time)
  // Organ -> brain: 32 group activity bytes. NeuroBit64 channel 32+g gets the byte of group g and
  //                 channel g gets 255 minus it (an inverted copy).
  // Brain -> organ: the 64-bit word of NeuroBit64. Ones in bits 0..31 are counted as "sympathetic",
  //                 ones in bits 32..63 as "parasympathetic"; the counts of one organ tick are used
  //                 in the next tick.
  class Link {
    constructor(nb) {
      this.nb = nb || null;              // a NeuroBit64S instance, or null when nothing is connected
      this.aff = new Uint8Array(32);
      this.k = 0;                        // slot counter
      this.nextSample = 0;               // byte that NeuroBit64 receives during the coming slot
      this.prevFire = 0; this.prevCh = 0;
      this.sCnt = 0; this.pCnt = 0; this.sym = 0; this.par = 0;
    }
    // call once per slot, after the organ has computed its cell; affWrite = [group, value] or null.
    // sym and par change only at tickEnd, so a tick works with the counts of the tick before it.
    slot(affWrite, tickEnd) {
      if (this.prevFire) { if (this.prevCh < 32) this.sCnt++; else this.pCnt++; }   // bit sampled mid-slot
      if (this.nb) { this.prevCh = this.nb.ch; this.prevFire = this.nb.step(this.nextSample); }
      const chn = (this.k + 1) & 63, a = this.aff[chn & 31];
      this.nextSample = chn < 32 ? 255 - a : a;                                     // uses the old value
      if (affWrite) this.aff[affWrite[0]] = affWrite[1];
      if (tickEnd) { this.sym = this.sCnt; this.par = this.pCnt; this.sCnt = 0; this.pCnt = 0; }
      this.k++;
    }
  }

  // ---- telemetry
  const ORGAN = { 1: 'heart', 2: 'pancreas', 3: 'kidney' };
  const uartFrame = (p) => { let x = 0; for (const b of p) x ^= b; return [0xa5, 0x5a, ...p, x]; };
  // pulls 19-byte frames out of a byte stream (serial port or Bluetooth UART module)
  class FrameParser {
    constructor(onFrame) { this.buf = []; this.onFrame = onFrame; this.bad = 0; }
    push(bytes) {
      for (const b of bytes) this.buf.push(b);
      while (this.buf.length >= 19) {
        if (this.buf[0] !== 0xa5 || this.buf[1] !== 0x5a) { this.buf.shift(); continue; }
        let x = 0; for (let i = 2; i < 18; i++) x ^= this.buf[i];
        if (x !== this.buf[18]) { this.bad++; this.buf.shift(); continue; }
        this.onFrame(this.buf.slice(2, 18)); this.buf.splice(0, 19);
      }
    }
  }
  const s8 = (b) => (b << 24) >> 24;
  function decodePayload(p) {
    const w = (i) => p[i] | (p[i + 1] << 8);
    return { seq: p[0], organ: p[1] >> 4, organName: ORGAN[p[1] >> 4] || 'unknown', link: (p[1] >> 3) & 1, cond: p[1] & 7,
      flags: p[2], signal: s8(p[3]), countA: w(4), countB: w(6), countC: w(8), m1: w(10), m2: w(12), m3: p[14], brain: s8(p[15]) };
  }

  // Bluetooth LE advertising packet (ADV_NONCONN_IND, manufacturer data 0xFFFF + 16 payload bytes)
  function advBytes(organ, p) {
    return [0xaa, 0xd6, 0xbe, 0x89, 0x8e, 0x42, 29, organ, 0x34, 0x36, 0x42, 0x4e, 0xc7, 0x02, 0x01, 0x06, 0x13, 0xff, 0xff, 0xff, ...p];
  }
  function advBits(organ, p, channel) {            // the bit stream on air, as a string of 0/1
    const by = advBytes(organ, p); let crc = 0x555555, wh = channel | 0x40, out = '';
    const put = (bit, white) => { let o = bit; if (white) { if (wh & 1) { o ^= 1; wh ^= 0x88; } wh >>= 1; } out += o; };
    by.forEach((d, k) => { for (let i = 0; i < 8; i++) { const bit = (d >> i) & 1; if (k >= 5) { const t = ((crc >> 23) & 1) ^ bit; crc = (crc << 1) & 0xffffff; if (t) crc ^= 0x00065b; } put(bit, k >= 5); } });
    for (let i = 23; i >= 0; i--) put((crc >> i) & 1, true);
    return out;
  }
  // independent receiver: dewhiten, check the CRC, pick out address and manufacturer data
  function advReceive(bits, channel) {
    if (bits.slice(0, 8) !== '01010101') throw new Error('preamble');
    const byteAt = (i) => parseInt(bits.slice(i, i + 8).split('').reverse().join(''), 2);
    if ([0, 1, 2, 3].map((i) => byteAt(8 + 8 * i)).join() !== [0xd6, 0xbe, 0x89, 0x8e].join()) throw new Error('access address');
    let lfsr = channel | 0x40; const body = [];
    for (let i = 40; i + 8 <= bits.length; i += 8) { let b = byteAt(i); for (let m = 1; m < 256; m <<= 1) { if (lfsr & 1) { lfsr ^= 0x88; b ^= m; } lfsr >>= 1; } body.push(b); }
    const len = body[1], pdu = body.slice(0, 2 + len), rx = body.slice(2 + len, 5 + len);
    let crc = 0x555555;
    for (const d of pdu) for (let i = 0; i < 8; i++) { const t = ((crc >> 23) & 1) ^ ((d >> i) & 1); crc = (crc << 1) & 0xffffff; if (t) crc ^= 0x00065b; }
    const cb = [16, 8, 0].map((s) => { let v = (crc >> s) & 255, r = 0; for (let i = 0; i < 8; i++) { r = (r << 1) | (v & 1); v >>= 1; } return r; });
    if (cb.join() !== rx.join()) throw new Error('CRC');
    let mfg = null;
    for (let i = 8; i < pdu.length;) { const l = pdu[i], t = pdu[i + 1]; if (t === 0xff) mfg = { company: pdu[i + 2] | (pdu[i + 3] << 8), data: pdu.slice(i + 4, i + 1 + l) }; i += l + 1; }
    return { type: pdu[0] & 15, addr: pdu.slice(2, 8).reverse().map((b) => b.toString(16).padStart(2, '0')).join(':'), mfg };
  }

  // ---- parts every organ model uses
  // groups: 32 groups over N cells, sizes differ by at most one (Bresenham counter, as on the chip)
  class Groups { constructor(N) { this.N = N; this.acc = 0; this.g = 0; }
    next() { this.acc += 32; const end = this.acc >= this.N; return end; }
    advance(end) { if (end) { this.acc -= this.N; this.g = (this.g + 1) & 31; } } }
  // NeuroBit64 leaky integrate-and-fire rule for the 7-bit adrenergic neurons: returns [n', spike]
  const lif7 = (n, inp) => { const s = n - (n >> 2) + inp; return s >= 32 ? [0, 1] : [s, 0]; };
  const hex2 = (b) => b.toString(16).padStart(2, '0');
  return { sat, xs32, rhash, NeuroBit64S, Link, uartFrame, FrameParser, decodePayload, advBytes, advBits, advReceive, Groups, lif7, hex2, ORGAN };
});
