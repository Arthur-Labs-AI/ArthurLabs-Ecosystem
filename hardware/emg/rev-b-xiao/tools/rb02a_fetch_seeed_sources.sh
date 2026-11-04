#!/usr/bin/env bash
# RB-02A: download the Seeed source files into a work directory and verify their SHA-256.
# Usage: bash rb02a_fetch_seeed_sources.sh <workdir>      (no purchase, no login; plain HTTPS GET)
set -eu
W="${1:?workdir}"; mkdir -p "$W"; cd "$W"
B=https://files.seeedstudio.com/wiki/SeeedStudio-XIAO-ESP32S3
dl() { curl -sfL -A 'Mozilla/5.0' -o "$1" "$2"; }
dl v14_plain_SCH_PCB.zip   "$B/new-res/202003751_XIAO%20ESP32S3_v1.4_SCH%26PCB_260226.zip"
dl v15_sense_SCH_PCB.zip   "$B/new-res/202003753_XIAO%20ESP32S3%20Sense_v1.5_SCH%26PCB_260226.zip"
dl v14_plain_SCH.pdf       "$B/new-res/202003751_XIAO%20ESP32S3_v1.4_SCH_260226.pdf.pdf"
dl v15_sense_SCH.pdf       "$B/new-res/202003753_XIAO%20ESP32S3%20Sense_v1.5_SCH_260226.pdf.pdf"
dl XIAO_ESP32S3_v1.1_Dimensioning.dxf "$B/res/XIAO_ESP32S3_v1.1_Dimensioning.dxf"
dl plain_3d_model.zip      "$B/res/seeed-studio-xiao-esp32s3-3d_model.zip"
dl sense_3d_model.zip      "$B/res/seeed-studio-xiao-esp32s3-sense-3d_model.zip"
sha256sum -c - <<'H'
a82247725c8a8bcd8cac81a7acbd126396217e5b680f6dfe28958851e02d5cdb  v14_plain_SCH_PCB.zip
a82247725c8a8bcd8cac81a7acbd126396217e5b680f6dfe28958851e02d5cdb  v15_sense_SCH_PCB.zip
15993097cd695d177af352f4664ca91290a99c833f51d122d1165ef222f9923c  v14_plain_SCH.pdf
15993097cd695d177af352f4664ca91290a99c833f51d122d1165ef222f9923c  v15_sense_SCH.pdf
5fd32e3ba7a4bd85b8cc0f5d9413e26dd947e84e27b2d0f03350a7d367903f23  XIAO_ESP32S3_v1.1_Dimensioning.dxf
0d552ed2cc7359ea132601f4f7fe2c9d816e2dfe4f58f6463e83f84a901d3650  plain_3d_model.zip
773c16cb7518a3a18df926979f24c7e224f19309aad69962ec8a54454e288c59  sense_3d_model.zip
H
unzip -oq v14_plain_SCH_PCB.zip -d v14_plain_zip
echo "identical v1.4-plain and v1.5-sense archives: $(cmp -s v14_plain_SCH_PCB.zip v15_sense_SCH_PCB.zip && echo YES || echo no)"
echo "PCB: $(ls v14_plain_zip/*/*.kicad_pcb)"
sha256sum v14_plain_zip/*/*.kicad_pcb
