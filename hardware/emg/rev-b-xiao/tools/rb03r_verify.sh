#!/usr/bin/env bash
# RB-03R: verify a candidate PCB in a SCRATCH project copy (canonical project files are copied in, never written back).
#   bash rb03r_verify.sh <candidate.kicad_pcb> <evidence dir> [--fill]
set -eu
ROOT="$(git rev-parse --show-toplevel)"; T="$ROOT/hardware/emg/rev-b-xiao/tools"; K="$ROOT/hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB"
C="$(readlink -f "$1")"; E="$(mkdir -p "$2" && readlink -f "$2")"; FILL="${3:-}"
SHA0="$(sha256sum "$K/ARTHUR_EMG_RevB.kicad_pro" "$K/ARTHUR_EMG_RevB.kicad_dru" | cut -d" " -f1 | tr -d "\n")"
SRC="${RB03R_PROJECT:-$K}"     # RB03R_PROJECT is only used by the negative-control tests
P="$E/prj"; rm -rf "$P"; cp -r "$SRC" "$P"; chmod -R u+w "$P"; rm -rf "$P/.history" "$P"/~*.lck
if [ "$FILL" = "--fill" ]; then python3 "$T/rb03_fill.py" "$C" "$P/ARTHUR_EMG_RevB.kicad_pcb" 2>&1 | grep -v assert || true
else cp "$C" "$P/ARTHUR_EMG_RevB.kicad_pcb"; fi
cp "$SRC/ARTHUR_EMG_RevB.kicad_pro" "$P/"; cp "$SRC/ARTHUR_EMG_RevB.kicad_dru" "$P/"
cd "$P"
kicad-cli pcb drc --schematic-parity --severity-all --format json -o "$E/drc.json" ARTHUR_EMG_RevB.kicad_pcb >/dev/null 2>&1
kicad-cli pcb drc --schematic-parity --severity-all --format report -o "$E/drc.rpt" ARTHUR_EMG_RevB.kicad_pcb >/dev/null 2>&1
kicad-cli sch erc --severity-all --format json -o "$E/erc.json" ARTHUR_EMG_RevB.kicad_sch >/dev/null 2>&1 || true
kicad-cli sch export netlist --format kicadxml -o "$E/revb.xml" ARTHUR_EMG_RevB.kicad_sch >/dev/null
python3 "$T/rb03_audit.py" --pcb ARTHUR_EMG_RevB.kicad_pcb --out "$E/audit.json" 2>&1 | grep -v assert | tail -3 || true
python3 "$T/rb03r_via_audit.py" --pcb ARTHUR_EMG_RevB.kicad_pcb --out "$E/via_audit.json" --csv "$E/via_audit.csv" 2>&1 | grep -v assert | tail -3 || true
python3 - "$E/drc.json" <<'PY'
import json,sys,collections
d=json.load(open(sys.argv[1]))
c=collections.Counter((v['severity'],v['type']) for v in d['violations'])
print('DRC:',dict(c),'| unconnected',len(d['unconnected_items']),'| parity',len(d['schematic_parity']))
PY
# --- the remaining RB-03R checks (all on the scratch copy) ---
python3 "$T/rb02g_check.py" --pcb ARTHUR_EMG_RevB.kicad_pcb --netlist "$E/revb.xml" --json "$E/rb02_checks_module_frame.json" > "$E/rb02_checks_module_frame.txt" || true
python3 "$T/rb02e_economic_audit.py" --pcb ARTHUR_EMG_RevB.kicad_pcb --netlist "$E/revb.xml" --out "$E/economic" > /dev/null || true
python3 "$T/rb03r_analog_audit.py" --pcb ARTHUR_EMG_RevB.kicad_pcb --out "$E/analog.json" 2>&1 | grep -v assert | tail -3 || true
RC=0
python3 "$T/rb03r_guard.py" check --project "$P" --netlist "$E/revb.xml" --pcb "$P/ARTHUR_EMG_RevB.kicad_pcb" > "$E/guard_check.txt" 2>&1 && echo "GUARD CHECK: PASS" || { echo "GUARD CHECK: FAIL"; tail -5 "$E/guard_check.txt"; RC=1; }
python3 "$T/rb03r_guard.py" canary --project "$P" --pcb ARTHUR_EMG_RevB.kicad_pcb --work "$E/canary" > "$E/guard_canary.txt" 2>&1 && echo "GUARD CANARY: PASS" || { echo "GUARD CANARY: FAIL"; tail -8 "$E/guard_canary.txt"; RC=1; }
# the canonical project files must be byte-identical before and after (the scratch copy is the only thing touched)
sha256sum "$K/ARTHUR_EMG_RevB.kicad_pro" "$K/ARTHUR_EMG_RevB.kicad_dru" > "$E/canonical_project_sha256.txt"
SHA1="$(sha256sum "$K/ARTHUR_EMG_RevB.kicad_pro" "$K/ARTHUR_EMG_RevB.kicad_dru" | cut -d" " -f1 | tr -d "\n")"
[ "$SHA0" = "$SHA1" ] || { echo "CANONICAL PROJECT FILES CHANGED DURING VERIFY: FAIL"; RC=1; }
bash "$T/rb04_lock.sh" verify || RC=1
exit $RC
