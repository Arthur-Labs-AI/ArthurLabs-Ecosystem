#!/usr/bin/env python3
"""RB-04I: read-only absolute-coordinate comparison of the installed U1 footprint (canonical PCB) with the library footprint
ARTHUR:XIAO_ESP32S3_HANDSOLDER, and of the library's embedded keep-out zones with the board-level rule areas.
    python3 rb04i_u1_compare.py --pcb board.kicad_pcb --lib footprint.kicad_mod --out compare.json
Nothing is written to the project."""
import argparse, json, math, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_sexpr import parse, kids, first
ap = argparse.ArgumentParser(); ap.add_argument("--pcb", required=True); ap.add_argument("--lib", required=True); ap.add_argument("--out", required=True)
a = ap.parse_args()
t = parse(Path(a.pcb).read_text()); m = parse(Path(a.lib).read_text())
u1 = [f for f in kids(t, "footprint") if any(str(p[1]) == "Reference" and str(p[2]) == "U1" for p in kids(f, "property"))][0]
at = first(u1, "at"); FX, FY, FR = float(at[1]), float(at[2]), float(at[3])
def tr(x, y):
    th = math.radians(FR)
    return (round(FX + x * math.cos(th) + y * math.sin(th), 3), round(FY - x * math.sin(th) + y * math.cos(th), 3))
def xy(n): return float(n[1]), float(n[2])
def seg(p, q): return tuple(sorted((p, q)))
def items(f, with_pose_rot):
    out = {"pad": [], "line": [], "rect": [], "circle": [], "arc": [], "text": [], "poly": []}
    for p in kids(f, "pad"):
        pa = first(p, "at"); sz = first(p, "size"); dr = first(p, "drill")
        lay = tuple(sorted(l if l != "F.Mask" and l != "B.Mask" else "*.Mask" for l in [str(x) for x in first(p, "layers")[1:]] if l not in ("F.Mask", "B.Mask") or True))
        lay = tuple(sorted(set("*.Mask" if x in ("F.Mask", "B.Mask") and ("F.Mask" in [str(y) for y in first(p, "layers")[1:]] and "B.Mask" in [str(y) for y in first(p, "layers")[1:]]) else x for x in [str(y) for y in first(p, "layers")[1:]])))
        mm = first(p, "solder_mask_margin")
        out["pad"].append((str(p[1]), str(p[2]), str(p[3]), tr(*xy(pa)), (float(sz[1]), float(sz[2])), float(dr[1]) if dr else None, lay, float(mm[1]) if mm else 0.0))
    for k in kids(f, "fp_line"):
        out["line"].append((str(first(k, "layer")[1]), seg(tr(*xy(first(k, "start"))), tr(*xy(first(k, "end")))), float(first(first(k, "stroke"), "width")[1])))
    for k in kids(f, "fp_rect"):
        a_, b_ = tr(*xy(first(k, "start"))), tr(*xy(first(k, "end")))
        out["rect"].append((str(first(k, "layer")[1]), (min(a_[0], b_[0]), min(a_[1], b_[1]), max(a_[0], b_[0]), max(a_[1], b_[1]))))
    for k in kids(f, "fp_circle"):
        out["circle"].append((str(first(k, "layer")[1]), tr(*xy(first(k, "center"))), round(math.hypot(float(first(k, "end")[1]) - float(first(k, "center")[1]), float(first(k, "end")[2]) - float(first(k, "center")[2])), 3)))
    for k in kids(f, "fp_arc"):
        s, mi, e = tr(*xy(first(k, "start"))), tr(*xy(first(k, "mid"))), tr(*xy(first(k, "end")))
        out["arc"].append((str(first(k, "layer")[1]), tuple(sorted((s, e))), mi))
    for k in kids(f, "fp_text"):
        pa = first(k, "at"); out["text"].append((str(k[1]), str(k[2]), str(first(k, "layer")[1]), tr(float(pa[1]), float(pa[2]))))
    for k in kids(f, "fp_poly"):
        out["poly"].append((str(first(k, "layer")[1]), tuple(sorted(tr(*xy(p)) for p in first(first(k, "pts"), "xy") if False) )))
    return out
A = items(u1, True); B = items(m, False)
res = {}
for k in A:
    sa = sorted(map(repr, A[k])); sb = sorted(map(repr, B[k]))
    only_board = [x for x in sa if x not in sb]; only_lib = [x for x in sb if x not in sa]
    res[k] = dict(board=len(sa), lib=len(sb), only_board=only_board, only_lib=only_lib)
# properties
pa = {str(p[1]): (str(p[2]), str(first(p, "layer")[1]), first(p, "hide") is not None) for p in kids(u1, "property")}
pb = {str(p[1]): (str(p[2]), str(first(p, "layer")[1]), first(p, "hide") is not None) for p in kids(m, "property")}
res["properties"] = dict(board=pa, lib=pb)
# zones: lib embedded vs board-level rule areas (absolute polygons)
def zones_lib(t_, transform):
    out = {}
    for z in kids(t_, "zone"):
        if first(z, "keepout") is None: continue
        nm = str(first(z, "name")[1]) if first(z, "name") else ""
        pts = [xy(p) for p in first(first(z, "polygon"), "pts")[1:] if p[0] == "xy"]
        pts = sorted(transform(*p) for p in pts)
        lay = first(z, "layers"); lay = [str(x) for x in lay[1:]] if lay else [str(first(z, "layer")[1])]
        ko = {str(k[0]): str(k[1]) for k in first(z, "keepout")[1:]}
        out[nm] = dict(layers=sorted(lay), keepout=ko, poly=pts)
    return out
zl = zones_lib(m, tr)
zb = zones_lib(t, lambda x, y: (round(x, 3), round(y, 3)))
zres = {}
for nm in sorted(set(zl) | set(zb)):
    if nm not in zb: zres[nm] = "ONLY IN LIBRARY"; continue
    if nm not in zl: zres[nm] = "board-level only (not part of U1)"; continue
    A_, B_ = zl[nm], zb[nm]
    dmax = max(math.dist(p, q) for p, q in zip(A_["poly"], sorted(B_["poly"]))) if len(A_["poly"]) == len(B_["poly"]) else None
    zres[nm] = dict(layers_equal=A_["layers"] == B_["layers"], keepout_equal=A_["keepout"] == B_["keepout"], polygon_max_corner_delta_mm=round(dmax, 4) if dmax is not None else "n/a", lib_layers=A_["layers"], keepout=A_["keepout"])
res["zones"] = zres
res["footprint_instance"] = dict(at=[FX, FY, FR], embedded_zones_in_board_instance=len(kids(u1, "zone")), embedded_zones_in_library=len(kids(m, "zone")))
json.dump(res, open(a.out, "w"), indent=1, default=str)
for k in ("pad", "line", "rect", "circle", "arc", "text"):
    print(k, "board", res[k]["board"], "lib", res[k]["lib"], "only_board", len(res[k]["only_board"]), "only_lib", len(res[k]["only_lib"]))
print("zones:", json.dumps(zres, indent=0, default=str)[:3000])
print(res["footprint_instance"])
