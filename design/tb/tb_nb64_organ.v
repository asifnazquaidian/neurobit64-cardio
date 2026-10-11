// Test bench for a NeuroBit64 organ chip (-DDUT=nb64_cardio | nb64_pancreas | nb64_kidney).
// It records what leaves the chip, for comparison with the software model:
//   U ..   the 16 payload bytes of every UART frame (header and checksum are checked here)
//   A c .. the on-air bits of every Bluetooth LE advertising packet on channel index c
//   RESULT the number of raster bits and ones and a 64-bit signature of the raster stream, and
//          (with -DLINK=1) the word count and signature of the NeuroBit64-S chip wired to it.
// Options: -DN_CELLS= -DN_TICKS= -DCOND= -DLINK=0|1 -DADV=0|1 -DNBLIF= -DNBLEAK= -DNBTSEL= -DOUTFILE="..."
//          -DNB_LATE=n  release the reset of NeuroBit64-S n clocks later
//          -DHAS_RX -DGCMD=value [-DCMDBYTE=8'h50 -DCMDFLAG=px_v]  write an input value through uart_rx
`timescale 1ns / 1ps
`default_nettype none
`ifndef N_CELLS
 `define N_CELLS 1000
`endif
`ifndef N_TICKS
 `define N_TICKS 320
`endif
`ifndef COND
 `define COND 0
`endif
`ifndef LINK
 `define LINK 0
`endif
`ifndef ADV
 `define ADV 1
`endif
`ifndef NBLIF
 `define NBLIF 1
`endif
`ifndef NBLEAK
 `define NBLEAK 2
`endif
`ifndef NBTSEL
 `define NBTSEL 4
`endif
`ifndef NB_LATE
 `define NB_LATE 0
`endif
`ifndef CMDBYTE
 `define CMDBYTE 8'h47
`endif
`ifndef CMDFLAG
 `define CMDFLAG gx_v
`endif
`ifndef OUTFILE
 `define OUTFILE "design/results/tb.out"
`endif

