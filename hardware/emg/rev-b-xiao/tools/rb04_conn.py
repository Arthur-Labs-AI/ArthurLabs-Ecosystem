#!/usr/bin/env python3
"""RB-04: per-net copper connectivity WITHOUT letting test-point pads (TPx) act as bridges, to find nets whose continuity depends on a
bare test pad.  Independent union-find over track ends, T-junctions, crossings, vias and pad contacts.
    python3 rb04_conn.py --pcb board --out conn.json"""
import argparse, collections, json, math, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb03r_safe import safe_pcb
from rb02_check_placement import load
from rb02_sexpr import first, kids

ap = argparse.ArgumentParser(); ap.add_argument("--pcb", type=Path, required=True); ap.add_argument("--out", type=Path, required=True)
a = ap.parse_args()
fps, E, z, root = load(safe_pcb(a.pcb))
segs = collections.defaultdict(list)
for s in kids(root, "segment"):
    st, en = first(s, "start"), first(s, "end")
    segs[str(first(s, "net")[1])].append((str(first(s, "layer")[1]), (round(float(st[1]), 3), round(float(st[2]), 3)), (round(float(en[1]), 3), round(float(en[2]), 3)), float(first(s, "width")[1])))
vias = collections.defaultdict(list)
for v in kids(root, "via"):
    vias[str(first(v, "net")[1])].append((round(float(first(v, "at")[1]), 3), round(float(first(v, "at")[2]), 3)))
padsof = collections.defaultdict(list)
for ref, o in fps.items():
    for p in o.pads:
        if p["net"]:
            padsof[p["net"]].append((ref, p, o))


def segdist(pt, p, q):
    dx, dy = q[0] - p[0], q[1] - p[1]
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((pt[0] - p[0]) * dx + (pt[1] - p[1]) * dy) / l2))
    return math.hypot(pt[0] - (p[0] + t * dx), pt[1] - (p[1] + t * dy))


def comps(net, allow_tp):
    S = segs.get(net, [])
    parent = {}
    def f(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x
    def u(a_, b_):
        parent[f(a_)] = f(b_)
    for i, (L, p, q, w) in enumerate(S):
        u(("s", i), ("s", i))
        for j, (L2, p2, q2, w2) in enumerate(S[i + 1:], i + 1):
            if L != L2:
                continue
            # touching / crossing / T: any end of one within half width of the other
            if min(segdist(p, p2, q2), segdist(q, p2, q2), segdist(p2, p, q), segdist(q2, p, q)) <= (w + w2) / 2 + 0.005 or _cross((p, q), (p2, q2)):
                u(("s", i), ("s", j))
    for k, vp in enumerate(vias.get(net, [])):
        for i, (L, p, q, w) in enumerate(S):
            if segdist(vp, p, q) <= w / 2 + 0.3:
                u(("v", k), ("s", i))
        f(("v", k))
    # via-to-via through different layers is already by the barrel; vias connect all layers
    # vias connect segments of different layers: merge every segment touching the same via (done above)
    pads = [(r, p, o) for (r, p, o) in padsof.get(net, []) if allow_tp or not r.startswith("TP")]
    for n_, (r, p, o) in enumerate(pads):
        key = ("p", r, p["num"], n_)
        f(key)
        for i, (L, p0, q0, w) in enumerate(S):
            if L != o.layer and not p.get("thru"):
                continue
            hw, hh = p["w"] / 2, p["h"] / 2
            if abs(segdist((p["x"], p["y"]), p0, q0)) <= max(hw, hh) + w / 2 - 0.0 and (abs(segdist((p["x"], p["y"]), p0, q0)) <= min(hw, hh) + w / 2 or True):
                u(key, ("s", i))
        for k, vp in enumerate(vias.get(net, [])):
            if math.hypot(vp[0] - p["x"], vp[1] - p["y"]) <= max(p["w"], p["h"]) / 2 + 0.3:
                u(key, ("v", k))
    # pads touching each other on the same layer (same net) are connected
    for i, (r1, p1, o1) in enumerate(pads):
        for j, (r2, p2, o2) in enumerate(pads[i + 1:], i + 1):
            if r1 != r2 and o1.layer == o2.layer and abs(p1["x"] - p2["x"]) < (p1["w"] + p2["w"]) / 2 and abs(p1["y"] - p2["y"]) < (p1["h"] + p2["h"]) / 2:
                u(("p", r1, p1["num"], i), ("p", r2, p2["num"], j))
    groups = collections.defaultdict(list)
    for n_, (r, p, o) in enumerate(pads):
        groups[f(("p", r, p["num"], n_))].append(f"{r}.{p['num']}")
    return list(groups.values())


def _cross(a_, b_):
    def cr(o, p, q):
        return (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
    d1, d2 = cr(b_[0], b_[1], a_[0]), cr(b_[0], b_[1], a_[1])
    d3, d4 = cr(a_[0], a_[1], b_[0]), cr(a_[0], a_[1], b_[1])
    return d1 * d2 < 0 and d3 * d4 < 0


res = {}
for net in sorted(padsof):
    if net == "GND" or net.startswith("unconnected"):
        continue
    c_all = comps(net, True)
    c_notp = comps(net, False)
    if len(padsof[net]) >= 2:
        res[net] = {"pads": len(padsof[net]), "components_with_tp": len(c_all), "components_without_tp": len(c_notp)}
bad = {n: v for n, v in res.items() if v["components_without_tp"] > 1 or v["components_with_tp"] > 1}
a.out.write_text(json.dumps({"nets_checked": len(res), "split_nets": bad}, indent=1))
print("nets checked", len(res), "| nets whose pads are not one connected component (TP pads excluded):", {n: (v["components_with_tp"], v["components_without_tp"]) for n, v in bad.items()})
