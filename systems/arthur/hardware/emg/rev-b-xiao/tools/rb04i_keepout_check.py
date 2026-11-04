#!/usr/bin/env python3
"""RB-04I: independent keep-out check of the 11 XIAO keep-out rule areas against the routed canonical PCB (read-only) + SVG overlay.
    python3 rb04i_keepout_check.py --pcb board.kicad_pcb --out-dir evidence/rb04i"""
import argparse, json, math, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_sexpr import parse, kids, first
ap = argparse.ArgumentParser(); ap.add_argument("--pcb", required=True); ap.add_argument("--out-dir", required=True); a = ap.parse_args()
out = Path(a.out_dir); out.mkdir(parents=True, exist_ok=True)
t = parse(Path(a.pcb).read_text())
Z = []
for z in kids(t, "zone"):
    ko = first(z, "keepout")
    nm = str(first(z, "name")[1]) if first(z, "name") else ""
    if ko is None or not nm.startswith("XIAO"): continue
    pts = [(float(p[1]), float(p[2])) for p in first(first(z, "polygon"), "pts")[1:] if p[0] == "xy"]
    lay = first(z, "layers"); lay = [str(x) for x in lay[1:]] if lay else [str(first(z, "layer")[1])]
    rules = {str(k[0]): str(k[1]) for k in ko[1:]}
    Z.append(dict(name=nm, layers=lay, rules=rules, box=(min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts))))
segs = []; vias = []; pads = []
for s in kids(t, "segment"):
    p, q = first(s, "start"), first(s, "end")
    segs.append(dict(layer=str(first(s, "layer")[1]), x0=float(p[1]), y0=float(p[2]), x1=float(q[1]), y1=float(q[2]), w=float(first(s, "width")[1]), net=str(first(s, "net")[1])))
for v in kids(t, "via"):
    at = first(v, "at"); vias.append(dict(x=float(at[1]), y=float(at[2]), r=float(first(v, "size")[1]) / 2, net=str(first(v, "net")[1])))
for f in kids(t, "footprint"):
    ref = [str(p[2]) for p in kids(f, "property") if str(p[1]) == "Reference"][0]
    at = first(f, "at"); x, y = float(at[1]), float(at[2]); r = float(at[3]) if len(at) > 3 else 0; th = math.radians(r)
    for p in kids(f, "pad"):
        lay = [str(v) for v in first(p, "layers")[1:]]
        pa = first(p, "at"); lx, ly = float(pa[1]), float(pa[2]); sz = first(p, "size"); w, h = float(sz[1]), float(sz[2])
        px = x + lx * math.cos(th) + ly * math.sin(th); py = y - lx * math.sin(th) + ly * math.cos(th)
        if int(round(r / 90)) % 2: w, h = h, w
        pads.append(dict(ref=ref, num=str(p[1]), x=px, y=py, w=w, h=h, layers=lay, net=str(first(p, "net")[1]) if first(p, "net") else "", mask_open=any("Mask" in l for l in lay), cu=[l for l in lay if l.endswith("Cu")]))
def rect_pt_dist(b, x, y):
    dx = max(b[0] - x, 0, x - b[2]); dy = max(b[1] - y, 0, y - b[3]); return math.hypot(dx, dy)
def seg_hits(b, s):
    n = max(2, int(math.hypot(s["x1"] - s["x0"], s["y1"] - s["y0"]) / 0.02))
    return any(rect_pt_dist(b, s["x0"] + (s["x1"] - s["x0"]) * i / n, s["y0"] + (s["y1"] - s["y0"]) * i / n) < s["w"] / 2 for i in range(n + 1))
def rect_rect(b, x, y, w, h): return not (x + w / 2 <= b[0] or x - w / 2 >= b[2] or y + h / 2 <= b[1] or y - h / 2 >= b[3])
res = []; viol = 0
for z in Z:
    b = z["box"]; r = dict(name=z["name"], layers=z["layers"], rules=z["rules"], tracks=[], vias=[], pads=[], pours=[])
    if z["rules"].get("tracks") == "not_allowed":
        for s in segs:
            if s["layer"] in z["layers"] and seg_hits(b, s): r["tracks"].append(f"{s['layer']} {s['net']} ({s['x0']},{s['y0']})-({s['x1']},{s['y1']})")
    if z["rules"].get("vias") == "not_allowed":
        for v in vias:
            if rect_pt_dist(b, v["x"], v["y"]) < v["r"]: r["vias"].append(f"{v['net']} ({v['x']},{v['y']})")
    for p in pads:
        if p["ref"] == "U1": continue
        if any(l in z["layers"] or l == "*.Cu" for l in p["cu"]) and rect_rect(b, p["x"], p["y"], p["w"], p["h"]): r["pads"].append(f"{p['ref']}.{p['num']} net {p['net']} mask_open={p['mask_open']}")
    # pads of U1 inside the keep-out (informational: the BAT+ post land)
    r["u1_pads_inside"] = [f"U1.{p['num']} {p['cu']} {p['w']}x{p['h']}" for p in pads if p["ref"] == "U1" and rect_rect(b, p["x"], p["y"], p["w"], p["h"]) and p["num"] not in [str(i) for i in range(1, 15)]]
    r["violations"] = len(r["tracks"]) + len(r["vias"]) + len(r["pours"])
    viol += r["violations"]; res.append(r)
