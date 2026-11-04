#!/usr/bin/env python3
"""RB-04H: inventory of PCB-footprint property vs schematic-symbol field differences (read-only).
    python3 rb04h_field_inventory.py --pcb board.kicad_pcb --netlist revb.xml --out inventory.json [--csv inventory.csv]
Source of truth = the schematic fields as exported in the KiCad netlist (custom fields + Datasheet + Description).  Reference/Value/Footprint are
not compared as field text (value/footprint parity is checked separately)."""
import argparse, csv, json, sys, xml.etree.ElementTree as ET
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_sexpr import parse, kids, first
ap = argparse.ArgumentParser(); ap.add_argument("--pcb", required=True); ap.add_argument("--netlist", required=True); ap.add_argument("--out", required=True); ap.add_argument("--csv")
a = ap.parse_args()
t = parse(Path(a.pcb).read_text())
pcb = {}
for f in kids(t, "footprint"):
    props = {str(p[1]): str(p[2]) for p in kids(f, "property")}
    pcb[props["Reference"]] = props
sch = {}
for c in ET.parse(a.netlist).getroot().iter("comp"):
    d = {fl.get("name"): (fl.text or "") for fl in c.iter("field")}
    d["Datasheet"] = c.findtext("datasheet", d.get("Datasheet", "")); d["Description"] = c.findtext("description", d.get("Description", ""))
    d.pop("Footprint", None)
    sch[c.get("ref")] = d
SKIP = {"Reference", "Value", "Footprint"}
rows = []; summary = {}
for ref in sorted(sch, key=lambda r: (''.join(ch for ch in r if ch.isalpha()), int(''.join(ch for ch in r if ch.isdigit()) or 0))):
    if ref not in pcb:
        rows.append(dict(ref=ref, field="*", status="missing_footprint", pcb="", sch="")); continue
    for k, v in sch[ref].items():
        if k in SKIP: continue
        pv = pcb[ref].get(k)
        st = "same" if pv == v else ("missing_in_pcb" if pv is None else "differs")
        rows.append(dict(ref=ref, field=k, status=st, pcb=pv if pv is not None else "", sch=v))
    for k in pcb[ref]:
        if k not in SKIP and k not in sch[ref]:
            rows.append(dict(ref=ref, field=k, status="pcb_only", pcb=pcb[ref][k], sch=""))
import collections
cnt = collections.Counter((r["field"], r["status"]) for r in rows if r["status"] != "same")
by_ref = collections.Counter(r["ref"] for r in rows if r["status"] != "same")
out = dict(footprints=len(pcb), symbols=len(sch), refs_with_mismatch=len(by_ref), by_field_status={f"{k[0]}:{k[1]}": v for k, v in sorted(cnt.items())},
           rows=[r for r in rows if r["status"] != "same"])
json.dump(out, open(a.out, "w"), indent=1)
if a.csv:
    with open(a.csv, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["ref", "field", "status", "pcb", "sch"]); w.writeheader(); w.writerows(r for r in rows if r["status"] != "same")
print(json.dumps({k: out[k] for k in ("footprints", "symbols", "refs_with_mismatch", "by_field_status")}, indent=1))
