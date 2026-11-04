#!/usr/bin/env bash
# RB-03R: reproducible repair chain that produced the installed Rev B PCB (V1C placement, 0 via-in-pad).  Everything runs in scratch
# directories; the canonical project files are only read.   bash rb03r_repair_chain.sh <work dir>
# The greedy router is not bit-reproducible across code revisions, so steps s0-s4 can end in a slightly different board; the archived
# intermediate board archive/rb03r_chain/step4_after_AFE_reroute_m7.kicad_pcb is the exact input of s5-s6 for the installed board:
#   RB03R_FROM_M7=1 bash rb03r_repair_chain.sh <work dir>
set -eu
ROOT="$(git rev-parse --show-toplevel)"; T="$ROOT/hardware/emg/rev-b-xiao/tools"; W="$(mkdir -p "${1:?work dir}" && readlink -f "$1")"
V() { bash "$T/rb03r_verify.sh" "$1" "$2" --fill 2>&1 | grep -E "DRC:|GUARD"; }
if [ -z "${RB03R_FROM_M7:-}" ]; then
# s0  place (V1C = V1 + 2.5 mm band-row relief) and route; 0.20/0.16 via ladder as the starting point, no via-in-pad fallback is kept afterwards
RB03_INSTALL=0 RB03_VARIANT=V1C RB03_ROUTER_FLAGS="--via-ladder" bash "$T/run_rb03_route.sh" "$W/s0" "$W/e0" > "$W/s0.log" 2>&1
P0="$W/s0/prj/final.kicad_pcb"
# s1  hi-Z nets, their buffer and the AFE rail re-routed together in class-priority order (the greedy pass left CH3 boxed in)
python3 "$T/rb03r_routenet.py" --pcb "$P0" --out "$W/c1.kicad_pcb" --rip --nets /CH3/HIZ_P /CH3/HIZ_N /CH3/BUF_N AFE_3V0
V "$W/c1.kicad_pcb" "$W/vc1"
# s2  local via relocation (no rip-up)
python3 "$T/rb03r_nudge.py" --pcb "$W/c1.kicad_pcb" --out "$W/c2.kicad_pcb" --log "$W/c2.json" --radius 3.0 --slack 0.0 --drc "$W/vc1/drc.json"
# s3  selective passive repositioning for pads that are boxed in (<= 0.2 mm each)
python3 "$T/rb03r_movepart.py" --pcb "$W/c2.kicad_pcb" --out "$W/m4.kicad_pcb" --refs C4006 Q3001 U4002 R7102 --radius 2.0 --log "$W/m4.json"
# s4  TLV9064 rule areas, AFE rail re-routed with the via-vs-hi-Z-pad mask
python3 -c "import sys; sys.path.insert(0,'$T'); import rb03r_escape_areas as E; E.add('$W/m4.kicad_pcb','$W/m5.kicad_pcb')"
python3 "$T/rb03r_routenet.py" --pcb "$W/m5.kicad_pcb" --out "$W/m7.kicad_pcb" --rip --nets AFE_3V0
python3 -c "import sys; sys.path.insert(0,'$T'); import rb03r_escape_areas as E; E.add('$W/m7.kicad_pcb','$W/m7.kicad_pcb')"
else
cp "$ROOT/hardware/emg/rev-b-xiao/archive/rb03r_chain/step4_after_AFE_reroute_m7.kicad_pcb" "$W/m7.kicad_pcb"
fi
V "$W/m7.kicad_pcb" "$W/vm7"
# s5  via-audit driven relocation (U1.9) -- the SPI length cap is off here: this is what produced the installed board
python3 "$T/rb03r_nudge.py" --pcb "$W/m7.kicad_pcb" --out "$W/m8.kicad_pcb" --radius 3.0 --slack 0.0 --via-audit "$W/vm7/via_audit.json" --spi-cap 100
# s6  the two pockets that need a neighbour moved: C6009 (R7101, tie up to 30 mm accepted) and C304 (R306)
python3 "$T/rb03r_movepart.py" --pcb "$W/m8.kicad_pcb" --out "$W/mv.kicad_pcb" --refs R7101 --radius 1.0 --target GND,24.7,49.0 --gnd-cap 30
python3 "$T/rb03r_movepart.py" --pcb "$W/mv.kicad_pcb" --out "$W/mw.kicad_pcb" --refs R306 --radius 1.2 --target GND,14.7,18.5 --gnd-cap 30
V "$W/mw.kicad_pcb" "$W/vw"
python3 "$T/rb03r_nudge.py" --pcb "$W/mw.kicad_pcb" --out "$W/final.kicad_pcb" --radius 3.0 --slack 0.0 --via-audit "$W/vw/via_audit.json" --drc "$W/vw/drc.json" --spi-cap 8
V "$W/final.kicad_pcb" "$W/vfinal"
