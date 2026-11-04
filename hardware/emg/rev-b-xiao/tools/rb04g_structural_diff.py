#!/usr/bin/env python3
"""RB-04G: structural (semantic, uuid-agnostic) diff between the pre-R1b and the installed PCB.  Exit 1 on any unexpected change.
    python3 rb04g_structural_diff.py --old archive/.../ARTHUR_EMG_RevB.kicad_pcb --new kicad/.../ARTHUR_EMG_RevB.kicad_pcb --out diff.json"""
import argparse, json, math, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_sexpr import parse, kids, first
ap = argparse.ArgumentParser(); ap.add_argument("--old", required=True); ap.add_argument("--new", required=True); ap.add_argument("--out", required=True)
ap.add_argument("--ignore-metadata-properties", action="store_true", help="RB-04H: ignore hidden custom footprint properties (everything except Reference/Value)")
a = ap.parse_args()
A = parse(Path(a.old).read_text()); B = parse(Path(a.new).read_text())
def strip(n):
    if isinstance(n, list):
        return [strip(c) for c in n if not (isinstance(c, list) and c and c[0] in ("uuid", "tstamp"))]
    return n
def canon(n): return json.dumps(strip(n), sort_keys=True, default=str)
res = {}; bad = []
def cmp(name, ea, eb):
    ok = sorted(canon(x) for x in ea) == sorted(canon(x) for x in eb)
    res[name] = dict(count_old=len(ea), count_new=len(eb), identical=ok)
    if not ok: bad.append(name)
for n in ("segment", "via", "gr_line", "gr_arc", "gr_rect", "gr_circle", "gr_poly", "gr_text", "net", "dimension", "group"):
    cmp(n, kids(A, n), kids(B, n))
for n in ("general", "layers", "setup", "title_block", "paper", "version"):
    ea, eb = first(A, n), first(B, n)
    same = canon(ea) == canon(eb); res[n] = dict(identical=same)
    if not same: bad.append(n)
def drop_props(f):
    return [c for c in f if not (isinstance(c, list) and c and c[0] == "property" and str(c[1]) not in ("Reference", "Value"))]
# footprints
def fps(t):
    d = {}
    for f in kids(t, "footprint"):
        ref = [str(p[2]) for p in kids(f, "property") if str(p[1]) == "Reference"][0]
        d[ref] = f
    return d
fa, fb = fps(A), fps(B)
res["footprints"] = dict(old=len(fa), new=len(fb), same_refs=sorted(fa) == sorted(fb))
changed = []; pos = []
for r in fa:
    ea, eb = fa[r], fb[r]
    pa, pb = first(ea, "at"), first(eb, "at")
    pos.append((r, canon(pa) == canon(pb), canon(first(ea, "layer")) == canon(first(eb, "layer"))))
    if r == "U1":
        def nopad23(f):
            g = drop_props(f) if a.ignore_metadata_properties else f
            return [c for c in g if not (isinstance(c, list) and c[0] == "pad" and str(c[1]) == "23" and str(c[2]) == "thru_hole")]
        rest_same = canon(nopad23(ea)) == canon(nopad23(eb))
        p_old = [p for p in kids(ea, "pad") if str(p[1]) == "23" and str(p[2]) == "thru_hole"][0]
        p_new = [p for p in kids(eb, "pad") if str(p[1]) == "23" and str(p[2]) == "thru_hole"][0]
        res["U1_other_content_identical"] = rest_same
        res["U1_pad23_old"] = {k: strip(first(p_old, k)) for k in ("at", "size", "drill", "layers", "net", "solder_mask_margin")}
        res["U1_pad23_new"] = {k: strip(first(p_new, k)) for k in ("at", "size", "drill", "layers", "net", "solder_mask_margin")}
        smd_old = [p for p in kids(ea, "pad") if str(p[1]) == "23" and str(p[2]) == "smd"][0]; smd_new = [p for p in kids(eb, "pad") if str(p[1]) == "23" and str(p[2]) == "smd"][0]
        res["U1_bcu_pad23_identical"] = canon(smd_old) == canon(smd_new)
        if not rest_same or not res["U1_bcu_pad23_identical"]: bad.append("U1 content")
    elif (canon(drop_props(ea)) != canon(drop_props(eb))) if a.ignore_metadata_properties else (canon(ea) != canon(eb)):
        changed.append(r)
res["footprints_changed_other_than_U1_pad23"] = changed; res["positions_and_layers_identical"] = all(p[1] and p[2] for p in pos)
if changed or not res["positions_and_layers_identical"] or not res["footprints"]["same_refs"]: bad.append("footprints")
# zones: rule areas identical, filled-polygon area per layer
def zone_info(t):
    out = {}; rules = []
    for z in kids(t, "zone"):
        keep = first(z, "keepout")
        key = canon([c for c in z if not (isinstance(c, list) and c[0] in ("filled_polygon", "fill"))])
        if keep: rules.append(key)
        else: rules.append(key)
        for fp in kids(z, "filled_polygon"):
            l = str(first(fp, "layer")[1]); pts = first(fp, "pts"); xy = [(float(p[1]), float(p[2])) for p in pts[1:] if p[0] == "xy"]
            ar = sum(xy[i][0] * xy[(i + 1) % len(xy)][1] - xy[(i + 1) % len(xy)][0] * xy[i][1] for i in range(len(xy))) / 2
            out[l] = out.get(l, 0) + ar
    return sorted(rules), {k: round(v, 2) for k, v in out.items()}
ra, aa = zone_info(A); rb, ab = zone_info(B)
res["zone_definitions_identical"] = ra == rb; res["fill_area_mm2_old"] = aa; res["fill_area_mm2_new"] = ab
if ra != rb: bad.append("zone definitions")
# outline bounding box
def outline(t):
    xs = []; ys = []
    for k in t:
        if isinstance(k, list) and k and k[0] in ("gr_line", "gr_arc", "gr_rect") and first(k, "layer") and str(first(k, "layer")[1]) == "Edge.Cuts":
            for nm in ("start", "end", "mid"):
                q = first(k, nm)
                if q: xs.append(float(q[1])); ys.append(float(q[2]))
    return [min(xs), min(ys), max(xs), max(ys)]
res["outline_old"], res["outline_new"] = outline(A), outline(B)
res["unexpected"] = bad
json.dump(res, open(a.out, "w"), indent=1, default=str)
print(json.dumps({k: v for k, v in res.items() if k not in ("U1_pad23_old", "U1_pad23_new")}, indent=1, default=str))
print("U1 pad 23 old:", res["U1_pad23_old"]); print("U1 pad 23 new:", res["U1_pad23_new"])
sys.exit(1 if bad else 0)
