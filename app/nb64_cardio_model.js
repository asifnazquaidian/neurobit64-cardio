// NeuroBit64-Cardio: bit-exact software model of design/rtl/nb64_cardio.v
// 1000 cardiac myocytes (Hybrid Excitable Cell model, thesis chapter 5), each with one
// beta-adrenergic and one alpha-adrenergic neuron, 32 conduction groups, brain link, telemetry.
// Copyright (c) 2026 Asif Mehmood.  SPDX-License-Identifier: Apache-2.0
//
// Number formats   v  12-bit signed, 1/16 mV      u  14-bit signed, 1/32 mV
//                  tr 13-bit, 1/64 mV (beta-receptor potential during the action potential,
//                     alpha-receptor potential after it)
//                  s  10-bit, ticks since the upstroke     nb, na  7-bit neuron membranes
// One tick is one Euler step of 1 ms. One unit = 64 bits of state.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./nb64_common.js'));
  else root.NB64Cardio = factory(root.NB64);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';
  const { sat, xs32, rhash, lif7 } = C;
  const VR = -960, VT = -640;                 // -60 mV, -40 mV
  // conditions (pins cond[2:0]).  isa4: pacemaker drive of the sino-atrial group in 1/64 mV per tick,
  // rsa: depth of the slow (respiratory) modulation, jg: beat-to-beat random drive, av: slow node cells
  // in group 8, tk: decay shift of the beta-receptor potential (7 -> 128 ms, 8 -> 256 ms as in the thesis)
  const COND = [
    { name: 'normal sinus rhythm',         isa4: 44,  rsa: 3, jg: 0, av: 0, tk: 7 },
    { name: 'tachycardia',                 isa4: 240, rsa: 3, jg: 0, av: 0, tk: 7 },
    { name: 'bradycardia',                 isa4: 12,  rsa: 0, jg: 0, av: 0, tk: 7 },
    { name: 'irregular rhythm',            isa4: 64,  rsa: 3, jg: 5, av: 0, tk: 7 },
    { name: 'conduction block',            isa4: 44,  rsa: 3, jg: 0, av: 1, tk: 7 },
    { name: 'prolonged action potential',  isa4: 44,  rsa: 3, jg: 0, av: 0, tk: 8 },
    { name: 'normal sinus rhythm',         isa4: 44,  rsa: 3, jg: 0, av: 0, tk: 7 },
    { name: 'normal sinus rhythm',         isa4: 44,  rsa: 3, jg: 0, av: 0, tk: 7 },
  ];
  // GA: gain shift of the alpha-receptor potential, GC: coupling per upstroke (1/16 mV), VCA/MU/W2SH:
  // calcium plateau (45 mV, centred 225 ms, half-width 181 ms), BSH: brain-drive shift,
  // AVGA/AVTA: the same gain and the decay shift for the slow node cells of the block condition
  const DEF = { N: 1000, GA: 5, GC: 32, VCA: 720, MU: 225, W2SH: 15, BSH: 4, AVGA: 1, AVTA: 9 };
  class Cardio {
    constructor(o) {
      o = o || {};
      this.P = Object.assign({}, DEF, o.params || {});
      const N = this.N = o.N || this.P.N;
      this.cond = o.cond | 0; this.linkEn = o.link ? 1 : 0;
      this.K = Object.assign({}, COND[this.cond], o.condOverride || {});
      this.link = new C.Link(o.nb || null);
      this.v = new Int16Array(N).fill(VR); this.u = new Int16Array(N); this.tr = new Uint16Array(N);
      this.s = new Uint16Array(N); this.ap = new Uint8Array(N); this.nb = new Uint8Array(N); this.na = new Uint8Array(N);
      this.x = 0x12345678 | 0;
      this.cn = new Uint8Array(32);            // upstrokes of each group in the previous tick
      this.t = 0;                              // tick counter (16 bit)
      // beat detector and measurements
      this.epi = 0; this.quiet = 0; this.beatDone = 0; this.tLast = 0; this.ibi = 0; this.ibiPrev = 0; this.dibi = 0;
      this.irr = 0; this.partial = 0; this.block = 0; this.lowpart = 0; this.nbeats = 0;
      this.arm = 0; this.tb = 0; this.apd = 0; this.jit = 8; this.episodes = [];
      this.flags = 0; this.seq = 0; this.mv = 0;
      this.wu = 0; this.wb = 0; this.wa = 0;   // window counters
      this.frames = []; this.onFrame = o.onFrame || null; this.keepFrames = o.keepFrames !== false;
      this.sigLo = 0; this.sigHi = 0; this.events = 0;           // raster signature
      this.beats = [];                         // tick of every detected beat (model only)
      this.raster = o.raster ? [] : null;      // optional: [tick, cell] of every upstroke (model only)
      this.probe = o.probe === undefined ? -1 : o.probe; this.trace = [];
    }

    // one cell, pure integer function; returns the event bits
    // isaq: pacemaker drive of this tick (1/64 mV), pm1/own: upstrokes of the previous and of the own
    // group in the previous tick, nz: noise -15..15, d2: 2 dither bits
    cell(i, g, pm1, own, isaq, nz, d2) {
      const P = this.P, K = this.K, r = rhash(i), node = K.av && g === 8;
      let v = this.v[i], u = this.u[i], tr = this.tr[i], s = this.s[i], ap = this.ap[i], nb = this.nb[i], na = this.na[i];
      let up = 0, down = 0, sb, sa;
      if (!ap) {
        const x = v - VR, y = x - 320, p = x * y;
        const q = (p * 164 + 131072) >> 18;                    // k/C (v - Vr)(v - Vt), k = 0.5, C = 50
        const tu = (u * 41 + 2048) >> 12;                      // u / C
        const hyp = tr >> (node ? P.AVGA : P.GA);              // alpha-receptor potential pulls the cell down
        let cpl = pm1 + own; if (cpl > 63) cpl = 63;
        let I = nz + P.GC * cpl;
        if (g === 0) I += (isaq + d2) >> 2;                    // sino-atrial group: pacemaker drive
        const vn = sat(v + q - tu - hyp + I, -2048, 2047);
        const t = -12 * x - u;                                 // b (v - Vr) - u, b = -6
        const un = sat(u + ((t * 123 + 2048) >> 12), -8192, 8191);
        [na, sa] = lif7(na, tr >> 8); [nb, sb] = lif7(nb, 0);
        if (v >= VT) {                                         // upstroke
          up = 1; ap = 1; s = 0; tr = ((62 + r) << 6) - (tr >> 1);
          u = sat(u + 800, -8192, 8191); v = 560;              // d = 25 mV, peak 35 mV
        } else {
          const ta = node ? P.AVTA : 7;
          v = vn; u = un; tr = tr - ((tr + (1 << ta) - 1) >> ta);
        }
      } else {
        const tk = K.tk;
        const trn = tr - ((tr + (1 << tk) - 1) >> tk);
        const dx = s - P.MU, sq = dx * dx;
        const bump = sq < (1 << P.W2SH) ? P.VCA - ((P.VCA * sq) >> P.W2SH) : 0;
        [nb, sb] = lif7(nb, tr >> 8); [na, sa] = lif7(na, 0);
        if (tr < 320) { down = 1; ap = 0; v = VR; tr = 3840; s = 0; }   // end of the action potential
        else { v = (trn >> 2) - 768 + bump; tr = trn; s = s < 1023 ? s + 1 : 1023; }
      }
      this.v[i] = v; this.u[i] = u; this.tr[i] = tr; this.s[i] = s; this.ap[i] = ap; this.nb[i] = nb; this.na[i] = na;
      return up | (sb << 1) | (sa << 2) | (down << 3);
    }

    tick() {
      const N = this.N, P = this.P, K = this.K, L = this.link, t = this.t;
      const ph = t & 4095, tri = (ph < 2048 ? ph : 4095 - ph) >> 8;          // 0..7, period 4.1 s
      let isaq = K.isa4 + K.rsa * (tri - 4) + K.jg * (this.jit - 8);
      if (this.linkEn) isaq += sat((L.sym - L.par) >> P.BSH, -32, 31);
      if (isaq < 0) isaq = 0;
      let ups = 0, bsp = 0, asp = 0, vacc = 0;
      let g = 0, acc = 0, pm1 = 0, gup = 0, gsp = 0;
      for (let i = 0; i < N; i++) {
        const xr = this.x, nz = ((xr >>> 28) & 15) - ((xr >>> 24) & 15);
        const ev = this.cell(i, g, pm1, this.cn[g], isaq, nz, xr & 3);
        this.x = xs32(xr);
        const up = ev & 1, sb = (ev >> 1) & 1, sa = (ev >> 2) & 1;
        ups += up; bsp += sb; asp += sa; vacc += this.v[i]; gup += up; gsp += sb + sa;
        if (up) { this.events++; if (this.raster) this.raster.push(t, i); }
        // signature of the raster stream (one upstroke bit per cell per tick)
        const nLo = ((this.sigLo << 1) | (this.sigHi >>> 31)) ^ up, nHi = ((this.sigHi << 1) | (this.sigLo >>> 31)) ^ (i & 1023);
        this.sigLo = nLo | 0; this.sigHi = nHi | 0;
        acc += 32; const gend = acc >= N;
        let aw = null;
        if (gend) {
          const a = L.aff[g];
          aw = [g, sat(a - (a >> 2) + 4 * gsp, 0, 255)];
          pm1 = this.cn[g]; this.cn[g] = gup > 63 ? 63 : gup;
          gup = 0; gsp = 0; acc -= N; g = (g + 1) & 31;
        }
        L.slot(aw, i === N - 1);
      }
      this.tickEnd(ups, bsp, asp, vacc);
    }
    tickEnd(ups, bsp, asp, vacc) {
      const N = this.N, t = this.t;
      // ---- beat detector on the collective upstrokes
      let epi = this.epi + ups; if (epi > 4095) epi = 4095;
      const quiet = ups ? 0 : (this.quiet < 255 ? this.quiet + 1 : 255);
      const since = (t - this.tLast) & 0xffff;
      if (!this.beatDone && epi >= (N >> 1)) {
        this.beatDone = 1; this.nbeats++; this.beats.push(t);
        const ibi = since > 4095 ? 4095 : since;
        const d = Math.abs(ibi - this.ibi);
        this.dibi = this.nbeats > 2 ? (d > 255 ? 255 : d) : 0;
        this.irr = ((this.irr << 1) | (this.nbeats > 2 && d > 100 ? 1 : 0)) & 0xff;
        this.ibi = this.nbeats > 1 ? ibi : 0; this.tLast = t;
        this.block = this.partial; this.partial = 0; this.jit = (this.x >>> 4) & 15;
      }
      if (quiet >= 64 && epi > 0) {            // the activation is over
        if (!this.beatDone && epi >= (N >> 5)) this.partial = 1;
        if (this.beatDone) this.lowpart = epi < N - (N >> 3) ? 1 : 0;
        this.episodes.push(epi); epi = 0; this.beatDone = 0;
      }
      this.epi = epi; this.quiet = quiet;
      // ---- action potential duration from the two neuron populations
      if (this.arm === 0 && bsp >= (N >> 3)) { this.arm = 1; this.tb = t; }
      else if (this.arm === 1 && asp >= (N >> 3)) { const a = (t - this.tb) & 0xffff; this.apd = a > 4095 ? 4095 : a; this.arm = 2; }
      else if (this.arm === 2 && asp === 0 && bsp === 0) this.arm = 0;
      // ---- flags
      let ic = 0; for (let k = 0; k < 8; k++) ic += (this.irr >> k) & 1;
      const live = this.nbeats > 1;
      let f = 0;
      if (live && this.ibi < 600) f |= 1;                       // tachycardia   (> 100 beats/min)
      if (live && this.ibi > 1000) f |= 2;                      // bradycardia   (< 60 beats/min)
      if (ic >= 3) f |= 4;                                      // irregular rhythm
      if (this.block) f |= 8;                                   // an activation died out between two beats
      if (this.apd > 450) f |= 16;                              // long action potential
      if (since > 2000) f |= 32;                                // pause
      if (this.lowpart) f |= 64;                                // fewer than 7/8 of the cells took part
      if (f) f |= 128;
      this.flags = f;
      // ---- window of 16 ticks -> one telemetry frame
      this.wu = Math.min(65535, this.wu + ups); this.wb = Math.min(65535, this.wb + bsp); this.wa = Math.min(65535, this.wa + asp);
      if (this.probe >= 0) this.trace.push(this.v[this.probe]);
      if ((t & 15) === 15) {
        const mv = sat(vacc >> 14, -128, 127) & 255;
        const L = this.link, br = this.linkEn ? sat(L.sym - L.par, -128, 127) & 255 : 0;
        const p = [this.seq, 0x10 | (this.linkEn << 3) | this.cond, this.flags, mv,
          this.wu & 255, this.wu >> 8, this.wb & 255, this.wb >> 8, this.wa & 255, this.wa >> 8,
          this.ibi & 255, this.ibi >> 8, this.apd & 255, this.apd >> 8, this.dibi, br];
        if (this.keepFrames) this.frames.push(p);
        if (this.onFrame) this.onFrame(p, (this.seq & 7) === 7);
        this.seq = (this.seq + 1) & 255; this.wu = 0; this.wb = 0; this.wa = 0;
      }
      this.t = (t + 1) & 0xffff;
    }
    run(ticks) { for (let i = 0; i < ticks; i++) this.tick(); return this; }
    signature() { const h = (a) => (a >>> 0).toString(16).padStart(8, '0'); return h(this.sigHi) + h(this.sigLo); }
  }
  // root mean square of successive differences of the beat intervals, ms (computed off-chip)
  function rmssd(beats) {
    const ibi = []; for (let i = 1; i < beats.length; i++) ibi.push(beats[i] - beats[i - 1]);
    let s = 0, n = 0; for (let i = 1; i < ibi.length; i++) { s += (ibi[i] - ibi[i - 1]) ** 2; n++; }
    return n ? Math.sqrt(s / n) : 0;
  }
  const FLAGS = ['tachycardia', 'bradycardia', 'irregular rhythm', 'blocked activation', 'long action potential', 'pause', 'low participation', 'abnormal'];
  return { Chip: Cardio, Cardio, COND, DEF, rmssd, FLAGS, VR, VT, ORGAN: 1 };
});
