#!/usr/bin/env python3
"""RB-03R: how every SMD GND pad reaches the In1 plane: nearest GND via (centre distance) and the F.Cu GND copper component it sits in.
    python3 rb03r_gnd_ties.py --pcb board.kicad_pcb --out gnd_ties.json"""
import argparse, json, math, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_check_placement import load
from rb02_sexpr import first, kids
ap = argparse.ArgumentParser(); ap.add_argument("--pcb", type=Path, required=True); ap.add_argument("--out", type=Path, required=True)
a = ap.parse_args()
from rb03r_safe import safe_pcb
a.pcb = safe_pcb(a.pcb)
fps, E, z, root = load(a.pcb)
vias = [(float(first(v, "at")[1]), float(first(v, "at")[2])) for v in kids(root, "via") if str(first(v, "net")[1]) == "GND"]
segs = []
for s in kids(root, "segment"):
    if str(first(s, "net")[1]) == "GND" and str(first(s, "layer")[1]) == "F.Cu":
        st, en = first(s, "start"), first(s, "end")
        segs.append((float(st[1]), float(st[2]), float(en[1]), float(en[2])))
par = list(range(len(segs)))
def f(i):
    while par[i] != i:
        par[i] = par[par[i]]; i = par[i]
    return i
key = {}
for i, s in enumerate(segs):
    for k in ((round(s[0], 3), round(s[1], 3)), (round(s[2], 3), round(s[3], 3))):
        if k in key: par[f(i)] = f(key[k])
        else: key[k] = i
comp_len = {}
for i, s in enumerate(segs):
    comp_len[f(i)] = comp_len.get(f(i), 0) + math.hypot(s[2] - s[0], s[3] - s[1])
rows = []
for ref, o in fps.items():
    for p in o.pads:
        if p["net"] != "GND" or p.get("thru") or ref.startswith("TP"):
            continue
        d = min(math.hypot(p["x"] - vx, p["y"] - vy) for vx, vy in vias)
        hits = [i for i, s in enumerate(segs) if (min(s[0], s[2]) - 0.3 <= p["x"] <= max(s[0], s[2]) + 0.3 and min(s[1], s[3]) - 0.3 <= p["y"] <= max(s[1], s[3]) + 0.3)]
        cl = max([comp_len[f(i)] for i in hits] + [0.0])
        rows.append({"pad": f"{ref}.{p['num']}", "nearest_gnd_via_mm": round(d, 2), "fcu_gnd_component_mm": round(cl, 2)})
rows.sort(key=lambda r: -r["nearest_gnd_via_mm"])
a.out.write_text(json.dumps(rows, indent=1))
ds = [r["nearest_gnd_via_mm"] for r in rows]
print(f"{len(rows)} SMD GND pads; nearest via: median {sorted(ds)[len(ds)//2]:.2f} mm, max {max(ds):.2f} mm; > 2.0 mm: {sum(1 for d in ds if d > 2.0)}; > 3.0 mm: {sum(1 for d in ds if d > 3.0)}")
print("longest:", [(r['pad'], r['nearest_gnd_via_mm'], r['fcu_gnd_component_mm']) for r in rows[:8]])
