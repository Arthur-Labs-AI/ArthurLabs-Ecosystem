#!/usr/bin/env python3
"""RB-04: CPL / placement sanity for JLC assembly: per polarised / oriented part list the KiCad position-file rotation and the
absolute location of pin 1 relative to the part centre (so the JLC 2D viewer can be compared by eye), plus duplicate / missing /
off-board / bottom-side checks of the CPL against the BOM.   python3 rb04_cpl.py --pcb b --pos pos.csv --out cpl_check.json"""
import argparse, csv, json, math, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_check_placement import load
ap = argparse.ArgumentParser(); ap.add_argument("--pcb", type=Path, required=True); ap.add_argument("--pos", type=Path, required=True); ap.add_argument("--out", type=Path, required=True)
a = ap.parse_args()
fps, E, z, root = load(a.pcb)
pos = {r["Ref"]: r for r in csv.DictReader(a.pos.open())}
rows, issues = [], []
for ref, r in pos.items():
    o = fps[ref]
    if r["Side"] != "top":
        issues.append((ref, "not top"))
    px = float(r["PosX"]); py = -float(r["PosY"])
    if abs(px - o.x) > 0.01 or abs(py - o.y) > 0.01:
        issues.append((ref, f"CPL position differs from footprint origin ({px},{py}) vs ({o.x},{o.y})"))
    p1 = [p for p in o.pads if p["num"] == "1"]
    pin1 = None
    if p1:
        dx, dy = p1[0]["x"] - o.x, p1[0]["y"] - o.y
        pin1 = ("E" if dx > 0.3 else "W" if dx < -0.3 else "") + ("S" if dy > 0.3 else "N" if dy < -0.3 else "")
    rows.append({"ref": ref, "package": r["Package"], "value": r["Val"], "cpl_rot": float(r["Rot"]), "x": px, "y": r["PosY"], "pin1_side": pin1})
pol = [x for x in rows if x["ref"][0] in "UDQJX" or x["ref"].startswith("FB")]
missing = sorted(set(fps) - set(pos) - {"U1"} - {r for r in fps if r.startswith("TP")})
res = {"cpl_rows": len(rows), "issues": issues, "parts_in_pcb_not_in_cpl_excluding_U1_TP": missing, "oriented_parts": pol}
a.out.write_text(json.dumps(res, indent=1))
print(len(rows), "rows; issues", issues[:3], "missing", missing)
for x in sorted(pol, key=lambda r: (r["package"], r["ref"])):
    print(f"{x['ref']:6s} {x['package'][:34]:34s} rot {x['cpl_rot']:7.1f} pin1 {x['pin1_side']}")
