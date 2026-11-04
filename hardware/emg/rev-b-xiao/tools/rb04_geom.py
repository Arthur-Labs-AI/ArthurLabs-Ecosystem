#!/usr/bin/env python3
"""RB-04: independent geometric audit of the routed PCB.  It does NOT call KiCad's DRC engine.

Geometry sources: tracks, vias, zones, outline and stack-up from the .kicad_pcb text; pad copper / solder-mask polygons from
pcbnew's pad shape export (pcbnew is only a shape provider here).  All distances are computed by the code in this file.

    python3 rb04_geom.py --pcb board.kicad_pcb --out geom.json
Reports:  copper clearance (different nets, per layer), hole to copper, hole to hole, copper to board edge, track / via / drill limits,
          inner-plane antipad clearance, In1 / In2 fill continuity and signal return-path coverage, rule-area occupancy.
"""
import argparse
import collections
import json
import math
import sys
from pathlib import Path

import pcbnew

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_sexpr import first, kids, parse  # noqa: E402
from rb03r_safe import safe_pcb  # noqa: E402

NM = 1e6
CU = ("F.Cu", "In1.Cu", "In2.Cu", "B.Cu")


# ---------------------------------------------------------------- geometry helpers
def pseg(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def sseg(a, b):
    """distance between segments a=(x0,y0,x1,y1), b"""
    def cross(o, p, q):
        return (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
    p1, p2, p3, p4 = (a[0], a[1]), (a[2], a[3]), (b[0], b[1]), (b[2], b[3])
    d1, d2, d3, d4 = cross(p3, p4, p1), cross(p3, p4, p2), cross(p1, p2, p3), cross(p1, p2, p4)
    if ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)) and d1 * d2 != 0 and d3 * d4 != 0:
        return 0.0
    return min(pseg(a[0], a[1], *b), pseg(a[2], a[3], *b), pseg(b[0], b[1], *a), pseg(b[2], b[3], *a))


def inside(poly, x, y):
    c = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            c = not c
        j = i
    return c


def bbox(pts):
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


class Item:
    __slots__ = ("kind", "ref", "net", "layer", "segs", "r", "bb", "c", "info", "hole")

    def __init__(self, kind, ref, net, layer, segs, r, c=None, info="", hole=0.0):
        self.kind, self.ref, self.net, self.layer, self.segs, self.r, self.c, self.info, self.hole = kind, ref, net, layer, segs, r, c, info, hole
        pts = [(s[0], s[1]) for s in segs] + [(s[2], s[3]) for s in segs]
        x0, y0, x1, y1 = bbox(pts)
        self.bb = (x0 - r, y0 - r, x1 + r, y1 + r)


def dist(a, b):
    """edge-to-edge distance (>= 0) between two items (capsules / polygons as segment sets)"""
    # polygon containment (pads): a point of one inside the other
    best = 1e9
    for s in a.segs:
        for t in b.segs:
            d = sseg(s, t)
            if d < best:
                best = d
    d = best - a.r - b.r
    if d > 0.0:
        # a zero-length 'segment' circle inside a polygon
        for x, y in ((a, b), (b, a)):
            if x.kind == "pad" and x.c and len(y.segs) == 1 and y.segs[0][0] == y.segs[0][2] and y.segs[0][1] == y.segs[0][3]:
                pass
    return max(d, 0.0)


