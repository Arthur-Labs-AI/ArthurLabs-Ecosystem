#!/usr/bin/env python3
"""RB-02A: extract mechanical geometry from a Seeed XIAO ESP32-S3 KiCad PCB (pure python, no KiCad needed).

    python3 rb02a_xiao_cad_extract.py <file.kicad_pcb> [-o out.json]

Output JSON (all lengths mm, board coordinates of the source file, +y down as in KiCad):
  meta      : file sha256, generator/version, thickness, copper layers, stackup
  outline   : Edge.Cuts bounding box, segment count, corner radii found
  footprints: reference, value, library name, layer, position, rotation, side
  pads      : reference, number, net, layer(s), absolute centre, size, shape, drill, absolute rotation
  provenance of each number is "pcb-geometry" (parsed from the manufacturer file); nothing is typed in by hand.

The footprint-local -> board transform follows the KiCad file format: for a footprint at (x, y) with angle a,
a pad at (px, py) is at (x, y) + R(a)·(px, py); bottom-side footprints are stored already mirrored, so the same
formula applies (validated in the comparison script against single-pad bottom footprints).
"""
import argparse
import hashlib
import json
import math
import re
import sys
from pathlib import Path


def parse(text):
    tok = re.compile(r'\(|\)|"(?:\\.|[^"\\])*"|[^\s()"]+')
    stack = [[]]
    for m in tok.finditer(text):
        t = m.group(0)
        if t == "(":
            stack.append([])
        elif t == ")":
            x = stack.pop()
            stack[-1].append(x)
        else:
            if t[0] == '"':
                t = t[1:-1].replace('\\"', '"')
            stack[-1].append(t)
    return stack[0][0]


def kids(node, name):
    return [c for c in node if isinstance(c, list) and c and c[0] == name]


def first(node, name, default=None):
    k = kids(node, name)
    return k[0] if k else default


def f(x):
    return float(x)


def rot(px, py, a_deg):
    a = math.radians(a_deg)
    # KiCad angles are counter-clockwise on screen with +y down -> x' = x cos + y sin, y' = -x sin + y cos
    return (px * math.cos(a) + py * math.sin(a), -px * math.sin(a) + py * math.cos(a))