module tb_nb64_organ;
    reg clk = 0, rst_n = 0, nb_rst_n = 0;
    always #62.5 clk = ~clk;                       // 8 MHz

    wire nb_sdi, sdo, sck, sync, uart_tx, bb_data, bb_en, pll_en;
    wire [1:0] rf_ch;
    wire nsdo, nsck, nsync, nvalid;
    wire linked = (`LINK != 0);
    reg  urx = 1'b1;

    `DUT #(.N(`N_CELLS)) dut (
        .clk(clk), .rst_n(rst_n), .cond(3'd`COND), .link_en(linked), .adv_en(`ADV != 0),
        .nb_sdo(linked & nsdo), .nb_sync(linked & nsync), .nb_sdi(nb_sdi),
`ifdef HAS_RX
        .uart_rx(urx),
`endif
        .sdo(sdo), .sck(sck), .sync(sync),
        .uart_tx(uart_tx), .bb_data(bb_data), .bb_en(bb_en), .pll_en(pll_en), .rf_ch(rf_ch)
    );

    neurobit64s brain (
        .clk(clk), .rst_n(nb_rst_n), .sdi(nb_sdi), .bist_en(1'b0), .lif_en(`NBLIF != 0),
        .leak(2'd`NBLEAK), .thresh_sel(3'd`NBTSEL), .sdo(nsdo), .sck(nsck), .sync(nsync), .valid(nvalid)
    );

    integer f;

    // ---- command port (pancreas chip): -DGCMD=mg/dL sends 47 lo hi after 40 ticks
    task send(input [7:0] d);
        integer j;
        begin
            urx = 0; repeat (69) @(posedge clk);
            for (j = 0; j < 8; j = j + 1) begin urx = d[j]; repeat (69) @(posedge clk); end
            urx = 1; repeat (69) @(posedge clk);
        end
    endtask
`ifdef GCMD
    initial begin
        repeat (40 * 8 * `N_CELLS + 1234) @(posedge clk);
        send(`CMDBYTE); send(`GCMD & 255); send(`GCMD >> 8);
    end
    always @(posedge dut.`CMDFLAG) $display("GCMD_TICK %0d", dut.t);
`endif

    // ---- UART receiver (69 clocks per bit) and frame check
    integer nb = 0, i, frames = 0, uart_errors = 0;
    reg [7:0] rxd, cks;
    always @(negedge uart_tx) begin
        repeat (34) @(posedge clk);
        for (i = 0; i < 8; i = i + 1) begin repeat (69) @(posedge clk); rxd[i] = uart_tx; end
        repeat (69) @(posedge clk);
        if (!uart_tx) uart_errors = uart_errors + 1;
        if (nb == 0) begin if (rxd !== 8'hA5) uart_errors = uart_errors + 1; cks = 8'd0; end
        else if (nb == 1) begin if (rxd !== 8'h5A) uart_errors = uart_errors + 1; $fwrite(f, "U"); end
        else if (nb < 18) begin $fwrite(f, " %02x", rxd); cks = cks ^ rxd; end
        else begin if (rxd !== cks) uart_errors = uart_errors + 1; $fwrite(f, "\n"); frames = frames + 1; end
        nb = (nb == 18) ? 0 : nb + 1;
    end

    // ---- on-air bit recorder: the middle of every 1 us bit while bb_en is high
    integer packets = 0;
    always @(posedge bb_en) begin
        $fwrite(f, "A %0d ", rf_ch);
        if (!pll_en) $display("pll_en low at the start of a packet");
        repeat (4) @(posedge clk);
        while (bb_en) begin $fwrite(f, "%0d", bb_data); repeat (8) @(posedge clk); end
        $fwrite(f, "\n");
        packets = packets + 1;
    end

    // ---- raster stream
    reg [63:0] rsig = 64'd0, rsig_at = 64'd0;
    reg [9:0]  idx = 10'd0;
    integer    rbits = 0, rones = 0, rones_at = 0, sync_errors = 0;
    always @(posedge sck) begin
        if (sync) begin if (idx != 10'd0 && rbits != 0) sync_errors = sync_errors + 1; idx = 10'd0; end
        rsig  = {rsig[62:0], rsig[63]} ^ {22'd0, idx, 31'd0, sdo};
        rbits = rbits + 1; rones = rones + sdo;
        idx   = (idx == `N_CELLS - 1) ? 10'd0 : idx + 10'd1;
        if (rbits == `N_TICKS * `N_CELLS) begin rsig_at = rsig; rones_at = rones; end
    end

    // ---- word stream of NeuroBit64-S
    localparam integer NBW = (`N_TICKS * `N_CELLS) / 64 - 2;
    reg [63:0] word = 64'd0, wsig = 64'd0, wsig_at = 64'd0;
    reg [6:0]  nbit = 7'd0;
    reg        started = 1'b0;
    integer    words = 0, wones = 0, wones_at = 0, kk;
    always @(posedge nsck) begin
        if (nsync) begin started = 1'b1; nbit = 7'd0; end
        if (started) begin
            word[nbit[5:0]] = nsdo;
            if (nbit == 7'd63) begin
                for (kk = 0; kk < 64; kk = kk + 1) wones = wones + word[kk];
                wsig  = {wsig[62:0], wsig[63]} ^ word ^ words;
                words = words + 1; nbit = 7'd0;
                if (words == NBW) begin wsig_at = wsig; wones_at = wones; end
            end else nbit = nbit + 7'd1;
        end
    end

    initial begin
        f = $fopen(`OUTFILE, "w");
        #100 rst_n = 1'b1;                         // released between clock edges
        if (`NB_LATE == 0) nb_rst_n = 1'b1;
        else begin repeat (`NB_LATE) @(negedge clk); nb_rst_n = 1'b1; end
    end
    initial begin
        wait (rbits == `N_TICKS * `N_CELLS);
        wait (frames == `N_TICKS / 16);
        repeat (20) @(posedge clk);
        wait (!dut.tele.busy);
        repeat (100) @(posedge clk);
        $fwrite(f, "RESULT ticks=%0d cells=%0d cond=%0d link=%0d frames=%0d packets=%0d raster_bits=%0d raster_ones=%0d raster_sig=%016x nb_words=%0d nb_ones=%0d nb_sig=%016x\n",
                `N_TICKS, `N_CELLS, `COND, `LINK, `N_TICKS / 16, (`ADV != 0) ? 3 * (`N_TICKS / 128) : 0, `N_TICKS * `N_CELLS, rones_at, rsig_at,
                linked ? NBW : 0, linked ? wones_at : 0, linked ? wsig_at : 64'd0);
        $fclose(f);
        $display("done: %0d frames, %0d packets, uart_errors=%0d sync_errors=%0d", frames, packets, uart_errors, sync_errors);
        $finish;
    end
endmodule
