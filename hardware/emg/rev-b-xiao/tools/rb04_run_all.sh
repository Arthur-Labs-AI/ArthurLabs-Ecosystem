#!/usr/bin/env bash
# RB-04: run every independent audit on the canonical PCB.  Nothing is written into the project; exports go to the scratch dir only and
# are NOT manufacturing-release files.      bash rb04_run_all.sh <scratch dir> [evidence dir]
set -eu
ROOT="$(git rev-parse --show-toplevel)"; R="$ROOT/hardware/emg/rev-b-xiao"; T="$R/tools"; K="$R/kicad/ARTHUR_EMG_RevB"
W="$(mkdir -p "${1:?scratch dir}" && readlink -f "$1")"; E="${2:-$R/evidence/rb04}"; mkdir -p "$E"
PCB="$K/ARTHUR_EMG_RevB.kicad_pcb"
bash "$T/rb04_lock.sh" verify
bash "$T/rb03r_verify.sh" "$PCB" "$W/base"                                   # KiCad DRC/ERC, guard check + canary, economic audit, via audit
python3 "$T/rb04_parity.py" --project "$K" --out "$E/parity.json"
python3 "$T/rb04_geom.py" --pcb "$PCB" --out "$E/geom.json" > "$E/geom.txt"
python3 "$T/rb04_mask.py" --pcb "$PCB" --out "$E/mask.json" --csv "$E/mask_class23.csv" > "$E/mask.txt"
python3 "$T/rb04_electrical.py" --pcb "$PCB" --netlist "$W/base/revb.xml" --out "$E/electrical.json" > "$E/electrical.txt"
python3 "$T/rb04_power.py" --pcb "$PCB" --out "$E/power.json" > "$E/power.txt"
python3 "$T/rb04_conn.py" --pcb "$PCB" --out "$E/conn.json" > "$E/conn.txt"
python3 "$T/rb03s_iron_access.py" --pcb "$PCB" --out "$E/iron_access.json" > /dev/null
# DFM-only exports in the scratch copy of the project (never uploaded, never committed)
rm -rf "$W/dfm"; mkdir -p "$W/dfm/prj" "$W/dfm/gerber"; cp -r "$K/." "$W/dfm/prj/"; chmod -R u+w "$W/dfm/prj"; rm -rf "$W/dfm/prj/.history"
( cd "$W/dfm/prj"
  kicad-cli pcb export gerbers --layers F.Cu,In1.Cu,In2.Cu,B.Cu,F.Paste,F.Mask,B.Mask,F.SilkS,B.SilkS,Edge.Cuts -o ../gerber/ ARTHUR_EMG_RevB.kicad_pcb > /dev/null
  kicad-cli pcb export drill --format excellon --drill-origin absolute --excellon-units mm -o ../gerber/ ARTHUR_EMG_RevB.kicad_pcb > /dev/null
  kicad-cli pcb export pos --format csv --units mm --side both --exclude-dnp -o ../pos.csv ARTHUR_EMG_RevB.kicad_pcb > /dev/null
  kicad-cli sch export bom --fields 'Reference,Value,Footprint,${QUANTITY},MPN,LCSC,Manufacturer' --group-by 'Value,Footprint,MPN' --exclude-dnp -o ../bom_kicad.csv ARTHUR_EMG_RevB.kicad_sch > /dev/null )
python3 "$T/rb04_gerber.py" --gerber "$W/dfm/gerber" --pcb "$PCB" --pos "$W/dfm/pos.csv" --bom "$W/dfm/bom_kicad.csv" --out "$E/gerber_report.json" --svg-dir "$W/dfm/svg" > "$E/gerber.txt"
python3 "$T/rb04_cpl.py" --pcb "$PCB" --pos "$W/dfm/pos.csv" --out "$E/cpl_check.json" > "$E/cpl.txt"
python3 "$T/rb03r_guard_selftest.py" --out "$E/guard_selftest.json" > "$E/guard_selftest.txt" || true
bash "$T/rb04_lock.sh" verify
echo "RB-04 run complete; exports in $W/dfm (scratch, not release files)"