def extract(path):
    raw = Path(path).read_bytes()
    root = parse(raw.decode("utf-8"))
    out = {"meta": {"file": Path(path).name, "sha256": hashlib.sha256(raw).hexdigest(),
                    "generator": (first(root, "generator") or ["", ""])[1],
                    "generator_version": (first(root, "generator_version") or ["", ""])[1],
                    "format_version": (first(root, "version") or ["", ""])[1]}}
    gen = first(root, "general")
    out["meta"]["thickness_mm"] = f(first(gen, "thickness")[1]) if gen and first(gen, "thickness") else None
    layers = first(root, "layers")
    out["meta"]["copper_layers"] = [l[1] for l in layers[1:] if len(l) > 2 and l[2] in ("signal", "power", "mixed")]
    setup = first(root, "setup")
    st = first(setup, "stackup") if setup else None
    if st:
        out["meta"]["stackup"] = [{"layer": l[1], "type": (first(l, "type") or ["", ""])[1],
                                   "thickness": f(first(l, "thickness")[1]) if first(l, "thickness") else None}
                                  for l in kids(st, "layer")]
    nets = {n[1]: n[2] for n in kids(root, "net")}

    # ---- outline (Edge.Cuts graphics on the board and inside footprints)
    xs, ys, segs, arcs = [], [], 0, 0
    def edge_items(node, ox=0.0, oy=0.0, a=0.0, top=True):
        nonlocal segs, arcs
        for kind in ("gr_line", "gr_arc", "gr_rect", "gr_circle", "gr_poly", "fp_line", "fp_arc", "fp_rect", "fp_poly"):
            for it in kids(node, kind):
                ly = first(it, "layer")
                if not ly or ly[1] != "Edge.Cuts":
                    continue
                pts = []
                for key in ("start", "end", "mid", "center"):
                    p = first(it, key)
                    if p:
                        pts.append((f(p[1]), f(p[2])))
                pp = first(it, "pts")
                if pp:
                    for xy in kids(pp, "xy"):
                        pts.append((f(xy[1]), f(xy[2])))
                if kind.endswith("arc"):
                    arcs += 1
                else:
                    segs += 1
                for px, py in pts:
                    if node is root:
                        xs.append(px); ys.append(py)
                    else:
                        rx, ry = rot(px, py, a)
                        xs.append(ox + rx); ys.append(oy + ry)
    edge_items(root)
    fps = kids(root, "footprint")
    for fp in fps:
        at = first(fp, "at")
        edge_items(fp, f(at[1]), f(at[2]), f(at[3]) if len(at) > 3 else 0.0)
    out["outline"] = {"bbox": [min(xs), min(ys), max(xs), max(ys)] if xs else None,
                      "width": (max(xs) - min(xs)) if xs else None, "height": (max(ys) - min(ys)) if ys else None,
                      "segments": segs, "arcs": arcs, "source": "Edge.Cuts"}

    def fp_boxes(fp, fx, fy, fa):
        """absolute bounding boxes of courtyard / fabrication / silk graphics of one footprint, per layer."""
        boxes = {}
        for kind in ("fp_line", "fp_arc", "fp_rect", "fp_circle", "fp_poly"):
            for it in kids(fp, kind):
                ly = first(it, "layer")
                if not ly or not re.search(r"(CrtYd|Fab)$", ly[1]):
                    continue
                pts = []
                for key in ("start", "end", "mid"):
                    p = first(it, key)
                    if p:
                        pts.append((f(p[1]), f(p[2])))
                c = first(it, "center")
                e = first(it, "end")
                if c and e and kind == "fp_circle":
                    r = math.hypot(f(e[1]) - f(c[1]), f(e[2]) - f(c[2]))
                    pts += [(f(c[1]) - r, f(c[2]) - r), (f(c[1]) + r, f(c[2]) + r)]
                pp = first(it, "pts")
                if pp:
                    pts += [(f(xy[1]), f(xy[2])) for xy in kids(pp, "xy")]
                for px, py in pts:
                    rx, ry = rot(px, py, fa)
                    b = boxes.setdefault(ly[1], [1e9, 1e9, -1e9, -1e9])
                    b[0] = min(b[0], fx + rx); b[1] = min(b[1], fy + ry)
                    b[2] = max(b[2], fx + rx); b[3] = max(b[3], fy + ry)
        return boxes

    # ---- footprints and pads
    out["footprints"], out["pads"] = [], []
    for fp in fps:
        at = first(fp, "at")
        fx, fy, fa = f(at[1]), f(at[2]), (f(at[3]) if len(at) > 3 else 0.0)
        layer = first(fp, "layer")[1]
        props = {p[1]: p[2] for p in kids(fp, "property")}
        ref = props.get("Reference", "")
        out["footprints"].append({"ref": ref, "value": props.get("Value", ""), "library": fp[1], "layer": layer,
                                  "x": fx, "y": fy, "rotation": fa, "boxes": fp_boxes(fp, fx, fy, fa)})
        for pad in kids(fp, "pad"):
            pat = first(pad, "at")
            px, py = f(pat[1]), f(pat[2])
            pa = f(pat[3]) if len(pat) > 3 else 0.0
            rx, ry = rot(px, py, fa)
            size = first(pad, "size")
            drill = first(pad, "drill")
            net = first(pad, "net")
            nm = ""
            if net:
                nm = net[2] if len(net) > 2 else nets.get(net[1], "")
            lyr = first(pad, "layers")
            # copper bounding box in board coordinates (pad angle in the file is absolute)
            def pad_bbox():
                import math as _m
                ang = pa % 360
                w, h = f(size[1]), f(size[2])
                if round(ang) % 180 == 90:
                    w, h = h, w
                bx = [fx + rx - w / 2, fy + ry - h / 2, fx + rx + w / 2, fy + ry + h / 2]
                prim = first(pad, "primitives")
                if pad[3] == "custom" and prim:
                    ca, sa = _m.cos(_m.radians(pa)), _m.sin(_m.radians(pa))
                    def L(px_, py_):   # local pad frame -> board
                        return (fx + rx + px_ * ca + py_ * sa, fy + ry - px_ * sa + py_ * ca)
                    for pr in prim[1:]:
                        if not isinstance(pr, list):
                            continue
                        if pr[0] == "gr_circle":
                            c = first(pr, "center"); e = first(pr, "end")
                            cx_, cy_ = f(c[1]), f(c[2])
                            r_ = _m.hypot(f(e[1]) - cx_, f(e[2]) - cy_)
                            X, Y = L(cx_, cy_)
                            bx = [min(bx[0], X - r_), min(bx[1], Y - r_), max(bx[2], X + r_), max(bx[3], Y + r_)]
                        elif pr[0] == "gr_poly":
                            for xy in kids(first(pr, "pts"), "xy"):
                                X, Y = L(f(xy[1]), f(xy[2]))
                                bx = [min(bx[0], X), min(bx[1], Y), max(bx[2], X), max(bx[3], Y)]
                return bx
            out["pads"].append({
                "bbox": pad_bbox(),
                "ref": ref, "number": pad[1], "type": pad[2], "shape": pad[3], "net": nm,
                "pinfunction": (first(pad, "pinfunction") or ["", ""])[1],
                "layers": lyr[1:] if lyr else [], "x": fx + rx, "y": fy + ry, "rotation": pa,
                "w": f(size[1]), "h": f(size[2]),
                "drill": f(drill[1]) if drill and len(drill) > 1 and re.fullmatch(r"[-0-9.]+", drill[1]) else None,
                "footprint_layer": layer})
    # ---- zones (pours, keep-outs, mask windows): layer(s), net, polygon bounding box
    out["zones"] = []
    for z in kids(root, "zone"):
        ly = first(z, "layer") or first(z, "layers")
        lyr = ly[1:] if ly else []
        poly = first(first(z, "polygon") or [], "pts")
        pts = [(f(xy[1]), f(xy[2])) for xy in kids(poly, "xy")] if poly else []
        ko = first(z, "keepout")
        out["zones"].append({
            "net": (first(z, "net_name") or ["", ""])[1], "layers": lyr, "name": (first(z, "name") or ["", ""])[1],
            "keepout": ({k[0]: k[1] for k in ko[1:] if isinstance(k, list) and len(k) > 1} if ko else None),
            "bbox": [min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)] if pts else None,
            "points": pts})
    # ---- vias (plated barrels), for under-module keep-out analysis
    out["vias"] = [{"x": f(first(v, "at")[1]), "y": f(first(v, "at")[2]), "size": f(first(v, "size")[1]),
                    "drill": f(first(v, "drill")[1]), "net": (first(v, "net") or ["", ""])[1]} for v in kids(root, "via")]
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pcb", type=Path)
    ap.add_argument("-o", "--out", type=Path)
    a = ap.parse_args(argv)
    data = extract(a.pcb)
    txt = json.dumps(data, indent=1)
    if a.out:
        a.out.write_text(txt)
        print(f"{a.pcb.name}: {len(data['footprints'])} footprints, {len(data['pads'])} pads -> {a.out}")
    else:
        print(txt)
    return 0


if __name__ == "__main__":
    sys.exit(main())
