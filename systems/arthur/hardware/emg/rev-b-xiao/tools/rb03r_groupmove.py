#!/usr/bin/env python3
"""RB-03R: move a group of footprints together by (dx, dy) (e.g. a column of series resistors) to open a via pocket, re-route their
nets strictly, then tie a target offending via with rb03r_nudge.attempt.   Scratch copy only.
    python3 rb03r_groupmove.py --pcb in --out out --refs R6001 R6002 R6003 --dy 0.4 --target GND,24.7,49.0"""
import argparse, json, sys
from pathlib import Path
import pcbnew
import sys as _sys, pathlib as _pl
_sys.path.insert(0, str(_pl.Path(__file__).resolve().parent))
from rb03r_safe import safe_pcb  # noqa: E402
sys.path.insert(0, str(Path(__file__).resolve().parent))
import rb03_router as RT, rb03r_repair as RP, rb03r_nudge as NG, rb03r_movepart as MP
from rb02_sexpr import parse
NM = 1e6
ap = argparse.ArgumentParser()
ap.add_argument("--pcb", type=Path, required=True); ap.add_argument("--out", type=Path, required=True)
ap.add_argument("--refs", nargs="+", required=True); ap.add_argument("--dx", type=float, default=0.0); ap.add_argument("--dy", type=float, default=0.0)
ap.add_argument("--target"); ap.add_argument("--slack", type=float, default=0.0)
a = ap.parse_args()
root = parse(a.pcb.read_text())
b0 = pcbnew.LoadBoard(str(safe_pcb(a.pcb)))
orig = {ref: [(p.GetNumber(), p.GetNetname(), p.GetPosition().x / NM, p.GetPosition().y / NM) for p in b0.FindFootprintByReference(ref).Pads()] for ref in a.refs}
# courtyard overlaps against everything outside the group
boxes = {f.GetReference(): MP.courtyard_box(f) for f in b0.GetFootprints()}
for ref in a.refs:
    c = boxes[ref]; nb = (c[0] + a.dx + 0.05, c[1] + a.dy + 0.05, c[2] + a.dx - 0.05, c[3] + a.dy - 0.05)
    for r2, o in boxes.items():
        if r2 not in a.refs and MP.overlaps(nb, o):
            print("courtyard conflict:", ref, "vs", r2); sys.exit(2)
moves = {ref: (a.dx, a.dy) for ref in a.refs}
b, r = MP.build(a.pcb, root, moves, a.slack)
own = {(ref, n) for ref in a.refs for (n, nt, x, y) in orig[ref]}
for fp in b.GetFootprints():
    for p in fp.Pads():
        if p.GetNetname() == "GND" and (fp.GetReference(), p.GetNumber()) not in own:
            r.gnd_done.add((fp.GetReference(), p.GetNumber()))
nets = set()
for ref in a.refs:
    nets |= MP.strip_part(r, b, ref, orig[ref])
order = sorted(nets, key=lambda n: (RT.PRIORITY.index(RT.klass(n)) if RT.klass(n) in RT.PRIORITY else 99, n))
for n in order:
    if n not in r.nets_by_name or len(r.nets_by_name[n]) < 2:
        continue
    ok, info = r._route_net(n, RT.klass(n), r.nets_by_name[n])
    print(n, ok, info if not ok else "", flush=True)
    if not ok:
        sys.exit(3)
gp = {f"{ref}.{n}" for ref in a.refs for (n, nt, x, y) in orig[ref] if nt == "GND"}
if gp:
    r.gnd_vias(prefixes=gp)
if a.target:
    tn, tx, ty = a.target.split(","); tx, ty = float(tx), float(ty)
    if not any(v[0] == tn and abs(v[1] - tx) < 1e-6 and abs(v[2] - ty) < 1e-6 for v in r.vias) or NG.attempt(r, b, tn, tx, ty, 3.0) is None:
        print("target not fixable"); sys.exit(4)
bad = RP.offenders(b, r)
print("offenders after:", bad)
for ref in a.refs:
    MP.set_fp_position(root, ref, a.dx, a.dy)
RP.write_board(root, r, a.out)
print("OK")
