#!/usr/bin/env bash
# One-shot RB-01R verification: fresh export -> ERC -> independent audit -> mutation test -> BOM -> Rev A hash.
# Usage: bash hardware/emg/rev-b-xiao/tools/run_rb01r_checks.sh   (from anywhere inside the repo)
set -u
ROOT="$(git rev-parse --show-toplevel)"
TOOLS="$ROOT/hardware/emg/rev-b-xiao/tools"
PRJ="$ROOT/hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB"
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"; cd "$PRJ" || exit 2
rc=0
echo "== kicad-cli $(kicad-cli version) ; output dir $OUT"
kicad-cli sch export netlist --format kicadxml -o "$OUT/revb.xml" ARTHUR_EMG_RevB.kicad_sch || rc=1
kicad-cli sch erc --severity-all --format json -o "$OUT/erc.json" ARTHUR_EMG_RevB.kicad_sch >/dev/null || rc=1
python3 - "$OUT/erc.json" <<'PY' || rc=1
import json,sys,collections
d=json.load(open(sys.argv[1])); c=collections.Counter()
for s in d['sheets']:
    for v in s['violations']: c[(v['severity'],v['type'])]+=1
print('ERC:',dict(c) or 'clean')
err=sum(n for (sev,_),n in c.items() if sev=='error'); other=sum(n for (sev,t),n in c.items() if t!='footprint_link_issues')
sys.exit(1 if err or other else 0)
PY
python3 "$TOOLS/rb01r_netlist_audit.py" "$OUT/revb.xml" || rc=1
python3 "$TOOLS/test_audit_mutations.py" "$OUT/revb.xml" | tail -8 || rc=1
kicad-cli sch export bom --fields 'Reference,Value,Footprint,MPN,Manufacturer,LCSC,JLC_Class,${DNP},${QUANTITY}' \
  --labels 'Refs,Value,Footprint,MPN,Manufacturer,LCSC,JLC_Class,DNP,Qty' --group-by 'Value,Footprint,MPN,LCSC' \
  --ref-range-delimiter '' -o "$OUT/bom.csv" ARTHUR_EMG_RevB.kicad_sch >/dev/null && wc -l "$OUT/bom.csv"
cd "$ROOT/hardware/emg" || exit 2
P=$(sha256sum rev-a-cost/kicad/ARTHUR_EMG_RevA_Cost/ARTHUR_EMG_RevA_Cost.kicad_pcb | cut -d' ' -f1)
T=$(git ls-files rev-a rev-a-cost | xargs sha256sum | sha256sum | cut -d' ' -f1)
[ "$P" = d7a585e8ae46299215d26c0aa58ea0ca5829d46ce72a45d279290263e94a0005 ] && echo "Rev A PCB hash unchanged" || { echo "Rev A PCB HASH CHANGED $P"; rc=1; }
[ "$T" = d5d722898307447d77b327cacff40d451708a3b9fb76d2008e63e59cd0ea2c67 ] && echo "Rev A tree hash unchanged" || { echo "Rev A TREE HASH CHANGED $T"; rc=1; }
python3 "$TOOLS/rb01r_calcs.py" > "$OUT/calcs.txt" && echo "calcs written to $OUT/calcs.txt"
exit $rc
