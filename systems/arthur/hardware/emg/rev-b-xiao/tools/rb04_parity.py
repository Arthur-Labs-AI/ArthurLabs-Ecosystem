#!/usr/bin/env python3
"""RB-04: independent schematic <-> PCB parity.  Reads (a) the schematic netlist exported by kicad-cli in a scratch copy and (b) the
.kicad_pcb text, and compares reference, value, footprint id, DNP/exclusion attributes, and the net of every pad.
    python3 rb04_parity.py --project <dir with .kicad_sch + .kicad_pcb> --out parity.json [--workdir scratch]"""
import argparse, collections, json, shutil, subprocess, sys, tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_sexpr import first, kids, parse

ap = argparse.ArgumentParser()
ap.add_argument("--project", type=Path, required=True); ap.add_argument("--out", type=Path, required=True); ap.add_argument("--pcb", type=Path)
a = ap.parse_args()
tmp = Path(tempfile.mkdtemp(prefix="rb04_parity_"))
shutil.copytree(a.project, tmp / "p", ignore=shutil.ignore_patterns(".history", "~*", "*.lck"))
sch = next((tmp / "p").glob("*.kicad_sch"))
sch = tmp / "p" / "ARTHUR_EMG_RevB.kicad_sch"
xml = tmp / "n.xml"
subprocess.run(["kicad-cli", "sch", "export", "netlist", "--format", "kicadxml", "-o", str(xml), str(sch)], capture_output=True, check=True)
r = ET.parse(xml).getroot()
S = {}
for c in r.find("components"):
    props = {p.get("name"): p.get("value") for p in c.findall("property")}
    fields = {f.get("name"): f.text for f in (c.find("fields") if c.find("fields") is not None else [])}
    S[c.get("ref")] = {"value": c.findtext("value"), "fp": c.findtext("footprint"), "props": props, "fields": fields}
nodes = {}
snets = {}
for n in r.find("nets"):
    name = n.get("name")
    for nd in n.findall("node"):
        nodes[(nd.get("ref"), nd.get("pin"))] = name
        snets.setdefault(name, []).append((nd.get("ref"), nd.get("pin")))
pcb = parse((a.pcb or next(a.project.glob("*.kicad_pcb"))).read_text())
P = {}
for f in kids(pcb, "footprint"):
    props = {str(p[1]): str(p[2]) for p in kids(f, "property")}
    ref = props.get("Reference")
    attr = [str(x) for x in (first(f, "attr") or ["attr"])[1:]]
    P[ref] = {"value": props.get("Value"), "fp": str(f[1]), "layer": str(first(f, "layer")[1]), "attr": attr,
              "pads": {str(p[1]): (str(first(p, "net")[1]) if first(p, "net") else "") for p in kids(f, "pad")}}
res = {"schematic_components": len(S), "pcb_footprints": len(P)}
res["missing_in_pcb"] = sorted(set(S) - set(P)); res["extra_in_pcb"] = sorted(set(P) - set(S))
res["value_mismatch"] = [(k, S[k]["value"], P[k]["value"]) for k in S if k in P and S[k]["value"] != P[k]["value"]]
res["footprint_mismatch"] = [(k, S[k]["fp"], P[k]["fp"]) for k in S if k in P and S[k]["fp"] != P[k]["fp"]]
sch_dnp = {k for k, v in S.items() if v["props"].get("dnp") is not None or "dnp" in (v["fields"] or {})}
pcb_dnp = {k for k, v in P.items() if "dnp" in v["attr"]}
res["dnp_schematic"] = sorted(sch_dnp); res["dnp_pcb"] = sorted(pcb_dnp)
# pad nets
bad, nopad, unpinned = [], [], []
pcb_net_pads = collections.defaultdict(list)
for ref, f in P.items():
    for num, net in f["pads"].items():
        if net:
            pcb_net_pads[net].append((ref, num))
for (ref, pin), net in nodes.items():
    if ref not in P:
        continue
    if pin not in P[ref]["pads"]:
        nopad.append((ref, pin)); continue
    if P[ref]["pads"][pin] != net:
        bad.append((ref, pin, net, P[ref]["pads"][pin]))
for ref, f in P.items():
    for num, net in f["pads"].items():
        if net and (ref, num) not in nodes:
            unpinned.append((ref, num, net))
res["netlist_nodes"] = len(nodes); res["pad_net_mismatch"] = bad; res["netlist_pins_without_pad"] = nopad; res["pcb_netted_pads_not_in_netlist"] = unpinned
res["nets_in_schematic"] = len(snets); res["nets_in_pcb"] = len(pcb_net_pads)
res["nets_only_in_pcb"] = sorted(set(pcb_net_pads) - set(snets)); res["nets_only_in_schematic"] = sorted(set(snets) - set(pcb_net_pads))
# nets with a single pad in the PCB (stubs) and net pad-set equality
res["pad_set_differs"] = [n for n in snets if n in pcb_net_pads and sorted(snets[n]) != sorted(pcb_net_pads[n])]
res["top_side_smt"] = sum(1 for k, v in P.items() if v["layer"] == "F.Cu" and "smd" in v["attr"] and "dnp" not in v["attr"] and "exclude_from_pos_files" not in v["attr"])
res["attrs"] = {",".join(k): n for k, n in collections.Counter(tuple(sorted(v["attr"])) for v in P.values()).items()}
res["layers"] = dict(collections.Counter(v["layer"] for v in P.values()))
res["bottom_side"] = sorted(k for k, v in P.items() if v["layer"] != "F.Cu")
a.out.write_text(json.dumps(res, indent=1, default=list))
for k in ("schematic_components", "pcb_footprints", "missing_in_pcb", "extra_in_pcb", "value_mismatch", "footprint_mismatch", "dnp_schematic", "dnp_pcb", "netlist_nodes",
          "pad_net_mismatch", "netlist_pins_without_pad", "pcb_netted_pads_not_in_netlist", "nets_in_schematic", "nets_in_pcb", "nets_only_in_pcb", "nets_only_in_schematic",
          "pad_set_differs", "top_side_smt", "attrs", "layers", "bottom_side"):
    print(k, res[k] if not isinstance(res[k], list) or len(res[k]) < 8 else (len(res[k]), res[k][:4]))
shutil.rmtree(tmp, ignore_errors=True)
