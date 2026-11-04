#!/usr/bin/env bash
# RB-02F: regenerate the edge map and re-evaluate the fallback variant on SCRATCH copies (project PCB untouched).
# Usage: bash run_rb02f_checks.sh <outdir>
set -u
ROOT="$(git rev-parse --show-toplevel)"; T="$ROOT/hardware/emg/rev-b-xiao/tools"; E="$ROOT/hardware/emg/rev-b-xiao/evidence"; K="$ROOT/hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB"
O="${1:?outdir}"; mkdir -p "$O"
( cd "$K" && kicad-cli sch export netlist --format kicadxml -o "$O/revb.xml" ARTHUR_EMG_RevB.kicad_sch >/dev/null ) || exit 1
python3 "$T/rb02e_economic_audit.py" --pcb "$K/ARTHUR_EMG_RevB.kicad_pcb" --netlist "$O/revb.xml" --out "$O/current" >/dev/null || exit 1
python3 "$T/rb02f_annotate.py" --pcb "$K/ARTHUR_EMG_RevB.kicad_pcb" --edge-json "$O/current/edge_clearance.json" --out "$O/rb02f_edge_map" || exit 1
python3 "$T/rb02f_variant.py" --netlist "$O/revb.xml" --spec "$E/rb02f/fallback_F18_spec.json" --out "$O/F18" | tail -1
python3 "$T/rb02_check_placement.py" --pcb "$O/F18/variant.kicad_pcb" --netlist "$O/revb.xml" --json "$O/F18/chk.json" | tail -2
python3 "$T/rb02e_economic_audit.py" --pcb "$O/F18/variant.kicad_pcb" --netlist "$O/revb.xml" --out "$O/F18" | python3 -c "import sys,json; d=json.load(sys.stdin)['edge']; print('fallback edge status:', d['status_all_top_smt'], 'min envelope', d['min_envelope_to_edge'])"
