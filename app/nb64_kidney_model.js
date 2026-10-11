// NeuroBit64-Kidney: bit-exact software model of design/rtl/nb64_kidney.v
// 1000 nephron units. Each unit is one Hybrid Excitable Cell (the juxtaglomerular / afferent-
// arteriole cell of the nephron; one spike stands for one quantum of filtrate) with an
// alpha-1 adrenergic neuron (vasoconstrictor) and a beta-1 adrenergic neuron (renin release).
// The HEC equations and constants are those of the thesis (regular-spiking set); their use for the
// kidney is an extension proposed in the thesis chapter "Future Directions" and is not validated
// against kidney data.
// Copyright (c) 2026 Asif Mehmood.  SPDX-License-Identifier: Apache-2.0
//
// Number formats   v 12-bit signed, 1/16 mV   u 16-bit signed, 1/32 mV   tr 12-bit, 1/16 mV
//                  (threshold elevation = tubuloglomerular feedback)   act 1 bit   n1, n2 7-bit neurons
// One tick is one Euler step of 1 ms. One unit = 55 bits of state.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./nb64_common.js'));
  else root.NB64Kidney = factory(root.NB64);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';
  const { sat, xs32, rhash, lif7 } = C;
  const VR = -960;
  // conditions (pins cond[2:0]).  loss: nephrons with hash < loss do not work (out of 16),
  // p: perfusion pressure in mmHg (0 = slow sweep 60..187), symp: resting sympathetic tone
  const COND = [
    { name: 'healthy kidney',                      loss: 0,  p: 100, symp: 0 },
    { name: 'early nephron loss (25 %)',           loss: 4,  p: 100, symp: 0 },
    { name: 'moderate nephron loss (50 %)',        loss: 8,  p: 100, symp: 0 },
    { name: 'advanced nephron loss (75 %)',        loss: 12, p: 100, symp: 0 },
    { name: 'low perfusion pressure (60 mmHg)',    loss: 0,  p: 60,  symp: 0 },
    { name: 'high perfusion pressure (160 mmHg)',  loss: 0,  p: 160, symp: 0 },
    { name: 'high sympathetic tone',               loss: 0,  p: 100, symp: 12 },
    { name: 'healthy kidney, pressure sweep',      loss: 0,  p: 0,   symp: 0 },
  ];
  // TGT: filtration set point (spikes per tick), ATG: threshold step per spike (1/16 mV),
  // RSH: shift of the renin field into the drive, KN: effect of one alpha-1 spike, GP: pressure gain
  const DEF = { N: 1000, TGT: 16, ATG: 640, RSH: 7, KN: 48, GP: 10 };

  class Kidney {
    constructor(o) {
      o = o || {};
      this.P = Object.assign({}, DEF, o.params || {});
      const N = this.N = o.N || this.P.N;
      this.cond = o.cond | 0; this.linkEn = o.link ? 1 : 0;
      this.K = Object.assign({}, COND[this.cond], o.condOverride || {});
      this.link = new C.Link(o.nb || null);
      this.v = new Int16Array(N).fill(VR); this.u = new Int16Array(N); this.tr = new Uint16Array(N);
      this.act = new Uint8Array(N); this.n1 = new Uint8Array(N); this.n2 = new Uint8Array(N);
      this.x = 0x12345678 | 0; this.t = 0;
      this.renin = 0; this.rsym = 0; this.rlev = 0;    // renin-angiotensin fields, 12 bit
      this.pext = -1; this.pin = this.pressure();
      this.etot = 0; this.eact = 0;                    // totals of the running 256-tick epoch
      this.active = 0; this.gfr = 0; this.rate = 0; this.flags = 0; this.seq = 0; this.epochs = 0;
      this.wf = 0; this.wa = 0; this.wb = 0;
      this.frames = []; this.onFrame = o.onFrame || null; this.keepFrames = o.keepFrames !== false;
      this.sigLo = 0; this.sigHi = 0; this.events = 0;
      this.raster = o.raster ? [] : null;
    }
    pressure() {
      if (this.pext >= 0) return this.pext;
      if (this.K.p) return this.K.p;
      const ph = this.t & 16383, tri = (ph < 8192 ? ph : 16383 - ph) >> 6;      // 0..127, period 16.4 s
      return 60 + tri;
    }
    setPressure(mm) { this.pext = mm === 0xffff ? -1 : sat(mm | 0, 0, 255); }
    setInput(x) { this.setPressure(x); }

    cell(i, drv, sd, sdb, nz, last) {
      const P = this.P;
      let v = this.v[i], u = this.u[i], tr = this.tr[i], act = this.act[i], n1 = this.n1[i], n2 = this.n2[i], s1, s2;
      const dead = rhash(i) < this.K.loss;
      const x = v - VR, y = x - 320, p = x * y;
      const q = (p * 229 + 262144) >> 19;                      // k/C (v - Vr)(v - Vt), k = 0.7, C = 100
      const tu = (u * 41 + 4096) >> 13;                        // u / C
      const fire = !dead && v >= -640 + tr ? 1 : 0;            // threshold = Vt + feedback
      [n1, s1] = lif7(n1, sd);                                 // alpha-1 neuron: vasoconstriction
      [n2, s2] = lif7(n2, sdb);                                // beta-1 neuron: renin release
      const vn = sat(v + q - tu + (dead ? 0 : drv - (s1 ? P.KN : 0)) + nz, -2048, 2047);
      const t = -4 * x - u;                                    // b (v - Vr) - u, b = -2
      const un = sat(u + ((t * 123 + 2048) >> 12), -32768, 32767);
      if (fire) { v = -800; u = sat(u + 3200, -32768, 32767); tr = sat(tr + P.ATG, 0, 4095); }
      else { v = vn; u = un; tr = tr - ((tr + 127) >> 7); }
      const wasAct = act | fire;
      act = last ? 0 : wasAct;                                 // cleared in the last tick of an epoch
      this.v[i] = v; this.u[i] = u; this.tr[i] = tr; this.act[i] = act; this.n1[i] = n1; this.n2[i] = n2;
      return fire | (s1 << 1) | (s2 << 2) | (wasAct << 3);
    }

    tick() {
      const N = this.N, P = this.P, K = this.K, L = this.link, t = this.t;
      const pr = this.pin;
      let sd = K.symp; if (this.linkEn) sd = sat(sd + (L.sym >> 4), 0, 31);
      const lowp = pr < 80 ? (80 - pr) >> 2 : 0;               // intrarenal baroreceptor
      const sdb = sat(sd + lowp, 0, 31);
      const drv = ((pr * P.GP) >> 6) + (this.renin >> P.RSH);
      const last = (t & 255) === 255;
      let nf = 0, na = 0, nb = 0, nact = 0, vacc = 0, g = 0, acc = 0, gup = 0;
      for (let i = 0; i < N; i++) {
        const xr = this.x, nz = ((xr >>> 28) & 15) - ((xr >>> 24) & 15);
        const ev = this.cell(i, drv, sd, sdb, nz, last);
        this.x = xs32(xr);
        const f = ev & 1;
        nf += f; na += (ev >> 1) & 1; nb += (ev >> 2) & 1; nact += (ev >> 3) & 1; vacc += this.v[i]; gup += f;
        if (f) { this.events++; if (this.raster) this.raster.push(t, i); }
        const nLo = ((this.sigLo << 1) | (this.sigHi >>> 31)) ^ f, nHi = ((this.sigHi << 1) | (this.sigLo >>> 31)) ^ (i & 1023);
        this.sigLo = nLo | 0; this.sigHi = nHi | 0;
        acc += 32; const gend = acc >= N;
        let aw = null;
        if (gend) {
          const a = L.aff[g];
          aw = [g, sat(a - (a >> 2) + 8 * gup, 0, 255)];       // group filtration activity for the brain
          gup = 0; acc -= N; g = (g + 1) & 31;
        }
        L.slot(aw, i === N - 1);
      }
      this.tickEnd(nf, na, nb, nact, vacc, sd, last);
    }

    tickEnd(nf, na, nb, nact, vacc, sd, last) {
      const P = this.P, N = this.N, t = this.t;
      this.renin = sat(this.renin + P.TGT - nf, 0, 4095);     // macula densa path: rises while filtration is below the set point
      this.rsym = sat(this.rsym - (this.rsym >> 6) + (nb >> 2), 0, 4095);   // beta-1 path: renin released by nerve spikes
      this.rlev = sat(this.renin + this.rsym, 0, 4095);
      const etot = Math.min(65535, this.etot + nf);
      if (last) {
        this.active = nact;                                    // nephrons that filtered in this epoch
        this.gfr = Math.min(255, (etot * 25) >> 10);           // percent of the set point (4096 spikes per epoch)
        this.rate = etot; this.etot = 0; this.epochs = Math.min(3, this.epochs + 1);
      } else this.etot = etot;
      let f = 0;
      const ok = this.epochs >= 2;                             // the first epoch contains the start-up
      if (ok && this.active < N - (N >> 3)) f |= 1;                             // nephrons missing
      if (ok && this.rate * N > this.active * 320 * P.TGT) f |= 2;              // filtration per working nephron above 125 %
      if (ok && this.gfr < 60) f |= 4;                                          // total filtration low
      if (this.rlev > 2048) f |= 8;                                            // renin high
      if (sd >= 8) f |= 16;                                                     // strong sympathetic drive
      if (this.pin > 140) f |= 32;                                              // perfusion pressure high
      if ((f & 3) === 3 && !(f & 4)) f |= 64;                                   // early pattern: loss hidden by hyperfiltration
      if (f) f |= 128;
      this.flags = f;
      this.wf = Math.min(65535, this.wf + nf); this.wa = Math.min(65535, this.wa + na); this.wb = Math.min(65535, this.wb + nb);
      if ((t & 15) === 15) {
        const mv = sat(vacc >> 14, -128, 127) & 255;
        const L = this.link, br = this.linkEn ? sat(L.sym - L.par, -128, 127) & 255 : 0;
        const p = [this.seq, 0x30 | (this.linkEn << 3) | this.cond, this.flags, mv,
          this.wf & 255, this.wf >> 8, this.wa & 255, this.wa >> 8, this.wb & 255, this.wb >> 8,
          this.active & 255, this.active >> 8, this.gfr, this.pin, this.rlev >> 4, br];
        if (this.keepFrames) this.frames.push(p);
        if (this.onFrame) this.onFrame(p, (this.seq & 7) === 7);
        this.seq = (this.seq + 1) & 255; this.wf = 0; this.wa = 0; this.wb = 0;
      }
      this.t = (t + 1) & 0xffff;
      this.pin = this.pressure();
    }
    run(ticks) { for (let i = 0; i < ticks; i++) this.tick(); return this; }
    signature() { const h = (a) => (a >>> 0).toString(16).padStart(8, '0'); return h(this.sigHi) + h(this.sigLo); }
  }
  const FLAGS = ['nephrons missing', 'hyperfiltration', 'low total filtration', 'renin high', 'strong sympathetic drive', 'high perfusion pressure', 'early-loss pattern', 'abnormal'];
  return { Chip: Kidney, Kidney, COND, DEF, FLAGS, ORGAN: 3 };
});
