// Compares the record of the Verilog test bench with the record of the software model.
// node compare.js verilog.out model.out   -> prints PASS or the first difference; exit code 1 on FAIL
'use strict';
const fs = require('fs');
const C = require('./nb64_common.js');
const rd = (f) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean);
const v = rd(process.argv[2]), m = rd(process.argv[3]);
const body = (a) => a.filter((l) => !l.startsWith('RESULT')), res = (a) => a.find((l) => l.startsWith('RESULT'));
const vb = body(v), mb = body(m);
let bad = null;
for (let i = 0; i < mb.length && !bad; i++) if (vb[i] !== mb[i]) bad = `line ${i + 1}\n  verilog: ${vb[i]}\n  model:   ${mb[i]}`;
if (!bad && res(v) !== res(m)) bad = `RESULT\n  verilog: ${res(v)}\n  model:   ${res(m)}`;
// independent receiver on the Verilog bits: CRC, address, payload = the UART frame before it
let rx = 0, last = null, addr = '';
for (const l of vb) {
  if (l[0] === 'U') last = l.slice(2);
  else { const [, ch, bits] = l.split(' '); const a = C.advReceive(bits, 37 + +ch); addr = a.addr;
    if (a.type !== 2 || a.mfg.company !== 0xffff || a.mfg.data.map(C.hex2).join(' ') !== last) bad = bad || 'advertising packet does not carry the UART payload'; rx++; }
}
const frames = mb.filter((l) => l[0] === 'U').length;
console.log(`${bad ? 'FAIL' : 'PASS'}  ${frames} frames and ${mb.length - frames} advertising packets identical; ${rx} packets received with good CRC${addr ? ' from ' + addr : ''}`);
console.log('  ' + res(v));
if (bad) { console.log(bad); process.exit(1); }
