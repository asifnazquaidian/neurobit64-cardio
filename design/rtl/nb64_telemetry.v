/*
 * nb64_telemetry : sends one 16-byte report of a NeuroBit64 organ chip
 *   a) on a UART (clk / 69 = 115.9 kbaud at 8 MHz, 8N1):  A5 5A, 16 bytes, XOR of the 16.
 *      A ready-made Bluetooth serial module, or a USB serial cable, carries it to a phone or PC.
 *   b) if adv is set, also as a Bluetooth LE advertising packet (ADV_NONCONN_IND, manufacturer
 *      data, company 0xFFFF) on channels 37, 38, 39: the whitened 1 Mbit/s bit stream with CRC-24
 *      for a 2.4 GHz GFSK transmitter. The radio itself is analog and is not part of this design.
 * The UART and packet generator follow the GlucoSense GS-1 core.
 * Copyright (c) 2026 Asif Mehmood.  SPDX-License-Identifier: Apache-2.0
 */

`default_nettype none

module nb64_telemetry (
    input  wire         clk,
    input  wire         rst_n,
    input  wire         send,       // one-clock strobe: take the payload and send it
    input  wire         adv,        // sampled with send: follow the UART frame with advertising packets
    input  wire [3:0]   organ,      // 1 heart, 2 pancreas, 3 kidney (last byte of the device address)
    input  wire [127:0] payload,    // byte 0 in bits 7:0
    output wire         uart_tx,
    output reg          bb_data,    // BLE bit stream, 1 Mbit/s
    output reg          bb_en,      // high while a packet is on air
    output reg          pll_en,     // high from 128 us before a packet until its end
    output reg  [1:0]   rf_ch,      // 0, 1, 2 = advertising channel 37, 38, 39
    output wire         busy
);
    reg [127:0] pl;
    reg         adv_r;

    function [7:0] pbyte(input [3:0] i);
        pbyte = pl[{i, 3'b000} +: 8];
    endfunction

    function [7:0] abyte(input [5:0] k);
        case (k)
            6'd0:  abyte = 8'hAA;                       // preamble
            6'd1:  abyte = 8'hD6;                       // access address 0x8E89BED6
            6'd2:  abyte = 8'hBE;
            6'd3:  abyte = 8'h89;
            6'd4:  abyte = 8'h8E;
            6'd5:  abyte = 8'h42;                       // ADV_NONCONN_IND, random address
            6'd6:  abyte = 8'd29;                       // payload length
            6'd7:  abyte = {4'h0, organ};               // address C7:4E:42:36:34:0x  ("NB64")
            6'd8:  abyte = 8'h34;
            6'd9:  abyte = 8'h36;
            6'd10: abyte = 8'h42;
            6'd11: abyte = 8'h4E;
            6'd12: abyte = 8'hC7;
            6'd13: abyte = 8'h02;                       // flags: LE general discoverable, no BR/EDR
            6'd14: abyte = 8'h01;
            6'd15: abyte = 8'h06;
            6'd16: abyte = 8'h13;                       // manufacturer data, 19 bytes follow
            6'd17: abyte = 8'hFF;
            6'd18: abyte = 8'hFF;                       // company 0xFFFF (test)
            6'd19: abyte = 8'hFF;
            default: abyte = pbyte(k[3:0] - 4'd4);      // k = 20..35 -> payload byte 0..15
        endcase
    endfunction

    // ---- UART transmitter
    reg  [6:0] txdiv;
    reg  [3:0] txbit;
    reg  [9:0] txsh;
    reg        txbusy, txgo;
    reg  [7:0] txbyte;
    assign uart_tx = txsh[0];

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            txdiv <= 7'd0; txbit <= 4'd0; txsh <= 10'h3FF; txbusy <= 1'b0;
        end else if (!txbusy) begin
            if (txgo) begin txsh <= {1'b1, txbyte, 1'b0}; txbusy <= 1'b1; txdiv <= 7'd68; txbit <= 4'd0; end
        end else if (txdiv != 7'd0) begin
            txdiv <= txdiv - 7'd1;
        end else begin
            txdiv <= 7'd68;
            txsh  <= {1'b1, txsh[9:1]};
            txbit <= txbit + 4'd1;
            if (txbit == 4'd9) txbusy <= 1'b0;
        end
    end

    // ---- sequencer
    localparam S_IDLE = 3'd0, S_UART = 3'd1, S_UWAIT = 3'd2, S_PLL = 3'd3, S_TX = 3'd4, S_CRC = 3'd5;
    reg  [2:0]  st;
    reg  [4:0]  ui;
    reg  [7:0]  cks;
    reg  [10:0] n;
    reg  [5:0]  k;
    reg  [2:0]  bi, bdiv;
    reg  [23:0] crc;
    reg  [6:0]  wh;
    assign busy = (st != S_IDLE);

    wire [7:0] ub     = pbyte(ui[3:0] - 4'd2);
    wire [7:0] ab     = abyte(k);
    wire       rawbit = ab[bi];
    wire       crcin  = (st == S_CRC) ? 1'b0 : (crc[23] ^ rawbit);
    wire       txbitv = (st == S_CRC) ? crc[23] : rawbit;
    wire       white  = (st == S_CRC) || (k >= 6'd5);

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            st <= S_IDLE; ui <= 5'd0; cks <= 8'd0; n <= 11'd0; k <= 6'd0; bi <= 3'd0; bdiv <= 3'd0;
            crc <= 24'h555555; wh <= 7'd0; pl <= 128'd0; adv_r <= 1'b0;
            bb_data <= 1'b0; bb_en <= 1'b0; pll_en <= 1'b0; rf_ch <= 2'd0; txgo <= 1'b0; txbyte <= 8'd0;
        end else begin
            txgo <= 1'b0;
            case (st)
                S_IDLE: if (send) begin pl <= payload; adv_r <= adv; ui <= 5'd0; cks <= 8'd0; st <= S_UART; end

                S_UART: if (!txbusy && !txgo) begin
                    if (ui == 5'd19) begin
                        if (adv_r) begin rf_ch <= 2'd0; pll_en <= 1'b1; n <= 11'd0; st <= S_PLL; end
                        else st <= S_IDLE;
                    end else begin
                        txbyte <= (ui == 5'd0) ? 8'hA5 : (ui == 5'd1) ? 8'h5A : (ui == 5'd18) ? cks : ub;
                        if (ui >= 5'd2 && ui != 5'd18) cks <= cks ^ ub;
                        txgo <= 1'b1;
                        ui   <= ui + 5'd1;
                        st   <= S_UWAIT;
                    end
                end

                S_UWAIT: if (txbusy) st <= S_UART;

                S_PLL: begin                           // synthesiser settling time, 1024 clocks = 128 us
                    n <= n + 11'd1;
                    if (n == 11'd1023) begin
                        k <= 6'd0; bi <= 3'd0; bdiv <= 3'd0; crc <= 24'h555555;
                        wh <= {1'b1, 4'b1001, (rf_ch != 2'd0), (rf_ch != 2'd1)};   // 0x40 | 37, 38, 39
                        st <= S_TX;
                    end
                end

                S_TX, S_CRC: begin                     // one bit every 8 clocks
                    bdiv <= bdiv + 3'd1;
                    if (bdiv == 3'd0) begin
                        bb_en   <= 1'b1;
                        bb_data <= txbitv ^ (white & wh[0]);
                        if (white) wh <= {wh[0], wh[6:4], wh[3] ^ wh[0], wh[2:1]};
                        if (st == S_CRC || k >= 6'd5)
                            crc <= {crc[22:0], 1'b0} ^ (crcin ? 24'h00065B : 24'h000000);
                    end
                    if (bdiv == 3'd7) begin
                        bi <= bi + 3'd1;
                        if (st == S_TX) begin
                            if (bi == 3'd7) begin
                                k <= k + 6'd1;
                                if (k == 6'd35) begin n <= 11'd0; st <= S_CRC; end
                            end
                        end else begin
                            n <= n + 11'd1;
                            if (n == 11'd23) begin
                                bb_en <= 1'b0; bb_data <= 1'b0; n <= 11'd0;
                                if (rf_ch == 2'd2) begin pll_en <= 1'b0; rf_ch <= 2'd0; st <= S_IDLE; end
                                else begin rf_ch <= rf_ch + 2'd1; st <= S_PLL; end
                            end
                        end
                    end
                end

                default: st <= S_IDLE;
            endcase
        end
    end
endmodule
