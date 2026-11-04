#!/usr/bin/env python3
"""RB-02G: routing-difficulty / analog-risk proxies for a placement (no routing is performed).

    python3 rb02g_metrics.py --pcb x.kicad_pcb [--json out.json]

Per net half-perimeter wire length (HPWL) grouped by RB-02 netclass; per-leg Manhattan length of the AC-coupled run
(R(b+7+o) -> clamp D(b+3+o)); P/N length mismatch per channel; courtyard utilisation and free-area fraction; where the five
electrode connectors and the USB end sit (edge, cable-exit side).
"""
import argparse
import fnmatch
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_check_placement import load  # noqa: E402
from rb02_write_project import PATTERNS  # noqa: E402


def klass(net):
    for c, p in PATTERNS:
        if fnmatch.fnmatchcase(net, p):
            return c
    return "Default"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pcb", type=Path, required=True)
    ap.add_argument("--json", type=Path)
    a = ap.parse_args(argv)
    fps, E, z, root = load(a.pcb)
    W, H = E[2] - E[0], E[3] - E[1]
    nets = {}
    for r, o in fps.items():
        for p in o.pads:
            if p["net"] and not p["net"].startswith("unconnected") and p["net"] not in ("GND",):
                nets.setdefault(p["net"], []).append((p["x"], p["y"]))
    by = {}
    tot = 0.0
    longest = []
    for n, pts in nets.items():
        if len(pts) < 2:
            continue
        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
        h = (max(xs) - min(xs)) + (max(ys) - min(ys))
        k = klass(n)
        by[k] = by.get(k, 0.0) + h
        tot += h
        longest.append((h, n))
    longest.sort(reverse=True)

    def c(r):
        o = fps[r]
        return (sum(p["x"] for p in o.pads) / len(o.pads), sum(p["y"] for p in o.pads) / len(o.pads))
    legs = {}
    mism = {}
    for ch in (1, 2, 3, 4):
        b = ch * 100
        ln = []
        for o_, side in ((0, "P"), (1, "N")):
            ra = c(f"R{b+7+o_}"); d = [p for p in fps[f"D{b+3+o_}"].pads if p["num"] == "3"][0]
            L = abs(ra[0] - d["x"]) + abs(ra[1] - d["y"])
            legs[f"CH{ch}{side}"] = round(L, 1)
            ln.append(L)
        mism[f"CH{ch}"] = round(abs(ln[0] - ln[1]), 1)
    crtA = sum((o.crt[2] - o.crt[0]) * (o.crt[3] - o.crt[1]) for o in fps.values() if o.crt and o.layer == "F.Cu" and o.libid != "ARTHUR:XIAO_ESP32S3_HANDSOLDER") 
    crtA += 21.38 * (32 - 10.865 + 0.5)    # XIAO courtyard inside the board
    jlist = ["J101", "J201", "J301", "J401", "J5001"]

    def edge_of(r):
        o = fps[r]; cx, cy = c(r)
        d = {"north": cy - E[1], "south": E[3] - cy, "west": cx - E[0], "east": E[2] - cx}
        return min(d, key=d.get)
    u = fps["U1"]
    mod = (u.x - 8.89, u.y - 10.5675, u.x + 8.89, u.y + 10.5675)
    near = {"EMG_HIZ": (1e9, None), "EMG_ELECTRODE": (1e9, None)}
    for r_, o_ in fps.items():
        if r_ == "U1":
            continue
        for p_ in o_.pads:
            k_ = klass(p_["net"]) if p_["net"] else None
            if k_ in near:
                dx = max(mod[0] - p_["x"], 0, p_["x"] - mod[2]); dy = max(mod[1] - p_["y"], 0, p_["y"] - mod[3])
                d_ = math.hypot(dx, dy)
                if d_ < near[k_][0]:
                    near[k_] = (d_, r_)
    import math as _m
    th_ = _m.radians(fps["J1"].rot - 180.0)
    ex_, ey_ = -_m.sin(th_), -_m.cos(th_)
    plug = ("east" if ex_ > 0.5 else "west") if abs(ex_) > 0.5 else ("south" if ey_ > 0.5 else "north")
    out = {"battery_plug_exit": plug, "hiz_to_module_mm": round(near["EMG_HIZ"][0], 1), "hiz_nearest_part": near["EMG_HIZ"][1],
           "electrode_to_module_mm": round(near["EMG_ELECTRODE"][0], 1), "W": round(W, 2), "H": round(H, 2), "area": round(W * H), "aspect": round(max(W, H) / min(W, H), 2),
           "courtyard_utilisation": round(crtA / (W * H), 3), "hpwl_total": round(tot), "hpwl_by_class": {k: round(v) for k, v in sorted(by.items())},
           "longest_nets": [(round(h, 1), n) for h, n in longest[:6]], "ac_run_leg_len": legs, "ac_run_max": max(legs.values()),
           "ac_run_min": min(legs.values()), "ac_pn_mismatch_max": max(mism.values()), "ac_pn_mismatch": mism,
           "electrode_connector_edges": {r: edge_of(r) for r in jlist}, "battery_connector_edge": edge_of("J1")}
    print(json.dumps(out, indent=1))
    if a.json:
        a.json.write_text(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
