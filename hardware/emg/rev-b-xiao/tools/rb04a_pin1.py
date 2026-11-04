#!/usr/bin/env python3
"""RB-04A: absolute pin-1 pad position + orientation of every polarised / oriented part, with the community JLC rotation correction (KiBot
excerpt: ^SOT-23 +180, ^TSSOP- +270, ^SOIC- +270, ^JST_PH_S +180).  The JLC viewer is the only authority; this table is a hypothesis for D5."""
import json, math, re, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_sexpr import parse, kids, first
pcb = sys.argv[1]; out = sys.argv[2]
t = parse(open(pcb).read())
CORR = [(r"^SOT-23", 180), (r"^TSSOP-", 270), (r"^SOIC-", 270), (r"^JST_PH_S", 180)]
rows = []
for f in kids(t, "footprint"):
    ref = [str(p[2]) for p in kids(f, "property") if str(p[1]) == "Reference"][0]
    if not re.match(r"^(D|Q|U|X|J|FB)\d", ref) or ref == "U1": continue
    name = str(f[1]); at = first(f, "at"); x, y = float(at[1]), float(at[2]); rot = float(at[3]) if len(at) > 3 else 0.0
    p1 = None
    for p in kids(f, "pad"):
        if str(p[1]) == "1":
            a = first(p, "at"); px, py = float(a[1]), float(a[2])
            th = math.radians(rot)
            p1 = (round(x + px * math.cos(th) + py * math.sin(th), 3), round(y - px * math.sin(th) + py * math.cos(th), 3))
            break
    short = name.split(":")[-1]
    corr = next((c for r, c in CORR if re.match(r, short)), 0)
    rows.append(dict(ref=ref, footprint=short, x=x, y=y, kicad_rot=rot, pin1_xy=p1, community_corr=corr, expected_jlc_rot=(rot + corr) % 360))
json.dump(rows, open(out, "w"), indent=1)
for r in rows: print(r["ref"], r["footprint"][:28], "rot", r["kicad_rot"], "pin1", r["pin1_xy"], "jlc?", r["expected_jlc_rot"])
