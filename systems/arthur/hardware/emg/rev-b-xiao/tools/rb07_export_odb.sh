#!/usr/bin/env bash
# RB-07: export ODB++ from the frozen canonical KiCad PCB (read-only: works on a scratch copy of the project).
#   bash rb07_export_odb.sh <out.zip>
set -eu
T="$(cd "$(dirname "$0")" && pwd)"; K="$T/../kicad/ARTHUR_EMG_RevB"; bash "$T/rb04_lock.sh" verify
W="$(mktemp -d)"; cp -r "$K" "$W/prj"; chmod -R u+w "$W/prj"; rm -rf "$W/prj/.history" "$W"/prj/*.lck
( cd "$W/prj" && kicad-cli pcb export odb --compression zip --units mm --precision 6 -o "$(readlink -f -- "$1" 2>/dev/null || echo "$1")" ARTHUR_EMG_RevB.kicad_pcb )
cmp -s "$W/prj/ARTHUR_EMG_RevB.kicad_pcb" "$K/ARTHUR_EMG_RevB.kicad_pcb" && echo "scratch PCB identical to canonical"; rm -rf "$W"
