#!/usr/bin/env python3
"""RB-04C: top / bottom overlay of the Seeed module geometry on the canonical Rev B PCB (SVG + PNG via rsvg-convert).
    python3 rb04c_overlay.py --pcb board.kicad_pcb --geom xiao_geometry.json --seeed seeed.kicad_pcb --out-dir dir"""
import argparse, json, math, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import rb02a_xiao_cad_extract as X
from rb02_sexpr import parse, kids, first

ap = argparse.ArgumentParser()
ap.add_argument("--pcb", required=True); ap.add_argument("--geom", required=True); ap.add_argument("--seeed", required=True); ap.add_argument("--out-dir", required=True)
a = ap.parse_args(); out = Path(a.out_dir)
G = json.load(open(a.geom)); S = X.extract(a.seeed); T = G["_T"]
ox0, oy0, ox1, oy1 = S["outline"]["bbox"]
b = lambda sx, sy: (T[0] - (sx - ox0), T[1] - (sy - oy0))          # Seeed file coords -> board
t = parse(Path(a.pcb).read_text())
BOX = (24.0, 36.0, 53.0, 67.5)
SC = 28.0
def X_(x): return (x - BOX[0]) * SC
def Y_(y): return (y - BOX[1]) * SC
W = (BOX[2] - BOX[0]) * SC; Hh = (BOX[3] - BOX[1]) * SC


def svg_start():
    return [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W:.0f}" height="{Hh:.0f}" viewBox="0 0 {W:.0f} {Hh:.0f}"><rect width="100%" height="100%" fill="#ffffff"/>']


def rect(x0, y0, x1, y1, **kw):
    st = " ".join(f'{k.replace("_", "-")}="{v}"' for k, v in kw.items())
    return f'<rect x="{X_(x0):.1f}" y="{Y_(y0):.1f}" width="{(x1 - x0) * SC:.1f}" height="{(y1 - y0) * SC:.1f}" {st}/>'


def circ(x, y, r, **kw):
    st = " ".join(f'{k.replace("_", "-")}="{v}"' for k, v in kw.items())
    return f'<circle cx="{X_(x):.1f}" cy="{Y_(y):.1f}" r="{r * SC:.1f}" {st}/>'


def text(x, y, s, size=11, fill="#000", anchor="start"):
    return f'<text x="{X_(x):.1f}" y="{Y_(y):.1f}" font-family="sans-serif" font-size="{size}" fill="{fill}" text-anchor="{anchor}">{s}</text>'


