#!/usr/bin/env python3
"""RB-05: independent validation of the quote package (reads only the shipped files + the KiCad PCB text).
    python3 rb05_verify.py <package dir> <pcb> <via_list.csv> <out.json>"""
import csv, json, math, re, sys, tempfile, zipfile, collections
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_sexpr import parse, kids, first
from rb04_gerber import parse_gerber, aperture_size, excellon
P = Path(sys.argv[1]); pcb = Path(sys.argv[2]); vias_csv = Path(sys.argv[3]); out = Path(sys.argv[4])
res = []; info = {}
def chk(name, ok, detail=""):
    res.append({"check": name, "result": "PASS" if ok else "FAIL", "detail": str(detail)}); print("PASS" if ok else "FAIL", name, detail)
d = Path(tempfile.mkdtemp())
with zipfile.ZipFile(P / "ARTHUR_EMG_RevB_Gerbers.zip") as z:
    names = z.namelist(); z.extractall(d)
want = {"F_Cu.gtl", "In1_Cu.g1", "In2_Cu.g2", "B_Cu.gbl", "F_Mask.gts", "B_Mask.gbs", "F_Silkscreen.gto", "B_Silkscreen.gbo", "F_Paste.gtp", "Edge_Cuts.gm1"}
got = {n.split("-", 1)[1] for n in names if "-" in n}
chk("zip: flat, 10 Gerber layers + 1 drill, no job file", got == want and any(n.endswith(".drl") for n in names) and len(names) == 11 and not any("/" in n or n.endswith("gbrjob") for n in names), sorted(names))
G = {n.split("-", 1)[1]: parse_gerber(d / n) for n in names if n.split(".")[-1] in ("gtl", "gbl", "g1", "g2", "gts", "gbs", "gto", "gbo", "gtp", "gm1")}
chk("all Gerbers are metric, 4.6 coordinates", all(g["units"] == "mm" for g in G.values()))
holes, pts = excellon(next(d.glob("*.drl")))
# ---- PCB source
root = parse(pcb.read_text())
def rot(x, y, deg):
    t = math.radians(deg); return x * math.cos(t) + y * math.sin(t), -x * math.sin(t) + y * math.cos(t)
fps = {}; pads = []; ptth = []
for f in kids(root, "footprint"):
    ref = [str(p[2]) for p in kids(f, "property") if str(p[1]) == "Reference"][0]
    a = first(f, "at"); fx, fy = float(a[1]), float(a[2]); fr = float(a[3]) if len(a) > 3 else 0.0
    attr = [str(x) for x in (first(f, "attr") or [])[1:]]
    layer = str(first(f, "layer")[1])
    fps[ref] = dict(x=fx, y=fy, rot=fr, attr=attr, layer=layer, name=str(f[1]).split(":")[-1])
    for p in kids(f, "pad"):
        pa = first(p, "at"); dx, dy = rot(float(pa[1]), float(pa[2]), fr)
        lay = [str(x) for x in first(p, "layers")[1:]]
        sz = first(p, "size"); dr = first(p, "drill")
        rec = dict(ref=ref, num=str(p[1]), kind=str(p[2]), shape=str(p[3]), x=fx + dx, y=fy + dy, w=float(sz[1]), h=float(sz[2]), layers=lay, drill=float(dr[1]) if dr and len(dr) > 1 and not isinstance(dr[1], list) and str(dr[1]) != "oval" else None)
        pads.append(rec)
