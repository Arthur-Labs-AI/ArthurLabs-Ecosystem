#!/usr/bin/env python3
"""RB-04: independent copper-resistance solver for the supply nets (separate code from rb03_audit.py).  Segments are resistors
R = rho*L/(w*t) (35 um outer copper, rho 1.72e-8 ohm m), vias 1.17 mOhm (25 um plating, 1.6 mm barrel), a pad joins every segment end
inside its bounding box (+0.1 mm) on that layer.  Dijkstra from the source pad gives the resistance to every pad.
Drop = current bound x resistance; the bounds are datasheet-derived (see REVB_RB04_INDEPENDENT_ELECTRICAL_AUDIT.md section 6).
    python3 rb04_power.py --pcb board --out power.json"""
import argparse, collections, heapq, json, math, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb03r_safe import safe_pcb
from rb02_check_placement import load
from rb02_sexpr import first, kids

RHO, T = 1.72e-8, 35e-6
RVIA = 1.17e-3
SRC = {"AFE_3V0": ("U4002", "5", 13.8), "DVDD_F": ("FB1", "2", 11.4), "VBAT": ("J1", "1", 500.0), "/Analog_Power_Interlock/VBAT_AFE": ("R4001", "2", 14.8),
       "/XIAO_Brain_Interface/XIAO_3V3": ("U1", "12", 11.4), "/XIAO_5V": ("U1", "14", 20.0)}
ap = argparse.ArgumentParser(); ap.add_argument("--pcb", type=Path, required=True); ap.add_argument("--out", type=Path, required=True)
ap.add_argument("--no-tp", action="store_true", help="test-point pads (TPx) may not carry current between track sets")
a = ap.parse_args()
fps, E, zones, root = load(safe_pcb(a.pcb))
segs = []
for s in kids(root, "segment"):
    st, en = first(s, "start"), first(s, "end")
    segs.append((str(first(s, "net")[1]), str(first(s, "layer")[1]), (round(float(st[1]), 3), round(float(st[2]), 3)), (round(float(en[1]), 3), round(float(en[2]), 3)), float(first(s, "width")[1])))
