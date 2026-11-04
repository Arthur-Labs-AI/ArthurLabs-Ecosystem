#!/usr/bin/env python3
"""RB-03R: local via relocation.  Every via whose centre is closer than GAP (0.25 mm) to SMD pad copper (true pad shape) is moved to the
nearest legal grid cell (clearances / hi-Z / SPI rules from the router masks) and reconnected with short stubs on the layers it
served.  Nothing else is touched (no net is ripped up).  Run on a SCRATCH project copy.

    python3 rb03r_nudge.py --pcb in.kicad_pcb --out out.kicad_pcb [--log log.json] [--radius 2.0]
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
from rb02_sexpr import parse  # noqa: E402

GAP = RP.GAP
STAGE = [0, 0]
CAP_SPI = 2.0
CAP_GND = 4.0
NM = 1e6


def pads_touching(b, x, y, rad):
    pos = pcbnew.VECTOR2I(int(round(x * NM)), int(round(y * NM)))
    out = []
    for fp in b.GetFootprints():
        for p in fp.Pads():
            if p.GetAttribute() != pcbnew.PAD_ATTRIB_PTH and p.GetNetname() and p.HitTest(pos, int(rad * NM)):
                out.append((fp.GetReference(), p.GetNumber()))
    return out


def remove_via(r, net, x, y):
    r.vias = [v for v in r.vias if not (v[0] == net and abs(v[1] - x) < 1e-6 and abs(v[2] - y) < 1e-6)]
    for L in r.copper:
        r.copper[L] = [c for c in r.copper[L] if not (c[5] == "via" and c[4] == net and abs((c[0] + c[2]) / 2 - x) < 1e-6 and abs((c[1] + c[3]) / 2 - y) < 1e-6)]


def attempt(r, b, net, x, y, radius, max_ok=6):
    cl = RT.klass(net)
    pads = r.nets_by_name.get(net, [])
    if net == "GND" and not pads:                      # route_all skips GND: build the pad table on demand
        pads = []
        for fp in b.GetFootprints():
            for p in fp.Pads():
                if p.GetNetname() == "GND" and p.GetAttribute() != pcbnew.PAD_ATTRIB_PTH:
                    bb = p.GetBoundingBox()
                    pads.append({"obj": p, "ref": fp.GetReference(), "num": p.GetNumber(), "x": p.GetPosition().x / NM, "y": p.GetPosition().y / NM,
                                 "rect": (bb.GetLeft() / NM, bb.GetTop() / NM, bb.GetRight() / NM, bb.GetBottom() / NM),
                                 "layers": [RT.L_F] if p.IsOnLayer(pcbnew.F_Cu) else [RT.L_B], "th": False})
        r.nets_by_name["GND"] = pads
    touching = {f"{a}.{n}" for a, n in pads_touching(b, x, y, RT.VIA_D / 2 + 0.3)} & {f"{p['ref']}.{p['num']}" for p in pads}
    # terminals: segment ends at the via, one per layer / end; pads touched by the annulus
    ends = []
    for (n, L, xa, ya, xb, yb, w) in r.tracks:
        if n != net:
            continue
        for (px, py) in ((xa, ya), (xb, yb)):
            if abs(px - x) < 1e-6 and abs(py - y) < 1e-6:
                ends.append((L, px, py, w))
    snap = RP.snapshot(r)
    remove_via(r, net, x, y)
    widths = [RT.CLASS_W[cl]] + [w for w in (0.25, 0.2, 0.15) if w < RT.CLASS_W[cl]]
    best = None
    ok_count = 0
    nxg = r.nx
    for w in widths:
        tm, vm = r.masks(net, w / 2, RT.CLASS_C[cl], cl == "EMG_HIZ", RT.VIA_D / 2, cl)
        cand = []
        ci, cj = r.cell(x, y)
        rc = int(radius / RT.G) + 1
        for dj in range(-rc, rc + 1):
            for di in range(-rc, rc + 1):
                i, j = ci + di, cj + dj
                if i < 0 or j < 0 or i >= r.nx or j >= r.ny:
                    continue
                d = math.hypot(di, dj) * RT.G
                if d > radius or d < 0.05 or vm[j * nxg + i]:
                    continue
                cand.append((d, i, j, False))
        if net == "GND":                                   # a GND pad may also tie to a GND via that already exists nearby
            for (n2, vx, vy) in r.vias:
                if n2 == "GND" and (abs(vx - x) > 1e-6 or abs(vy - y) > 1e-6):
                    d = math.hypot(vx - x, vy - y)
                    if d <= radius:
                        ii, jj = r.cell(vx, vy)
                        cand.append((d, ii, jj, True))
        cand.sort()
        for (d, i, j, existing) in cand[:150]:
            qx, qy = r.xy(i, j)
            snap2 = RP.snapshot(r)
            try:
                good = True
                length = 0.0
                for pr in pads:
                    if f"{pr['ref']}.{pr['num']}" not in touching:
                        continue
                    lay = pr["layers"] or [RT.L_F]
                    cs = r.pad_cells(pr, tm, lay)
                    src = {c for c in cs if c[0] == RT.L_F}
                    if not src:
                        good = False
                        break
                    tm2 = {L: bytearray(tm[L]) for L in tm}
                    for (L, ii, jj) in cs:
                        tm2[L][jj * nxg + ii] = r.tm_nopad[L][jj * nxg + ii]
                    path = r.search(src, {(RT.L_F, i, j)}, tm2, vm, False, [RT.L_F], max_exp=300000)
                    if path is None:
                        good = False
                        STAGE[0] += 1
                        break
                    r.commit(net, path, w)
                    length += len(path) * RT.G
                    r.finish_stubs(net, [pr], w)
                if good:
                    for (L, px, py, w0) in ends:
                        si, sj = r.cell(px, py)
                        tm2 = {LL: bytearray(tm[LL]) for LL in tm}
                        tm2[L][sj * nxg + si] = 0
                        path = r.search({(L, si, sj)}, {(L, i, j)}, tm2, vm, False, [L], max_exp=300000)
                        if path is None:
                            good = False
                            STAGE[1] += 1
                            break
                        r.commit(net, path, w0)
                        length += len(path) * RT.G
                cap = {"SPI_FAST": CAP_SPI, "CTRL_SLOW": 3.0, "GND": CAP_GND}.get(cl if net != "GND" else "GND", 4.0)
                if good and length > cap:
                    good = False
                if good:
                    cand_result = (length + d, (qx, qy), w, d, existing)
                    ok_count += 1
                    if best is None or cand_result[0] < best[0]:
                        best = cand_result
                    RP.restore(r, snap2)
                    if ok_count >= max_ok:
                        break
                    continue
            finally:
                if not (best and False):
                    pass
            RP.restore(r, snap2)
        if best:
            break
    if best is None:
        RP.restore(r, snap)
        print(f'    diag {net} ({x},{y}) cand={len(cand)} stage={STAGE} ends={[(e[0],e[1],e[2]) for e in ends]} touching={sorted(touching)}')
        return None
    # commit the best candidate (re-run its connection)
    _, (qx, qy), w, d, existing = best
    tm, vm = r.masks(net, w / 2, RT.CLASS_C[cl], cl == "EMG_HIZ", RT.VIA_D / 2, cl)
    i, j = r.cell(qx, qy)
    for pr in pads:
        if f"{pr['ref']}.{pr['num']}" not in touching:
            continue
        lay = pr["layers"] or [RT.L_F]
        cs = r.pad_cells(pr, tm, lay)
        src = {c for c in cs if c[0] == RT.L_F}
        tm2 = {L: bytearray(tm[L]) for L in tm}
        for (L, ii, jj) in cs:
            tm2[L][jj * nxg + ii] = r.tm_nopad[L][jj * nxg + ii]
        path = r.search(src, {(RT.L_F, i, j)}, tm2, vm, False, [RT.L_F], max_exp=300000)
        r.commit(net, path, w)
        r.finish_stubs(net, [pr], w)
    for (L, px, py, w0) in ends:
        si, sj = r.cell(px, py)
        tm2 = {LL: bytearray(tm[LL]) for LL in tm}
        tm2[L][sj * nxg + si] = 0
        path = r.search({(L, si, sj)}, {(L, i, j)}, tm2, vm, False, [L], max_exp=300000)
        r.commit(net, path, w0)
    if not existing:
        r.add_via(net, qx, qy)
    return {"net": net, "from": [x, y], "to": [qx, qy], "moved_mm": round(d, 2), "length_mm": round(best[0], 2), "w": w, "existing_via": existing, "pads": sorted(touching)}


def prune_gnd_spurs(r, b):
    """per layer, GND track components that touch fewer than two anchors (SMD pad, via) are leftovers of a removed via: the
    In1 plane serves GND, so they are dropped"""
    pads = [p for fp in b.GetFootprints() for p in fp.Pads() if p.GetNetname() == "GND"]
    removed = 0
    for L in (RT.L_F, RT.L_B, RT.L_I2):
        segs = [t for t in r.tracks if t[0] == "GND" and t[1] == L]
        if not segs:
            continue
        parent = list(range(len(segs)))

        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        key = lambda x, y: (round(x, 4), round(y, 4))  # noqa: E731
        at = {}
        for i, t in enumerate(segs):
            for k in (key(t[2], t[3]), key(t[4], t[5])):
                if k in at:
                    parent[find(i)] = find(at[k])
                else:
                    at[k] = i
        anchors = {}
        for i, t in enumerate(segs):
            for (x, y) in ((t[2], t[3]), (t[4], t[5])):
                hit = None
                for (n, vx, vy) in r.vias:
                    if n == "GND" and abs(vx - x) < 1e-6 and abs(vy - y) < 1e-6:
                        hit = ("via", round(vx, 3), round(vy, 3))
                        break
                if hit is None:
                    pos = pcbnew.VECTOR2I(int(round(x * NM)), int(round(y * NM)))
                    for p in pads:
                        if p.IsOnLayer({RT.L_F: pcbnew.F_Cu, RT.L_B: pcbnew.B_Cu, RT.L_I2: pcbnew.In2_Cu}[L]) and p.HitTest(pos):
                            hit = ("pad", p.GetParentFootprint().GetReference(), p.GetNumber())
                            break
                if hit:
                    anchors.setdefault(find(i), set()).add(hit)
        dead = {find(i) for i in range(len(segs))} - {c for c, a_ in anchors.items() if len(a_) >= 2}
        for i, t in enumerate(segs):
            if find(i) in dead:
                r.tracks.remove(t)
                removed += 1
    # orphan GND vias: no incident track and not inside an SMD pad
    for (n, vx, vy) in list(r.vias):
        if n != "GND":
            continue
        if any((abs(t[2] - vx) < 1e-6 and abs(t[3] - vy) < 1e-6) or (abs(t[4] - vx) < 1e-6 and abs(t[5] - vy) < 1e-6) for t in r.tracks if t[0] == "GND"):
            continue
        pos = pcbnew.VECTOR2I(int(round(vx * NM)), int(round(vy * NM)))
        if any(p.HitTest(pos, int(RT.VIA_D / 2 * NM)) for p in pads):
            continue
        r.vias.remove((n, vx, vy))
        for L in r.copper:
            r.copper[L] = [c for c in r.copper[L] if not (c[5] == "via" and c[4] == "GND" and abs((c[0] + c[2]) / 2 - vx) < 1e-6 and abs((c[1] + c[3]) / 2 - vy) < 1e-6)]
        removed += 1
    for L in r.copper:
        r.copper[L] = [c for c in r.copper[L] if not (c[5] == "track" and c[4] == "GND")]
    for t in r.tracks:
        if t[0] == "GND":
            w = t[6]
            r.copper[t[1]].append((min(t[2], t[4]) - w / 2, min(t[3], t[5]) - w / 2, max(t[2], t[4]) + w / 2, max(t[3], t[5]) + w / 2, "GND", "track"))
    return removed


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pcb", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--log", type=Path)
    ap.add_argument("--radius", type=float, default=2.0)
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--drc", type=Path, help="also relocate vias that appear in clearance violations of this DRC json")
    ap.add_argument("--hiz-snap", type=float, default=0.0, help="extra hi-Z margin in the masks (router uses 0.09/0.05 for off-grid stubs)")
    ap.add_argument("--via-audit", type=Path, help="also relocate vias the geometric via audit classes FAIL (needs a 0.40 mm own-pad gap)")
    ap.add_argument("--gnd-cap", type=float, default=4.0, help="max stub length (mm) for a relocated GND tie")
    ap.add_argument("--spi-cap", type=float, default=2.0, help="max added stub length for a relocated SPI via (mm)")
    ap.add_argument("--mask-improve", type=float, default=None, metavar="WEB",
                    help="also relocate vias whose annulus is closer than WEB mm (JLC: 0.09) to a pad's solder opening; target centre-to-copper = 0.30 + WEB + 0.01")
    ap.add_argument("--slack", type=float, default=0.03)
    a = ap.parse_args(argv)
    global CAP_SPI, CAP_GND
    CAP_SPI = a.spi_cap
    CAP_GND = a.gnd_cap
    root = parse(a.pcb.read_text())
    b = pcbnew.LoadBoard(str(safe_pcb(a.pcb)))
    r = RT.Router(b)
    r.slack = a.slack
    r.hiz_snap, r.hiz_snap_pad = a.hiz_snap, a.hiz_snap
    r.own_pad_via_gap = GAP
    r.relax_via_in_pad = False
    r.gnd_rects = [(x0, y0, x1, y1) for (x0, y0, x1, y1, n, k) in r.copper[RT.L_F] if n == "GND" and k == "pad"]
    r.route_all(only={"__none__"})
    RP.load_state(r, root)
    log = {"moved": [], "failed": []}
    for rnd in range(a.rounds):
        bad = RP.offenders(b, r)
        if a.drc:
            d = json.load(open(a.drc))
            for v in d["violations"]:
                if v["type"] not in ("clearance", "hole_clearance"):
                    continue
                for it in v["items"]:
                    if it["description"].startswith("Via ["):
                        px, py = it["pos"]["x"], it["pos"]["y"]
                        for (n, vx, vy) in r.vias:
                            if abs(vx - px) < 0.06 and abs(vy - py) < 0.06 and not any(abs(vx - bx) < 1e-6 and abs(vy - by) < 1e-6 for (_, bx, by, _) in bad):
                                bad.append((n, vx, vy, "drc"))
        if a.via_audit:
            va = json.load(open(a.via_audit))
            for rec in va["records"]:
                if rec["class"].startswith("FAIL"):
                    vx, vy = rec["via"]
                    if not any(abs(vx - bx) < 1e-6 and abs(vy - by) < 1e-6 for (_, bx, by, _) in bad):
                        bad.append((rec["via_net"], vx, vy, rec["pad"]))
        mask_items = {}
        if a.mask_improve is not None:
            va = json.load(open(a.via_audit)) if a.via_audit else None
            if va is None:
                raise SystemExit("--mask-improve needs --via-audit")
            for rec in sorted(va["records"], key=lambda q: q["annulus_to_opening_mm"]):
                if rec["annulus_to_opening_mm"] < a.mask_improve and not rec["class"].startswith("FAIL"):
                    vx, vy = rec["via"]
                    key = (round(vx, 3), round(vy, 3))
                    if key in mask_items:
                        continue
                    mask_items[key] = 0.30 + a.mask_improve + 0.01 + (0.05 if rec["pad"].startswith("U1.") else 0.0)
                    if not any(abs(vx - bx) < 1e-6 and abs(vy - by) < 1e-6 for (_, bx, by, _) in bad):
                        bad.append((rec["via_net"], vx, vy, rec["pad"]))
        print(f"round {rnd}: {len(bad)} offending vias", flush=True)
        if not bad:
            break
        progress = False
        for (net, x, y, pad) in bad:
            if not any(v[0] == net and abs(v[1] - x) < 1e-6 and abs(v[2] - y) < 1e-6 for v in r.vias):
                continue
            r.own_pad_via_gap = mask_items.get((round(x, 3), round(y, 3)), 0.40 if a.via_audit and pad.split('.')[0] == 'U1' else GAP)
            res = attempt(r, b, net, x, y, a.radius)
            r.own_pad_via_gap = GAP
            if res:
                print(f"  moved {net} {pad} ({x:.1f},{y:.1f}) -> ({res['to'][0]:.1f},{res['to'][1]:.1f}) {res['moved_mm']} mm", flush=True)
                log["moved"].append(res)
                progress = True
            else:
                print(f"  FAILED {net} {pad} ({x:.1f},{y:.1f})", flush=True)
        if not progress:
            break
    log["gnd_spurs_pruned"] = prune_gnd_spurs(r, b)
    print('GND spur segments pruned:', log['gnd_spurs_pruned'])
    log["remaining"] = [f"{n}:{p}@({x:.2f},{y:.2f})" for n, x, y, p in RP.offenders(b, r)]
    RP.write_board(root, r, a.out)
    if a.log:
        a.log.write_text(json.dumps(log, indent=1))
    print("remaining offenders:", len(log["remaining"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