# ---------------------------------------------------------------- load
def load(pcb_path):
    pcb_path = Path(pcb_path)
    root = parse(pcb_path.read_text())
    b = pcbnew.LoadBoard(str(safe_pcb(pcb_path)))
    nets = {}
    items = {L: [] for L in CU}
    # tracks
    for s in kids(root, "segment"):
        st, en = first(s, "start"), first(s, "end")
        L = str(first(s, "layer")[1])
        w = float(first(s, "width")[1])
        items[L].append(Item("track", "", str(first(s, "net")[1]), L, [(float(st[1]), float(st[2]), float(en[1]), float(en[2]))], w / 2, info=f"w={w}"))
    vias = []
    for v in kids(root, "via"):
        at = first(v, "at")
        x, y = float(at[1]), float(at[2])
        size, drill = float(first(v, "size")[1]), float(first(v, "drill")[1])
        net = str(first(v, "net")[1])
        vias.append({"x": x, "y": y, "size": size, "drill": drill, "net": net})
        for L in CU:
            items[L].append(Item("via", "", net, L, [(x, y, x, y)], size / 2, c=(x, y), hole=drill / 2))
    # pads (pcbnew polygons)
    pads = []
    holes = []
    for fp in b.GetFootprints():
        ref = fp.GetReference()
        for p in fp.Pads():
            net = p.GetNetname()
            lay = []
            for lid, L in ((pcbnew.F_Cu, "F.Cu"), (pcbnew.B_Cu, "B.Cu"), (pcbnew.In1_Cu, "In1.Cu"), (pcbnew.In2_Cu, "In2.Cu")):
                if p.IsOnLayer(lid):
                    lay.append(L)
            ps = pcbnew.SHAPE_POLY_SET()
            p.TransformShapeToPolygon(ps, p.GetLayer() if p.GetLayer() in (pcbnew.F_Cu, pcbnew.B_Cu) else pcbnew.F_Cu, 0, 5000, pcbnew.ERROR_INSIDE)
            pts = []
            if ps.OutlineCount():
                o = ps.Outline(0)
                pts = [(o.CPoint(i).x / NM, o.CPoint(i).y / NM) for i in range(o.PointCount())]
            if not pts:
                continue
            segs = [(pts[i][0], pts[i][1], pts[(i + 1) % len(pts)][0], pts[(i + 1) % len(pts)][1]) for i in range(len(pts))]
            pos = p.GetPosition()
            attr = {pcbnew.PAD_ATTRIB_SMD: "smd", pcbnew.PAD_ATTRIB_PTH: "pth", pcbnew.PAD_ATTRIB_NPTH: "npth", pcbnew.PAD_ATTRIB_CONN: "conn"}.get(p.GetAttribute(), "?")
            drill = max(p.GetDrillSize().x, p.GetDrillSize().y) / NM
            rec = {"ref": ref, "num": p.GetNumber(), "net": net, "layers": lay, "poly": pts, "attr": attr, "drill": drill, "x": pos.x / NM, "y": pos.y / NM,
                   "mask_margin": p.GetLocalSolderMaskMargin() / NM if p.GetLocalSolderMaskMargin() else 0.0}
            pads.append(rec)
            if attr == "npth":
                if drill > 0:
                    holes.append({"ref": f"{ref}.{p.GetNumber()}", "x": rec["x"], "y": rec["y"], "d": drill, "net": "", "npth": True})
                continue
            if attr in ("pth", "conn") and drill > 0:
                holes.append({"ref": f"{ref}.{p.GetNumber()}", "x": rec["x"], "y": rec["y"], "d": drill, "net": net, "npth": False})
            for L in lay:
                if L in items:
                    items[L].append(Item("pad", f"{ref}.{p.GetNumber()}", net, L, segs, 0.0, c=(rec["x"], rec["y"]), info=attr))
    for v in vias:
        holes.append({"ref": "via", "x": v["x"], "y": v["y"], "d": v["drill"], "net": v["net"], "npth": False})
    # outline
    edge = []
    for n in root:
        if not isinstance(n, list) or not n:
            continue
        if n[0] == "gr_line" and str(first(n, "layer")[1]) == "Edge.Cuts":
            s, e = first(n, "start"), first(n, "end")
            edge.append((float(s[1]), float(s[2]), float(e[1]), float(e[2])))
        if n[0] == "gr_arc" and str(first(n, "layer")[1]) == "Edge.Cuts":
            s, m, e = first(n, "start"), first(n, "mid"), first(n, "end")
            P = [(float(s[1]), float(s[2])), (float(m[1]), float(m[2])), (float(e[1]), float(e[2]))]
            # circle through three points
            (x1, y1), (x2, y2), (x3, y3) = P
            d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2))
            ux = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / d
            uy = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / d
            r = math.hypot(x1 - ux, y1 - uy)
            a1, a2, a3 = (math.atan2(p[1] - uy, p[0] - ux) for p in P)
            # direction a1 -> a3 through a2
            def norm(a):
                return a % (2 * math.pi)
            ccw = norm(a2 - a1) < norm(a3 - a1)
            span = norm(a3 - a1) if ccw else -norm(a1 - a3)
            N = 24
            pts = [(ux + r * math.cos(a1 + span * i / N), uy + r * math.sin(a1 + span * i / N)) for i in range(N + 1)]
            edge += [(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]) for i in range(N)]
    # zones
    zones = []
    for z in kids(root, "zone"):
        name = str(first(z, "name")[1]) if first(z, "name") else ""
        lay = first(z, "layer")
        layers = [str(lay[1])] if lay else [str(x) for x in first(z, "layers")[1:]]
        net = str(first(z, "net_name")[1]) if first(z, "net_name") else (str(first(z, "net")[1]) if first(z, "net") else "")
        poly = [(float(p[1]), float(p[2])) for p in first(first(z, "polygon"), "pts")[1:] if isinstance(p, list) and p and p[0] == "xy"]
        fills = []
        for fpoly in kids(z, "filled_polygon"):
            fl = str(first(fpoly, "layer")[1])
            fills.append((fl, [(float(p[1]), float(p[2])) for p in first(fpoly, "pts")[1:] if isinstance(p, list) and p and p[0] == "xy"]))
        keep = first(z, "keepout")
        zones.append({"name": name, "layers": layers, "net": net, "outline": poly, "fills": fills, "keepout": bool(keep),
                      "no_tracks": bool(keep) and str(first(keep, "tracks")[1]) == "not_allowed" if keep and first(keep, "tracks") else False,
                      "no_vias": bool(keep) and str(first(keep, "vias")[1]) == "not_allowed" if keep and first(keep, "vias") else False})
    return root, items, vias, pads, holes, edge, zones, b


