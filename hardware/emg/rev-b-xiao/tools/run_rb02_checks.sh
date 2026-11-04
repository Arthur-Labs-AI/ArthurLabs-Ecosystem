#!/usr/bin/env bash
# RB-02 one-shot: fresh netlist -> build placement-only PCB -> KiCad DRC (+schematic parity) -> placement / footprint / netclass
# checks -> seeded custom-rule proof -> RB-01R electrical re-verification.   Usage: bash run_rb02_checks.sh <outdir>
set -u
# SUPERSEDED (RB-03): this script REBUILDS the 97 x 32 RB-02 board in place and would overwrite the routed V1 board.
# Use run_rb03_route.sh (placement+routing+checks) or rb02g_check.py (RB-02 checks in the module frame) instead.
if [ "${RB02_ALLOW_REBUILD:-0}" != "1" ]; then
    echo "run_rb02_checks.sh is superseded by run_rb03_route.sh (it would overwrite the main PCB). Set RB02_ALLOW_REBUILD=1 to force." >&2
    exit 3
fi
ROOT="$(git rev-parse --show-toplevel)"; T="$ROOT/hardware/emg/rev-b-xiao/tools"; K="$ROOT/hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB"
O="${1:?outdir}"; mkdir -p "$O"; rc=0
cd "$K" || exit 2
kicad-cli sch export netlist --format kicadxml -o "$O/revb.xml" ARTHUR_EMG_RevB.kicad_sch >/dev/null || rc=1
python3 "$T/rb02_make_footprints.py" >/dev/null || rc=1
python3 "$T/rb02_write_project.py" >/dev/null || rc=1
python3 "$T/rb02_build_pcb.py" --netlist "$O/revb.xml" --out "$K/ARTHUR_EMG_RevB.kicad_pcb" || rc=1
kicad-cli pcb drc --schematic-parity --severity-all --format json -o "$O/drc.json" ARTHUR_EMG_RevB.kicad_pcb >/dev/null 2>&1
kicad-cli pcb drc --schematic-parity --severity-all --format report -o "$O/drc.rpt" ARTHUR_EMG_RevB.kicad_pcb >/dev/null 2>&1
python3 - "$O/drc.json" <<'PY' || rc=1
import json,sys,collections
d=json.load(open(sys.argv[1]))
c=collections.Counter((v['severity'],v['type']) for v in d['violations'])
u=len(d.get('unconnected_items',[])); p=len(d.get('schematic_parity',[]))
print('DRC violations:',dict(c) or 'none','| unconnected items (expected before routing):',u,'| schematic parity issues:',p)
bad=[k for k in c if k[0]=='error']
sys.exit(1 if bad or p else 0)
PY
python3 "$T/rb02_check_placement.py" --pcb "$K/ARTHUR_EMG_RevB.kicad_pcb" --netlist "$O/revb.xml" --json "$O/placement_checks.json" | tail -3 || rc=1
python3 "$T/rb02_audit_footprints.py" --netlist "$O/revb.xml" --json "$O/footprint_audit.json" | tail -1 || rc=1
python3 "$T/rb02_check_netclasses.py" --netlist "$O/revb.xml" | tail -1 || rc=1
python3 "$T/rb02_seed_drc_rules.py" | tail -1 || rc=1
python3 "$T/rb02_post_tolerance_stack.py" --n 100000 > "$O/post_tolerance_stack.txt"
bash "$T/run_rb01r_checks.sh" "$O/rb01r" 2>&1 | grep -E "ERC|checks passed|MUTATION|Rev A" || rc=1
exit $rc
