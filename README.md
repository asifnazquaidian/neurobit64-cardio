# NeuroBit64-Cardio: a 1000-cell cardio-neural network chip: 1000 cardiac myocytes, each with a beta-adrenergic and an alpha-adrenergic neuron

A variant of [NeuroBit64](https://github.com/asifnazquaidian/neurobit64) for the heart. **Design and simulation only: no chip has been fabricated and there is no mask layout (GDSII) for this chip.**

It belongs to a family of three organ chips that share one architecture, one brain link and one telemetry format:
[NeuroBit64-Cardio](https://github.com/asifnazquaidian/neurobit64-cardio), [NeuroBit64-Pancreas](https://github.com/asifnazquaidian/neurobit64-pancreas), [NeuroBit64-Kidney](https://github.com/asifnazquaidian/neurobit64-kidney).

| Item | Value |
|---|---|
| Network | 1000 myocytes + 1000 beta-adrenergic neurons + 1000 alpha-adrenergic neurons |
| Architecture | one cell circuit shared by all units, one unit per slot of 8 clocks (as in NeuroBit64-S), 1000 slots per tick |
| Clock | 8 MHz gives 1 tick = 1 ms, i.e. the model runs in real time |
| State | `{na[6:0], nb[6:0], ap, s[9:0], tr[12:0], u[13:0], v[11:0]}` = 64 bits per unit, held in a circulating shift register |
| Brain link | 3 wires to a NeuroBit64-S chip: `nb_sdi` (32 group-activity bytes and their inverted copies, one sample per neuron), `nb_sdo` and `nb_sync` (its 64 decision bits; neurons 0-31 are counted as sympathetic, 32-63 as parasympathetic drive) |
| Telemetry | UART, 115.9 kbaud, one 19-byte frame every 16 ms, for a Bluetooth serial module or a USB cable; and the bit stream of a Bluetooth LE advertising packet every 128 ms for a 2.4 GHz transmitter |
| Raster output | `sdo`, `sck`, `sync`: one event bit per unit per tick in the NeuroBit64-S serial format (1 Mbit/s at 8 MHz) |
| Size (SkyWater 130 nm, Yosys) | about 248,566 standard cells, 61,042 flip-flops, 2.25 mm2 of cell area (synthesised); die about 2.4 x 2.4 mm with 23 pads |

```
                 nb_sdi                       uart_tx  --> Bluetooth serial module --> phone / PC
 NeuroBit64-S  <--------  NeuroBit64-Cardio    bb_data  --> 2.4 GHz GFSK transmitter (not designed)
 (brain chip)  -------->  1000 units            sdo/sck/sync --> serial memory (raster)
              nb_sdo, nb_sync
```

## The model

- Cell: the Hybrid Excitable Cell (HEC) model for cardiac myocytes of the thesis (chapter 5, section "Cardiac Myocytes", human column of the species table: a = 0.03, b = -6, C = 50, d = 25, k = 0.5, V_beta = 70 mV, V_Ca = 45 mV), forward Euler with a 1 ms step.
- At rest `v' = v + k (v - Vr)(v - Vt)/C - u/C - g Va + I`, `u' = u + a (b (v - Vr) - u)`. When `v >= Vt` the cell fires: the beta-receptor potential `Vb` is released and the membrane follows `Vb exp(-s/Tk) - 48 mV + VCa (1 - ((s - mu)/W)^2)` (upstroke, plateau, repolarisation). When `Vb exp(-s/Tk)` has fallen below 5 mV the action potential ends, `v = Vr`, and the alpha-receptor potential `Va = 60 mV` is released.
- Neurons: the beta neuron of a cell integrates `Vb`, the alpha neuron integrates `Va`, with the leaky integrate-and-fire rule of NeuroBit64-S. The beta neurons therefore burst at the upstroke and the alpha neurons at the end of the plateau; the chip measures the action potential duration as the time between the two population bursts, as proposed in the thesis (section "Cardio-Neural Network").
- Network: 32 conduction groups of 31 or 32 cells. Group 0 is the sino-atrial group and receives a pacemaker drive; every cell is excited by the upstrokes of its own and of the previous group in the previous tick, so an activation travels through the groups in about 64 ms. A beat is counted when half of the cells have fired in one activation (the collective-firing criterion of the thesis).

### What was added to the thesis model

- The thesis value `Tk = 250 ms` gives a 600-660 ms action potential. The chip uses 128 ms by default (action potential about 320 ms) so that rates up to 140 beats/min fit; condition 5 switches to 256 ms.
- The Gaussian calcium term of the thesis is replaced by a parabola of the same height and similar width (no exponential function is needed).
- The decaying alpha-receptor potential holding the cell down (which sets the diastolic interval), the dependence of the next `Vb` on the remaining `Va` (restitution), the 32-group conduction path, the slow 4.1 s modulation of the pacemaker drive and the six demonstration conditions are design decisions of this chip. They are not taken from measurements.

## What the chip reports

Every 16 ticks: sequence number, organ and condition, flags, mean membrane potential, upstrokes, beta-neuron spikes, alpha-neuron spikes, beat interval (ms), action potential duration (ms), change of the interval, brain drive.

Flags: tachycardia (interval < 600 ms), bradycardia (> 1000 ms), irregular rhythm (3 of the last 8 interval changes > 100 ms), blocked activation, long action potential (> 450 ms), pause (> 2 s), low participation (< 7/8 of the cells).

Conditions (pins `cond[2:0]`, for demonstration and test): 0 normal sinus rhythm, 1 tachycardia, 2 bradycardia, 3 irregular rhythm, 4 conduction block, 5 prolonged action potential.

Results of the software model (`design/results/model_summary.txt`):

```
NeuroBit64-Cardio, software model, 60 s of model time per condition (after 4 s of start-up for the flags)

cond  condition                     brain chip  beats  rate   interval ms (min-max)   RMSSD   APD   flags raised (% of reports)
0     normal sinus rhythm           none          79    79     761 (713-818)              35.1   314   none
1     tachycardia                   none         138   137     438 (428-468)               4.6   294   tachycardia 100
2     bradycardia                   none          50    50    1198 (1150-1251)            34.3   322   bradycardia 100
3     irregular rhythm              none          84    83     719 (588-970)               130   311   tachycardia 4, irregular rhythm 72
4     conduction block              none          40    39    1522 (1448-1596)            95.3   318   bradycardia 100, irregular rhythm 72, blocked activation 100
5     prolonged action potential    none          59    58    1030 (981-1090)             45.9   601   bradycardia 76, long action potential 100
0     normal sinus rhythm           connected     82    82     735 (693-787)              29.5   318   none
1     tachycardia                   connected    138   138     436 (426-465)               4.4   294   tachycardia 100
2     bradycardia                   connected     62    62     967 (952-986)              12.6   320   none
3     irregular rhythm              connected     86    86     701 (593-908)             105.8   319   tachycardia 5, irregular rhythm 64
4     conduction block              connected     41    41    1471 (1408-1541)            82.1   318   bradycardia 100, irregular rhythm 50, blocked activation 100
5     prolonged action potential    connected     60    60    1003 (962-1055)             38.9   600   bradycardia 54, long action potential 100
```

## Verification

The Verilog was simulated with Icarus Verilog and compared with the software model `design/model/nb64_cardio_model.js`, which uses the same integer arithmetic. Compared: every UART frame, every Bluetooth LE advertising packet bit by bit, the number of events and a 64-bit signature of the whole raster stream and, with a NeuroBit64-S chip (its real Verilog) wired to the link, the word count and signature of that chip. An independent receiver model also checked the CRC of every advertising packet.

| Condition | Ticks (ms) | NeuroBit64-S connected | Frames | BLE packets | Raster events | Brain words | Result |
|---|---|---|---|---|---|---|---|
| 0 | 2400 | no | 150 | 54 | 4000 | - | identical |
| 3 | 1600 | yes | 100 | 36 | 2000 | 24998 | identical |
| 4 | 1920 | yes | 120 | 45 | 2250 | 29998 | identical |
| 5 | 1280 | no | 80 | 30 | 2000 | - | identical |
| 2 | 640 | no | 40 | 15 | 1000 | - | identical |
| 1 | 960 | yes | 60 | 21 | 2782 | 14998 | identical |

Full record: `design/results/verilog_vs_model.txt`. Icarus Verilog needs about 0.25 s per tick for 1000 units, so the long runs (60 s of model time) were made with the software model only.

## Size

| Units | Standard cells | Flip-flops | Cell area (um2) | |
|---|---|---|---|---|
| 64 | 23924 | 4880 | 211648 | synthesised |
| 128 | 39248 | 8720 | 351413 | synthesised |
| 1000 | 248566 | 61042 | 2253063 | synthesised (straight-line estimate from the two rows above: 248038 cells, 2255715 um2) |

About 2184 um2 per unit and 71883 um2 for everything else. `design/floorplan.svg` is a to-scale block floorplan (a planning drawing). The chip is larger than the biggest Tiny Tapeout tile (8x2 tiles, about 0.3 mm2), so it needs its own die on an open multi-project wafer run.

## What has NOT been done

- **No layout.** Place and route, timing analysis and gate-level simulation have not been run. 8 MHz is slow for 130 nm, but that is an expectation, not a result.
- **No radio.** The chip makes the bits of the advertising packet; the 2.4 GHz transmitter is analog and is not designed. The practical route to a phone is the UART pin with a ready-made Bluetooth serial module, and that path has not been tried with hardware.
- **The link was simulated only with both chips released from reset together.** The logic that re-aligns to the `sync` pin of NeuroBit64-S after a different start has not been exercised.
- **The meaning of the brain link is a convention of these chips** (which NeuroBit64 neurons count as sympathetic or parasympathetic). NeuroBit64-S is a general 64-neuron chip, not a model of a brain region.
- The rhythm classes are conditions built into the model. The chip has not been tested on recorded ECG or patient data and is not a diagnostic device.

## Files

| Path | Content |
|---|---|
| `design/rtl/nb64_cardio.v` | the chip |
| `design/rtl/nb64_link.v`, `design/rtl/nb64_telemetry.v` | brain link, UART and Bluetooth LE packet generator (shared by the three chips) |
| `design/tb/` | test bench and the NeuroBit64-S chip used in the link tests |
| `design/model/` | software model (`nb64_cardio_model.js`, `nb64_common.js`), test and summary scripts |
| `design/results/` | test records, model summary, synthesis reports |
| `design/synth/` | Yosys scripts |
| `app/` | NeuroBit64 Organ Monitor (web app) |

## Repeat the tests

Needs Node.js, Icarus Verilog and (for the size) Yosys with the sky130 liberty file.

```
pwsh design/run_tests.ps1 -Organ cardio -Tests "0,320,0;1,320,1"     # condition,ticks,link ; ...
node design/model/summary.js
```

## Monitor app

Open `app/index.html` (or publish the `app` folder as a static site). It runs the chip model in the browser, or receives the frames from a Bluetooth serial module (Web Bluetooth) or a serial port (Web Serial) and shows the readings, the flags and the signals. It was tested with the simulated source only.

## Reference and licence

A. Mehmood, "Artificial Neuron Model for Large Scale Spiking Brain Neural Network", PhD thesis, University of Engineering and Technology Taxila, 2025.

Copyright (c) 2026 Asif Mehmood. Apache License 2.0 (see `LICENSE`). AI tools were used where applicable, for convenience, in preparing the circuit description, the tests and this document. This is a research design, not a medical device.