# GND0 pad vs R1b ring
gnd0 = [z for z in Z if "GND0" in z["name"]][0]["box"]
ring = [p for p in pads if p["ref"] == "U1" and p["num"] == "23" and "*.Cu" in p["cu"]][0]
gnd0_pad = (gnd0[0] + 0.5, gnd0[1] + 0.5, gnd0[2] - 0.5, gnd0[3] - 0.5)       # keep-out = pad + 0.5 mm (RB-00.6 §4)
ring_edge_y = ring["y"] + ring["w"] / 2
summary = dict(zones=len(Z), violations=viol, gnd0_pad_box=gnd0_pad, ring=dict(x=ring["x"], y=ring["y"], dia=ring["w"], top_edge_y=ring_edge_y),
               ring_to_gnd0_pad_gap=round(gnd0_pad[1] - ring_edge_y, 3), ring_inside_gnd0_margin_band_by=round(ring_edge_y - gnd0[1], 3))
# U.FL region: host copper within the module's U.FL footprint box (module frame u 4.039, v 19.406 -> board 45.04, 45.54), 3 x 4 mm
uf = (45.04 - 2.0, 45.54 - 2.0, 45.04 + 2.0, 45.54 + 2.0)
summary["ufl_region_host_f_cu"] = sorted({f"{s['net']} w{s['w']}" for s in segs if s["layer"] == "F.Cu" and seg_hits(uf, s)})
summary["ufl_region_vias"] = sorted({f"{v['net']}" for v in vias if rect_pt_dist(uf, v["x"], v["y"]) < v["r"]})
json.dump(dict(summary=summary, zones=res), open(out / "keepout_check.json", "w"), indent=1)
print(json.dumps(summary, indent=1)); 
for r in res: print(f"{r['name']:34s} tracks {len(r['tracks'])} vias {len(r['vias'])} other-part pads {len(r['pads'])} u1_pads {r['u1_pads_inside']}")
# overlay
BOX = (28.0, 42.0, 53.0, 66.5); SC = 30
X = lambda x: (x - BOX[0]) * SC; Y = lambda y: (y - BOX[1]) * SC
el = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{(BOX[2]-BOX[0])*SC:.0f}" height="{(BOX[3]-BOX[1])*SC:.0f}"><rect width="100%" height="100%" fill="#fff"/>']
for s in segs:
    if s["layer"] == "F.Cu": el.append(f'<line x1="{X(s["x0"]):.1f}" y1="{Y(s["y0"]):.1f}" x2="{X(s["x1"]):.1f}" y2="{Y(s["y1"]):.1f}" stroke="#c83232" stroke-width="{s["w"]*SC:.1f}" stroke-linecap="round" stroke-opacity="0.8"/>')
for v in vias: el.append(f'<circle cx="{X(v["x"]):.1f}" cy="{Y(v["y"]):.1f}" r="{v["r"]*SC:.1f}" fill="#e8b4b4" stroke="#7a1f1f" stroke-width="0.6"/>')
for p in pads:
    el.append(f'<rect x="{X(p["x"]-p["w"]/2):.1f}" y="{Y(p["y"]-p["h"]/2):.1f}" width="{p["w"]*SC:.1f}" height="{p["h"]*SC:.1f}" fill="{"#2a62c8" if p["ref"]=="U1" else "#a02828"}" fill-opacity="0.45"/>')
cols = {"pads 15-22": "#ff8c00", "pad 25": "#ffb000", "GND0": "#d000d0", "USB shell": "#00a0a0", "no vias": "#40a040"}
for z in Z:
    b = z["box"]; c = next((v for k, v in cols.items() if k in z["name"]), "#808080")
    el.append(f'<rect x="{X(b[0]):.1f}" y="{Y(b[1]):.1f}" width="{(b[2]-b[0])*SC:.1f}" height="{(b[3]-b[1])*SC:.1f}" fill="{c}" fill-opacity="{0.10 if "no vias" in z["name"] else 0.25}" stroke="{c}" stroke-width="1.2" stroke-dasharray="{"5,3" if "no vias" in z["name"] else "0"}"/>')
el.append(f'<circle cx="{X(ring["x"]):.1f}" cy="{Y(ring["y"]):.1f}" r="{ring["w"]/2*SC:.1f}" fill="none" stroke="#000" stroke-width="1.5"/>')
el.append(f'<circle cx="{X(45.04):.1f}" cy="{Y(45.54):.1f}" r="{1.4*SC:.1f}" fill="none" stroke="#a00000" stroke-width="1.5" stroke-dasharray="3,3"/><text x="{X(45.04)+45:.0f}" y="{Y(45.54):.0f}" font-size="11" font-family="sans-serif" fill="#a00000">U.FL</text>')
el.append(f'<text x="8" y="16" font-size="12" font-family="sans-serif">RB-04I: XIAO keep-out rule areas (board-level) on the routed canonical PCB - F.Cu copper in red; orange/magenta/teal = F.Cu keep-outs; green dashed = no-via areas</text></svg>')
(out / "keepout_overlay.svg").write_text("\n".join(el))
subprocess.run(["rsvg-convert", "-o", str(out / "keepout_overlay.png"), str(out / "keepout_overlay.svg")], check=True)
