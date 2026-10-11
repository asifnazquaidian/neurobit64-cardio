// Long runs of the software model: what the chip reports in every condition.
// node summary.js   -> design/results/model_summary.txt and .json   (60 s of model time per condition)
'use strict';
const fs = require('fs'), path = require('path');
const C = require('./nb64_common.js'), M = require('./nb64_cardio_model.js');
const T = 60000, rows = [];
for (const link of [0, 1]) for (let cond = 0; cond < 6; cond++) {
  const nb = link ? new C.NeuroBit64S({ lif: 1, leak: 2, tsel: 4 }) : null;
  const c = new M.Chip({ cond, link, nb }); c.run(T);
  const b = c.beats, ibi = []; for (let i = 1; i < b.length; i++) ibi.push(b[i] - b[i - 1]);
  const mean = ibi.reduce((a, x) => a + x, 0) / (ibi.length || 1);
  const fr = c.frames.slice(250), share = (bit) => Math.round(100 * fr.filter((p) => (p[2] >> bit) & 1).length / fr.length);
  const br = fr.reduce((a, p) => a + ((p[15] << 24) >> 24), 0) / fr.length;
  rows.push({ condition: cond, name: c.K.name, brain_chip: link ? 'connected' : 'none', beats: b.length, mean_interval_ms: Math.round(mean), rate_bpm: Math.round(60000 / mean),
    min_ms: Math.min(...ibi), max_ms: Math.max(...ibi), rmssd_ms: +M.rmssd(b).toFixed(1), apd_ms: c.apd, brain_drive: +br.toFixed(1),
    flags_percent_of_reports: Object.fromEntries(M.FLAGS.slice(0, 7).map((n, i) => [n, share(i)]).filter(([, v]) => v > 0)), abnormal_percent: share(7) });
}
const out = path.join(__dirname, '..', 'results');
fs.writeFileSync(path.join(out, 'model_summary.json'), JSON.stringify(rows, null, 2));
const L = ['NeuroBit64-Cardio, software model, 60 s of model time per condition (after 4 s of start-up for the flags)', '',
  'cond  condition                     brain chip  beats  rate   interval ms (min-max)   RMSSD   APD   flags raised (% of reports)'];
for (const r of rows) L.push(`${r.condition}     ${r.name.padEnd(28)}  ${r.brain_chip.padEnd(10)}  ${String(r.beats).padStart(4)}  ${String(r.rate_bpm).padStart(4)}   ${String(r.mean_interval_ms).padStart(5)} (${r.min_ms}-${r.max_ms})`.padEnd(88) + `${String(r.rmssd_ms).padStart(6)}  ${String(r.apd_ms).padStart(4)}   ${Object.entries(r.flags_percent_of_reports).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
fs.writeFileSync(path.join(out, 'model_summary.txt'), L.join('\n') + '\n'); console.log(L.join('\n'));
