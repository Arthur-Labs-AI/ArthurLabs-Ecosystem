#!/usr/bin/env python3
"""RB-04: independent via / solder-mask audit against the published JLCPCB figures (separate implementation from rb03r_via_audit.py).

For every via and every pad opening (pad copper + mask expansion, polygons from pcbnew's pad shape export) it computes exact
via-centre -> opening-edge distances with its own point/segment code, then
  * classes the 201 vias (clear / class 2 / class 3 / hole-touch / via-in-pad) with the same definitions as RB-03S,
  * checks the 0.10 mm mask bridge between adjacent openings, the 0.09 mm opening-to-neighbouring-track clearance,
  * checks via hole to track (0.20), via hole to hole (0.20), PTH hole to track (0.28),
  * for every class-2/3 via computes the pad shift that would clear it and the courtyard slack in that direction.
    python3 rb04_mask.py --pcb board.kicad_pcb --out mask.json [--csv mask.csv]
"""
import argparse, csv, json, math, sys
from pathlib import Path
import pcbnew
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb03r_safe import safe_pcb
from rb02_sexpr import first, kids, parse

NM = 1e6


def pseg(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def inside(poly, x, y):
    c = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]; xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            c = not c
        j = i
    return c


def pdist(poly, x, y):
    return min(pseg(x, y, *poly[i], *poly[(i + 1) % len(poly)]) for i in range(len(poly)))


