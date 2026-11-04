#!/usr/bin/env python3
"""RB-03R: named rule areas around the pin columns of the three TLV9064 packages (U501-U503) used by the narrowed hi-Z leakage
rules in the .kicad_dru.  Each area is a rectangle that spans one pin column (7 pins, 0.65 mm pitch) and 1.5 mm to either side of it
(no keep-out flags: it only gives the DRC engine a region to test "fully enclosed by").

    python3 rb03r_escape_areas.py --pcb in.kicad_pcb --out out.kicad_pcb      (idempotent)
"""
import argparse
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_check_placement import load  # noqa: E402
from rb02_sexpr import Q, dump, first, kids, parse  # noqa: E402

ICS = ("U501", "U502", "U503")
SIDE = 1.5
END = 0.45


def area_names():
    return [f"HIZ_ESC_{ic}_{s}" for ic in ICS for s in ("L", "R")]


def areas_for(pcb_path):
    fps, E, z, root = load(pcb_path)
    out = {}
    for ic in ICS:
        pads = fps[ic].pads
        cx = sum(p["x"] for p in pads) / len(pads)
        for tag, sel in (("L", [p for p in pads if p["x"] < cx]), ("R", [p for p in pads if p["x"] >= cx])):
            x0 = min(p["x"] - p["w"] / 2 for p in sel) - SIDE
            x1 = max(p["x"] + p["w"] / 2 for p in sel) + SIDE
            y0 = min(p["y"] - p["h"] / 2 for p in sel) - END
            y1 = max(p["y"] + p["h"] / 2 for p in sel) + END
            out[f"HIZ_ESC_{ic}_{tag}"] = (x0, y0, x1, y1)
        # one region per package: the union of both pin-column regions (tracks that run between the two columns, under the
        # body, are inside it); both rule names keep the same rectangle so the DRU predicates stay valid
        L, R = out[f"HIZ_ESC_{ic}_L"], out[f"HIZ_ESC_{ic}_R"]
        U = (min(L[0], R[0]), min(L[1], R[1]), max(L[2], R[2]), max(L[3], R[3]))
        out[f"HIZ_ESC_{ic}_L"] = out[f"HIZ_ESC_{ic}_R"] = U
    return out


def zone_node(name, r):
    x0, y0, x1, y1 = r
    return ["zone", ["net", 0], ["net_name", Q("")], ["layers", Q("F.Cu"), Q("In1.Cu"), Q("In2.Cu"), Q("B.Cu")], ["uuid", Q(str(uuid.uuid4()))],
            ["name", Q(name)], ["hatch", "edge", 0.5], ["connect_pads", ["clearance", 0]], ["min_thickness", 0.25], ["filled_areas_thickness", "no"],
            ["keepout", ["tracks", "allowed"], ["vias", "allowed"], ["pads", "allowed"], ["copperpour", "allowed"], ["footprints", "allowed"]],
            ["placement", ["enabled", "no"], ["sheetname", Q("")]], ["fill", ["thermal_gap", 0.5], ["thermal_bridge_width", 0.5]],
            ["polygon", ["pts", ["xy", x0, y0], ["xy", x1, y0], ["xy", x1, y1], ["xy", x0, y1]]]]


def add(pcb_in, pcb_out):
    areas = areas_for(pcb_in)
    root = parse(Path(pcb_in).read_text())
    root[:] = [n for n in root if not (isinstance(n, list) and n and n[0] == "zone" and first(n, "name") and str(first(n, "name")[1]).startswith("HIZ_ESC_"))]
    for name, r in areas.items():
        root.append(zone_node(name, r))
    Path(pcb_out).write_text(dump(root) + "\n")
    return areas


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pcb", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    for k, v in add(a.pcb, a.out).items():
        print(k, [round(x, 2) for x in v])