def host_layer(el):
    # board outline, F.Cu tracks / pads / vias, courtyards
    for k in t:
        if isinstance(k, list) and k and k[0] == "gr_rect" and str(first(k, "layer")[1]) == "Edge.Cuts":
            s, e = first(k, "start"), first(k, "end")
            el.append(rect(float(s[1]), float(s[2]), float(e[1]), float(e[2]), fill="none", stroke="#000", stroke_width=1.5))
    # outline from lines if no rect
    for k in t:
        if isinstance(k, list) and k and k[0] == "gr_line" and str(first(k, "layer")[1]) == "Edge.Cuts":
            s, e = first(k, "start"), first(k, "end")
            el.append(f'<line x1="{X_(float(s[1])):.1f}" y1="{Y_(float(s[2])):.1f}" x2="{X_(float(e[1])):.1f}" y2="{Y_(float(e[2])):.1f}" stroke="#000" stroke-width="1.5"/>')
    for s in kids(t, "segment"):
        if str(first(s, "layer")[1]) == "F.Cu":
            p, q = first(s, "start"), first(s, "end"); w = float(first(s, "width")[1])
            el.append(f'<line x1="{X_(float(p[1])):.1f}" y1="{Y_(float(p[2])):.1f}" x2="{X_(float(q[1])):.1f}" y2="{Y_(float(q[2])):.1f}" stroke="#c83232" stroke-opacity="0.75" stroke-width="{w * SC:.1f}" stroke-linecap="round"/>')
    for v in kids(t, "via"):
        at = first(v, "at"); el.append(circ(float(at[1]), float(at[2]), float(first(v, "size")[1]) / 2, fill="#e8b4b4", stroke="#7a1f1f", stroke_width=0.6))
    for f in kids(t, "footprint"):
        ref = [str(p[2]) for p in kids(f, "property") if str(p[1]) == "Reference"][0]
        at = first(f, "at"); x, y = float(at[1]), float(at[2]); r = float(at[3]) if len(at) > 3 else 0; th = math.radians(r)
        for p in kids(f, "pad"):
            lay = [str(v) for v in first(p, "layers")[1:]]
            if "F.Cu" not in lay and "*.Cu" not in lay: continue
            pa = first(p, "at"); lx, ly = float(pa[1]), float(pa[2]); sz = first(p, "size"); w, h = float(sz[1]), float(sz[2])
            px = x + lx * math.cos(th) + ly * math.sin(th); py = y - lx * math.sin(th) + ly * math.cos(th)
            if int(round(r / 90)) % 2: w, h = h, w
            col = "#2a62c8" if ref == "U1" else "#a02828"
            el.append(rect(px - w / 2, py - h / 2, px + w / 2, py + h / 2, fill=col, fill_opacity=0.55, stroke=col, stroke_width=0.6))
        if ref != "U1":
            for k in f:
                if isinstance(k, list) and k[0] == "fp_rect" and str(first(k, "layer")[1]) == "F.CrtYd":
                    s_, e_ = first(k, "start"), first(k, "end")
                    cs = [(x + float(q[1]) * math.cos(th) + float(q[2]) * math.sin(th), y - float(q[1]) * math.sin(th) + float(q[2]) * math.cos(th)) for q in (s_, e_)]
                    x0, x1 = sorted((cs[0][0], cs[1][0])); y0, y1 = sorted((cs[0][1], cs[1][1]))
                    el.append(rect(x0, y0, x1, y1, fill="none", stroke="#888", stroke_width=0.7, stroke_dasharray="3,2"))
                    el.append(text((x0 + x1) / 2, (y0 + y1) / 2 + 0.2, ref, 8, "#555", "middle"))


def module_outline(el, col="#0050d0"):
    pts = []
    for seg in G["_seeed_outline_u_v"]:
        d = "M " + " L ".join(f"{X_(T[0] - u):.1f},{Y_(T[1] - v):.1f}" for u, v in seg)
        el.append(f'<path d="{d}" fill="none" stroke="{col}" stroke-width="2"/>')


def legend(el, items):
    y = Hh - 80
    for col, name in items:
        el.append(f'<rect x="{10}" y="{y - 9}" width="14" height="10" fill="{col}" fill-opacity="0.7" stroke="{col}"/><text x="30" y="{y}" font-family="sans-serif" font-size="11">{name}</text>'); y += 15


# ---------- BOTTOM overlay: module underside (seen from the host board's top) on host F.Cu
el = svg_start(); host_layer(el); module_outline(el)
for r in G["castellations"]:
    u, v = r["module_u"], r["module_v"]
    cx, cy = r["board_x"], r["board_y"]
    # module bottom copper bbox in board frame
    bb = None
for p in S["pads"]:
    if p["ref"] == "U9" and p["shape"] == "custom" and "B.Cu" in p["layers"]:
        x0, y0 = b(p["bbox"][0], p["bbox"][1]); x1, y1 = b(p["bbox"][2], p["bbox"][3])
        el.append(rect(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1), fill="#00a8c8", fill_opacity=0.5, stroke="#007a94", stroke_width=0.8))
