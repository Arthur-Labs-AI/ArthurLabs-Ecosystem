#!/usr/bin/env python3
"""RB-07: verify a KiCad ODB++ export (zip) against the canonical PCB and the audited JLC Gerber/drill/BOM/CPL release (read-only).
    python3 rb07_odb_verify.py --odb x.zip --release-dir manufacturing-release/... --out odb_verification.json"""
import argparse, csv, json, math, re, sys, tempfile, zipfile
from pathlib import Path
R = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_sexpr import parse, kids, first
from rb04_gerber import parse_gerber, excellon
ap = argparse.ArgumentParser(); ap.add_argument("--odb", required=True); ap.add_argument("--release-dir", required=True); ap.add_argument("--out", required=True)
a = ap.parse_args()
res = []
def chk(name, ok, detail=""):
    res.append(dict(check=name, result="PASS" if ok else "FAIL", detail=str(detail)[:500])); print("PASS" if ok else "FAIL", name, str(detail)[:150])
d = Path(tempfile.mkdtemp()); zipfile.ZipFile(a.odb).extractall(d)
L = d / "steps/pcb/layers"
def feats(layer):
    txt = (L / layer / "features").read_text()
    syms = {int(m.group(1)): m.group(2) for m in re.finditer(r"^\$(\d+) (\S+)", txt, re.M)}
    pads = [(float(m.group(1)), float(m.group(2)), syms[int(m.group(3))]) for m in re.finditer(r"^P ([-\d.]+) ([-\d.]+) (\d+) ", txt, re.M)]
    lines = len(re.findall(r"^L ", txt, re.M)); return pads, lines, txt
def diam(s):
    m = re.fullmatch(r"r(\d+(?:\.\d+)?)", s)
    return round(float(m.group(1)) / 1000.0, 4) if m else None
at = lambda pads: [(diam(s), s) for x, y, s in pads if abs(x - 44.635) < 0.002 and abs(y + 54.79) < 0.002]
# ---- container / units
info = (d / "misc/info").read_text(); chk("ODB++ job: units MM, version 8.1, source KiCad 10.0.6", "UNITS=MM" in info and "ODB_VERSION_MAJOR=8" in info and "KiCad EDA 10.0.6" in info, info.replace("\n", " ")[:160])
chk("zip is a single ODB++ job tree (matrix, steps/pcb, misc, symbols)", all((d / p).exists() for p in ("matrix/matrix", "steps/pcb/stephdr", "steps/pcb/profile", "steps/pcb/eda/data", "steps/pcb/netlists/cadnet/netlist")))
# ---- stackup / layers
mat = (d / "matrix/matrix").read_text()
layers = re.findall(r"LAYER \{\n.*?TYPE=(\w+)\n\s+NAME=(\S+)", mat, re.S)
sig = [n for t, n in layers if t == "SIGNAL"]; chk("four copper (SIGNAL) layers: F.CU, IN1.CU, IN2.CU, B.CU", sig == ["F.CU", "IN1.CU", "IN2.CU", "B.CU"], sig)
chk("three dielectric layers", [n for t, n in layers if t == "DIELECTRIC"] == ["DIELECTRIC_1", "DIELECTRIC_2", "DIELECTRIC_3"])
mk = [n for t, n in layers if t == "SOLDER_MASK"]; chk("top and bottom solder-mask layers present", sorted(mk) == ["B.MASK", "F.MASK"], mk)
chk("no drill layer other than the plated through-hole layer; no NPTH layer", [n for t, n in layers if t == "DRILL"] == ["DRILL_PLATED_F.CU-B.CU"], [n for t, n in layers if t == "DRILL"])
# ---- outline
prof = (d / "steps/pcb/profile").read_text()
pts = [(float(x), float(y)) for x, y in re.findall(r"^O[SB] ([-\d.]+) ([-\d.]+)", prof, re.M)] + [(float(x), float(y)) for x, y in re.findall(r"^OC ([-\d.]+) ([-\d.]+)", prof, re.M)]
xs, ys = [p[0] for p in pts], [p[1] for p in pts]
w, h = max(xs) - min(xs), max(ys) - min(ys)
chk("profile: 51.30 × 64.95 mm, origin 0,0 (y down = negative)", abs(w - 51.3) < 0.005 and abs(h - 64.95) < 0.005 and abs(min(xs)) < 0.005 and abs(max(ys)) < 0.005, (round(w, 3), round(h, 3), min(xs), min(ys)))
# ---- drill: vias + BAT+ hole
dr = (L / "drill_plated_f.cu-b.cu")
dp, _, dtxt = feats("drill_plated_f.cu-b.cu")
tools = re.findall(r"NUM=(\d+)\n\s+TYPE=(\w+)\n.*?FINISH_SIZE=([\d.]+)\n\s+DRILL_SIZE=([\d.]+)", (dr / "tools").read_text(), re.S)
n300 = sum(1 for p in dp if diam(p[2]) == 0.3); n19 = [p for p in dp if diam(p[2]) == 1.9]
chk("drill: 201 holes of Ø0.30 mm (vias) and exactly 1 plated hole of Ø1.90 mm", n300 == 201 and len(n19) == 1 and len(dp) == 202, (n300, len(n19), len(dp)))
chk("Ø1.90 mm hole at X 44.635 / Y −54.790 (KiCad 44.635 / 54.790) and typed PLATED in the tool list", abs(n19[0][0] - 44.635) < 0.002 and abs(n19[0][1] + 54.79) < 0.002 and any(t == "PLATED" and abs(float(f) - 1900) < 1 for _, t, f, _ in tools), n19)
# match against the audited Excellon
gz = zipfile.ZipFile(Path(a.release_dir) / "ARTHUR_EMG_RevB_R1b_RELEASE_Gerbers.zip"); gd = Path(tempfile.mkdtemp()); gz.extractall(gd)
holes, gpts = excellon(next(gd.glob("*.drl")))
so = sorted((round(x, 3), round(y, 3)) for x, y, s in dp if diam(s) == 0.3); sg = sorted((round(x, 3), round(y, 3)) for x, y in gpts[0.3])
chk("all 201 via positions equal the audited Excellon drill positions", so == sg and len(so) == 201)
# ---- copper / mask at the BAT+ hole
for lay, want in (("f.cu", [2.3]), ("in1.cu", [2.3]), ("in2.cu", [2.3]), ("b.cu", [2.3, 3.0]), ("f.mask", [1.95]), ("b.mask", [1.95, 3.0])):
    p, _, _ = feats(lay); got = sorted(x for x, s in at(p))
    chk(f"{lay}: flashes at the BAT+ hole = {want}", got == want, got)
