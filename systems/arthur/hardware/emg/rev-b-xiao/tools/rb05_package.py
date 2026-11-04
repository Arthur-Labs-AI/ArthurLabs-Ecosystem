#!/usr/bin/env python3
"""RB-05: build the JLCPCB quote package from the canonical project (copy in scratch; the project is never opened in place).
    python3 rb05_package.py <scratch dir> <out dir>
Writes <out>/ARTHUR_EMG_RevB_Gerbers.zip, _BOM.csv, _CPL.csv, _CPL_raw_KiCad_rotation.csv.  NOT manufacturing-release files."""
import csv, math, re, shutil, subprocess, sys, zipfile, os, json
from pathlib import Path
R = Path(__file__).resolve().parent.parent
import os as _os
K = Path(_os.environ.get("RB05_PROJECT", str(R / "kicad/ARTHUR_EMG_RevB")))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_sexpr import parse, kids, first
W = Path(sys.argv[1]).resolve(); O = Path(sys.argv[2]).resolve()
shutil.rmtree(W, ignore_errors=True); W.mkdir(parents=True); O.mkdir(parents=True, exist_ok=True)
prj = W / "prj"
shutil.copytree(K, prj, ignore=shutil.ignore_patterns(".history", "*.lck", "*.kicad_prl"))
subprocess.run(["chmod", "-R", "u+w", str(prj)])
gd = W / "gerber"; gd.mkdir()
pcb = "ARTHUR_EMG_RevB.kicad_pcb"
def run(*a):
    r = subprocess.run(list(a), cwd=prj, capture_output=True, text=True)
    if r.returncode: print(r.stdout, r.stderr); sys.exit("kicad-cli failed")
run("kicad-cli", "pcb", "export", "gerbers", "--layers", "F.Cu,In1.Cu,In2.Cu,B.Cu,F.Paste,F.Mask,B.Mask,F.SilkS,B.SilkS,Edge.Cuts", "-o", str(gd) + "/", pcb)
run("kicad-cli", "pcb", "export", "drill", "--format", "excellon", "--drill-origin", "absolute", "--excellon-units", "mm", "--excellon-zeros-format", "decimal", "-o", str(gd) + "/", pcb)
run("kicad-cli", "pcb", "export", "pos", "--format", "csv", "--units", "mm", "--side", "both", "--exclude-dnp", "-o", str(W / "pos.csv"), pcb)
# ---- zip: flat, copper / mask / paste / silk / outline / drill; job file left out
names = sorted(p for p in gd.iterdir() if p.suffix != ".gbrjob")
zp = O / "ARTHUR_EMG_RevB_Gerbers.zip"
with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED) as z:
    for p in names: z.write(p, p.name)
# ---- CPL: reference-specific north JST override remains pending factory preview.
pos = list(csv.DictReader(open(W / "pos.csv")))
from jlc_rotations import factory_rotation
rows_p, rows_r = [], []
for r in sorted(pos, key=lambda r: (re.sub(r"\d", "", r["Ref"]), int(re.sub(r"\D", "", r["Ref"])))):
    assert r["Side"] == "top", r
    rot = float(r["Rot"]) % 360
    x, y = float(r["PosX"]), float(r["PosY"])
    base = [r["Ref"], f"{x:.4f}mm", f"{y:.4f}mm", "Top"]
    rows_r.append(base + [f"{rot:g}"])
    rows_p.append(base + [f"{factory_rotation(r['Ref'], r['Package'], rot):g}"])
hdr = ["Designator", "Mid X", "Mid Y", "Layer", "Rotation"]
for fn, rows in (("ARTHUR_EMG_RevB_CPL.csv", rows_p), ("ARTHUR_EMG_RevB_CPL_raw_KiCad_rotation.csv", rows_r)):
    with open(O / fn, "w", newline="") as f:
        w = csv.writer(f); w.writerow(hdr); w.writerows(rows)
# ---- BOM from the schematic fields (ungrouped export, grouped here by LCSC)
subprocess.run(["kicad-cli", "sch", "export", "netlist", "--format", "kicadxml", "-o", str(W / "revb.xml"), "ARTHUR_EMG_RevB.kicad_sch"], cwd=prj, capture_output=True)
import xml.etree.ElementTree as ET
cpl_refs = {r["Ref"] for r in pos}
groups = {}
for c in ET.parse(W / "revb.xml").getroot().iter("comp"):
    ref = c.get("ref")
    if ref not in cpl_refs: continue
    fld = {f.get("name"): (f.text or "") for f in c.iter("field")}
    fp = c.findtext("footprint", "").split(":")[-1]
    g = groups.setdefault(fld["LCSC"], dict(comment=c.findtext("value"), mpn=fld["MPN"], fp=fp, refs=[]))
    assert (g["comment"], g["mpn"], g["fp"]) == (c.findtext("value"), fld["MPN"], fp), ref
    g["refs"].append(ref)
def key(ref): return (re.sub(r"\d", "", ref), int(re.sub(r"\D", "", ref)))
with open(O / "ARTHUR_EMG_RevB_BOM.csv", "w", newline="") as f:
    w = csv.writer(f); w.writerow(["Comment", "Designator", "Footprint", "LCSC Part #"])
    for lcsc, g in sorted(groups.items(), key=lambda kv: key(sorted(kv[1]["refs"], key=key)[0])):
        w.writerow([f'{g["comment"]} {g["mpn"]}', ",".join(sorted(g["refs"], key=key)), g["fp"], lcsc])
print("zip", zp.name, len(names), "files; CPL", len(rows_p), "rows; BOM groups", len(groups), "refs", sum(len(g["refs"]) for g in groups.values()))
