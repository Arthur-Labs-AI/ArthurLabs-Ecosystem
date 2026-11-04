#!/usr/bin/env bash
# RB-03: promote the V1 placement, route (rb03_router.py), fill zones, then DRC/ERC/audit.  Overwrites the main Rev B PCB.
#   bash run_rb03_route.sh <scratch dir> [evidence dir]
set -eu
ROOT="$(git rev-parse --show-toplevel)"; T="$ROOT/hardware/emg/rev-b-xiao/tools"; K="$ROOT/hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB"
O="${1:?scratch dir}"; E="${2:-$ROOT/hardware/emg/rev-b-xiao/evidence/rb03}"; mkdir -p "$O" "$E"
bash "$T/rb03_promote_v1.sh" "$O" > "$O/promote.log"
# every pcbnew operation runs in a scratch copy of the project (pcbnew rewrites .kicad_pro and loses the netclasses)
P="$O/prj"; rm -rf "$P"; cp -r "$K" "$P"; rm -rf "$P/.history" "$P"/~*.lck
cp "$O/v1/variant.kicad_pcb" "$P/ARTHUR_EMG_RevB.kicad_pcb"
python3 "$T/rb03_router.py" --pcb "$P/ARTHUR_EMG_RevB.kicad_pcb" --out "$P/routed.kicad_pcb" --log "$E/router_log.json" --via-gap "${RB03_VIA_GAP:-0.25}" ${RB03_ROUTER_FLAGS:-} 2>&1 | grep -v assert | tee "$O/router.log" | tail -4
cp "$K/ARTHUR_EMG_RevB.kicad_pro" "$P/ARTHUR_EMG_RevB.kicad_pro"; cp "$K/ARTHUR_EMG_RevB.kicad_dru" "$P/ARTHUR_EMG_RevB.kicad_dru"
python3 "$T/rb03_fill.py" "$P/routed.kicad_pcb" "$P/final.kicad_pcb" 2>&1 | grep -v assert
cp "$K/ARTHUR_EMG_RevB.kicad_pro" "$P/ARTHUR_EMG_RevB.kicad_pro"
[ "${RB03_INSTALL:-1}" = "1" ] && cp "$P/final.kicad_pcb" "$K/ARTHUR_EMG_RevB.kicad_pcb"
cp "$P/final.kicad_pcb" "$P/ARTHUR_EMG_RevB.kicad_pcb"
cd "$P"
kicad-cli pcb drc --schematic-parity --severity-all --format json -o "$E/drc.json" ARTHUR_EMG_RevB.kicad_pcb >/dev/null 2>&1
kicad-cli pcb drc --schematic-parity --severity-all --format report -o "$E/drc.rpt" ARTHUR_EMG_RevB.kicad_pcb >/dev/null 2>&1
kicad-cli sch erc --severity-all --format json -o "$E/erc.json" ARTHUR_EMG_RevB.kicad_sch >/dev/null 2>&1 || true
kicad-cli sch export netlist --format kicadxml -o "$O/revb.xml" ARTHUR_EMG_RevB.kicad_sch >/dev/null
python3 "$T/rb03_audit.py" --pcb "$P/ARTHUR_EMG_RevB.kicad_pcb" --out "$E/audit.json" 2>&1 | grep -v assert | tail -3
python3 "$T/rb02g_check.py" --pcb ARTHUR_EMG_RevB.kicad_pcb --netlist "$O/revb.xml" --json "$E/rb02_checks_module_frame.json" > "$E/rb02_checks_module_frame.txt" || true
python3 "$T/rb02e_economic_audit.py" --pcb ARTHUR_EMG_RevB.kicad_pcb --netlist "$O/revb.xml" --out "$E/economic" > /dev/null
python3 - "$E/drc.json" <<'PY'
import json,sys,collections
d=json.load(open(sys.argv[1]))
c=collections.Counter((v['severity'],v['type']) for v in d['violations'])
print('DRC:',dict(c),'| unconnected',len(d['unconnected_items']),'| parity',len(d['schematic_parity']))
PY
