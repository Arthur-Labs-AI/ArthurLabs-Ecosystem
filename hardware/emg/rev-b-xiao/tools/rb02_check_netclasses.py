#!/usr/bin/env python3
"""RB-02: prove every net of the frozen schematic is matched by exactly one netclass pattern (none falls back to Default)
and print the net -> class table.   python3 rb02_check_netclasses.py --netlist revb.xml --project <.kicad_pro>"""
import argparse, fnmatch, json, sys, xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--netlist", type=Path, required=True)
ap.add_argument("--project", type=Path, default=Path(__file__).resolve().parents[1] / "kicad/ARTHUR_EMG_RevB/ARTHUR_EMG_RevB.kicad_pro")
a = ap.parse_args()
pats = json.loads(a.project.read_text())["net_settings"]["netclass_patterns"]
nets = [n.get("name") for n in ET.parse(a.netlist).getroot().findall("./nets/net")]
tab = defaultdict(list)
bad = []
for n in nets:
    hit = sorted({p["netclass"] for p in pats if fnmatch.fnmatchcase(n, p["pattern"])})
    if len(hit) != 1:
        bad.append((n, hit))
    else:
        tab[hit[0]].append(n)
for c, l in sorted(tab.items()):
    print(f"{c:14s} {len(l):3d}  " + ", ".join(sorted(l)[:6]) + (" ..." if len(l) > 6 else ""))
print(f"{len(nets)} nets; unclassified or ambiguous: {bad}")
sys.exit(1 if bad else 0)
