#!/usr/bin/env python3
"""RB-06: final release checks on a candidate release directory (Gerber zip + BOM + CPL) against the frozen canonical project.
    python3 rb06_release_check.py --zip g.zip --bom bom.csv --cpl cpl.csv --out checks.json"""
import argparse, csv, json, math, re, shutil, subprocess, sys, tempfile, zipfile, xml.etree.ElementTree as ET
from pathlib import Path
R = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_sexpr import parse, kids, first
from rb04_gerber import parse_gerber, excellon
ap = argparse.ArgumentParser(); ap.add_argument("--zip", required=True); ap.add_argument("--bom", required=True); ap.add_argument("--cpl", required=True); ap.add_argument("--out", required=True)
ap.add_argument("--reference-zip", required=True); ap.add_argument("--reference-bom", required=True); ap.add_argument("--reference-cpl", required=True)
a = ap.parse_args()
res = []
def chk(name, ok, detail=""):
    res.append(dict(check=name, result="PASS" if ok else "FAIL", detail=str(detail)[:400])); print("PASS" if ok else "FAIL", name, str(detail)[:140])
PCB = R / "kicad/ARTHUR_EMG_RevB/ARTHUR_EMG_RevB.kicad_pcb"
t = parse(PCB.read_text())
# --- canonical hashes vs lock baseline
import hashlib
base = {l.split()[1]: l.split()[0] for l in (R / "tools/baseline/canonical_files.sha256").read_text().splitlines() if l.strip()}
K = R / "kicad/ARTHUR_EMG_RevB"
bad = [f for f, h in base.items() if hashlib.sha256((K / f).read_bytes()).hexdigest() != h]
chk("canonical files (11 incl. PCB and U1 footprint) match the lock baseline", not bad and len(base) == 11, bad or len(base))
# --- Gerber zip structure + equivalence with the audited QUOTE-ONLY zip
def unzip(p, d): zipfile.ZipFile(p).extractall(d); return sorted(x.name for x in Path(d).iterdir())
da, db = tempfile.mkdtemp(), tempfile.mkdtemp()
na, nb = unzip(a.zip, da), unzip(a.reference_zip, db)
chk("zip: flat, 10 Gerber layers + 1 drill, no job file", len(na) == 11 and na == nb and not any(n.endswith("gbrjob") for n in na), na)
noise = re.compile(r"CreationDate|DRILL file|TF.ProjectId|GenerationSoftware|Created by KiCad")
diff = [n for n in na if [l for l in (Path(da) / n).read_text().splitlines() if not noise.search(l)] != [l for l in (Path(db) / n).read_text().splitlines() if not noise.search(l)]]
chk("release Gerber/drill equivalent to the audited QUOTE-ONLY outputs (timestamps ignored)", not diff, diff or "11/11 equivalent")
chk("BOM byte-identical to the audited package", Path(a.bom).read_bytes() == Path(a.reference_bom).read_bytes())
chk("CPL byte-identical to the audited package", Path(a.cpl).read_bytes() == Path(a.reference_cpl).read_bytes())
# --- BAT+ hole: open, plated, component
holes, pts = excellon(next(Path(da).glob("*.drl")))
chk("drill: 201 × Ø0.30 vias + exactly 1 × Ø1.90 plated hole, no NPTH", holes == {0.3: 201, 1.9: 1}, holes)
chk("Ø1.90 hole at (44.635, -54.790) Gerber frame = U1 pad 23", [tuple(p) for p in pts.get(1.9, [])] == [(44.635, -54.79)], pts.get(1.9))
drl = next(Path(da).glob("*.drl")).read_text()
chk("Ø1.90 tool tagged Plated,PTH,ComponentDrill (not ViaDrill)", re.search(r"ComponentDrill\s*\nT2C1\.900", drl) is not None)
for lay in ("F_Mask.gts", "B_Mask.gbs", "F_Paste.gtp"):
    f = [n for n in na if n.endswith(lay.split(".")[0] + "." + lay.split(".")[1])]
