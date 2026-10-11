// Runs the software model of an organ chip and writes the same record as the Verilog test bench.
// node run_model.js --organ cardio|pancreas|kidney --ticks 320 [--cells 1000] [--cond 0] [--link 1]
//                   [--adv 1] [--nblif 1 --nbleak 2 --nbtsel 4] --out file
'use strict';
const fs = require('fs'), path = require('path');
const C = require('./nb64_common.js');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const organ = arg('organ', 'cardio'), T = +arg('ticks', 320), N = +arg('cells', 1000), cond = +arg('cond', 0);
const link = +arg('link', 0), adv = +arg('adv', 1), out = arg('out', null);
const M = require(path.join(__dirname, `nb64_${organ}_model.js`));
const NBW = Math.floor(T * N / 64) - 2;
const nb = link ? new C.NeuroBit64S({ lif: +arg('nblif', 1), leak: +arg('nbleak', 2), tsel: +arg('nbtsel', 4), snapAt: NBW }) : null;
const lines = [];
let organId = 0;
const chip = new M.Chip({ N, cond, link, nb, onFrame: (p, isAdv) => {
  organId = p[1] >> 4;
  lines.push('U ' + p.map(C.hex2).join(' '));
  if (adv && isAdv) for (let ch = 0; ch < 3; ch++) lines.push(`A ${ch} ${C.advBits(organId, p, 37 + ch)}`);
} });
const gcmd = +arg('gcmd', -1), gtick = +arg('gtick', 0);     // value written through uart_rx during tick gtick
if (gcmd >= 0) { chip.run(gtick); chip.setInput(gcmd); chip.run(T - gtick); } else chip.run(T);
const packets = lines.filter((l) => l[0] === 'A').length;
lines.push(`RESULT ticks=${T} cells=${N} cond=${cond} link=${link} frames=${T >> 4} packets=${packets} raster_bits=${T * N} raster_ones=${chip.events} raster_sig=${chip.signature()} nb_words=${link ? NBW : 0} nb_ones=${link ? nb.snap.ones : 0} nb_sig=${link ? nb.snap.sig : '0000000000000000'}`);
if (out) fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(lines[lines.length - 1]);