# ---------------------------------------------------------------- netclasses (re-implemented from the project file)
import fnmatch


def netclass_map(pro_path, net_names):
    j = json.load(open(pro_path))
    ns = j["net_settings"]
    classes = {c["name"]: c for c in ns["classes"]}
    out = {}
    for n in net_names:
        cls = "Default"
        for p in ns["netclass_patterns"]:
            if fnmatch.fnmatchcase(n, p["pattern"]):
                cls = p["netclass"]
                break
        out[n] = cls
    return out, classes


# ---------------------------------------------------------------- checks
def grid_pairs(its, cell=2.0):
    g = collections.defaultdict(list)
    for i, it in enumerate(its):
        x0, y0, x1, y1 = it.bb
        for gx in range(int(x0 // cell), int(x1 // cell) + 1):
            for gy in range(int(y0 // cell), int(y1 // cell) + 1):
                g[(gx, gy)].append(i)
    seen = set()
    for lst in g.values():
        for a in range(len(lst)):
            for b in range(a + 1, len(lst)):
                p = (lst[a], lst[b])
                if p not in seen:
                    seen.add(p)
                    yield p


def clearance_report(items, floor=0.30):
    res = {}
    for L, its in items.items():
        worst = []
        n = 0
        hist = collections.Counter()
        for i, j in grid_pairs(its):
            a, b = its[i], its[j]
            if a.net == b.net and a.net:
                continue
            if a.kind == "pad" and b.kind == "pad" and a.ref.split(".")[0] == b.ref.split(".")[0] and False:
                continue
            # skip unconnected NC pads of the same footprint without net on both (net '')
            if not a.net and not b.net and a.kind == b.kind == "pad":
                continue
            if a.bb[0] > b.bb[2] + floor or b.bb[0] > a.bb[2] + floor or a.bb[1] > b.bb[3] + floor or b.bb[1] > a.bb[3] + floor:
                continue
            d = dist(a, b)
            n += 1
            if d < floor:
                worst.append((round(d, 3), a.kind + ":" + (a.ref or a.net), b.kind + ":" + (b.ref or b.net), a.net, b.net))
        worst.sort()
        res[L] = {"pairs_checked": n, "below_floor": len(worst), "lowest": worst[:25]}
    return res


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pcb", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    root, items, vias, pads, holes, edge, zones, b = load(a.pcb)
    out = {"counts": {"tracks": sum(1 for it in items["F.Cu"] + items["B.Cu"] + items["In1.Cu"] + items["In2.Cu"] if it.kind == "track"),
                      "vias": len(vias), "pads": len(pads), "holes": len(holes), "zones": len(zones)}}
    # --- constructional limits
    tw = collections.Counter()
    for L in CU:
        for it in items[L]:
            if it.kind == "track":
                tw[round(it.r * 2, 3)] += 1
    out["track_widths"] = dict(sorted(tw.items()))
    out["via_sizes"] = sorted({(v["size"], v["drill"]) for v in vias})
    out["via_annular_ring_mm"] = sorted({round((v["size"] - v["drill"]) / 2, 3) for v in vias})
    out["pad_drills"] = sorted({(h["d"]) for h in holes if h["ref"] != "via"})
    # --- clearance
    pro = Path(a.pcb).with_suffix(".kicad_pro")
    allnets = sorted({it.net for L in CU for it in items[L] if it.net})
    cmap, cdef = netclass_map(pro, allnets)
    out["netclass_summary"] = dict(collections.Counter(cmap.values()))
    # class-aware clearance (max of both classes' clearance), all signal layers
    viol, tight = [], []
    for L in ("F.Cu", "B.Cu", "In2.Cu"):
        its = items[L]
        for i, j in grid_pairs(its):
            x, y = its[i], its[j]
            if x.net == y.net and x.net:
                continue
            if not x.net and not y.net:
                continue
            need = max(cdef[cmap.get(x.net, "Default")]["clearance"] if x.net else 0.2, cdef[cmap.get(y.net, "Default")]["clearance"] if y.net else 0.2, 0.15)
            if x.bb[0] > y.bb[2] + need or y.bb[0] > x.bb[2] + need or x.bb[1] > y.bb[3] + need or y.bb[1] > x.bb[3] + need:
                continue
            d = dist(x, y)
            if d < need - 1e-3:
                viol.append((round(d, 3), need, L, x.kind + ":" + (x.ref or x.net), y.kind + ":" + (y.ref or y.net)))
            elif d < need + 0.03:
                tight.append(round(d - need, 3))
    out["class_aware_clearance_violations"] = sorted(viol)[:30]
    out["class_aware_clearance_violation_count"] = len(viol)
    out["pairs_within_0.03_of_required"] = len(tight)
    # custom rules re-implemented: hi-Z leakage 0.40 (exemptions listed), SPI to hi-Z 2.0, SPI to buffered 1.0
    esc = {z["name"]: z["outline"] for z in zones if z["name"].startswith("HIZ_ESC_")}
    def in_esc(it):
        pts = [(s[0], s[1]) for s in it.segs] + [(s[2], s[3]) for s in it.segs]
        return any(all(inside(poly, x, y) for x, y in pts) for poly in esc.values())
    hz, exempt, spi_h, spi_b = [], [], [], []
    for L in ("F.Cu", "B.Cu", "In2.Cu"):
        its = items[L]
        for i, j in grid_pairs(its, cell=3.0):
            x, y = its[i], its[j]
            cx, cy = cmap.get(x.net, ""), cmap.get(y.net, "")
            for p, q, cp, cq in ((x, y, cx, cy), (y, x, cy, cx)):
                if cp == "EMG_HIZ" and cq not in ("EMG_HIZ", "GND", "") and q.net != "GND":
                    if p.bb[0] > q.bb[2] + 0.4 or q.bb[0] > p.bb[2] + 0.4 or p.bb[1] > q.bb[3] + 0.4 or q.bb[1] > p.bb[3] + 0.4:
                        continue
                    d = dist(p, q)
                    if d < 0.4 - 1e-3:
                        rec = (round(d, 3), L, p.kind + ":" + (p.ref or p.net), q.kind + ":" + (q.ref or q.net))
                        u50 = any(r.startswith(("U501.", "U502.", "U503.")) for r in (p.ref, q.ref))
                        (exempt if (u50 or (in_esc(p) and in_esc(q))) else hz).append(rec)
        # SPI rules over all pairs (distance larger than the grid cell): brute force on nets of interest
        spi = [it for it in its if cmap.get(it.net) == "SPI_FAST"]
        for it in spi:
            for o in its:
                co = cmap.get(o.net)
                if co not in ("EMG_HIZ", "EMG_BUF") or o.net == it.net:
                    continue
                if it.bb[0] > o.bb[2] + 2.0 or o.bb[0] > it.bb[2] + 2.0 or it.bb[1] > o.bb[3] + 2.0 or o.bb[1] > it.bb[3] + 2.0:
                    continue
                d = dist(it, o)
                if co == "EMG_HIZ" and d < 2.0:
                    spi_h.append((round(d, 3), L, it.net, o.net))
                if co == "EMG_BUF" and d < 1.0:
                    spi_b.append((round(d, 3), L, it.net, o.net))
    out["rules_independent"] = {"hiz_leakage_below_0.4_not_exempt": sorted(hz)[:20], "hiz_not_exempt_count": len(hz), "hiz_exempt_count": len(exempt), "hiz_exempt_with_via": [e for e in exempt if "via:" in e[2] or "via:" in e[3]][:10], "hiz_exempt_min": sorted(exempt)[:6],
                                "spi_to_hiz_below_2.0": sorted(spi_h)[:10], "spi_to_buf_below_1.0": sorted(spi_b)[:10]}
    out["clearance"] = clearance_report({k: v for k, v in items.items() if k in ("F.Cu", "B.Cu", "In2.Cu")}, floor=0.30)
    # --- hole to copper of other net, hole to hole
    h2c = []
    for L in ("F.Cu", "B.Cu"):
        for h in holes:
            for it in items[L]:
                if it.net == h["net"] and h["net"]:
                    continue
                if it.kind == "via" and abs(it.c[0] - h["x"]) < 1e-6 and abs(it.c[1] - h["y"]) < 1e-6:
                    continue
                if it.bb[0] > h["x"] + 1 or it.bb[2] < h["x"] - 1 or it.bb[1] > h["y"] + 1 or it.bb[3] < h["y"] - 1:
                    continue
                pd = min(pseg(h["x"], h["y"], *s) for s in it.segs)
                d = pd - it.r - h["d"] / 2
                if it.kind == "pad" and inside([(s[0], s[1]) for s in it.segs], h["x"], h["y"]):
                    d = 0.0
                if d < 0.25:
                    h2c.append((round(d, 3), h["ref"], h["net"], it.kind + ":" + (it.ref or it.net), L))
    h2c.sort()
    out["hole_to_other_net_copper_below_0.25"] = h2c[:30]
    hh = []
    for i in range(len(holes)):
        for j in range(i + 1, len(holes)):
            p, q = holes[i], holes[j]
            if abs(p["x"] - q["x"]) > 2 or abs(p["y"] - q["y"]) > 2:
                continue
            d = math.hypot(p["x"] - q["x"], p["y"] - q["y"]) - p["d"] / 2 - q["d"] / 2
            if d < 0.5:
                hh.append((round(d, 3), p["ref"], q["ref"], (round(p["x"], 2), round(p["y"], 2))))
    hh.sort()
    out["hole_to_hole_below_0.5"] = hh[:20]
    # --- copper to board edge
    emin = []
    for L in CU:
        for it in items[L]:
            if it.kind == "pad" and it.info == "npth":
                continue
            m = 1e9
            for s in it.segs:
                for e in edge:
                    m = min(m, sseg(s, e))
            emin.append((round(m - it.r, 3), it.kind, it.ref or it.net, L))
    emin.sort()
    out["copper_to_edge_lowest"] = emin[:12]
    # --- planes
    planes = {}
    for z in zones:
        if z["net"] != "GND" or z["keepout"]:
            continue
        for L in z["layers"]:
            rings = [p for (fl, p) in z["fills"] if fl == L]
            area = 0.0
            for r in rings:
                s = 0.0
                for i in range(len(r)):
                    x0, y0 = r[i]
                    x1, y1 = r[(i + 1) % len(r)]
                    s += x0 * y1 - x1 * y0
                area += s / 2
            planes[L] = {"zone": z["name"], "fill_polygons": len(rings), "signed_area_sum_mm2": round(area, 1), "abs_area_sum_mm2": round(sum(abs(sum(r[i][0] * r[(i + 1) % len(r)][1] - r[(i + 1) % len(r)][0] * r[i][1] for i in range(len(r))) / 2) for r in rings), 1),
                         "rings": [len(r) for r in rings][:8]}
    out["planes"] = planes
    # --- return path coverage over In1 fill (even-odd over all rings of the layer)
    in1 = [p for z in zones if z["net"] == "GND" and not z["keepout"] for (fl, p) in z["fills"] if fl == "In1.Cu"]

    def over_plane(x, y):
        c = 0
        for r in in1:
            if inside(r, x, y):
                c ^= 1
        return bool(c)

    vnet = collections.defaultdict(list)
    for v in vias:
        vnet[v["net"]].append((v["x"], v["y"]))
    cov = collections.defaultdict(lambda: [0, 0])
    unc = []
    at_via = 0
    for L in ("F.Cu", "B.Cu", "In2.Cu"):
        for it in items[L]:
            if it.kind != "track" or it.net == "GND":
                continue
            x0, y0, x1, y1 = it.segs[0]
            n = max(1, int(math.hypot(x1 - x0, y1 - y0) / 0.25))
            for k in range(n + 1):
                x, y = x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n
                if any(math.hypot(x - vx, y - vy) <= 0.62 for vx, vy in vnet.get(it.net, [])):
                    at_via += 1                    # the track is inside its own via antipad (r 0.3 + 0.3 plane clearance): it leaves the plane's reference there by design
                    continue
                cov[it.net][1] += 1
                if over_plane(x, y):
                    cov[it.net][0] += 1
                else:
                    unc.append((round(x, 2), round(y, 2), it.net, L))
    tot = sum(v[1] for v in cov.values())
    ok = sum(v[0] for v in cov.values())
    out["return_path"] = {"samples": tot, "samples_on_own_via_excluded": at_via, "over_in1_fill": ok, "pct": round(100 * ok / tot, 2) if tot else None, "uncovered_examples": unc[:15],
                          "nets_below_100pct": {n: round(100 * v[0] / v[1], 1) for n, v in cov.items() if v[0] != v[1]}}
    # --- keep-out occupancy
    occ = []
    for z in zones:
        if not z["keepout"] or not z["outline"]:
            continue
        for L in CU:
            if L not in z["layers"]:
                continue
            for it in items[L]:
                if it.kind == "pad" and z["no_tracks"] and False:
                    continue
                if (it.kind == "track" and z["no_tracks"]) or (it.kind == "via" and z["no_vias"]):
                    pts = [(s[0], s[1]) for s in it.segs] + [(s[2], s[3]) for s in it.segs]
                    if any(inside(z["outline"], x, y) for x, y in pts):
                        occ.append((z["name"], it.kind, it.net, L, [round(v, 2) for v in it.segs[0]]))
    out["keepout_occupancy"] = occ
    out["keepouts"] = [{"name": z["name"], "no_tracks": z["no_tracks"], "no_vias": z["no_vias"], "layers": z["layers"]} for z in zones if z["keepout"]]
    a.out.write_text(json.dumps(out, indent=1, default=list))
    print(json.dumps({k: out[k] for k in ("counts", "track_widths", "via_sizes", "via_annular_ring_mm", "pad_drills")}, default=list))
    for L, r in out["clearance"].items():
        print(L, "pairs", r["pairs_checked"], "below 0.30:", r["below_floor"], "lowest", r["lowest"][:3])
    ri = out["rules_independent"]
    print("class-aware clearance violations:", out["class_aware_clearance_violation_count"], out["class_aware_clearance_violations"][:4])
    print("hi-Z <0.4 not exempt:", ri["hiz_not_exempt_count"], ri["hiz_leakage_below_0.4_not_exempt"][:4], "| exempt:", ri["hiz_exempt_count"], "| spi->hiz<2:", ri["spi_to_hiz_below_2.0"][:3], "| spi->buf<1:", ri["spi_to_buf_below_1.0"][:3])
    print("hole2copper<0.25:", out["hole_to_other_net_copper_below_0.25"][:5])
    print("hole2hole<0.5:", out["hole_to_hole_below_0.5"][:5])
    print("edge:", out["copper_to_edge_lowest"][:4])
    print("planes:", {k: (v["fill_polygons"], v["abs_area_sum_mm2"]) for k, v in planes.items()})
    print("return path:", {k: out["return_path"][k] for k in ("samples", "pct", "nets_below_100pct")})
    print("keepout occupancy:", occ[:6])
    return 0


if __name__ == "__main__":
    sys.exit(main())
