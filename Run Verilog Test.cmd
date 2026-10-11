@echo off
rem Short check: simulates the Verilog of NeuroBit64-Cardio with a NeuroBit64-S chip connected for 160 ms
rem (takes about one minute) and compares everything it sends with the software model.
rem The last lines must start with PASS. Needs PowerShell 7, Icarus Verilog and Node.js
rem (on the author's PC the portable copies are found automatically).
title NeuroBit64-Cardio Verilog test
cd /d "%~dp0"
pwsh -NoProfile -File design\run_tests.ps1 -Organ cardio -Tests "0,160,1" -Tag _quick
pause
