#!/usr/bin/env python3
"""RB-03S: local placement repair for one ground pad.  Moves the named footprints by the given offsets, rips up and strictly re-routes
only the non-GND nets of the moved parts, removes the old ground tie of the target pad (including the dangling tail of its wire),
places a new GND via with rb03_router.gnd_vias (in2 edge margin configurable) and reports the new tie length.  Scratch copies only.

    python3 rb03s_repair.py --pcb in --out out --move R7101:-0.3:0 C6009:-0.15:0 --pad C6009.2 [--in2-margin 0.0]
"""
import argparse, json, math, sys
from pathlib import Path
import pcbnew
sys.path.insert(0, str(Path(__file__).resolve().parent))
import rb03_router as RT, rb03r_repair as RP, rb03r_movepart as MP
from rb03r_safe import safe_pcb
from rb02_sexpr import parse
NM = 1e6
ap = argparse.ArgumentParser()
ap.add_argument("--pcb", type=Path, required=True); ap.add_argument("--out", type=Path, required=True)
ap.add_argument("--move", nargs="+", required=True, help="REF:dx:dy[:rot]")
ap.add_argument("--pad", default=None, help="REF.NUM of a GND pad to re-tie (optional)")
ap.add_argument("--in2-margin", type=float, default=0.4); ap.add_argument("--slack", type=float, default=0.0)
ap.add_argument("--gnd-rect-margin", type=float, default=0.35)
ap.add_argument("--also-reroute", nargs="*", default=[], help="extra nets to rip up and re-route (they pass through the moved parts)")
ap.add_argument("--log", type=Path)
a = ap.parse_args()
moves = {}
for m in a.move:
    p = m.split(":"); moves[p[0]] = (float(p[1]), float(p[2]), float(p[3]) if len(p) > 3 else 0.0)
root = parse(a.pcb.read_text())
b0 = pcbnew.LoadBoard(str(safe_pcb(a.pcb)))
orig = {ref: [(p.GetNumber(), p.GetNetname(), p.GetPosition().x / NM, p.GetPosition().y / NM) for p in b0.FindFootprintByReference(ref).Pads()] for ref in moves}
boxes = {f.GetReference(): MP.courtyard_box(f) for f in b0.GetFootprints()}
for ref, (dx, dy, rot) in moves.items():
    c = boxes[ref]; nb = (c[0] + dx + 0.001, c[1] + dy + 0.001, c[2] + dx - 0.001, c[3] + dy - 0.001)
    for r2, o in boxes.items():
        if r2 in moves or r2 == ref:
            continue
        if MP.overlaps((c[0] + 0.001, c[1] + 0.001, c[2] - 0.001, c[3] - 0.001), o):
            continue                      # already overlapping in the input board (DRC judges it); not made worse by an x move
        ob = o
        if MP.overlaps(nb, ob):
            print("courtyard conflict:", ref, "vs", r2); sys.exit(2)
b = pcbnew.LoadBoard(str(safe_pcb(a.pcb)))
for ref, (dx, dy, rot) in moves.items():
    fp = b.FindFootprintByReference(ref); pos = fp.GetPosition()
    fp.SetPosition(pcbnew.VECTOR2I(pos.x + int(round(dx * NM)), pos.y + int(round(dy * NM))))
    if rot: fp.SetOrientationDegrees(fp.GetOrientationDegrees() + rot)
r = RT.Router(b); r.slack = a.slack; r.own_pad_via_gap = RP.GAP; r.relax_via_in_pad = False
r.gnd_rects = [(x0, y0, x1, y1) for (x0, y0, x1, y1, n, k) in r.copper[RT.L_F] if n == "GND" and k == "pad"]
r.route_all(only={"__none__"}); RP.load_state(r, root)
pref, pnum = a.pad.split(".") if a.pad else ("", "")
own = {(ref, n) for ref in moves for (n, nt, x, y) in orig[ref]}
for fp in b.GetFootprints():
    for p in fp.Pads():
        if p.GetNetname() == "GND" and (fp.GetReference(), p.GetNumber()) not in own:
            r.gnd_done.add((fp.GetReference(), p.GetNumber()))
nets = set()
for ref in moves:
    nets |= MP.strip_part(r, b, ref, orig[ref])
# dangling GND tails left by the removed ties (F.Cu / any layer): iterate until none
def dangling_pass():
    pads = [p for fp in b.GetFootprints() for p in fp.Pads() if p.GetNetname() == "GND"]
    gt = [t for t in r.tracks if t[0] == "GND"]
    def touched(x, y, me):
        for t in gt:
            if t is me: continue
            if (abs(t[2]-x) < 1e-6 and abs(t[3]-y) < 1e-6) or (abs(t[4]-x) < 1e-6 and abs(t[5]-y) < 1e-6): return True
        if any(n == "GND" and abs(vx-x) < 1e-6 and abs(vy-y) < 1e-6 for (n, vx, vy) in r.vias): return True
        pos = pcbnew.VECTOR2I(int(round(x*NM)), int(round(y*NM)))
        return any(p.HitTest(pos) for p in pads)
    dead = [t for t in gt if not (touched(t[2], t[3], t) and touched(t[4], t[5], t))]
    for t in dead: r.tracks.remove(t)
    return len(dead)
removed = 0
while True:
    n = dangling_pass(); removed += n
    if not n: break
for L in r.copper:
    r.copper[L] = [c for c in r.copper[L] if not (c[5] == "track" and c[4] == "GND")]
for t in r.tracks:
    if t[0] == "GND":
        w = t[6]; r.copper[t[1]].append((min(t[2], t[4]) - w/2, min(t[3], t[5]) - w/2, max(t[2], t[4]) + w/2, max(t[3], t[5]) + w/2, "GND", "track"))
r.gnd_done.discard((pref, pnum))
for ref in moves:
    for (n, nt, x, y) in orig[ref]:
        if nt == "GND": r.gnd_done.discard((ref, n))
nets |= set(a.also_reroute)
RP.rip(r, set(a.also_reroute))
order = sorted(nets, key=lambda n: (RT.PRIORITY.index(RT.klass(n)) if RT.klass(n) in RT.PRIORITY else 99, n))
fails = []
for n in order:
    if n not in r.nets_by_name or len(r.nets_by_name[n]) < 2: continue
    r.relax_via_in_pad = False
    ok, info = r._route_net(n, RT.klass(n), r.nets_by_name[n])
    print(n, ok, info if not ok else "", flush=True)
    if not ok: fails.append(n)
r.in2_edge_margin = a.in2_margin
r.gnd_rect_margin = a.gnd_rect_margin
todo = {f"{ref}.{n}" for ref in moves for (n, nt, x, y) in orig[ref] if nt == "GND"} | ({a.pad} if a.pad else set())
ntv = len(r.vias); ntt = len(r.tracks)
done, fail = r.gnd_vias(prefixes=todo)
newv = r.vias[ntv:]; newt = r.tracks[ntt:]
print("GND ties placed:", done, "failed:", fail, "new vias:", newv)
print("new GND tracks:", [(t[1], round(t[2],2), round(t[3],2), round(t[4],2), round(t[5],2), t[6]) for t in newt])
off = RP.offenders(b, r)
print("offenders:", off)
print("dangling GND segments removed:", removed, "| failed nets:", fails)
if fails or fail: sys.exit(3)
for ref, (dx, dy, rot) in moves.items():
    MP.set_fp_position(root, ref, dx, dy, rot)
RP.write_board(root, r, a.out)
if a.log: a.log.write_text(json.dumps({"moves": moves, "new_vias": newv, "offenders": off}, indent=1))
print("OK")
