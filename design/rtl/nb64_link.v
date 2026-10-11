/*
 * nb64_link : the connection between a NeuroBit64 organ chip and a NeuroBit64-S brain chip.
 * Copyright (c) 2026 Asif Mehmood.  SPDX-License-Identifier: Apache-2.0
 *
 * Both chips run from the same clock and use slots of 8 clocks. Three wires:
 *   nb_sdi   organ -> brain   8-bit activity samples for the 64 neurons of NeuroBit64-S, MSB first,
 *                             exactly as its sdi pin expects them. Channel 32+g gets the activity
 *                             byte of cell group g, channel g gets 255 minus that byte.
 *   nb_sdo   brain -> organ   the decision bits of NeuroBit64-S (its sdo pin)
 *   nb_sync  brain -> organ   its sync pin; used to find out which neuron a bit belongs to
 * Ones of neurons 0..31 are counted as sympathetic drive, ones of neurons 32..63 as
 * parasympathetic drive. The counts of one organ tick are handed over at tick_end.
 */

`default_nettype none

module nb64_link (
    input  wire       clk,
    input  wire       rst_n,
    input  wire       nb_sdo,
    input  wire       nb_sync,
    output reg        nb_sdi,
    input  wire       aff_we,       // write one group activity byte
    input  wire [4:0] aff_wa,
    input  wire [7:0] aff_wd,
    input  wire [4:0] aff_ra,       // read port for the organ core
    output wire [7:0] aff_rd,
    input  wire       tick_end,     // last clock of an organ tick
    output wire [9:0] sym_now,      // counts of the tick that is ending
    output wire [9:0] par_now,
    output reg  [9:0] sym,          // counts of the previous tick
    output reg  [9:0] par
);
    reg [2:0] mb;                   // copy of the clock counter of NeuroBit64-S
    reg [5:0] mch;                  // copy of its neuron counter
    reg       sync_d;
    reg [6:0] sh;
    reg [9:0] s_cnt, p_cnt;
    reg [7:0] aff [0:31];

    wire [5:0] chn  = mch + 6'd1;                 // neuron of the coming slot
    wire [7:0] araw = aff[chn[4:0]];
    wire [7:0] aval = chn[5] ? araw : ~araw;
    wire [5:0] chb  = mch - 6'd1;                 // neuron whose bit is on nb_sdo now
    assign aff_rd  = aff[aff_ra];
    assign sym_now = s_cnt;
    assign par_now = p_cnt;

    integer i;
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            mb <= 3'd0; mch <= 6'd0; sync_d <= 1'b0; sh <= 7'd0; nb_sdi <= 1'b0;
            s_cnt <= 10'd0; p_cnt <= 10'd0; sym <= 10'd0; par <= 10'd0;
            for (i = 0; i < 32; i = i + 1) aff[i] <= 8'd0;
        end else begin
            sync_d <= nb_sync;
            if (nb_sync && !sync_d) begin         // first clock of the slot of neuron 1
                mb <= 3'd1; mch <= 6'd1;
            end else begin
                mb <= mb + 3'd1;
                if (mb == 3'd7) mch <= mch + 6'd1;
            end

            if (mb == 3'd7) begin nb_sdi <= aval[7]; sh <= aval[6:0]; end
            else            begin nb_sdi <= sh[6];   sh <= {sh[5:0], 1'b0}; end

            if (mb == 3'd4 && nb_sdo) begin
                if (chb[5]) p_cnt <= p_cnt + 10'd1; else s_cnt <= s_cnt + 10'd1;
            end
            if (tick_end) begin sym <= s_cnt; par <= p_cnt; s_cnt <= 10'd0; p_cnt <= 10'd0; end
            if (aff_we) aff[aff_wa] <= aff_wd;
        end
    end
endmodule
