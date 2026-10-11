// NeuroBit64-Pancreas: bit-exact software model of design/rtl/nb64_pancreas.v
// 1000 pancreatic islet cells (Hybrid Excitable Cell model, thesis section "Pancreatic Cells"):
// beta cells in groups 0-18, alpha cells in groups 19-28, delta cells in groups 29-31. Every cell
// has an adrenergic neuron (alpha-2 type on beta and delta cells, beta-2 type on alpha cells);
// the activity of the 32 cell groups is reported to the brain.
// Copyright (c) 2026 Asif Mehmood.  SPDX-License-Identifier: Apache-2.0
//
// Number formats   v 12-bit signed, 1/16 mV     u 16-bit signed, 1/32 mV     ne 7-bit neuron
// One tick is one Euler step of 1 ms. One unit = 35 bits of state.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./nb64_common.js'));
  else root.NB64Pancreas = factory(root.NB64);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';
  const { sat, xs32, rhash, lif7 } = C;
  const VR = -960;
  // thesis table "Values of model parameters for simulation of pancreatic cells"
  //            kq = k f / C     ka = a      bx = 2 b     d (1/32 mV)   Vglu, Vins (1/16 mV)
  const TYPE = [
    { name: 'beta',  kq: 25, ka: 82,  b2: -10, d: 1600, vglu: 560, vins: 480 },
    { name: 'alpha', kq: 16, ka: 123, b2: -4,  d: 3200, vglu: 0,   vins: 0 },
    { name: 'delta', kq: 10, ka: 82,  b2: -2,  d: 1920, vglu: 560, vins: 640 },
  ];
  const typeOf = (g) => (g < 19 ? 0 : g < 29 ? 1 : 2);
  // conditions (pins cond[2:0]).  gl: fixed glucose in mg/dL, 0 = slow sweep 40..295 mg/dL
  // loss: 13/16 of the beta cells do not respond, weak: beta cells respond late and weakly,
  // noalpha: alpha cells do not respond, symp: resting sympathetic tone
  const COND = [
    { name: 'healthy islet, glucose sweep',           gl: 0,   loss: 0, weak: 0, noalpha: 0, symp: 0 },
    { name: 'healthy islet, low glucose (50 mg/dL)',   gl: 50,  loss: 0, weak: 0, noalpha: 0, symp: 0 },
    { name: 'healthy islet, normal glucose (95 mg/dL)', gl: 95, loss: 0, weak: 0, noalpha: 0, symp: 0 },
    { name: 'healthy islet, high glucose (240 mg/dL)', gl: 240, loss: 0, weak: 0, noalpha: 0, symp: 0 },
    { name: 'beta-cell loss, glucose sweep',           gl: 0,   loss: 1, weak: 0, noalpha: 0, symp: 0 },
    { name: 'weak beta-cell response, glucose sweep',  gl: 0,   loss: 0, weak: 1, noalpha: 0, symp: 0 },
    { name: 'no alpha-cell response, glucose sweep',   gl: 0,   loss: 0, weak: 0, noalpha: 1, symp: 0 },
    { name: 'high sympathetic tone, glucose sweep',    gl: 0,   loss: 0, weak: 0, noalpha: 0, symp: 12 },
  ];
  // GC: coupling between beta cells per spike, KN: effect of one nerve spike (1/16 mV), GG, GI: hormone
  // released per spike, GS / GW: glucose set point of healthy / weak beta cells (mg/dL), DMIN: strongest
  // hyperpolarising drive
  const DEF = { N: 1000, GC: 4, KN: 48, GG: 3, GI: 2, GS: 100, GW: 160, DMIN: 16 };

  class Pancreas {
    constructor(o) {
      o = o || {};
      this.P = Object.assign({}, DEF, o.params || {});
      const N = this.N = o.N || this.P.N;
      this.cond = o.cond | 0; this.linkEn = o.link ? 1 : 0;
      this.K = Object.assign({}, COND[this.cond], o.condOverride || {});
      this.link = new C.Link(o.nb || null);
      this.v = new Int16Array(N).fill(VR); this.u = new Int16Array(N); this.ne = new Uint8Array(N);
      this.x = 0x12345678 | 0; this.cn = new Uint8Array(32); this.t = 0;
      this.glu = 0; this.i1 = 0; this.i2 = 0;          // hormone fields, 12 bit
      this.rb = 0; this.ra = 0;                        // sensory-neuron rates (leaky sums)
      this.gext = -1;                                  // glucose written through the UART, mg/dL
      this.gin = this.glucose(); this.gest = 0; this.flags = 0; this.seq = 0;
      this.wb = 0; this.wa = 0; this.wd = 0;
      this.frames = []; this.onFrame = o.onFrame || null; this.keepFrames = o.keepFrames !== false;
      this.sigLo = 0; this.sigHi = 0; this.events = 0;
      this.raster = o.raster ? [] : null;
      this.tot = [0, 0, 0];                            // spikes per type since the start (model only)
    }
    glucose() {
      if (this.gext >= 0) return this.gext;
      if (this.K.gl) return this.K.gl;
      const ph = this.t & 16383, tri = (ph < 8192 ? ph : 16383 - ph) >> 5;      // 0..255, period 16.4 s
      return 40 + tri;
    }
    setGlucose(mg) { this.gext = mg === 0xffff ? -1 : sat(mg | 0, 0, 511); }
    setInput(x) { this.setGlucose(x); }

    cell(i, g, ty, cpl, drv, sd, e, nz) {
      const T = TYPE[ty], P = this.P;
      let v = this.v[i], u = this.u[i], ne = this.ne[i], se;
      const x = v - VR, y = x - 320, p = x * y;
      const q = (p * T.kq + 131072) >> 18;                     // k f / C (v - Vr)(v - Vt)
      const tu = (u * 41 + 4096) >> 13;                        // u / C, C = 100
      const de = (e * 41 + 2048) >> 12;                        // (Va + Vb) / C
      const fire = v >= -640 + e ? 1 : 0;                      // threshold = Vt + Va + Vb
      [ne, se] = lif7(ne, sd);                                 // adrenergic nerve ending
      const kick = se ? (ty === 1 ? P.KN : -P.KN) : 0;
      const vn = sat(v + q - tu + de + drv + nz + cpl + kick, -2048, 2047);
      const t = T.b2 * x - u;
      const un = sat(u + ((t * T.ka + 2048) >> 12), -32768, 32767);
      if (fire) { v = -800; u = sat(u + T.d, -32768, 32767); } else { v = vn; u = un; }
      this.v[i] = v; this.u[i] = u; this.ne[i] = ne;
      return fire | (se << 1);
    }

    tick() {
      const N = this.N, P = this.P, K = this.K, L = this.link, t = this.t;
      const G = this.gin;
      // glucose drive, 1/16 mV per tick
      const lo = G < 90 ? 90 - G : 0;
      const dAlpha = K.noalpha ? 0 : (lo * 3) >> 2;
      // beta and delta cells: K(ATP)-like drive, negative (hyperpolarising) below the set point
      const dBeta = K.weak ? sat(((G - P.GW) * 3) >> 5, -P.DMIN, 255) : sat(((G - P.GS) * 3) >> 4, -P.DMIN, 255);
      // nerve drive from the brain: sympathetic tone on every nerve ending, vagal drive on beta cells
      let sd = K.symp, vag = 0;
      if (this.linkEn) { sd = sat(sd + (L.sym >> 4), 0, 31); vag = sat(L.par >> 4, 0, 31); }
      const fg = this.glu >> 4, fi = this.i2 >> 4;             // hormone levels 0..255
      const e = [(560 * fg + 480 * fi) >> 8, 0, (560 * fg + 640 * fi) >> 8];
      const nsp = [0, 0, 0];
      let vacc = 0, g = 0, acc = 0, pm1 = 0, gup = 0;
      for (let i = 0; i < N; i++) {
        const xr = this.x, nz = ((xr >>> 28) & 15) - ((xr >>> 24) & 15);
        const ty = typeOf(g), dead = K.loss && ty === 0 && rhash(i) < 13;
        let cpl = 0, drv = ty === 1 ? dAlpha : dBeta;
        if (ty === 0) { let c = pm1 + this.cn[g]; if (c > 63) c = 63; cpl = P.GC * c; drv += vag; }
        if (dead) { drv = 0; cpl = 0; }
        const ev = this.cell(i, g, ty, cpl, drv, sd, e[ty], nz);
        this.x = xs32(xr);
        const f = ev & 1;
        nsp[ty] += f; vacc += this.v[i]; gup += f;
        if (f) { this.events++; this.tot[ty]++; if (this.raster) this.raster.push(t, i); }
        const nLo = ((this.sigLo << 1) | (this.sigHi >>> 31)) ^ f, nHi = ((this.sigHi << 1) | (this.sigLo >>> 31)) ^ (i & 1023);
        this.sigLo = nLo | 0; this.sigHi = nHi | 0;
        acc += 32; const gend = acc >= N;
        let aw = null;
        if (gend) {
          const a = L.aff[g];
          aw = [g, sat(a - (a >> 2) + 8 * gup, 0, 255)];       // group activity for the brain
          pm1 = ty === 0 ? this.cn[g] : 0; this.cn[g] = gup > 63 ? 63 : gup;
          gup = 0; acc -= N; g = (g + 1) & 31;
        }
        L.slot(aw, i === N - 1);
      }
      this.tickEnd(nsp, vacc);
    }

    tickEnd(nsp, vacc) {
      const P = this.P, t = this.t;
      // hormone fields: glucagon decays with 256 ms; insulin is a bell-shaped pulse (two stages of 32 ms)
      this.glu = sat(this.glu - ((this.glu + 255) >> 8) + ((P.GG * nsp[1]) >> 2), 0, 4095);
      const i1 = sat(this.i1 - ((this.i1 + 31) >> 5) + P.GI * (nsp[0] + nsp[2]), 0, 4095);
      this.i2 = sat(this.i2 - ((this.i2 + 31) >> 5) + (this.i1 >> 5), 0, 4095);
      this.i1 = i1;
      // firing rates of the beta and alpha populations and the glucose level read from them
      this.rb = sat(this.rb - (this.rb >> 6) + nsp[0], 0, 4095);
      this.ra = sat(this.ra - (this.ra >> 6) + nsp[1], 0, 4095);
      // beta cells active: glucose from their rate; otherwise from the alpha-cell rate (calibrated on the healthy islet)
      this.gest = this.rb >= 768 ? sat(90 + (((this.rb - 1132) * 26) >> 8), 0, 511) : sat(93 - ((this.ra * 25) >> 9), 0, 511);
      const G = this.gin;
      let f = 0;
      if (this.gest < 70) f |= 1;                              // low glucose
      if (this.gest > 180) f |= 2;                             // high glucose
      if (G > 140 && this.gest < 110) f |= 4;                  // glucose is high but the beta cells are quiet
      if (G < 70 && this.gest > 80) f |= 8;                    // glucose is low but the alpha cells are quiet
      if (this.K.symp + (this.linkEn ? this.link.sym >> 4 : 0) >= 8) f |= 16;   // strong sympathetic drive
      if (f & 0x1c) f |= 128;                                  // the islet does not answer as it should
      this.flags = f;
      this.wb = Math.min(65535, this.wb + nsp[0]); this.wa = Math.min(65535, this.wa + nsp[1]); this.wd = Math.min(65535, this.wd + nsp[2]);
      if ((t & 15) === 15) {
        const mv = sat(vacc >> 14, -128, 127) & 255;
        const L = this.link, br = this.linkEn ? sat(L.sym - L.par, -128, 127) & 255 : 0;
        const p = [this.seq, 0x20 | (this.linkEn << 3) | this.cond, this.flags, mv,
          this.wb & 255, this.wb >> 8, this.wa & 255, this.wa >> 8, this.wd & 255, this.wd >> 8,
          G & 255, G >> 8, this.gest & 255, this.gest >> 8, this.i2 >> 4, br];
        if (this.keepFrames) this.frames.push(p);
        if (this.onFrame) this.onFrame(p, (this.seq & 7) === 7);
        this.seq = (this.seq + 1) & 255; this.wb = 0; this.wa = 0; this.wd = 0;
      }
      this.t = (t + 1) & 0xffff;
      this.gin = this.glucose();                               // glucose of the next tick
    }
    run(ticks) { for (let i = 0; i < ticks; i++) this.tick(); return this; }
    signature() { const h = (a) => (a >>> 0).toString(16).padStart(8, '0'); return h(this.sigHi) + h(this.sigLo); }
  }
  const FLAGS = ['low glucose', 'high glucose', 'beta cells do not answer', 'alpha cells do not answer', 'strong sympathetic drive', '', '', 'islet response abnormal'];
  return { Chip: Pancreas, Pancreas, COND, DEF, TYPE, FLAGS, typeOf, ORGAN: 2 };
});
