#!/usr/bin/env python3
"""RB-03R: shortest F.Cu GND copper path (mm) and its width from every SMD GND pad to a GND via (Dijkstra over the track graph).
    python3 rb03r_gnd_path.py --pcb board --out gnd_paths.json"""
import argparse, heapq, json, math, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb03r_safe import safe_pcb
from rb02_check_placement import load
from rb02_sexpr import first, kids
ap = argparse.ArgumentParser(); ap.add_argument("--pcb", type=Path, required=True); ap.add_argument("--out", type=Path, required=True)
a = ap.parse_args()
fps, E, z, root = load(safe_pcb(a.pcb))
R = lambda x, y: (round(x, 3), round(y, 3))
adj = {}; widths = {}
for s in kids(root, "segment"):
    if str(first(s, "net")[1]) != "GND" or str(first(s, "layer")[1]) != "F.Cu":
        continue
    st, en = first(s, "start"), first(s, "end"); w = float(first(s, "width")[1])
    p, q = R(float(st[1]), float(st[2])), R(float(en[1]), float(en[2]))
    d = math.hypot(p[0] - q[0], p[1] - q[1])
    adj.setdefault(p, []).append((q, d, w)); adj.setdefault(q, []).append((p, d, w))
vias = {R(float(first(v, "at")[1]), float(first(v, "at")[2])) for v in kids(root, "via") if str(first(v, "net")[1]) == "GND"}
rows = []
for ref, o in fps.items():
    for p in o.pads:
        if p["net"] != "GND" or p.get("thru") or ref.startswith("TP"):
            continue
        starts = [n for n in adj if abs(n[0] - p["x"]) <= p["w"] / 2 + 0.15 and abs(n[1] - p["y"]) <= p["h"] / 2 + 0.15]
        best = None
        if any(math.hypot(v[0] - p["x"], v[1] - p["y"]) < 0.35 for v in vias):
            best = (0.0, 0.0)
        else:
            dist = {s: 0.0 for s in starts}; pq = [(0.0, s, 0.0) for s in starts]
            while pq:
                d, n, wmin = heapq.heappop(pq)
                if n in vias:
                    best = (d, wmin); break
                if d > dist.get(n, 1e9):
                    continue
                for m, dd, w in adj.get(n, []):
                    if d + dd < dist.get(m, 1e9):
                        dist[m] = d + dd; heapq.heappush(pq, (d + dd, m, min(w, wmin) if wmin else w))
        rows.append({"pad": f"{ref}.{p['num']}", "path_mm": None if best is None else round(best[0], 2), "min_width_mm": None if best is None else best[1]})
rows.sort(key=lambda r: -(r["path_mm"] or 0))
a.out.write_text(json.dumps(rows, indent=1))
paths = [r["path_mm"] for r in rows if r["path_mm"] is not None]
print(len(rows), "SMD GND pads; none-found:", sum(1 for r in rows if r["path_mm"] is None), "; > 2 mm:", sum(1 for x in paths if x > 2), "; > 4 mm:", sum(1 for x in paths if x > 4))
print([(r["pad"], r["path_mm"], r["min_width_mm"]) for r in rows[:8]])
