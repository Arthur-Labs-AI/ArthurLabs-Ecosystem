#!/usr/bin/env python3
"""RB-03R: selective passive repositioning.  For each given reference designator that still owns a via-in-pad / too-close via, try
small footprint offsets (nearest first, same rotation, no courtyard overlap), rip up only the nets of the part, re-route them with
the strict router (no via-in-pad), re-tie its GND pads, and accept the first offset that leaves no offending via.
Run on a SCRATCH project copy.

    python3 rb03r_movepart.py --pcb in.kicad_pcb --out out.kicad_pcb --refs C304 C4006 [--radius 1.5] [--log log.json]
"""
import argparse
import json
import math
import sys
from pathlib import Path

import pcbnew
import sys as _sys, pathlib as _pl
_sys.path.insert(0, str(_pl.Path(__file__).resolve().parent))
from rb03r_safe import safe_pcb  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rb03_router as RT  # noqa: E402
import rb03r_repair as RP  # noqa: E402
import rb03r_nudge as NG  # noqa: E402
from rb02_sexpr import first, kids, parse  # noqa: E402

NM = 1e6
import os
VERB = bool(os.environ.get('VERB'))
STEP = 0.1


def courtyard_box(fp, margin=0.0):
    bb = fp.GetCourtyard(pcbnew.F_CrtYd).BBox()
    return (bb.GetLeft() / NM - margin, bb.GetTop() / NM - margin, bb.GetRight() / NM + margin, bb.GetBottom() / NM + margin)


def overlaps(a, c):
    return a[0] < c[2] and c[0] < a[2] and a[1] < c[3] and c[1] < a[3]


def build(pcb, root, moves, slack, rot=0):
    b = pcbnew.LoadBoard(str(safe_pcb(pcb)))
    for ref, (dx, dy) in moves.items():
        fp = b.FindFootprintByReference(ref)
        pos = fp.GetPosition()
        fp.SetPosition(pcbnew.VECTOR2I(pos.x + int(round(dx * NM)), pos.y + int(round(dy * NM))))
        if rot:
            fp.SetOrientationDegrees(fp.GetOrientationDegrees() + rot)
    r = RT.Router(b)
    r.slack = slack
    r.own_pad_via_gap = RP.GAP
    r.relax_via_in_pad = False
    r.gnd_rects = [(x0, y0, x1, y1) for (x0, y0, x1, y1, n, k) in r.copper[RT.L_F] if n == "GND" and k == "pad"]
    r.route_all(only={"__none__"})
    RP.load_state(r, root)
    return b, r


def strip_part(r, b, ref, orig_pads):
    """remove the tracks / vias that belonged to the part's pads at their ORIGINAL positions, return the non-GND nets to re-route"""
    nets = set()
    for (num, net, x, y) in orig_pads:
        if net and net != "GND" and not net.startswith("unconnected"):
            nets.add(net)
    RP.rip(r, nets)
    # GND: vias within 0.7 mm of the old pad centre and the GND spurs that touch them (3 hops)
    for (num, net, x, y) in orig_pads:
        if net != "GND":
            continue
        gone = [v for v in r.vias if v[0] == "GND" and math.hypot(v[1] - x, v[2] - y) < 0.7]
        for (n, vx, vy) in gone:
            r.vias.remove((n, vx, vy))
            for L in r.copper:
                r.copper[L] = [c for c in r.copper[L] if not (c[5] == "via" and c[4] == "GND" and abs((c[0] + c[2]) / 2 - vx) < 1e-6 and abs((c[1] + c[3]) / 2 - vy) < 1e-6)]
            ends = [(vx, vy)]
            for _ in range(3):
                nxt, keep = [], []
                for t in r.tracks:
                    if t[0] == "GND" and any((abs(t[2] - ex) < 1e-6 and abs(t[3] - ey) < 1e-6) or (abs(t[4] - ex) < 1e-6 and abs(t[5] - ey) < 1e-6) for ex, ey in ends):
                        nxt += [(t[2], t[3]), (t[4], t[5])]
                    else:
                        keep.append(t)
                r.tracks = keep
                ends = nxt
        r.gnd_done.discard((ref, num))
    return nets


