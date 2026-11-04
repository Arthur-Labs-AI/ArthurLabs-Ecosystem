#!/usr/bin/env python3
"""RB-03 post-route audit of a filled board (read-only): connectivity inventory, hi-Z/electrode/ADC critical nets, plane
continuity and return-path coverage, power-distribution resistance, layer/via statistics.

    python3 rb03_audit.py --pcb routed_filled.kicad_pcb --out audit.json
"""
import argparse
import collections
import fnmatch
import heapq
import json
import math
import sys
from pathlib import Path

import pcbnew
import sys as _sys, pathlib as _pl
_sys.path.insert(0, str(_pl.Path(__file__).resolve().parent))
from rb03r_safe import safe_pcb  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_sexpr import first, kids, parse  # noqa: E402
from rb02_write_project import PATTERNS  # noqa: E402

RHO_SQ = 17.2e-9 / 35e-6        # ohm per square, 35 um copper
R_VIA = 17.2e-9 * 1.6e-3 / (math.pi * 0.3e-3 * 25e-6)      # 0.3 mm drill, 25 um plating, 1.6 mm barrel


def klass(n):
    for c, p in PATTERNS:
        if fnmatch.fnmatchcase(n, p):
            return c
    return "Default"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pcb", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    root = parse(a.pcb.read_text())
    segs = []
    for s in kids(root, "segment"):
        st, en = first(s, "start"), first(s, "end")
        segs.append({"net": str(first(s, "net")[1]), "layer": str(first(s, "layer")[1]), "x0": float(st[1]), "y0": float(st[2]),
                     "x1": float(en[1]), "y1": float(en[2]), "w": float(first(s, "width")[1])})
    vias = []
    for v in kids(root, "via"):
        at = first(v, "at")
        vias.append({"net": str(first(v, "net")[1]), "x": float(at[1]), "y": float(at[2]), "size": float(first(v, "size")[1]), "drill": float(first(v, "drill")[1])})
    b = pcbnew.LoadBoard(str(safe_pcb(a.pcb)))
    pads = []
    for fp in b.GetFootprints():
        for p in fp.Pads():
            pos = p.GetPosition()
            bb = p.GetBoundingBox()
            pads.append({"ref": fp.GetReference(), "num": p.GetNumber(), "net": p.GetNetname(), "x": pos.x / 1e6, "y": pos.y / 1e6,
                         "rect": (bb.GetLeft() / 1e6, bb.GetTop() / 1e6, bb.GetRight() / 1e6, bb.GetBottom() / 1e6),
                         "layers": [l for l, n in ((pcbnew.F_Cu, "F.Cu"), (pcbnew.B_Cu, "B.Cu")) if p.IsOnLayer(l) for l in [n]] if False else
                                   [n for l, n in ((pcbnew.F_Cu, "F.Cu"), (pcbnew.B_Cu, "B.Cu")) if p.IsOnLayer(l)]})
    out = {}
    # via-in-pad: via centre inside an SMD pad (accuracy 0) and via hole (r 0.15) touching pad copper (accuracy 0.15)
    vip, vtouch = [], []
    for fp in b.GetFootprints():
        for p in fp.Pads():
            if p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH:
                continue
            for v in vias:
                pos = pcbnew.VECTOR2I(int(v["x"] * 1e6), int(v["y"] * 1e6))
                if p.HitTest(pos, 0):
                    vip.append(f"{fp.GetReference()}.{p.GetNumber()}:{v['net']}@({v['x']:.2f},{v['y']:.2f})")
                elif p.HitTest(pos, 150000):
                    vtouch.append(f"{fp.GetReference()}.{p.GetNumber()}:{v['net']}@({v['x']:.2f},{v['y']:.2f})")
    out["via_in_smd_pad"] = {"centre_inside_pad": len(vip), "hole_touching_pad": len(vtouch), "centre_inside": vip, "hole_touching": vtouch}
    L = lambda s: math.hypot(s["x1"] - s["x0"], s["y1"] - s["y0"])
    # ---- inventory
    out["tracks"] = len(segs)
    out["vias"] = len(vias)
    out["track_length_by_layer_mm"] = {k: round(sum(L(s) for s in segs if s["layer"] == k), 1) for k in sorted({s["layer"] for s in segs})}
    out["min_track_width_mm"] = min(s["w"] for s in segs)
    out["via_sizes"] = sorted({(v["size"], v["drill"]) for v in vias})
    out["track_widths_mm"] = dict(collections.Counter(round(s["w"], 3) for s in segs))
    by = collections.defaultdict(lambda: {"length": 0.0, "vias": 0, "layers": set(), "widths": set()})
    for s in segs:
        d = by[s["net"]]
        d["length"] += L(s)
        d["layers"].add(s["layer"])
        d["widths"].add(round(s["w"], 3))
    for v in vias:
        by[v["net"]]["vias"] += 1
    nets = {}
    for n, d in sorted(by.items()):
        nets[n] = {"class": klass(n), "length_mm": round(d["length"], 1), "vias": d["vias"], "layers": sorted(d["layers"]), "widths": sorted(d["widths"])}
    out["nets"] = nets
    # ---- critical nets
    crit = {}
    for n, d in nets.items():
        if d["class"] in ("EMG_HIZ", "EMG_ELECTRODE", "ADC_CAP", "ANALOG_REF"):
            crit[n] = d
    out["critical"] = crit
    # P/N symmetry per channel
    sym = {}
    for c in (1, 2, 3, 4):
        for kind in ("HIZ", "ELEC"):
            p, nn = nets.get(f"/CH{c}/{kind}_P"), nets.get(f"/CH{c}/{kind}_N")
            if p and nn:
                sym[f"CH{c}_{kind}"] = {"P_mm": p["length_mm"], "N_mm": nn["length_mm"], "diff_mm": round(abs(p["length_mm"] - nn["length_mm"]), 1)}
        for kind in ("BUF", "ACN"):
            p, nn = nets.get(f"/CH{c}/{kind}_P"), nets.get(f"/CH{c}/{kind}_N")
            if p and nn:
                sym[f"CH{c}_{kind}"] = {"P_mm": p["length_mm"], "N_mm": nn["length_mm"], "diff_mm": round(abs(p["length_mm"] - nn["length_mm"]), 1)}
        p, nn = nets.get(f"/CH{c}_P"), nets.get(f"/CH{c}_N")
        if p and nn:
            sym[f"CH{c}_ADCIN"] = {"P_mm": p["length_mm"], "N_mm": nn["length_mm"], "diff_mm": round(abs(p["length_mm"] - nn["length_mm"]), 1)}
    out["symmetry"] = sym
    out["clock_X1_OUT_mm"] = nets.get("/ADC/X1_OUT", {}).get("length_mm")
    # ---- planes
    planes = {}
    polys = {}
    for z in b.Zones():
        if z.GetIsRuleArea():
            continue
        for lay, name in ((pcbnew.In1_Cu, "In1.Cu"), (pcbnew.In2_Cu, "In2.Cu")):
            if z.IsOnLayer(lay):
                ps = z.GetFilledPolysList(lay)
                polys[name] = ps
                n_out = ps.OutlineCount()
                areas = []
                holes = 0
                for i in range(n_out):
                    o = ps.Outline(i)
                    holes += ps.HoleCount(i)
                    # shoelace
                    pts = [(o.CPoint(k).x / 1e6, o.CPoint(k).y / 1e6) for k in range(o.PointCount())]
                    ar = 0.5 * abs(sum(pts[k][0] * pts[(k + 1) % len(pts)][1] - pts[(k + 1) % len(pts)][0] * pts[k][1] for k in range(len(pts))))
                    areas.append(round(ar, 1))
                planes[name] = {"zone": z.GetZoneName(), "net": z.GetNetname(), "filled_outlines": n_out, "outline_areas_mm2": sorted(areas, reverse=True)[:6], "holes": holes}
    bb = b.GetBoardEdgesBoundingBox()
    board_area = (bb.GetWidth() / 1e6 - 0.1) * (bb.GetHeight() / 1e6 - 0.1)
    out["board_area_mm2"] = round(board_area, 1)
    if "In1.Cu" in planes:
        out["in1_copper_fraction"] = round(sum(planes["In1.Cu"]["outline_areas_mm2"]) / board_area, 3)
    out["planes"] = planes
    # return-path coverage: sample every 0.5 mm along every track
    cov = {}
    if "In1.Cu" in polys:
        ps = polys["In1.Cu"]
        for cls in ("EMG_HIZ", "EMG_ELECTRODE", "EMG_BUF", "ANALOG_REF", "ADC_CAP", "SPI_FAST", "CTRL_SLOW", "PWR_AFE", "PWR_DVDD", "PWR_VBAT"):
            n_tot = n_in = 0
            worst = []
            vias_by_net = collections.defaultdict(list)
            for v in vias:
                vias_by_net[v["net"]].append((v["x"], v["y"]))
            for s in segs:
                if klass(s["net"]) != cls:
                    continue
                ln = L(s)
                k = max(1, int(ln / 0.5))
                for q in range(k + 1):
                    t = q / k
                    x, y = s["x0"] + t * (s["x1"] - s["x0"]), s["y0"] + t * (s["y1"] - s["y0"])
                    if any(math.hypot(x - vx, y - vy) < 0.8 for vx, vy in vias_by_net.get(s["net"], [])):
                        continue          # inside the track's own via anti-pad: the layer change itself, not a plane gap
                    n_tot += 1
                    if ps.Contains(pcbnew.VECTOR2I(int(x * 1e6), int(y * 1e6))):
                        n_in += 1
                    else:
                        worst.append((round(x, 1), round(y, 1), s["net"]))
            cov[cls] = {"samples": n_tot, "over_In1_copper_pct": round(100.0 * n_in / n_tot, 2) if n_tot else None, "uncovered_examples": worst[:5]}
    out["return_path_coverage_In1"] = cov
    # ---- power distribution: resistance from the source pad to every pad of the net
    SRC = {"AFE_3V0": ("U4002", "5"), "DVDD_F": ("FB1", "2"), "/XIAO_Brain_Interface/XIAO_3V3": ("U1", "12"),
           "VBAT": ("J1", "1"), "/Analog_Power_Interlock/VBAT_AFE": None, "/XIAO_5V": ("U1", "14")}
    pw = {}
    for net, src in SRC.items():
        nodes = {}

        def nid(x, y, lay):
            return nodes.setdefault((round(x, 3), round(y, 3), lay), len(nodes))
        edges = collections.defaultdict(list)
        npad = [p for p in pads if p["net"] == net]
        net_segs = [sg for sg in segs if sg["net"] == net]
        # points that must be nodes on a layer: segment ends, via centres, pad centres of the net
        pts_by_layer = collections.defaultdict(set)
        for sg in net_segs:
            pts_by_layer[sg["layer"]].add((round(sg["x0"], 3), round(sg["y0"], 3)))
            pts_by_layer[sg["layer"]].add((round(sg["x1"], 3), round(sg["y1"], 3)))
        for v in vias:
            if v["net"] == net:
                for lay in ("F.Cu", "B.Cu", "In2.Cu"):
                    pts_by_layer[lay].add((round(v["x"], 3), round(v["y"], 3)))
        for sg in net_segs:
            lay = sg["layer"]
            ax_, ay_, bx_, by_ = sg["x0"], sg["y0"], sg["x1"], sg["y1"]
            dx_, dy_ = bx_ - ax_, by_ - ay_
            ln2 = dx_ * dx_ + dy_ * dy_
            on = []
            for (px, py) in pts_by_layer[lay]:
                t = 0.0 if ln2 == 0 else ((px - ax_) * dx_ + (py - ay_) * dy_) / ln2
                if -1e-6 <= t <= 1 + 1e-6:
                    qx, qy = ax_ + t * dx_, ay_ + t * dy_
                    if math.hypot(px - qx, py - qy) < sg["w"] / 2 + 0.01:
                        on.append((t, px, py))
            on.sort()
            for k in range(len(on) - 1):
                (t0, x0_, y0_), (t1, x1_, y1_) = on[k], on[k + 1]
                if t1 - t0 < 1e-9:
                    continue
                u, w_ = nid(x0_, y0_, lay), nid(x1_, y1_, lay)
                r = RHO_SQ * math.hypot(x1_ - x0_, y1_ - y0_) / sg["w"]
                edges[u].append((w_, r)); edges[w_].append((u, r))
        for v in vias:
            if v["net"] != net:
                continue
            f, bk, i2 = nid(v["x"], v["y"], "F.Cu"), nid(v["x"], v["y"], "B.Cu"), nid(v["x"], v["y"], "In2.Cu")
            for u_, w_ in ((f, bk), (f, i2), (bk, i2)):
                edges[u_].append((w_, R_VIA)); edges[w_].append((u_, R_VIA))
        # pad -> any node of the net on its layers within the pad rect (0 ohm)
        pad_nodes = {}
        for p in npad:
            hit = [i for (x, y, lay), i in nodes.items() if lay in p["layers"] and p["rect"][0] - 0.15 <= x <= p["rect"][2] + 0.15 and p["rect"][1] - 0.15 <= y <= p["rect"][3] + 0.15]
            pad_nodes.setdefault((p["ref"], p["num"]), []).extend(hit)
            for h in hit[1:]:
                edges[hit[0]].append((h, 1e-6)); edges[h].append((hit[0], 1e-6))
        srcpad = src if src else None
        if srcpad is None or srcpad not in pad_nodes or not pad_nodes[srcpad]:
            # choose the pad with the most connections as the source (net without a unique regulator pin)
            cand = [k for k, v in pad_nodes.items() if v]
            srcpad = cand[0] if cand else None
        res = {}
        if srcpad:
            dist = {pad_nodes[srcpad][0]: 0.0}
            pq = [(0.0, pad_nodes[srcpad][0])]
            while pq:
                d, u = heapq.heappop(pq)
                if d > dist.get(u, 1e9):
                    continue
                for v2, r in edges[u]:
                    nd = d + r
                    if nd < dist.get(v2, 1e9):
                        dist[v2] = nd
                        heapq.heappush(pq, (nd, v2))
            for k, hit in pad_nodes.items():
                if not hit:
                    res[f"{k[0]}.{k[1]}"] = None
                else:
                    res[f"{k[0]}.{k[1]}"] = round(min(dist.get(h, 1e9) for h in hit) * 1000.0, 1)      # milliohm
        pw[net] = {"source": f"{srcpad[0]}.{srcpad[1]}" if srcpad else None, "pads": len(npad), "length_mm": nets.get(net, {}).get("length_mm"),
                   "vias": nets.get(net, {}).get("vias"), "widths": nets.get(net, {}).get("widths"), "resistance_mohm": res,
                   "max_mohm": max([v for v in res.values() if v is not None] + [0.0])}
    out["power"] = pw
    a.out.write_text(json.dumps(out, indent=1, default=list))
    print(json.dumps({k: out[k] for k in ("tracks", "vias", "track_length_by_layer_mm", "min_track_width_mm", "via_sizes", "planes", "return_path_coverage_In1")}, indent=1, default=list))
    for n, d in pw.items():
        print(n, d["source"], d["pads"], "max mohm", d["max_mohm"], "len", d["length_mm"], "vias", d["vias"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
