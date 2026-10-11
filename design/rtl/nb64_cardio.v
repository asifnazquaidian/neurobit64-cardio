/*
 * NeuroBit64-Cardio : 1000 cardiac myocytes, each with a beta-adrenergic and an alpha-adrenergic
 * neuron, on one time-shared circuit. Variant of NeuroBit64-S for the heart.
 * Copyright (c) 2026 Asif Mehmood.  SPDX-License-Identifier: Apache-2.0
 *
 * Cell model: Hybrid Excitable Cell model for cardiac myocytes (A. Mehmood, PhD thesis, UET Taxila
 * 2025, chapter 5), forward Euler, one step of 1 ms per tick, human parameter column:
 *   rest      v' = v + k (v - Vr)(v - Vt) / C - u / C - g Va + I       u' = u + a (b (v - Vr) - u)
 *   upstroke  when v >= Vt: the beta-receptor potential Vb is released, u' = u + d
 *   plateau   v = Vb exp(-s / Tk) - 48 mV + VCa (1 - ((s - mu) / W)^2)   (s = ms since the upstroke)
 *   end       when Vb exp(-s / Tk) < 5 mV: v = Vr, the alpha-receptor potential Va = 60 mV is released
 *   Va decays with 128 ms and holds the cell down, which sets the diastolic interval
 * The beta neuron of a cell integrates Vb, the alpha neuron integrates Va (NeuroBit64 leaky
 * integrate-and-fire rule), so the beta neurons fire at the upstroke and the alpha neurons at the
 * end of the plateau; the time between the two bursts is the action potential duration.
 *
 * Network: 32 groups of 31 or 32 cells. Group 0 is the sino-atrial group and has a pacemaker drive.
 * A cell is excited by the upstrokes of its own and of the previous group in the previous tick.
 *
 * Timing: one cell per slot of 8 clocks (as in NeuroBit64-S), N slots per tick.
 *         N = 1000 and clk = 8 MHz give 1 tick = 1 ms, i.e. real time.
 * State:  64 bits per unit {na[6:0], nb[6:0], ap, s[9:0], tr[12:0], u[13:0], v[11:0]}
 *         v 1/16 mV, u 1/32 mV, tr 1/64 mV (Vb during the action potential, Va after it)
 *
 * cond[2:0]  0 normal  1 tachycardia  2 bradycardia  3 irregular rhythm  4 conduction block
 *            5 prolonged action potential (Tk = 256 ms, the thesis value)  6, 7 as 0
 * Report (16 bytes, every 16 ticks): seq, 0x10|link<<3|cond, flags, mean v (mV), upstrokes,
 *   beta spikes, alpha spikes, beat interval (ms), action potential duration (ms), |change of the
 *   interval|, brain drive.  Flags: 0 tachycardia 1 bradycardia 2 irregular 3 blocked activation
 *   4 long action potential 5 pause 6 low participation 7 any of them.
 * Bit-exact software model: design/model/nb64_cardio_model.js
 */