def try_move(pcb, root, ref, dx, dy, orig_pads, slack, target=None, rot=0):
    b, r = build(pcb, root, {ref: (dx, dy)}, slack, rot)
    for fp in b.GetFootprints():
        for p in fp.Pads():
            if p.GetNetname() == "GND" and (fp.GetReference(), p.GetNumber()) not in {(ref, n) for (n, nt, x, y) in orig_pads}:
                r.gnd_done.add((fp.GetReference(), p.GetNumber()))
    # all existing GND pads other than the moved part's are "done"; the moved part's pads are re-tied below
    nets = strip_part(r, b, ref, orig_pads)
    # the moved pads must keep their clearance to foreign tracks / vias that stay in place
    fpm = b.FindFootprintByReference(ref)
    for p in fpm.Pads():
        pn = p.GetNetname()
        bb = p.GetBoundingBox()
        pr = (bb.GetLeft() / NM, bb.GetTop() / NM, bb.GetRight() / NM, bb.GetBottom() / NM)
        for L in (RT.L_F, RT.L_B):
            if L == RT.L_B and not p.IsOnLayer(pcbnew.B_Cu):
                continue
            for (x0, y0, x1, y1, n, kind) in r.copper[L]:
                if kind not in ("track", "via") or n == pn or n in nets:
                    continue
                c = 0.2 + 0.05
                if n in r.hiz_nets or pn in r.hiz_nets:
                    c = 0.4 + 0.05
                if pr[0] - c < x1 and x0 < pr[2] + c and pr[1] - c < y1 and y0 < pr[3] + c:
                    if VERB: print('    pad', f"{ref}.{p.GetNumber()}", 'too close to', n, kind, flush=True)
                    return None
    order = sorted(nets, key=lambda n: (RT.PRIORITY.index(RT.klass(n)) if RT.klass(n) in RT.PRIORITY else 99, n))
    # nets must be re-routed against the moved pads: the router's pad table was built from the moved board already
    for n in order:
        if n not in r.nets_by_name or len(r.nets_by_name[n]) < 2:
            continue
        r.relax_via_in_pad = False
        ok, info = r._route_net(n, RT.klass(n), r.nets_by_name[n])
        if not ok:
            if VERB: print('   ', n, info, flush=True)
            return None
    pads = {f"{ref}.{num}" for (num, net, x, y) in orig_pads if net == "GND"}
    if pads:
        r.gnd_vias(prefixes=pads)
    for (num, net, x, y) in orig_pads:
        if net == "GND" and (ref, num) not in r.gnd_done:
            if VERB: print('    GND via failed', ref, num, flush=True)
            return None
    if target:
        tn, tx, ty = target
        if not any(v[0] == tn and abs(v[1] - tx) < 1e-6 and abs(v[2] - ty) < 1e-6 for v in r.vias):
            return None
        tres = NG.attempt(r, b, tn, tx, ty, 3.0)
        if tres is None:
            return None
        r.target_len = tres["length_mm"]
    if RP.offenders(b, r):
        mine = {f"{ref}.{num}" for (num, net, x, y) in orig_pads}
        # tolerate offenders that already existed elsewhere, reject any at this part
        if any(o[3] in mine or o[0] in nets for o in RP.offenders(b, r)):
            if VERB: print('    offenders', RP.offenders(b, r)[:3], flush=True)
            return None
    return b, r


