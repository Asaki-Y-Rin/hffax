@echo off
rem ===================================================================
rem  HF WEATHER FAX encoder - Windows quick start
rem
rem  Double-click this file, or run it from a terminal. It does three
rem  things, all optional except the first:
rem    1. opens the single-file web app in your default browser
rem    2. shows where the sample audio and test image live
rem    3. prints the command lines for the Python CLI encoder
rem ===================================================================
setlocal
set ROOT=%~dp0
set APP=%ROOT%dist\index.html

echo.
echo  HF WEATHER FAX encoder  (IOC 576 / 120 lpm / 1500-2300 Hz)
echo  ==========================================================
echo.

if not exist "%APP%" (
  echo  dist\index.html is missing - build it first:
  echo      python tools\build.py
  echo.
  pause
  exit /b 1
)

echo  [1] Opening the web app in your default browser...
start "" "%APP%"
echo      %APP%
echo.
echo      In the app: drop in a picture, press "编码为 WAV", then "保存 WAV".
echo.

echo  [2] Sample files:
if exist "%ROOT%samples\test-chart.png"        echo      %ROOT%samples\test-chart.png         ^<- test chart
if exist "%ROOT%samples\test-chart-demo.wav"   echo      %ROOT%samples\test-chart-demo.wav    ^<- 7 s audio, quick listen
if exist "%ROOT%samples\test-chart-ioc576.wav" echo      %ROOT%samples\test-chart-ioc576.wav  ^<- full 576 lines, 296 s
echo.

echo  [3] Command line encoder (needs Python 3 + Pillow):
echo      python tools\faxencode.py --test-chart
echo      python tools\faxencode.py your-chart.png out.wav
echo.

echo  Transmitting: feed the WAV into your transceiver's data/mic input in USB
echo  or AM. Standard weather-fax channels are around 14.230 MHz (USB dial
echo  ~14.2281 MHz). Turn off speech processing and keep ALC out of the red.
echo.
pause