fp, _, _ = feats("f.paste"); chk("no solder-paste aperture at the BAT+ hole", at(fp) == [])
fm, _, ftxt = feats("f.mask"); bm, _, btxt = feats("b.mask")
chk("mask layers: flashes only (no surfaces/lines) → no feature can cover the hole", "\nS " not in ftxt and "\nS " not in btxt and "\nL " not in ftxt and "\nL " not in btxt)
# ---- vias on copper layers
vias = [(round(x, 3), round(y, 3)) for x, y, s in dp if diam(s) == 0.3]
fcp, _, _ = feats("f.cu"); bcp, _, _ = feats("b.cu")
fset = {(round(x, 3), round(y, 3)) for x, y, s in fcp if diam(s) == 0.6}; bset = {(round(x, 3), round(y, 3)) for x, y, s in bcp if diam(s) == 0.6}
chk("201 vias: Ø0.60 pad on F.Cu and on B.Cu at every drill position", all(v in fset and v in bset for v in vias), (len(fset), len(bset)))
chk("via mask apertures: none (all 201 tented): no Ø0.60/Ø0.30 flash in F.Mask/B.Mask at any via", not any((round(x, 3), round(y, 3)) in set(vias) for x, y, s in fm + bm))
# ---- components / assembly
comp = lambda lay: (L / lay / "components").read_text()
def parse_comps(txt):
    out = {}
    for m in re.finditer(r"^CMP \d+ ([-\d.]+) ([-\d.]+) ([-\d.]+) ([NM]) (\S+) (\S+) ?(;\S*)?\n((?:PRP .*\n)*)", txt, re.M):
        props = dict(re.findall(r"^PRP (\S+) '(.*)'$", m.group(8), re.M))
        out[m.group(5)] = dict(x=float(m.group(1)), y=float(m.group(2)), rot=float(m.group(3)), mirror=m.group(4), pkg=m.group(6), attr=m.group(7) or "", props=props)
    return out
