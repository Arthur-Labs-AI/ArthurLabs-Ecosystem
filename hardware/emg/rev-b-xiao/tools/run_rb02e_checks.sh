#!/usr/bin/env bash
# RB-02E: JLCPCB Economic PCBA design-compatibility audit of the placed board (read-only).  Usage: bash run_rb02e_checks.sh <outdir>
set -u
ROOT="$(git rev-parse --show-toplevel)"; T="$ROOT/hardware/emg/rev-b-xiao/tools"; K="$ROOT/hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB"
O="${1:?outdir}"; mkdir -p "$O"
( cd "$K" && kicad-cli sch export netlist --format kicadxml -o "$O/revb.xml" ARTHUR_EMG_RevB.kicad_sch >/dev/null ) || exit 1
python3 "$T/rb02e_economic_audit.py" --pcb "$K/ARTHUR_EMG_RevB.kicad_pcb" --netlist "$O/revb.xml" --out "$O" > "$O/summary.txt" || exit 1
python3 - "$O/economic_audit.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d["assembly"]; e=d["edge"]
print("layers",d["board"]["copper_layers"],"| size",d["board"]["width"],"x",d["board"]["height"],"| top SMT",a["jlc_assembled_top"],"bottom",a["jlc_assembled_bottom"],"THT",a["tht_by_jlc"])
print("DNP",a["dnp"],"| CPL has U1:",a["cpl_contains_U1"],"| B.Paste pads:",len(a["pads_with_B_Paste"]))
print("edge: RB-02 list",e["rb02_c26_count"],e["rb02_c26_status"],"| all top SMT",e["status_all_top_smt"],"| min envelope-to-edge",e["min_envelope_to_edge"])
bad = a["jlc_assembled_bottom"] or a["tht_by_jlc"] or a["cpl_contains_U1"] or a["pads_with_B_Paste"] or e["status_all_top_smt"]["FAIL"]
sys.exit(1 if bad else 0)
PY
