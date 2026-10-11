# Verilog (Icarus) against the software model for one organ chip.
#   pwsh design\run_tests.ps1 -Organ cardio -Tests "0,2400,0;3,1600,1"     (cond,ticks,link[,value] ; ...)
#   value = an input written through uart_rx after 40 ticks (pancreas: glucose mg/dL, kidney: pressure mmHg)
# Needs iverilog/vvp and node on PATH (or the portable copies used on the author's PC).
param([string]$Organ = "cardio", [string]$Tests = "0,320,0", [int]$Cells = 1000, [string]$Tag = "")
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$node = if (Test-Path "F:\Projects\Applications\GlucoSense\tools\node\node.exe") { "F:\Projects\Applications\GlucoSense\tools\node\node.exe" } else { "node" }
$eda = Join-Path (Split-Path $root -Parent) "tools\eda\mingw64\bin"
if (Test-Path $eda) { $env:Path = "$eda;" + $env:Path }
$rx = @(); if ($Organ -eq "pancreas") { $rx = @("-DHAS_RX") } elseif ($Organ -eq "kidney") { $rx = @("-DHAS_RX", "-DCMDBYTE=8'h50", "-DCMDFLAG=px_v") }
$log = "design\results\verilog_vs_model$Tag.txt"
"NeuroBit64-$Organ : Verilog (Icarus Verilog) against the software model, $Cells cells" | Set-Content $log
foreach ($t in $Tests.Split(';')) {
    $c, $ticks, $link, $val = $t.Split(',')
    $name = "c${c}_t${ticks}_l${link}_n${Cells}"
    $defs = @("-DDUT=nb64_$Organ", "-DN_CELLS=$Cells", "-DN_TICKS=$ticks", "-DCOND=$c", "-DLINK=$link", "-DOUTFILE=`"design/results/v_$name.out`"") + $rx
    if ($val) { $defs += "-DGCMD=$val" }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    iverilog -g2005 -o "design\results\tb_$name.vvp" @defs design\rtl\nb64_link.v design\rtl\nb64_telemetry.v "design\rtl\nb64_$Organ.v" design\tb\neurobit64s.v design\tb\tb_nb64_organ.v 2>$null
    $o = vvp "design\results\tb_$name.vvp"
    $v = $o | Select-String "done:"
    $margs = @("--organ", $Organ, "--ticks", $ticks, "--cells", $Cells, "--cond", $c, "--link", $link, "--out", "design\results\m_$name.out")
    $note = ""
    if ($val) { $gt = ($o | Select-String 'GCMD_TICK (\d+)').Matches[0].Groups[1].Value; $margs += @("--gcmd", $val, "--gtick", $gt); $note = ", input $val written through uart_rx in tick $gt" }
    & $node design\model\run_model.js @margs | Out-Null
    $r = & $node design\model\compare.js "design\results\v_$name.out" "design\results\m_$name.out"
    "" | Add-Content $log
    "condition $c, $ticks ticks, NeuroBit64-S connected: $link$note   (simulation $([int]$sw.Elapsed.TotalSeconds) s; test bench $v)" | Add-Content $log
    $r | Add-Content $log
    Remove-Item "design\results\tb_$name.vvp" -Confirm:$false
}
Get-Content $log
