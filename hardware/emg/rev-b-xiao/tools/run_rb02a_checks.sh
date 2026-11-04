#!/usr/bin/env bash
# RB-02A reproduction: fetch Seeed sources, extract geometry, compare with RB-00.6, sensitivity, 1:1 drawing.
# Usage: bash run_rb02a_checks.sh <workdir> [outdir]       exit 0 only if no DISCREPANCY remains (expected: 1, see report)
set -u
T="$(cd "$(dirname "$0")" && pwd)"; W="${1:?workdir}"; O="${2:-$W/out}"; mkdir -p "$O"
bash "$T/rb02a_fetch_seeed_sources.sh" "$W" || exit 2
PCB=$(ls "$W"/v14_plain_zip/*/*.kicad_pcb)
python3 "$T/rb02a_xiao_cad_extract.py" "$PCB" -o "$O/seeed_pcb_extract.json"
python3 "$T/rb02a_compare_rb006.py" --primary "$PCB" --out-dir "$O" ${SECONDARY:+--secondary "$SECONDARY"}
python3 "$T/rb02a_post_sensitivity.py" --pcb "$PCB" --json "$O/post_sensitivity.json" > "$O/post_sensitivity.txt"
python3 "$T/rb02a_make_1to1.py" --pcb "$PCB" --sha "$(sha256sum "$PCB" | cut -d' ' -f1)" --out "$O/XIAO_RB02A_CAD_1TO1.pdf"