`default_nettype none

module nb64_cardio #(
    parameter N = 1000
) (
    input  wire       clk,
    input  wire       rst_n,
    input  wire [2:0] cond,
    input  wire       link_en,    // 1 = use the drive received from NeuroBit64-S
    input  wire       adv_en,     // 1 = also make Bluetooth LE advertising packets
    input  wire       nb_sdo,     // from NeuroBit64-S
    input  wire       nb_sync,
    output wire       nb_sdi,     // to NeuroBit64-S
    output reg        sdo,        // raster: one upstroke bit per cell per tick, NeuroBit64-S format
    output reg        sck,
    output reg        sync,
    output wire       uart_tx,
    output wire       bb_data,
    output wire       bb_en,
    output wire       pll_en,
    output wire [1:0] rf_ch
);
    localparam SW = 64;
    localparam [9:0] NM1 = N - 1;

    // ---------------------------------------------------------------- condition table
    reg [7:0] isa4;  reg [1:0] rsa;  reg [2:0] jg;  reg av;  reg tk8;
    always @(*) begin
        isa4 = 8'd44; rsa = 2'd3; jg = 3'd0; av = 1'b0; tk8 = 1'b0;
        case (cond)
            3'd1: isa4 = 8'd240;
            3'd2: begin isa4 = 8'd12; rsa = 2'd0; end
            3'd3: begin isa4 = 8'd64; jg = 3'd5; end
            3'd4: av = 1'b1;
            3'd5: tk8 = 1'b1;
            default: ;
        endcase
    end

    // ---------------------------------------------------------------- sequencer
    reg  [2:0]      b;                          // clock within the slot
    reg  [9:0]      ci;                         // cell being served
    reg  [15:0]     t;                          // tick counter
    reg  [31:0]     x32;                        // noise source
    reg  [N*SW-1:0] vm;                         // circulating state, current cell at the bottom
    reg  [10:0]     gacc;                       // group divider
    reg  [4:0]      g;                          // group of the current cell
    reg  [5:0]      pm1;                        // upstrokes of the previous group in the previous tick
    reg  [191:0]    cn;                         // the same for all 32 groups, current group at the bottom
    reg  [5:0]      gup;                        // upstrokes of the current group in this tick
    reg  [6:0]      gsp;                        // neuron spikes of the current group in this tick
    reg             valid;
    wire            last  = (b == 3'd7);
    wire            tlast = last && (ci == NM1);

    wire [31:0] x1 = x32 ^ (x32 << 13);
    wire [31:0] x2 = x1 ^ (x1 >> 17);
    wire [31:0] x3 = x2 ^ (x2 << 5);

    // ---------------------------------------------------------------- brain link
    wire [7:0] aff_rd;
    wire [9:0] sym, par, sym_now, par_now;
    wire       gend;
    wire [7:0] aff_wd;
    nb64_link link (
        .clk(clk), .rst_n(rst_n), .nb_sdo(nb_sdo), .nb_sync(nb_sync), .nb_sdi(nb_sdi),
        .aff_we(last && gend), .aff_wa(g), .aff_wd(aff_wd), .aff_ra(g), .aff_rd(aff_rd),
        .tick_end(tlast), .sym_now(sym_now), .par_now(par_now), .sym(sym), .par(par)
    );

    // ---------------------------------------------------------------- pacemaker drive of this tick
    reg  [3:0] jit;                             // beat-to-beat random number (irregular rhythm)
    wire [11:0] ph   = t[11:0];
    wire [2:0]  trw  = ph[11] ? ~ph[10:8] : ph[10:8];                   // slow triangle, 4.1 s
    wire signed [10:0] dbr  = $signed({1'b0, sym}) - $signed({1'b0, par});
    wire signed [10:0] dbr4 = dbr >>> 4;
    wire signed [10:0] brn  = (dbr4 > 11'sd31) ? 11'sd31 : (dbr4 < -11'sd32) ? -11'sd32 : dbr4;
    wire signed [11:0] isum = $signed({4'b0, isa4})
                            + $signed({1'b0, rsa}) * ($signed({3'b000, trw}) - 6'sd4)
                            + $signed({1'b0, jg}) * ($signed({2'b00, jit}) - 6'sd8)
                            + (link_en ? $signed({brn[10], brn}) : 12'sd0);
    wire [10:0] isaq = isum[11] ? 11'd0 : isum[10:0];

    // ---------------------------------------------------------------- one cell
    wire signed [11:0] v   = vm[11:0];
    wire signed [13:0] u   = vm[25:12];
    wire        [12:0] tr  = vm[38:26];
    wire        [9:0]  s   = vm[48:39];
    wire               ap  = vm[49];
    wire        [6:0]  nb  = vm[56:50];
    wire        [6:0]  na  = vm[63:57];

    wire [3:0] r    = {ci[0], ci[1], ci[2], ci[3]} ^ ci[7:4] ^ {2'b00, ci[9:8]};
    wire       node = av && (g == 5'd8);
    wire signed [4:0] nz = $signed({1'b0, x32[31:28]}) - $signed({1'b0, x32[27:24]});

    // rest
    wire signed [12:0] x   = v + 13'sd960;                                // v - Vr
    wire signed [12:0] y   = x - 13'sd320;                                // v - Vt
    wire signed [25:0] p   = x * y;
    wire signed [35:0] qf  = p * 36'sd164 + 36'sd131072;
    wire signed [17:0] q   = qf >>> 18;                                   // k/C (v - Vr)(v - Vt)
    wire signed [21:0] tuf = u * 22'sd41 + 22'sd2048;
    wire signed [9:0]  tu  = tuf >>> 12;                                  // u / C
    wire        [12:0] hyp = node ? (tr >> 1) : (tr >> 5);
    wire        [6:0]  cps = {1'b0, pm1} + {1'b0, cn[5:0]};
    wire        [5:0]  cpl = cps[6] ? 6'd63 : cps[5:0];
    wire        [11:0] isd = {1'b0, isaq} + {10'd0, x32[1:0]};
    wire        [9:0]  isa = (g == 5'd0) ? isd[11:2] : 10'd0;
    wire signed [19:0] vsum = v + q - tu - $signed({1'b0, hyp}) + nz
                            + $signed({1'b0, cpl, 5'b00000}) + $signed({1'b0, isa});
    wire signed [11:0] vn  = (vsum > 20'sd2047) ? 12'sd2047 : (vsum < -20'sd2048) ? -12'sd2048 : vsum[11:0];
    wire signed [17:0] tt  = -(18'sd12 * x) - u;                          // b (v - Vr) - u
    wire signed [27:0] duf = tt * 28'sd123 + 28'sd2048;
    wire signed [17:0] us  = u + (duf >>> 12);
    wire signed [13:0] un  = (us > 18'sd8191) ? 14'sd8191 : (us < -18'sd8192) ? -14'sd8192 : us[13:0];
    wire signed [15:0] ud  = u + 16'sd800;                                // u + d
    wire signed [13:0] uf  = (ud > 16'sd8191) ? 14'sd8191 : ud[13:0];
    wire               up  = !ap && (v >= -12'sd640);
    wire        [6:0]  vb0  = 7'd62 + {3'b000, r};                        // 62..77 mV
    wire        [12:0] trup = {vb0, 6'b000000} - {1'b0, tr[12:1]};
    wire        [12:0] trda = node ? (tr - ((tr + 13'd511) >> 9)) : (tr - ((tr + 13'd127) >> 7));

    // action potential
    wire        [12:0] trn = tk8 ? (tr - ((tr + 13'd255) >> 8)) : (tr - ((tr + 13'd127) >> 7));
    wire signed [10:0] dx  = $signed({1'b0, s}) - 11'sd225;
    wire        [21:0] sq  = dx * dx;
    wire        [31:0] bm  = 32'd720 * sq;
    wire        [9:0]  bump = (sq < 22'd32768) ? (10'd720 - bm[24:15]) : 10'd0;
    wire               down = ap && (tr < 13'd320);
    wire signed [12:0] vap = $signed({2'b00, trn[12:2]}) - 13'sd768 + $signed({3'b000, bump});

    // the two neurons (NeuroBit64 leaky integrate-and-fire rule)
    wire [4:0] trin = tr[12:8];
    wire [7:0] nbs  = {1'b0, nb} - {3'b000, nb[6:2]} + (ap ? {3'b000, trin} : 8'd0);
    wire [7:0] nas  = {1'b0, na} - {3'b000, na[6:2]} + (ap ? 8'd0 : {3'b000, trin});
    wire       sb   = (nbs >= 8'd32);
    wire       sa   = (nas >= 8'd32);

    wire [11:0] v_nx  = !ap ? (up ? 12'sd560 : vn) : (down ? -12'sd960 : vap[11:0]);
    wire [13:0] u_nx  = !ap ? (up ? uf : un) : u;
    wire [12:0] tr_nx = !ap ? (up ? trup : trda) : (down ? 13'd3840 : trn);
    wire [9:0]  s_nx  = !ap ? (up ? 10'd0 : s) : (down ? 10'd0 : (&s ? s : s + 10'd1));
    wire        ap_nx = !ap ? up : !down;
    wire [6:0]  nb_nx = sb ? 7'd0 : nbs[6:0];
    wire [6:0]  na_nx = sa ? 7'd0 : nas[6:0];

    // ---------------------------------------------------------------- groups
    wire [10:0] gsum  = gacc + 11'd32;
    assign      gend  = (gsum >= N);
    wire [6:0]  gupn  = {1'b0, gup} + {6'd0, up};
    wire [5:0]  gupc  = gupn[6] ? 6'd63 : gupn[5:0];
    wire [6:0]  gspn  = gsp + {6'd0, sb} + {6'd0, sa};
    wire [9:0]  affs  = {2'b00, aff_rd} - {4'b0000, aff_rd[7:2]} + {1'b0, gspn, 2'b00};
    assign      aff_wd = (|affs[9:8]) ? 8'd255 : affs[7:0];

    // ---------------------------------------------------------------- per-tick totals
    reg  [9:0]  ups, bsp, asp;
    reg  signed [22:0] vacc;
    wire [9:0]  ups_t = ups + {9'd0, up};
    wire [9:0]  bsp_t = bsp + {9'd0, sb};
    wire [9:0]  asp_t = asp + {9'd0, sa};
    wire signed [22:0] vacc_t = vacc + $signed(v_nx);

    // ---------------------------------------------------------------- beat detector and measurements
    reg  [11:0] epi;     reg [7:0] quiet;  reg beat_done;  reg [15:0] t_last;
    reg  [11:0] ibi;     reg [7:0] dibi;   reg [7:0] irr;  reg partial, block, lowpart;
    reg  [1:0]  nbeats;  reg [1:0] arm;    reg [15:0] t_b; reg [11:0] apd;
    reg  [7:0]  seq;     reg [15:0] wu, wb, wa;

    reg  [11:0] epi_n;   reg [7:0] quiet_n; reg beat_done_n; reg [15:0] t_last_n;
    reg  [11:0] ibi_n;   reg [7:0] dibi_n;  reg [7:0] irr_n; reg partial_n, block_n, lowpart_n;
    reg  [1:0]  nbeats_n; reg [1:0] arm_n;  reg [15:0] t_b_n; reg [11:0] apd_n;
    reg  [7:0]  flags_n; reg beat_now;
    reg  [12:0] esum;    reg [15:0] since, adur;   reg [11:0] ibic, dabs;   reg [3:0] ic;
    integer     k;
    always @(*) begin
        epi_n = epi; quiet_n = quiet; beat_done_n = beat_done; t_last_n = t_last; ibi_n = ibi; dibi_n = dibi;
        irr_n = irr; partial_n = partial; block_n = block; lowpart_n = lowpart; nbeats_n = nbeats;
        arm_n = arm; t_b_n = t_b; apd_n = apd; beat_now = 1'b0;

        esum    = {1'b0, epi} + {3'b000, ups_t};
        epi_n   = esum[12] ? 12'd4095 : esum[11:0];
        quiet_n = (ups_t != 10'd0) ? 8'd0 : (&quiet ? quiet : quiet + 8'd1);
        since   = t - t_last;
        ibic    = (since > 16'd4095) ? 12'd4095 : since[11:0];
        dabs    = (ibic > ibi) ? (ibic - ibi) : (ibi - ibic);
        if (!beat_done && epi_n >= (N >> 1)) begin
            beat_now    = 1'b1;
            beat_done_n = 1'b1;
            nbeats_n    = (nbeats == 2'd3) ? 2'd3 : nbeats + 2'd1;
            dibi_n      = (nbeats_n == 2'd3) ? ((dabs > 12'd255) ? 8'd255 : dabs[7:0]) : 8'd0;
            irr_n       = {irr[6:0], (nbeats_n == 2'd3) && (dabs > 12'd100)};
            ibi_n       = (nbeats_n >= 2'd2) ? ibic : 12'd0;
            t_last_n    = t;
            block_n     = partial;
            partial_n   = 1'b0;
        end
        if (quiet_n >= 8'd64 && epi_n != 12'd0) begin
            if (!beat_done_n && epi_n >= (N >> 5)) partial_n = 1'b1;
            if (beat_done_n) lowpart_n = (epi_n < N - (N >> 3));
            epi_n = 12'd0; beat_done_n = 1'b0;
        end

        adur = t - t_b;
        if (arm == 2'd0 && bsp_t >= (N >> 3)) begin arm_n = 2'd1; t_b_n = t; end
        else if (arm == 2'd1 && asp_t >= (N >> 3)) begin apd_n = (adur > 16'd4095) ? 12'd4095 : adur[11:0]; arm_n = 2'd2; end
        else if (arm == 2'd2 && asp_t == 10'd0 && bsp_t == 10'd0) arm_n = 2'd0;

        ic = 4'd0;
        for (k = 0; k < 8; k = k + 1) ic = ic + {3'b000, irr_n[k]};
        flags_n[0] = (nbeats_n >= 2'd2) && (ibi_n < 12'd600);
        flags_n[1] = (nbeats_n >= 2'd2) && (ibi_n > 12'd1000);
        flags_n[2] = (ic >= 4'd3);
        flags_n[3] = block_n;
        flags_n[4] = (apd_n > 12'd450);
        flags_n[5] = (since > 16'd2000);
        flags_n[6] = lowpart_n;
        flags_n[7] = |flags_n[6:0];
    end

    // ---------------------------------------------------------------- report
    wire [16:0] wu_s = {1'b0, wu} + {7'd0, ups_t};
    wire [16:0] wb_s = {1'b0, wb} + {7'd0, bsp_t};
    wire [16:0] wa_s = {1'b0, wa} + {7'd0, asp_t};
    wire [15:0] wu_n = wu_s[16] ? 16'hFFFF : wu_s[15:0];
    wire [15:0] wb_n = wb_s[16] ? 16'hFFFF : wb_s[15:0];
    wire [15:0] wa_n = wa_s[16] ? 16'hFFFF : wa_s[15:0];
    wire signed [8:0]  mvs = vacc_t >>> 14;                                // mean v in mV (sum / 16 / 1024)
    wire signed [10:0] dnow = $signed({1'b0, sym_now}) - $signed({1'b0, par_now});
    wire [7:0]  brb = !link_en ? 8'd0 : (dnow > 11'sd127) ? 8'd127 : (dnow < -11'sd128) ? 8'h80 : dnow[7:0];
    wire        wend = tlast && (t[3:0] == 4'd15);
    wire [127:0] payload = {brb, dibi_n, 4'b0000, apd_n, 4'b0000, ibi_n, wa_n, wb_n, wu_n,
                            mvs[7:0], flags_n, 4'h1, link_en, cond, seq};
    wire        tbusy;
    nb64_telemetry tele (
        .clk(clk), .rst_n(rst_n), .send(wend), .adv(adv_en && (seq[2:0] == 3'd7)), .organ(4'd1),
        .payload(payload), .uart_tx(uart_tx), .bb_data(bb_data), .bb_en(bb_en), .pll_en(pll_en),
        .rf_ch(rf_ch), .busy(tbusy)
    );

    // ---------------------------------------------------------------- registers
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            b <= 3'd0; ci <= 10'd0; t <= 16'd0; x32 <= 32'h1234_5678;
            vm <= {N{52'd0, 12'hC40}};                                    // every cell at rest, v = Vr
            gacc <= 11'd0; g <= 5'd0; pm1 <= 6'd0; cn <= 192'd0; gup <= 6'd0; gsp <= 7'd0;
            valid <= 1'b0; sdo <= 1'b0; sck <= 1'b0; sync <= 1'b0; jit <= 4'd8;
            ups <= 10'd0; bsp <= 10'd0; asp <= 10'd0; vacc <= 23'sd0;
            epi <= 12'd0; quiet <= 8'd0; beat_done <= 1'b0; t_last <= 16'd0; ibi <= 12'd0; dibi <= 8'd0;
            irr <= 8'd0; partial <= 1'b0; block <= 1'b0; lowpart <= 1'b0; nbeats <= 2'd0;
            arm <= 2'd0; t_b <= 16'd0; apd <= 12'd0; seq <= 8'd0; wu <= 16'd0; wb <= 16'd0; wa <= 16'd0;
        end else begin
            b   <= b + 3'd1;
            sck <= valid && (b >= 3'd3) && (b <= 3'd6);
            if (last) begin
                sdo   <= up;
                sync  <= (ci == 10'd0);
                valid <= 1'b1;
                x32   <= x3;
                vm    <= {na_nx, nb_nx, ap_nx, s_nx, tr_nx, u_nx, v_nx, vm[N*SW-1:SW]};
                ci    <= (ci == NM1) ? 10'd0 : ci + 10'd1;
                if (gend) begin
                    gacc <= gsum - N;
                    g    <= g + 5'd1;
                    pm1  <= cn[5:0];
                    cn   <= {gupc, cn[191:6]};
                    gup  <= 6'd0; gsp <= 7'd0;
                end else begin
                    gacc <= gsum; gup <= gupc; gsp <= gspn;
                end
                if (ci == NM1) begin
                    pm1 <= 6'd0;
                    t   <= t + 16'd1;
                    ups <= 10'd0; bsp <= 10'd0; asp <= 10'd0; vacc <= 23'sd0;
                    epi <= epi_n; quiet <= quiet_n; beat_done <= beat_done_n; t_last <= t_last_n;
                    ibi <= ibi_n; dibi <= dibi_n; irr <= irr_n; partial <= partial_n; block <= block_n;
                    lowpart <= lowpart_n; nbeats <= nbeats_n; arm <= arm_n; t_b <= t_b_n; apd <= apd_n;
                    if (beat_now) jit <= x3[7:4];
                    if (t[3:0] == 4'd15) begin seq <= seq + 8'd1; wu <= 16'd0; wb <= 16'd0; wa <= 16'd0; end
                    else begin wu <= wu_n; wb <= wb_n; wa <= wa_n; end
                end else begin
                    ups <= ups_t; bsp <= bsp_t; asp <= asp_t; vacc <= vacc_t;
                end
            end
        end
    end

    wire _unused = &{tbusy, 1'b0};
endmodule
