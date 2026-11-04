#!/usr/bin/env python3
"""RB-03R: audit of the narrowed hi-Z exemption.  For each TLV9064 (U501-U503) rule area, list every track / via that lies inside it
and report those whose net has NO pad on that IC (a foreign net under the exemption would hide a leakage violation).
    python3 rb03r_escape_purity.py --pcb board.kicad_pcb --out purity.json"""
import argparse, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import rb03r_escape_areas as EA
from rb02_check_placement import load
from rb02_sexpr import first, kids, parse
ap = argparse.ArgumentParser(); ap.add_argument("--pcb", type=Path, required=True); ap.add_argument("--out", type=Path, required=True)
a = ap.parse_args()
from rb03r_safe import safe_pcb
a.pcb = safe_pcb(a.pcb)
areas = EA.areas_for(a.pcb)
fps, E, z, root = load(a.pcb)
res = {}
for ic in EA.ICS:
    x0, y0, x1, y1 = areas[f"HIZ_ESC_{ic}_L"]
    nets = {p["net"] for p in fps[ic].pads if p["net"]}
    inside, foreign = [], []
    for s in kids(root, "segment"):
        st, en = first(s, "start"), first(s, "end")
        pts = [(float(st[1]), float(st[2])), (float(en[1]), float(en[2]))]
        if all(x0 <= x <= x1 and y0 <= y <= y1 for x, y in pts) and str(first(s, "layer")[1]) == "F.Cu":
            n = str(first(s, "net")[1]); inside.append(n)
            if n not in nets and n != "GND":
                foreign.append({"net": n, "from": pts[0], "to": pts[1]})
    vias = []
    for v in kids(root, "via"):
        at = first(v, "at"); x, y = float(at[1]), float(at[2])
        if x0 <= x <= x1 and y0 <= y <= y1:
            n = str(first(v, "net")[1]); vias.append(n)
            if n not in nets and n != "GND":
                foreign.append({"net": n, "via": [x, y]})
    res[ic] = {"area": [round(t, 3) for t in (x0, y0, x1, y1)], "ic_nets": sorted(nets), "tracks_inside": len(inside), "vias_inside": len(vias),
               "foreign_non_gnd_items": foreign}
    print(ic, "tracks", len(inside), "vias", len(vias), "foreign:", len(foreign))
a.out.write_text(json.dumps(res, indent=1))
sys.exit(1 if any(v["foreign_non_gnd_items"] for v in res.values()) else 0)