top, bot = parse_comps(comp("comp_+_top")), parse_comps(comp("comp_+_bot"))
smd = {r: c for r, c in top.items() if c["attr"] == ";0=1"}
chk("top component layer: 126 SMD (mount type 1) + U1", len(smd) == 126 and len(top) == 127 and "U1" in top, (len(smd), len(top)))
chk("U1 marked THMT (mount type 2) and NO_POP (do-not-populate)", top["U1"]["attr"] == ";0=2,1", top["U1"]["attr"])
chk("no bottom-side SMT: bottom component layer holds only TP1–TP8 with mount type 0 (other), none SMD, none populated by CPL", sorted(bot) == [f"TP{i}" for i in range(1, 9)] and all(c["attr"] == ";0=0" for c in bot.values()), {k: v["attr"] for k, v in bot.items()})
cpl = list(csv.DictReader(open(Path(a.release_dir) / "ARTHUR_EMG_RevB_R1b_RELEASE_CPL.csv"))); raw = {r["Designator"]: r for r in csv.DictReader(open(Path(a.release_dir) / "alternate/ARTHUR_EMG_RevB_R1b_RELEASE_CPL_raw_KiCad_rotation.csv"))}
chk("ODB SMD component set = release CPL designators (126)", sorted(smd) == sorted(r["Designator"] for r in cpl))
dev = []
for r in cpl:
    c = smd[r["Designator"]]
    x = float(r["Mid X"].rstrip("mm")); y = float(r["Mid Y"].rstrip("mm"))
    if abs(c["x"] - x) > 0.001 or abs(c["y"] - y) > 0.001: dev.append((r["Designator"], "xy", c["x"], c["y"], x, y))
    kr = float(raw[r["Designator"]]["Rotation"])
    if abs(((360.0 - kr) % 360.0) - (c["rot"] % 360.0)) > 0.01: dev.append((r["Designator"], "rot", c["rot"], kr))
chk("ODB component (x, y) = CPL; ODB rotation = 360 − KiCad rotation (ODB++ is clockwise-positive) for all 126", not dev, dev[:5])
rot_same = sum(1 for r in cpl if abs(smd[r["Designator"]]["rot"] - float(raw[r["Designator"]]["Rotation"])) < 0.01)
bom = {x: r for r in csv.DictReader(open(Path(a.release_dir) / "ARTHUR_EMG_RevB_R1b_RELEASE_BOM.csv")) for x in r["Designator"].split(",")}
miss = [r for r in smd if smd[r]["props"].get("LCSC") != bom[r]["LCSC Part #"] or not smd[r]["props"].get("MPN")]
chk("every SMD component carries MPN + LCSC properties equal to the release BOM", not miss, miss[:5])
chk("U1 carries MPN 'Seeed PN 202003751…', Manufacturer 'Seeed Studio' and is not in the release BOM", top["U1"]["props"].get("Manufacturer") == "Seeed Studio" and "U1" not in bom)
chk("TP1–TP8 are not in the release BOM/CPL", not any(f"TP{i}" in bom for i in range(1, 9)) and not any(r["Designator"].startswith("TP") for r in cpl))
# ---- netlist
net = (d / "steps/pcb/netlists/cadnet/netlist").read_text()
names = {int(m.group(1)): m.group(2) for m in re.finditer(r"^\$(\d+) (.+)$", net, re.M)}
vb = [i for i, n in names.items() if n == "VBAT"][0]
pts = [(int(m.group(1)), float(m.group(2)), float(m.group(3)), float(m.group(4))) for m in re.finditer(r"^(\d+) ([\d.]+) ([-\d.]+) ([-\d.]+) ", net, re.M)]
hole = [p for p in pts if abs(p[2] - 44.635) < 0.002 and abs(p[3] + 54.79) < 0.002]
chk("netlist: 90 nets; the Ø1.90 hole location belongs to net VBAT only", len(names) == 90 and hole and all(p[0] == vb for p in hole), (len(names), hole[:3], vb))
out = dict(rotation_identical_count=rot_same, checks=res)
json.dump(out, open(a.out, "w"), indent=1)
nf = sum(r["result"] != "PASS" for r in res); print(len(res) - nf, "/", len(res), "PASS; rotations identical to KiCad raw:", rot_same, "of 126"); sys.exit(1 if nf else 0)