def set_fp_position(root, ref, dx, dy, rot=0):
    for fp in kids(root, "footprint"):
        refs = [p for p in fp if isinstance(p, list) and p and p[0] == "property" and str(p[1]) == "Reference"]
        if refs and str(refs[0][2]) == ref:
            at = first(fp, "at")
            at[1] = round(float(at[1]) + dx, 4)
            at[2] = round(float(at[2]) + dy, 4)
            if rot:
                ang = float(at[3]) if len(at) > 3 else 0.0
                ang = (ang + rot) % 360
                if len(at) > 3:
                    at[3] = ang if ang != int(ang) else int(ang)
                else:
                    at.append(int(ang))
            return True
    return False


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pcb", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--refs", nargs="+", required=True)
    ap.add_argument("--radius", type=float, default=1.5)
    ap.add_argument("--slack", type=float, default=0.0)
    ap.add_argument("--log", type=Path)
    ap.add_argument("--best-of", type=int, default=1, help="evaluate up to N successful offsets and keep the one with the shortest target stub")
    ap.add_argument("--gnd-cap", type=float, default=4.0)
    ap.add_argument("--step", type=float, default=0.1)
    ap.add_argument("--rots", type=int, nargs="*", default=[0], help="extra rotations to try (degrees)")
    ap.add_argument("--max-dx", type=float, default=None)
    ap.add_argument("--min-dx", type=float, default=None)
    ap.add_argument("--max-dy", type=float, default=None)
    ap.add_argument("--min-dy", type=float, default=None)
    ap.add_argument("--target", help="NET,x,y of an offending via that must become fixable by the move")
    a = ap.parse_args(argv)
    NG.CAP_GND = a.gnd_cap
    tgt = None
    if a.target:
        tn, tx, ty = a.target.split(",")
        tgt = (tn, float(tx), float(ty))
    cur = a.pcb
    log = {"moved": [], "failed": []}
    for ref in a.refs:
        root = parse(cur.read_text())
        b0 = pcbnew.LoadBoard(str(safe_pcb(cur)))
        fp0 = b0.FindFootprintByReference(ref)
        orig = [(p.GetNumber(), p.GetNetname(), p.GetPosition().x / NM, p.GetPosition().y / NM) for p in fp0.Pads()]
        c0 = courtyard_box(fp0)
        others = [(f.GetReference(), courtyard_box(f)) for f in b0.GetFootprints() if f.GetReference() != ref]
        near = [ob for _, ob in others if overlaps(c0, ob)]
        if near:
            print(f"{ref}: courtyard already touches {len(near)} neighbour courtyards (shrunk by 0.05 for the test)", flush=True)
        c0s = c0
        board = b0.GetBoardEdgesBoundingBox()
        cands = []
        STEPV = a.step
        n = int(round(a.radius / STEPV))
        for j in range(-n, n + 1):
            for i in range(-n, n + 1):
                d = math.hypot(i, j) * STEPV
                if 0 <= d <= a.radius and (d > 0 or any(a.rots)):
                    dx, dy = i * STEPV, j * STEPV
                    if (a.max_dx is not None and dx > a.max_dx + 1e-9) or (a.min_dx is not None and dx < a.min_dx - 1e-9) or (a.max_dy is not None and dy > a.max_dy + 1e-9) or (a.min_dy is not None and dy < a.min_dy - 1e-9):
                        continue
                    box = (c0[0] + dx, c0[1] + dy, c0[2] + dx, c0[3] + dy)
                    if box[0] < board.GetLeft() / NM + 0.5 or box[2] > board.GetRight() / NM - 0.5 or box[1] < board.GetTop() / NM + 0.5 or box[3] > board.GetBottom() / NM - 0.5:
                        continue
                    if any(overlaps((box[0] + 0.05, box[1] + 0.05, box[2] - 0.05, box[3] - 0.05), ob) for _, ob in others):
                        continue
                    if d > 0:
                        cands.append((d, dx, dy, 0))
                    for rr in a.rots:
                        if rr:
                            cx, cy = (c0[0] + c0[2]) / 2 + dx, (c0[1] + c0[3]) / 2 + dy
                            w2, h2 = (c0[3] - c0[1]) / 2, (c0[2] - c0[0]) / 2
                            if rr % 180 == 0:
                                w2, h2 = h2, w2
                            rb = (cx - h2 if False else cx - w2, cy - h2, cx + w2, cy + h2)
                            if not any(overlaps((rb[0] + 0.05, rb[1] + 0.05, rb[2] - 0.05, rb[3] - 0.05), ob) for _, ob in others):
                                cands.append((d + 0.5, dx, dy, rr))
        cands.sort()
        found = None
        nsucc = 0
        for (d, dx, dy, rr) in cands:
            res = try_move(cur, root, ref, dx, dy, orig, a.slack, tgt, rr)
            if res:
                nsucc += 1
                key = (getattr(res[1], "target_len", 0.0) + d, d)
                print(f"  candidate ({dx:+.2f},{dy:+.2f}) rot {rr}: target stub {getattr(res[1], 'target_len', 0.0):.2f} mm", flush=True)
                if found is None or key < found[0]:
                    found = (key, dx, dy, res, rr)
                if nsucc >= a.best_of:
                    break
        if found:
            found = (found[1] * 0 + 0, found[1], found[2], found[3], found[4])
        if not found:
            print(f"{ref}: no offset within {a.radius} mm worked ({len(cands)} tried)", flush=True)
            log["failed"].append(ref)
            continue
        d, dx, dy, (b, r), rr = found
        print(f"{ref}: moved ({dx:+.1f},{dy:+.1f}) mm rot {rr}", flush=True)
        set_fp_position(root, ref, dx, dy, rr)
        RP.write_board(root, r, a.out)
        cur = a.out
        log["moved"].append({"ref": ref, "dx": round(dx, 2), "dy": round(dy, 2), "rot": rr})
    if cur != a.out:
        a.out.write_text(a.pcb.read_text())
    if a.log:
        a.log.write_text(json.dumps(log, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
