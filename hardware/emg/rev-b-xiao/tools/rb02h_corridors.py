#!/usr/bin/env python3
"""RB-02H: routing-corridor, power-path and corner-radius numbers for a placement variant (read-only; no routing).

    python3 rb02h_corridors.py --pcb variant.kicad_pcb --name V1 --out <dir>
"""
import argparse, fnmatch, json, math, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_check_placement import load  # noqa: E402
import rb02g_layouts as L  # noqa: E402
from rb02_write_project import PATTERNS  # noqa: E402


def cls(n):
    for c, p in PATTERNS:
        if fnmatch.fnmatchcase(n, p):
            return c


def inside(px, py, W, H, r, m):
    x0, y0, x1, y1 = m, m, W - m, H - m
    rr = max(r - m, 0.0)
    if px < x0 or px > x1 or py < y0 or py > y1:
        return False
    for cx, cy, sx, sy in ((x0 + rr, y0 + rr, -1, -1), (x1 - rr, y0 + rr, 1, -1), (x0 + rr, y1 - rr, -1, 1), (x1 - rr, y1 - rr, 1, 1)):
        if rr > 0 and (px - cx) * sx > 0 and (py - cy) * sy > 0 and math.hypot(px - cx, py - cy) > rr:
            return False
    return True


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pcb", type=Path, required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    fps, E, z, root = load(a.pcb)
    W, H = E[2], E[3]
    A = set(L.BLOCKS["ALLA"])
    nets = {}
    for r, o in fps.items():
        for p in o.pads:
            n = p["net"]
            if n and n != "GND" and not n.startswith("unconnected"):
                nets.setdefault(n, set()).add(r)
    cross = sorted(n for n, rs in nets.items() if (rs & A) and (rs - A))
    a_bot = max(fps[r].crt[3] for r in A if fps[r].crt)
    gaps = []
    x = 0.5
    while x < W - 0.5:
        below = [o.crt[1] for r, o in fps.items() if r not in A and o.crt and o.layer == "F.Cu" and o.crt[0] <= x <= o.crt[2] and o.crt[1] >= a_bot - 0.01]
        top = max([fps[r].crt[3] for r in A if fps[r].crt and fps[r].crt[0] <= x <= fps[r].crt[2]] + [0])
        gaps.append((min(below) if below else H) - top)
        x += 0.5
    j1p = [p for p in fps["J1"].pads if p["num"] == "1"][0]
    post = [p for p in fps["U1"].pads if p["num"] == "23" and p["type"] == "thru_hole"][0]
    u = fps["U1"]
    ufl = (u.x + 4.851, u.y - 8.8385)
    hz = [(math.hypot(p["x"] - ufl[0], p["y"] - ufl[1]), r) for r, o in fps.items() for p in o.pads if p["net"] and fnmatch.fnmatchcase(p["net"], "/CH?/HIZ_*")]
    pts = []
    for r, o in fps.items():
        if o.layer != "F.Cu":
            continue
        for p in o.pads:
            if r == "U1" and not (p["type"] == "smd" and p["num"].isdigit() and int(p["num"]) <= 14):
                continue
            for dx in (-1, 1):
                for dy in (-1, 1):
                    pts.append((p["x"] + dx * p["w"] / 2, p["y"] + dy * p["h"] / 2))
    best = 0.0
    for r10 in range(10, 150):
        if all(inside(x_, y_, W, H, r10 / 10, 0.5) for x_, y_ in pts):
            best = r10 / 10
        else:
            break
    out = {"name": a.name, "outline": (W, H), "nets_crossing_zone_a_to_rest": {"count": len(cross), "nets": cross},
           "channel_gap_below_zone_a_mm": {"min": round(min(gaps), 2), "median": round(sorted(gaps)[len(gaps) // 2], 2), "max": round(max(gaps), 2)},
           "j1_pad1_to_bat_post_manhattan_mm": round(abs(j1p["x"] - post["x"]) + abs(j1p["y"] - post["y"]), 1),
           "ufl_to_nearest_hiz_mm": [round(min(hz)[0], 1), min(hz)[1]],
           "max_board_corner_radius_keeping_0p5mm_copper": best}
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / f"{a.name}_corridors.json").write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