vias = [(str(first(v, "net")[1]), (round(float(first(v, "at")[1]), 3), round(float(first(v, "at")[2]), 3))) for v in kids(root, "via")]
res = {}
for net, (sref, spin, amp) in SRC.items():
    adj = {}
    def edge(u, v, r):
        adj.setdefault(u, []).append((v, r)); adj.setdefault(v, []).append((u, r))
    mine = [(L, p, q, w) for n, L, p, q, w in segs if n == net]
    pts = collections.defaultdict(set)                      # layer -> {points that must become nodes (ends, vias)}
    for L, p, q, w in mine:
        pts[L].add(p); pts[L].add(q)
    for n, p in vias:
        if n == net:
            for L in ("F.Cu", "B.Cu", "In2.Cu"):
                pts[L].add(p)
    # same-net crossings / overlaps of two segments on one layer (KiCad treats overlapping copper of one net as connected)
    for i, (L1, p1, q1, w1) in enumerate(mine):
        for (L2, p2, q2, w2) in mine[i + 1:]:
            if L1 != L2:
                continue
            for (a0, a1, b0, b1) in ((p1, q1, p2, q2),):
                # closest point pair by sampling the shorter segment's endpoints against the other segment (axis-aligned runs)
                for pt, sa, sb, ww in ((a0, b0, b1, w2), (a1, b0, b1, w2), (b0, a0, a1, w1), (b1, a0, a1, w1)):
                    dx, dy = sb[0] - sa[0], sb[1] - sa[1]
                    l2 = dx * dx + dy * dy
                    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((pt[0] - sa[0]) * dx + (pt[1] - sa[1]) * dy) / l2))
                    cx, cy = sa[0] + t * dx, sa[1] + t * dy
                    if math.hypot(pt[0] - cx, pt[1] - cy) <= ww / 2 + 0.01:
                        pts[L1].add(pt); pts[L1].add((round(cx, 3), round(cy, 3)))
    padpts = collections.defaultdict(list)                   # (ref, num) -> [(point, layer)] where copper of this net touches the pad
    for ref, o in fps.items():
        for pd in o.pads:
            if pd["net"] != net or (a.no_tp and ref.startswith("TP")):
                continue
            for L, p, q, w in mine:
                if not (L == o.layer or pd.get("thru")):
                    continue
                dx, dy = q[0] - p[0], q[1] - p[1]
                l2 = dx * dx + dy * dy
                t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((pd["x"] - p[0]) * dx + (pd["y"] - p[1]) * dy) / l2))
                qx, qy = round(p[0] + t * dx, 3), round(p[1] + t * dy, 3)
                if abs(qx - pd["x"]) <= pd["w"] / 2 + w / 2 and abs(qy - pd["y"]) <= pd["h"] / 2 + w / 2:
                    pts[L].add((qx, qy))
                    padpts[(ref, pd["num"])].append(((qx, qy), L))
    for L, p, q, w in mine:
        dx, dy = q[0] - p[0], q[1] - p[1]
        l2 = dx * dx + dy * dy
        on = []
        for r_ in pts[L]:
            t = 0.0 if l2 == 0 else ((r_[0] - p[0]) * dx + (r_[1] - p[1]) * dy) / l2
            if -1e-9 <= t <= 1 + 1e-9:
                qx, qy = p[0] + t * dx, p[1] + t * dy
                if math.hypot(r_[0] - qx, r_[1] - qy) <= w / 2 + 0.01:      # T-junction: a track end lands on the body of this segment
                    on.append((t, r_))
        on.sort()
        for (t0, a0), (t1, b0) in zip(on, on[1:]):
            l = math.hypot(b0[0] - a0[0], b0[1] - a0[1]) * 1e-3
            edge((a0, L), (b0, L), RHO * l / (w * 1e-3 * T) if l > 0 else 1e-9)
    for n, p in vias:
        if n != net: continue
        for L1, L2 in (("F.Cu", "B.Cu"), ("F.Cu", "In2.Cu")):
            edge((p, L1), (p, L2), RVIA)
    pads = []
    for ref, o in fps.items():
        for pd in o.pads:
            if pd["net"] == net and not (a.no_tp and ref.startswith("TP")):
                pads.append((ref, pd))
    pnode = {}
    for ref, pd in pads:
        hw, hh = pd["w"] / 2 + 0.1, pd["h"] / 2 + 0.1
        node = ("pad", ref, pd["num"])
        hit = False
        for u in list(adj):
            if u[0] == "pad": continue
            (x, y), L = u
            if (L == fps[ref].layer or pd.get("thru")) and abs(x - pd["x"]) <= max(hw, hh) and abs(y - pd["y"]) <= max(hw, hh):
                edge(node, u, 1e-6); hit = True
        for (pt, L) in padpts.get((ref, pd["num"]), []):
            if (pt, L) in adj:
                edge(node, (pt, L), 1e-6); hit = True
        pnode[(ref, pd["num"])] = (node, hit)
    s = pnode.get((sref, spin))
    if not s or not s[1]:
        res[net] = {"error": f"source pad {sref}.{spin} not connected in the copper graph"}; continue
    dist = {s[0]: 0.0}; pq = [(0.0, s[0])]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, 1e9): continue
        for v, r in adj.get(u, []):
            if d + r < dist.get(v, 1e9):
                dist[v] = d + r; heapq.heappush(pq, (d + r, v))
    reach = {f"{r}.{n}": round(dist[nd] * 1e3, 1) for (r, n), (nd, hit) in pnode.items() if nd in dist}
    unreach = sorted(f"{r}.{n}" for (r, n), (nd, hit) in pnode.items() if nd not in dist)
    mx = max(reach.values())
    res[net] = {"source": f"{sref}.{spin}", "pads": len(pnode), "unreached_pads": unreach, "max_mohm": mx, "farthest": max(reach, key=reach.get), "bound_mA": amp,
                "drop_mV_upper_bound": round(amp * mx / 1000.0, 3)}
a.out.write_text(json.dumps(res, indent=1))
for n, v in res.items():
    print(n[:40].ljust(40), v if "error" in v else f"{v['source']} max {v['max_mohm']} mOhm @ {v['farthest']}  {v['bound_mA']} mA -> {v['drop_mV_upper_bound']} mV  unreached {v['unreached_pads']}")
