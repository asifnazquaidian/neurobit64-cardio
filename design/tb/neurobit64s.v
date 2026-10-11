/*
 * NeuroBit64-S : 64 neurons on one time-shared neuron circuit, serial in, serial out.
 * Copyright (c) 2026 Asif Mehmood
 * SPDX-License-Identifier: Apache-2.0
 *
 * One neuron "tick" has 64 slots, one per neuron; a slot is 8 clocks.
 *   - during a slot the 8-bit input sample of that neuron is shifted in on sdi (MSB first)
 *   - on the last clock the neuron is updated and decides 1 (fire) or 0
 *   - the decision is put on sdo for the whole next slot, with one sck pulse in its middle
 *   - sync is high while the bit of neuron 0 is on sdo (start of a 64-bit word)
 * So the chip pushes one 64-bit word per tick into a serial memory using 3 pins (sdo, sck, sync).
 * With a 50 MHz clock: 6.25 Mbit/s, 97,656 ticks per second.
 *
 * Neuron:  lif_en = 0  threshold neuron: fires when sample >= 256 - 2^thresh_sel
 *          lif_en = 1  leaky integrate-and-fire: v = v - (v >> leak) + sample,
 *                      fires when v >= (248 - 16*thresh_sel) << leak, then v = 0
 * bist_en = 1 takes the samples from an on-chip xorshift32 generator instead of sdi.
 */

`default_nettype none

module neurobit64s (
    input  wire       clk,
    input  wire       rst_n,
    input  wire       sdi,
    input  wire       bist_en,
    input  wire       lif_en,
    input  wire [1:0] leak,
    input  wire [2:0] thresh_sel,
    output reg        sdo,
    output reg        sck,
    output reg        sync,
    output reg        valid
);
    localparam N = 64, VW = 11;            // 11 bits hold the largest membrane value (2047)

    reg  [2:0]      b;                     // clock within the slot
    reg  [5:0]      ch;                    // neuron being served
    reg  [6:0]      s;                     // input shift register
    reg  [31:0]     x;                     // xorshift32 test source
    reg  [N*VW-1:0] vm;                    // membrane values; neuron 'ch' is at the bottom

    wire            last   = (b == 3'd7);
    wire [7:0]      sample = bist_en ? x[31:24] : {s, sdi};
    wire [7:0]      tbase  = 8'd0 - (8'd1 << thresh_sel);            // 255, 254, 252 ... 128
    wire [7:0]      tlif   = 8'd248 - {1'b0, thresh_sel, 4'b0000};   // 248, 232, 216 ... 136
    wire [VW-1:0]   thresh = lif_en ? ({3'b000, tlif} << leak) : {3'b000, tbase};
    wire [VW-1:0]   v      = vm[VW-1:0];
    wire [VW-1:0]   keep   = lif_en ? (v - (v >> leak)) : {VW{1'b0}};
    wire [VW-1:0]   sum    = keep + {3'b000, sample};
    wire            fire   = (sum >= thresh);

    wire [31:0]     x1 = x  ^ (x  << 13);
    wire [31:0]     x2 = x1 ^ (x1 >> 17);
    wire [31:0]     x3 = x2 ^ (x2 << 5);

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            b <= 3'd0; ch <= 6'd0; s <= 7'd0; x <= 32'h1234_5678; vm <= {N*VW{1'b0}};
            sdo <= 1'b0; sck <= 1'b0; sync <= 1'b0; valid <= 1'b0;
        end else begin
            b   <= b + 3'd1;
            s   <= {s[5:0], sdi};
            sck <= valid && (b >= 3'd3) && (b <= 3'd6);
            if (last) begin
                sdo   <= fire;
                sync  <= (ch == 6'd0);
                valid <= 1'b1;
                ch    <= ch + 6'd1;
                x     <= x3;
                vm    <= {fire ? {VW{1'b0}} : sum, vm[N*VW-1:VW]};
            end
        end
    end
endmodule

// Tiny Tapeout wrapper
module tt_um_asifmehmood_neurobit64 (
    input  wire [7:0] ui_in,    // [0] sdi  [1] bist_en  [2] lif_en  [4:3] leak  [7:5] thresh_sel
    output wire [7:0] uo_out,   // [0] sdo  [1] sck  [2] sync  [3] valid
    input  wire [7:0] uio_in,
    output wire [7:0] uio_out,
    output wire [7:0] uio_oe,
    input  wire       ena,
    input  wire       clk,
    input  wire       rst_n
);
    wire sdo, sck, sync, valid;
    neurobit64s core (
        .clk(clk), .rst_n(rst_n), .sdi(ui_in[0]), .bist_en(ui_in[1]), .lif_en(ui_in[2]),
        .leak(ui_in[4:3]), .thresh_sel(ui_in[7:5]),
        .sdo(sdo), .sck(sck), .sync(sync), .valid(valid)
    );
    assign uo_out  = {4'b0000, valid, sync, sck, sdo};
    assign uio_out = 8'b0;
    assign uio_oe  = 8'b0;
    wire _unused = &{ena, uio_in, 1'b0};
endmodule
