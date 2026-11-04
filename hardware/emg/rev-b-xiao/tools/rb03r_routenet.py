#!/usr/bin/env python3
"""RB-03R: route (or re-route) named nets on an existing routed board, other copper untouched.
    python3 rb03r_routenet.py --pcb in --out out --nets /CH3/BUF_N [--slack 0.0] [--rip]"""
import argparse, sys
from pathlib import Path
import pcbnew
import sys as _sys, pathlib as _pl
_sys.path.insert(0, str(_pl.Path(__file__).resolve().parent))
from rb03r_safe import safe_pcb  # noqa: E402
sys.path.insert(0, str(Path(__file__).resolve().parent))
import rb03_router as RT, rb03r_repair as RP
from rb02_sexpr import parse
ap = argparse.ArgumentParser()
ap.add_argument("--pcb", type=Path, required=True); ap.add_argument("--out", type=Path, required=True)
ap.add_argument("--nets", nargs="+", required=True); ap.add_argument("--slack", type=float, default=0.0)
ap.add_argument("--rip", action="store_true"); ap.add_argument("--gap", type=float, default=0.25)
a = ap.parse_args()
root = parse(a.pcb.read_text()); b = pcbnew.LoadBoard(str(safe_pcb(a.pcb)))
r = RT.Router(b); r.slack = a.slack; r.own_pad_via_gap = a.gap; r.relax_via_in_pad = False
r.gnd_rects = [(x0, y0, x1, y1) for (x0, y0, x1, y1, n, k) in r.copper[RT.L_F] if n == "GND" and k == "pad"]
r.route_all(only={"__none__"}); RP.load_state(r, root)
for fp in b.GetFootprints():
    for p in fp.Pads():
        if p.GetNetname() == "GND": r.gnd_done.add((fp.GetReference(), p.GetNumber()))
if a.rip: RP.rip(r, set(a.nets))
for n in a.nets:
    ok, info = r.route_net(n, RT.klass(n), r.nets_by_name[n])
    print(n, ok, info, flush=True)
RP.write_board(root, r, a.out)
