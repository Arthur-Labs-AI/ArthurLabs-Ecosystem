#!/usr/bin/env python3
"""RB-02G: build a SCRATCH placement-only PCB for a compact-layout variant (never the project PCB).

    python3 rb02g_build.py --netlist revb.xml --variant V1 --out <dir>  [--variants-file rb02g_variants.py]

Uses rb02_build_pcb.py unchanged (so footprints, nets, XIAO rule areas, DNP flags are exactly RB-02's) and then replaces the
RB-02 linear zone annotations (ZONE_A rule area, In2 GND outline, zone dividers) by the variant's own.
"""
import argparse
import importlib.util
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import rb02_placement as PL  # noqa: E402
import rb02_build_pcb as B  # noqa: E402
import rb02g_layouts as L  # noqa: E402
from rb02_check_placement import load  # noqa: E402
from rb02_sexpr import Q, dump, first, kids, parse  # noqa: E402

# base courtyards come from the archived RB-02 97 x 32 board once the main PCB has been promoted to V1
_ARCH = HERE.parent / "archive/rb02_97x32/ARTHUR_EMG_RevB_RB02_97x32.kicad_pcb"
PROJECT_PCB = _ARCH if _ARCH.exists() else HERE.parent / "kicad/ARTHUR_EMG_RevB/ARTHUR_EMG_RevB.kicad_pcb"


def courtyards():
    fps, E, z, root = load(PROJECT_PCB)
    crt = {}
    for r, o in fps.items():
        if o.crt:
            crt[r] = o.crt
        else:
            xs = [p["x"] for p in o.pads]; ys = [p["y"] for p in o.pads]; w = max(p["w"] for p in o.pads) / 2
            crt[r] = (min(xs) - w, min(ys) - w, max(xs) + w, max(ys) + w)
    return crt


def load_variants(path):
    spec = importlib.util.spec_from_file_location("rb02g_variants", path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m.VARIANTS


def build(netlist, variant, out_pcb):
    crt = courtyards()
    new, info = L.apply(variant, crt)
    PL.place.clear()
    PL.place.update(new)
    PL.DX = 0.0
    PL.BOARD_W, PL.BOARD_H = variant["W"], variant["H"]
    PL.CORNER_R = variant.get("corner_r", 1.0)
    sys.argv = ["rb02_build_pcb", "--netlist", str(netlist), "--out", str(out_pcb)]
    B.main()
    root = parse(Path(out_pcb).read_text())
    keep = []
    for it in root:
        if isinstance(it, list) and it and it[0] == "zone":
            nm = first(it, "name")
            if nm and str(nm[1]) in ("ZONE_A", "In2 GND zones A/B"):
                continue
        if isinstance(it, list) and it and it[0] in ("gr_line", "gr_text"):
            ly = first(it, "layer")
            if ly and str(ly[1]) in ("Dwgs.User", "Cmts.User"):
                continue
        keep.append(it)
    root[:] = keep
    W, H = variant["W"], variant["H"]
    for k, (x0, y0, x1, y1) in enumerate(variant.get("zone_a", [])):
        root.append(["zone", ["net", 0], ["net_name", Q("")], ["layers", Q("F.Cu"), Q("In1.Cu"), Q("In2.Cu"), Q("B.Cu")], ["uuid", B.uid()],
                     ["name", Q("ZONE_A")], ["hatch", "edge", 0.5], ["connect_pads", ["clearance", 0]], ["min_thickness", 0.25],
                     ["filled_areas_thickness", "no"],
                     ["keepout", ["tracks", "allowed"], ["vias", "allowed"], ["pads", "allowed"], ["copperpour", "allowed"], ["footprints", "allowed"]],
                     ["placement", ["enabled", "no"], ["sheetname", Q("")]], ["fill", ["thermal_gap", 0.5], ["thermal_bridge_width", 0.5]],
                     ["polygon", ["pts", ["xy", x0, y0], ["xy", x1, y0], ["xy", x1, y1], ["xy", x0, y1]]]])
    m = 0.3
    cx, cy = variant.get("zone_d_cut", (W + 1, H + 1))     # In2 GND stays out of the XIAO/RF corner (south-east rectangle)
    if cx > W:
        pts = [(m, m), (W - m, m), (W - m, H - m), (m, H - m)]
    else:
        pts = [(m, m), (W - m, m), (W - m, cy), (cx, cy), (cx, H - m), (m, H - m)]
    root.append(B.zone("GND", "In2.Cu", pts, "In2 GND zones A/B", 0))
    Path(out_pcb).write_text(dump(root) + "\n")
    import rb03r_escape_areas as EA            # named pin-column areas for the narrowed hi-Z rules
    EA.add(out_pcb, out_pcb)
    return info


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--netlist", type=Path, required=True)
    ap.add_argument("--variant", required=True)
    ap.add_argument("--variants-file", type=Path, default=HERE / "rb02g_variants.py")
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    v = load_variants(a.variants_file)[a.variant]
    a.out.mkdir(parents=True, exist_ok=True)
    info = build(a.netlist, v, a.out / "variant.kicad_pcb")
    print({k: val for k, val in info.items()})
    return 0


if __name__ == "__main__":
    sys.exit(main())