for e in G["underside"]:
    col = "#ff8c00"
    if e["shape"] == "circle":
        el.append(circ(e["bx"], e["by"], e["w"] / 2, fill=col, fill_opacity=0.65, stroke="#a35200", stroke_width=0.8))
    else:
        el.append(rect(e["bx"] - e["w"] / 2, e["by"] - e["h"] / 2, e["bx"] + e["w"] / 2, e["by"] + e["h"] / 2, fill=col if e["name"] != "PAD25_window" else "#ffd9a0", fill_opacity=0.6, stroke="#a35200", stroke_width=0.8))
    el.append(text(e["bx"] + 0.15, e["by"] - 0.55, e["name"].replace("PAD25_window", "pad25"), 8, "#703800"))
bat = G["bat"]["host_post"]
el.append(circ(bat["x"], bat["y"], 0.7, fill="#ffffff", stroke="#000", stroke_width=1.2))
el.append(circ(bat["x"], bat["y"], 0.95, fill="none", stroke="#000", stroke_width=0.8, stroke_dasharray="2,2"))
el.append(text(bat["x"] + 1.1, bat["y"] + 0.1, "BAT+ post hole Ø1.40", 9))
el.append(text(24.3, 36.8, "RB-04C BOTTOM overlay (module underside over host F.Cu)", 12))
legend(el, [("#2a62c8", "host U1 castellation pads (2.9 x 1.5)"), ("#a02828", "host F.Cu pads / tracks"), ("#00a8c8", "module castellation copper"), ("#ff8c00", "module exposed bottom pads")])
el.append("</svg>")
(out / "overlay_bottom.svg").write_text("\n".join(el))
# ---------- TOP overlay: module top parts + USB-C + U.FL on the host with its courtyards
el = svg_start(); host_layer(el); module_outline(el)
for f in S["footprints"]:
    bx_ = f["boxes"].get("F.CrtYd")
    if bx_ and f["ref"] not in ("U1",):
        x0, y0 = b(bx_[0], bx_[1]); x1, y1 = b(bx_[2], bx_[3])
        el.append(rect(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1), fill="#40a040", fill_opacity=0.25, stroke="#206020", stroke_width=0.6))
for ref, fill in (("U1", "#808080"),):
    for f in S["footprints"]:
        if f["ref"] == ref and f["boxes"].get("F.CrtYd"):
            bx_ = f["boxes"]["F.CrtYd"]; x0, y0 = b(bx_[0], bx_[1]); x1, y1 = b(bx_[2], bx_[3])
            el.append(rect(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1), fill="#808080", fill_opacity=0.25, stroke="#404040", stroke_width=0.6))
# USB-C receptacle (width 9.0, v -1.508 .. 5.842, centred u 8.89)
ux0, uy0 = T[0] - (8.89 + 4.5), T[1] - (-1.508); ux1, uy1 = T[0] - (8.89 - 4.5), T[1] - 5.842
el.append(rect(min(ux0, ux1), min(uy0, uy1), max(ux0, ux1), max(uy0, uy1), fill="#d0d0ff", fill_opacity=0.6, stroke="#2020a0", stroke_width=1))
el.append(text(T[0] - 8.89, T[1] - 2.2, "USB-C receptacle 9.0 mm (overhangs 1.5 mm)", 9, "#202080", "middle"))
fx, fy = G["ufl"]["centre_board"]
el.append(rect(fx - 1.4, fy - 1.3, fx + 1.4, fy + 1.3, fill="#ffd0d0", fill_opacity=0.7, stroke="#a02020", stroke_width=1))
el.append(text(fx, fy + 0.15, "U.FL", 9, "#600000", "middle"))
el.append(text(24.3, 36.8, "RB-04C TOP overlay (module top parts, USB-C, U.FL)", 12))
legend(el, [("#2a62c8", "host U1 castellation pads"), ("#40a040", "module top parts"), ("#a02828", "host F.Cu"), ("#d0d0ff", "USB-C")])
el.append("</svg>")
(out / "overlay_top.svg").write_text("\n".join(el))
for n in ("overlay_bottom", "overlay_top"):
    subprocess.run(["rsvg-convert", "-o", str(out / f"{n}.png"), str(out / f"{n}.svg")], check=True)
print("ok")