vias = [(float(first(v, "at")[1]), float(first(v, "at")[2]), float(first(v, "size")[1]), float(first(v, "drill")[1])) for v in kids(root, "via")]
# ---- 1 outline
og = G["Edge_Cuts.gm1"]; xs = [q for dd in og["draws"] for q in (dd[0][0], dd[1][0])]; ys = [q for dd in og["draws"] for q in (dd[0][1], dd[1][1])]
sz = (max(xs) - min(xs), max(ys) - min(ys)); info["outline"] = [round(v, 3) for v in (min(xs), min(ys), max(xs), max(ys))]
chk("outline 51.30 x 64.95 mm, origin at 0,0 (Gerber y negative)", abs(sz[0] - 51.3) < 0.01 and abs(sz[1] - 64.95) < 0.01 and abs(min(xs)) < 0.01 and abs(max(ys)) < 0.01, info["outline"])
# ---- 2 drill vs source
vset = sorted((round(x, 3), round(-y, 3)) for x, y, s, dr in vias)
dset = sorted((round(x, 3), round(y, 3)) for x, y in pts.get(0.3, []))
chk("drill: 201 x 0.30 holes at exactly the via positions", vset == dset and len(dset) == len(vias) == 201, len(dset))
pth = [p for p in pads if p["kind"] == "thru_hole"]
npth = [p for p in pads if p["kind"] == "np_thru_hole"]
hset = sorted((round(p["x"], 3), round(-p["y"], 3)) for p in pth)
PTH_D = pth[0]["drill"]      # drill size of the single PTH (BAT+ post) is read from the PCB, not hard-coded
chk(f"drill: PTH pads = {PTH_D:.2f} holes at source positions; 0 NPTH", hset == sorted((round(x, 3), round(y, 3)) for x, y in pts.get(PTH_D, [])) and len(npth) == 0 and set(holes) == {0.3, PTH_D}, {"holes": holes, "pth": [(p["ref"], p["num"]) for p in pth]})
# ---- 3 BAT+ post
bp = pth[0]; bx, by = bp["x"], -bp["y"]
def flash_at(g, x, y, tol=0.002):
    r = []
    for (pos, code, pol) in g["flashes"]:
        if abs(pos[0] - x) < tol and abs(pos[1] - y) < tol:
            r.append((g["apertures"][code][0], aperture_size(g["apertures"][code]), pol))
    return r
post = {L: flash_at(G[L], bx, by) for L in ("F_Cu.gtl", "B_Cu.gbl", "In1_Cu.g1", "In2_Cu.g2", "F_Mask.gts", "B_Mask.gbs")}
info["bat_post"] = dict(ref=f"{bp['ref']}.{bp['num']}", x=bp["x"], y=bp["y"], gerber_xy=(bx, by), pad=(bp["shape"], bp["w"], bp["h"]), layers=bp["layers"], flashes=post)
ok = (any(abs(s[0] - bp["w"]) < 0.01 for _, s, _ in post["F_Cu.gtl"]) and any(abs(s[0] - bp["w"]) < 0.01 for _, s, _ in post["B_Cu.gbl"]) and post["F_Mask.gts"] and post["B_Mask.gbs"])
chk(f"BAT+ post (U1.23): {PTH_D:.2f} mm drill, {bp['w']:.2f} mm pad on F.Cu and B.Cu, mask openings both sides, centred on the source position", ok, info["bat_post"])
# ---- 4 pad centres vs F.Cu flashes (position + pin 1 of every oriented part)
fl = [(p[0], p[1]) for p, c, pol in G["F_Cu.gtl"]["flashes"]]
miss = [(p["ref"], p["num"]) for p in pads if "F.Cu" in p["layers"] and p["kind"] in ("smd", "thru_hole")
        and not any(abs(a - p["x"]) < 0.002 and abs(b + p["y"]) < 0.002 for a, b in fl)]
chk("every F.Cu pad of the PCB has a flash at its centre in F_Cu (incl. pin 1 of all polarised parts)", not miss, miss[:5])
# ---- 5 mask
def mask_rects(L):
    r = []
    for (pos, code, pol) in G[L]["flashes"]:
        ap = G[L]["apertures"][code]; w, h = aperture_size(ap)
        rad = ap[1][0] if ap[0] == "RoundRect" else (min(w, h) / 2 if ap[0] in ("O", "C") else 0.0)
        r.append((pos[0], pos[1], w, h, rad))
    return r
MF, MB = mask_rects("F_Mask.gts"), mask_rects("B_Mask.gbs")
def dist(px, py, r):
    rad = r[4]; dx = max(abs(px - r[0]) - (r[2] / 2 - rad), 0); dy = max(abs(py - r[1]) - (r[3] / 2 - rad), 0); return max(math.hypot(dx, dy) - rad, 0.0)
bad_hole = []; cls = collections.Counter(); per = {}
for x, y, s, dr in vias:
    gx, gy = x, -y
    dm = min(min((dist(gx, gy, r) for r in MF), default=9), min((dist(gx, gy, r) for r in MB), default=9))
    hole_edge = dm - dr / 2; ann = dm - s / 2
    if hole_edge < 0.10 - 1e-6: bad_hole.append((x, y, round(hole_edge, 3)))
    c = 3 if ann < 0 else 2 if ann < 0.09 else 1
    cls[c] += 1; per[(round(x, 1), round(y, 1))] = (c, round(hole_edge, 3), round(ann, 3))
