#!/usr/bin/env bash
# RB-03 phase 0: build the approved V1 placement (placement only, unrouted) into <scratch>/v1/variant.kicad_pcb.
# The main project directory is never opened by pcbnew (pcbnew rewrites .kicad_pro on save and drops the netclasses).
set -eu
ROOT="$(git rev-parse --show-toplevel)"; T="$ROOT/hardware/emg/rev-b-xiao/tools"; K="$ROOT/hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB"
O="${1:?scratch dir}"; mkdir -p "$O"
( cd "$K" && kicad-cli sch export netlist --format kicadxml -o "$O/revb.xml" ARTHUR_EMG_RevB.kicad_sch >/dev/null )
python3 "$T/rb02g_build.py" --netlist "$O/revb.xml" --variant "${RB03_VARIANT:-V1}" --out "$O/v1"