G = {n.split("-", 1)[-1]: parse_gerber(Path(da) / n) for n in na if not n.endswith(".drl")}
at = lambda g: [(g["apertures"][c][0], g["apertures"][c][1][0], g["apertures"][c][2]) for p, c, pol in g["flashes"] if abs(p[0] - 44.635) < 0.002 and abs(p[1] + 54.79) < 0.002]
chk("F.Mask: single Ø1.95 opening at the hole; B.Mask: Ø1.95 + Ø3.00 openings", [x[1] for x in at(G["F_Mask.gts"])] == [1.95] and sorted(x[1] for x in at(G["B_Mask.gbs"])) == [1.95, 3.0], (at(G["F_Mask.gts"]), at(G["B_Mask.gbs"])))
chk("mask layers carry no regions/draws that could cover the hole", all(len(G[k]["regions"]) == 0 and len(G[k]["draws"]) == 0 for k in ("F_Mask.gts", "B_Mask.gbs")))
chk("no paste aperture at the hole", at(G["F_Paste.gtp"]) == [])
chk("copper at the hole is ComponentPad (Ø2.30 F/In1/In2/B) + Ø3.00 B.Cu land; no ViaPad", all(any(x[2] == "ComponentPad" and x[1] == 2.3 for x in at(G[k])) for k in ("F_Cu.gtl", "In1_Cu.g1", "In2_Cu.g2", "B_Cu.gbl")) and any(x[1] == 3.0 for x in at(G["B_Cu.gbl"])) and not any(x[2] == "ViaPad" for k in ("F_Cu.gtl", "B_Cu.gbl") for x in at(G[k])))
# --- netlist / BOM / CPL mapping
nl = Path(tempfile.mkdtemp()); shutil.copytree(K, nl / "p", ignore=shutil.ignore_patterns(".history", "*.lck")); subprocess.run(["chmod", "-R", "u+w", str(nl / "p")])
subprocess.run(["kicad-cli", "sch", "export", "netlist", "--format", "kicadxml", "-o", str(nl / "n.xml"), "ARTHUR_EMG_RevB.kicad_sch"], cwd=nl / "p", capture_output=True)
comps = {}
for c in ET.parse(nl / "n.xml").getroot().iter("comp"):
    comps[c.get("ref")] = dict(value=c.findtext("value"), fp=c.findtext("footprint").split(":")[-1], fld={f.get("name"): f.text or "" for f in c.iter("field")})
nodes = sum(1 for n in ET.parse(nl / "n.xml").getroot().iter("node"))
fps = {}
for f in kids(t, "footprint"):
    ref = [str(p[2]) for p in kids(f, "property") if str(p[1]) == "Reference"][0]
    at_ = first(f, "at"); attr = [str(x) for x in (first(f, "attr") or [])[1:]]
    fps[ref] = dict(x=float(at_[1]), y=float(at_[2]), rot=float(at_[3]) if len(at_) > 3 else 0.0, attr=attr, layer=str(first(f, "layer")[1]), name=str(f[1]).split(":")[-1])
expect = sorted(r for r, f in fps.items() if "smd" in f["attr"] and "dnp" not in f["attr"] and "exclude_from_pos_files" not in f["attr"])
cpl = list(csv.DictReader(open(a.cpl))); bom = list(csv.DictReader(open(a.bom)))
crefs = [r["Designator"] for r in cpl]; brefs = [x for r in bom for x in r["Designator"].split(",")]
chk("exactly 126 CPL rows, all Top, = every non-DNP SMD footprint on F.Cu", len(cpl) == 126 and sorted(crefs) == expect and all(r["Layer"] == "Top" for r in cpl) and all(fps[r]["layer"] == "F.Cu" for r in expect), len(expect))
chk("BOM: 29 lines, 126 unique designators, same set as the CPL", len(bom) == 29 and sorted(brefs) == sorted(crefs) and len(set(brefs)) == 126)
chk("U1 (XIAO) is DNP in the PCB and absent from BOM and CPL; TP1–TP8 absent", "dnp" in fps["U1"]["attr"] and "U1" not in brefs and "U1" not in crefs and not any(r.startswith("TP") for r in brefs + crefs), fps["U1"]["attr"])
sel = {l["sel"]["lcsc"]: l["sel"] for l in json.load(open(R / "evidence/rb04a/bom_selection.json")) if l["sel"]}
mism = []
for r in bom:
    for ref in r["Designator"].split(","):
        c = comps[ref]
        if c["fld"].get("LCSC") != r["LCSC Part #"] or c["fp"] != r["Footprint"]: mism.append((ref, "lcsc/footprint"))
        s = sel.get(r["LCSC Part #"])
        if not s or c["fld"].get("MPN") != s["mpn"] or c["fld"].get("BOM_Status") != "QUALIFIED": mism.append((ref, "selection"))
chk("every BOM designator: LCSC + footprint = schematic netlist fields; MPN and status = RB-04B qualified selection", not mism, mism[:5])
dev = []
for r in cpl:
    f = fps[r["Designator"]]; x = float(r["Mid X"].rstrip("mm")); y = float(r["Mid Y"].rstrip("mm"))
    if abs(x - f["x"]) > 0.0006 or abs(y + f["y"]) > 0.0006: dev.append(r["Designator"])
chk("CPL coordinates = PCB footprint origins (x, −y) to 0.0006 mm", not dev, dev[:5])
chk("netlist: 135 components, 357 pad nodes", len(comps) == 135 and nodes == 357, (len(comps), nodes))
bom_text = Path(a.bom).read_text()
chk("no PCBA line for the XIAO module (MPN/Seeed) anywhere in the BOM", "XIAO" not in bom_text and "Seeed" not in bom_text and "ESP32" not in bom_text)
json.dump(res, open(a.out, "w"), indent=1)
n_fail = sum(r["result"] != "PASS" for r in res); print(len(res) - n_fail, "/", len(res), "PASS"); sys.exit(1 if n_fail else 0)