def sdist_poly_seg(poly, s):
    def seg_seg(a, b):
        def cr(o, p, q):
            return (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
        p1, p2, p3, p4 = (a[0], a[1]), (a[2], a[3]), (b[0], b[1]), (b[2], b[3])
        d1, d2, d3, d4 = cr(p3, p4, p1), cr(p3, p4, p2), cr(p1, p2, p3), cr(p1, p2, p4)
        if d1 * d2 < 0 and d3 * d4 < 0:
            return 0.0
        return min(pseg(a[0], a[1], *b), pseg(a[2], a[3], *b), pseg(b[0], b[1], *a), pseg(b[2], b[3], *a))
    return min(seg_seg(s, (*poly[i], *poly[(i + 1) % len(poly)])) for i in range(len(poly)))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pcb", type=Path, required=True); ap.add_argument("--out", type=Path, required=True); ap.add_argument("--csv", type=Path)
    a = ap.parse_args(argv)
    root = parse(a.pcb.read_text())
    b = pcbnew.LoadBoard(str(safe_pcb(a.pcb)))
    glob = (b.GetDesignSettings().m_SolderMaskExpansion or 0) / NM
    # courtyards (front)
    crt = {}
    for fp in b.GetFootprints():
        bb = fp.GetCourtyard(pcbnew.F_CrtYd).BBox()
        if bb.GetWidth() > 0:
            crt[fp.GetReference()] = (bb.GetLeft() / NM, bb.GetTop() / NM, bb.GetRight() / NM, bb.GetBottom() / NM)
    openings = []
    ptholes = []
    for fp in b.GetFootprints():
        for p in fp.Pads():
            if p.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH and not p.IsOnLayer(pcbnew.F_Mask):
                continue
            side = "F.Cu" if p.IsOnLayer(pcbnew.F_Cu) else ("B.Cu" if p.IsOnLayer(pcbnew.B_Cu) else None)
            if side is None:
                continue
            ml = pcbnew.F_Mask if side == "F.Cu" else pcbnew.B_Mask
            if not p.IsOnLayer(ml):
                continue
            local = p.GetLocalSolderMaskMargin() / NM if p.GetLocalSolderMaskMargin() else 0.0
            exp = local + (glob if not p.GetLocalSolderMaskMargin() else 0.0)
            ps = pcbnew.SHAPE_POLY_SET()
            lay = pcbnew.F_Cu if side == "F.Cu" else pcbnew.B_Cu
            p.TransformShapeToPolygon(ps, lay, int(round(exp * NM)), 5000, pcbnew.ERROR_INSIDE)
            if not ps.OutlineCount():
                continue
            o = ps.Outline(0)
            poly = [(o.CPoint(i).x / NM, o.CPoint(i).y / NM) for i in range(o.PointCount())]
            pos = p.GetPosition()
            openings.append({"id": f"{fp.GetReference()}.{p.GetNumber()}", "ref": fp.GetReference(), "net": p.GetNetname(), "side": side, "poly": poly, "x": pos.x / NM, "y": pos.y / NM,
                             "exp": exp, "attr": p.GetAttribute()})
            if p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH:
                ptholes.append((f"{fp.GetReference()}.{p.GetNumber()}", pos.x / NM, pos.y / NM, max(p.GetDrillSize().x, p.GetDrillSize().y) / NM, p.GetNetname()))
    vias = [{"x": float(first(v, "at")[1]), "y": float(first(v, "at")[2]), "net": str(first(v, "net")[1]), "size": float(first(v, "size")[1]), "drill": float(first(v, "drill")[1])}
            for v in kids(root, "via")]
    tracks = [{"net": str(first(s, "net")[1]), "layer": str(first(s, "layer")[1]), "seg": (float(first(s, "start")[1]), float(first(s, "start")[2]), float(first(s, "end")[1]), float(first(s, "end")[2])),
               "w": float(first(s, "width")[1])} for s in kids(root, "segment")]
    rows = []
    for v in vias:
        r, h = v["size"] / 2, v["drill"] / 2
        recs = []
        for o in openings:
            if abs(o["x"] - v["x"]) > 3 or abs(o["y"] - v["y"]) > 3:
                continue
            ins = inside(o["poly"], v["x"], v["y"])
            d = pdist(o["poly"], v["x"], v["y"])
            sd = -d if ins else d                       # signed: negative = via centre inside the opening
            if sd - r > 0.6:
                continue
            recs.append({"pad": o["id"], "same_net": o["net"] == v["net"], "centre_to_opening": round(sd, 4), "hole_to_opening": round(sd - h, 4), "annulus_to_opening": round(sd - r, 4),
                         "centre_in_opening": ins, "opening": o})
        rows.append({"via": v, "recs": recs})
    # classification per via (worst record)
    def cls(recs):
        if not recs:
            return 1, "no pad opening within 0.6 mm of the annulus"
        hole = min(r["hole_to_opening"] for r in recs)
        ann = min(r["annulus_to_opening"] for r in recs)
        cin = any(r["centre_in_opening"] for r in recs)
        if cin:
            return 4, "via-in-pad"
        if hole < 0.10:
            return 4, "hole closer than 0.10 mm to an opening"
        if ann >= 0.09:
            return 1, "annulus >= 0.09 mm from every opening"
        if ann >= 0:
            return 2, "annulus outside the opening, dam 0.00-0.09 mm"
        return 3, "annulus overlaps an opening"
    summary = {1: 0, 2: 0, 3: 0, 4: 0}
    out_rows = []
    for rw in rows:
        c, why = cls(rw["recs"])
        summary[c] += 1
        rw["class"], rw["why"] = c, why
    # courtyard slack / shift needed for class 2/3
    for rw in rows:
        if rw["class"] not in (2, 3):
            continue
        v = rw["via"]
        worst = min(rw["recs"], key=lambda r: r["annulus_to_opening"])
        need = 0.09 - worst["annulus_to_opening"] + 0.01
        ref = worst["pad"].split(".")[0]
        ux, uy = worst["opening"]["x"] - v["x"], worst["opening"]["y"] - v["y"]
        nrm = math.hypot(ux, uy) or 1.0
        ux, uy = ux / nrm, uy / nrm
        if abs(ux) >= abs(uy):
            axis, sgn = "x", (1 if ux > 0 else -1)
        else:
            axis, sgn = "y", (1 if uy > 0 else -1)
        comp = max(abs(ux) if axis == "x" else abs(uy), 0.3)
        shift = need / comp
        c0 = crt.get(ref)
        slack = None
        if c0:
            slack = 1e9
            for r2, c in crt.items():
                if r2 == ref:
                    continue
                if axis == "x":
                    if c[1] < c0[3] and c[3] > c0[1]:
                        gap = (c[0] - c0[2]) if sgn > 0 else (c0[0] - c[2])
                        if gap > -1e-6:
                            slack = min(slack, gap)
                else:
                    if c[0] < c0[2] and c[2] > c0[0]:
                        gap = (c[1] - c0[3]) if sgn > 0 else (c0[1] - c[3])
                        if gap > -1e-6:
                            slack = min(slack, gap)
            if slack == 1e9:
                slack = None
        rw["fix"] = {"pad": worst["pad"], "move_part": ref, "axis": axis, "direction": sgn, "shift_needed_mm": round(shift, 3), "courtyard_slack_mm": None if slack is None else round(slack, 3),
                     "feasible_without_moving_neighbours": (slack is None) or slack >= shift}
    # mask bridge between adjacent openings (different nets) and opening to neighbouring tracks (0.09)
    bridge = []
    for i in range(len(openings)):
        for j in range(i + 1, len(openings)):
            p, q = openings[i], openings[j]
            if p["side"] != q["side"] or abs(p["x"] - q["x"]) > 6 or abs(p["y"] - q["y"]) > 6:
                continue
            d = min(pdist(q["poly"], *pt) for pt in p["poly"])
            d2 = min(pdist(p["poly"], *pt) for pt in q["poly"])
            d = min(d, d2)
            if d < 0.10 and p["ref"] != q["ref"]:
                bridge.append((round(d, 3), p["id"], q["id"]))
            elif d < 0.10:
                bridge.append((round(d, 3), p["id"], q["id"], "same footprint"))
    near_trk = []
    for o in openings:
        for t in tracks:
            if t["net"] == o["net"]:
                continue
            if (t["layer"] != o["side"]):
                continue
            s = t["seg"]
            if min(s[0], s[2]) - 1 > o["x"] or max(s[0], s[2]) + 1 < o["x"] or min(s[1], s[3]) - 1 > o["y"] or max(s[1], s[3]) + 1 < o["y"]:
                continue
            d = sdist_poly_seg(o["poly"], s) - t["w"] / 2
            if d < 0.09:
                near_trk.append((round(d, 3), o["id"], t["net"]))
    # via hole to track / hole to hole / PTH to track
    h2t = []
    for v in vias:
        for t in tracks:
            if t["net"] == v["net"]:
                continue
            s = t["seg"]
            d = pseg(v["x"], v["y"], *s) - t["w"] / 2 - v["drill"] / 2
            if d < 0.2:
                h2t.append((round(d, 3), v["net"], t["net"], (v["x"], v["y"])))
    hh = []
    for i in range(len(vias)):
        for j in range(i + 1, len(vias)):
            d = math.hypot(vias[i]["x"] - vias[j]["x"], vias[i]["y"] - vias[j]["y"]) - vias[i]["drill"] / 2 - vias[j]["drill"] / 2
            if d < 0.2:
                hh.append((round(d, 3), (vias[i]["x"], vias[i]["y"]), (vias[j]["x"], vias[j]["y"])))
    pth = []
    for (pid, x, y, dr, pnet) in ptholes:
        m = 1e9
        who = None
        for t in tracks:
            if t["net"] == pnet:
                continue
            d = pseg(x, y, *t["seg"]) - t["w"] / 2 - dr / 2
            if d < m:
                m, who = d, t["net"]
        for v in vias:
            if v["net"] == pnet:
                continue
            d = math.hypot(x - v["x"], y - v["y"]) - v["size"] / 2 - dr / 2
            if d < m:
                m, who = d, "via " + v["net"]
        pth.append((pid, dr, round(m, 3), who))
    res = {"via_count": len(vias), "mask_expansion_global_mm": glob, "class_counts": summary,
           "min_hole_to_opening": min((r["hole_to_opening"] for rw in rows for r in rw["recs"]), default=None),
           "max_annulus_overlap_mm": min((r["annulus_to_opening"] for rw in rows for r in rw["recs"]), default=None),
           "bridge_below_0.10": sorted(bridge)[:20], "opening_to_foreign_track_below_0.09": sorted(near_trk)[:20],
           "via_hole_to_foreign_track_below_0.20": sorted(h2t)[:10], "via_hole_to_hole_below_0.20": sorted(hh)[:10], "pth_holes": pth}
    res["vias"] = [{"x": rw["via"]["x"], "y": rw["via"]["y"], "net": rw["via"]["net"], "class": rw["class"], "why": rw["why"],
                    "records": [{k: r[k] for k in ("pad", "same_net", "centre_to_opening", "hole_to_opening", "annulus_to_opening")} for r in rw["recs"]], "fix": rw.get("fix")}
                   for rw in rows]
    a.out.write_text(json.dumps(res, indent=1, default=list))
    if a.csv:
        with a.csv.open("w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["x", "y", "net", "class", "why", "pad", "same_net", "centre_to_opening", "hole_to_opening", "annulus_to_opening", "shift_needed_mm", "courtyard_slack_mm", "feasible"])
            for v in res["vias"]:
                if v["class"] in (2, 3, 4):
                    for r in v["records"]:
                        fx = v["fix"] or {}
                        w.writerow([v["x"], v["y"], v["net"], v["class"], v["why"], r["pad"], r["same_net"], r["centre_to_opening"], r["hole_to_opening"], r["annulus_to_opening"],
                                    fx.get("shift_needed_mm"), fx.get("courtyard_slack_mm"), fx.get("feasible_without_moving_neighbours")])
    print("class counts:", summary, "min hole->opening", res["min_hole_to_opening"], "max annulus overlap", res["max_annulus_overlap_mm"])
    print("bridges <0.10:", res["bridge_below_0.10"][:6])
    print("openings < 0.09 to foreign track:", res["opening_to_foreign_track_below_0.09"][:6])
    print("via hole->track <0.2:", res["via_hole_to_foreign_track_below_0.20"][:4], "hole-hole <0.2:", res["via_hole_to_hole_below_0.20"][:4])
    print("PTH:", pth)
    return 0


if __name__ == "__main__":
    sys.exit(main())
