#!/usr/bin/env python3
"""RB-03S: hand-solder iron access to the 14 XIAO castellation toes, with an iron-BODY model (not only the 1.5 mm tip band of RB-02 C17).

Model (documented assumptions, not a vendor figure):
  * the iron tip touches the toe end of the host pad (west column x = pad - 1.45 mm, east column x = pad + 1.45 mm) at the board surface;
  * the LOWER surface of the iron body leaves the contact point at elevation THETA (30, 45, 60 deg reported; 30-45 deg is usual for
    hand soldering) pointing away from the module (west column: -x; east column: +x);
  * a part is a problem if its top (library height table rb02_check_placement.HEIGHT) is above that line at its horizontal distance d
    (courtyard edge to contact point): h > d * tan(theta), and its courtyard lies within the body's lateral half width
    r(s) = 1.0 mm + 0.10 * s (s along the axis; ~2 mm tip widening to ~6 mm at 30 mm).
  required d(h) = h / tan(theta)

    python3 rb03s_iron_access.py --pcb board.kicad_pcb --out iron_access.json
"""
import argparse, json, math, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb03r_safe import safe_pcb
from rb02_check_placement import load, height_of

ap = argparse.ArgumentParser(); ap.add_argument("--pcb", type=Path, required=True); ap.add_argument("--out", type=Path, required=True)
a = ap.parse_args()
fps, E, z, root = load(safe_pcb(a.pcb))
u1 = fps["U1"]
toes = [(p["num"], p["x"] + (-1.45 if p["x"] < u1.x else 1.45), p["y"], -1 if p["x"] < u1.x else 1) for p in u1.pads if p["num"] != "23"]


def required(h, theta):
    d = h / math.tan(theta)
    return d, 1.0 + 0.10 * (max(d, 1.5) / math.cos(theta))


rows = []
for th_deg in (30, 45, 60):
    th = math.radians(th_deg)
    worst = []
    for (num, tx, ty, side) in toes:
        ctrl = None
        for ref, o in fps.items():
            if ref == "U1" or not o.crt or o.layer != "F.Cu":
                continue
            x0, y0, x1, y1 = o.crt
            # horizontal distance from the contact point to the courtyard edge on the iron side
            d = (tx - x1) if side < 0 else (x0 - tx)
            if d <= -0.5 or d > 14:
                continue
            h = height_of(o.libid)
            need, r = required(h, th)
            if y1 < ty - r or y0 > ty + r:
                continue
            margin = d - need
            if ctrl is None or margin < ctrl["margin_mm"]:
                ctrl = {"toe": num, "part": ref, "height_mm": h, "distance_mm": round(d, 2), "required_mm": round(need, 2), "margin_mm": round(margin, 2)}
        worst.append(ctrl)
    for c in worst:
        if c:
            c["elevation_deg"] = th_deg
    rows += [c for c in worst if c]
res = {}
for th in (30, 45, 60):
    rr = [c for c in rows if c["elevation_deg"] == th]
    w = min(rr, key=lambda c: c["margin_mm"])
    res[str(th)] = {"worst": w, "toes_with_negative_margin": sorted({c["toe"] for c in rr if c["margin_mm"] < 0})}
# C17 tip band (RB-02): no courtyard within 1.5 mm of the toe end
band = []
for (num, tx, ty, side) in toes:
    for ref, o in fps.items():
        if ref == "U1" or not o.crt or o.layer != "F.Cu":
            continue
        x0, y0, x1, y1 = o.crt
        d = (tx - x1) if side < 0 else (x0 - tx)
        if -0.01 < d < 1.5 and y1 > ty - 0.75 and y0 < ty + 0.75:
            band.append((num, ref, round(d, 2)))
res["tip_band_1p5mm_violations"] = band
a.out.write_text(json.dumps({"summary": res, "rows": rows}, indent=1))
print(json.dumps(res, indent=1)[:1600])