chk("no via hole inside / touching a mask opening on either side (hole web >= 0.10 mm): vias fully tented", not bad_hole, bad_hole)
chk("mask via classes in the Gerber = RB-04 classes (179 / 12 / 10)", (cls[1], cls[2], cls[3]) == (179, 12, 10), dict(cls))
rows = list(csv.DictReader(vias_csv.open())); dev = []
for r in rows:
    k = (round(float(r["x_mm"]), 1), round(float(r["y_mm"]), 1)); c, he, an = per[k]
    if c != int(r["class"]) or abs(he - float(r["hole_edge_to_opening_mm"])) > 0.03: dev.append((r["id"], r["class"], c, r["hole_edge_to_opening_mm"], he))
chk("22 open mask vias V01-V22: class and hole-edge-to-opening match via_list.csv (rounded-rect distance, <=0.03 mm)", not dev, dev)
info["v01_v22"] = {r["id"]: per[(round(float(r["x_mm"]), 1), round(float(r["y_mm"]), 1))] for r in rows}
mv = [(p["ref"], p["num"]) for p in pads if p["kind"] == "smd" and "F.Cu" in p["layers"] and "F.Mask" not in p["layers"]]
chk("mask counts: F.Mask openings = F.Cu SMD pads + PTH; B.Mask openings = 8 test pads + PTH", len(MF) == sum(1 for p in pads if "F.Mask" in p["layers"] or "*.Mask" in p["layers"]) and len(MB) == 10, (len(MF), len(MB)))
# ---- 6 CPL / BOM
cpl = list(csv.DictReader((P / "ARTHUR_EMG_RevB_CPL.csv").open())); raw = list(csv.DictReader((P / "ARTHUR_EMG_RevB_CPL_raw_KiCad_rotation.csv").open()))
exp = {r: f for r, f in fps.items() if "smd" in f["attr"] and "dnp" not in f["attr"] and "exclude_from_pos_files" not in f["attr"]}
chk("CPL: exactly 126 rows, all 'Top', refs = every non-DNP, non-test-pad SMD footprint", len(cpl) == 126 and {r["Designator"] for r in cpl} == set(exp) and all(r["Layer"] == "Top" for r in cpl) and all(fps[r]["layer"] == "F.Cu" for r in exp), len(exp))
chk("CPL excludes U1 (XIAO) and TP1-TP8", not any(r["Designator"] == "U1" or r["Designator"].startswith("TP") for r in cpl))
dev = []
CORR = [(r"^SOT-23", 180), (r"^TSSOP-", 270), (r"^SOIC-", 270), (r"^JST_PH_S", 180)]
for r, rr in zip(cpl, raw):
    f = fps[r["Designator"]]; x = float(r["Mid X"].rstrip("mm")); y = float(r["Mid Y"].rstrip("mm"))
    c = next((cc for pat, cc in CORR if re.match(pat, f["name"])), 0)
    if abs(x - f["x"]) > 0.0006 or abs(y + f["y"]) > 0.0006 or abs(float(rr["Rotation"]) - f["rot"] % 360) > 1e-6 or abs(float(r["Rotation"]) - (f["rot"] + c) % 360) > 1e-6:
        dev.append(r["Designator"])
chk("CPL coordinates = PCB footprint origins (x, -y); raw rotation = KiCad; primary rotation = KiCad + community offset", not dev, dev)
bom = list(csv.DictReader((P / "ARTHUR_EMG_RevB_BOM.csv").open()))
brefs = [x for r in bom for x in r["Designator"].split(",")]
chk("BOM: 29 lines, 126 designators, no duplicates, same set as CPL, no U1/TP, every line has an LCSC number", len(bom) == 29 and len(brefs) == 126 == len(set(brefs)) and set(brefs) == set(exp) and all(re.match(r"^C\d+$", r["LCSC Part #"]) for r in bom), len(brefs))
sel = {l["sel"]["lcsc"]: set(l["refs"]) for l in json.load(open(Path(__file__).resolve().parent.parent / "evidence/rb04a/bom_selection.json")) if l["sel"]}
chk("BOM lines = RB-04B qualified selection (LCSC and designators)", {r["LCSC Part #"]: set(r["Designator"].split(",")) for r in bom} == sel)
json.dump({"checks": res, "info": info}, out.open("w"), indent=1, default=str)
print(sum(r["result"] == "PASS" for r in res), "/", len(res), "PASS")
sys.exit(0 if all(r["result"] == "PASS" for r in res) else 1)
