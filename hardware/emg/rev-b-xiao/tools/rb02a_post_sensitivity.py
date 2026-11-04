#!/usr/bin/env python3
"""RB-02A: BAT+ post geometry sensitivity analysis (no guaranteed tolerances are invented).

All CAD geometry is read from the Seeed PCB through rb02a_xiao_cad_extract.py.  Every *tolerance* below is an explicit
ASSUMPTION swept over a range, because neither Seeed nor the RB-00.6 documents publish it; the output shows which
combinations keep each requirement satisfied so the unknowns can be turned into a manufacturing-release gate.

    python3 rb02a_post_sensitivity.py --pcb <XIAO ESP32S3_V1.5.kicad_pcb> [--json out.json]
"""
import argparse
import itertools
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rb02a_xiao_cad_extract as X  # noqa: E402

HOLE_DRILL = 1.40          # RB-00.6 §3
RING_D = 1.90              # host F.Cu annular ring
MASK_OPEN = 1.45           # host mask opening (hole + 0.025/side)
BOT_PAD = 3.00             # host B.Cu pad
POST_D = (0.511, 0.54)     # AWG24 bare / tinned (assumption: +0.03)
CONE_D_SPEC = 1.10         # RB-00.6 "cone Ø <= 1.1"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pcb", type=Path, required=True)
    ap.add_argument("--json", type=Path)
    a = ap.parse_args(argv)
    cad = X.extract(a.pcb)
    pads = cad["pads"]
    bat = next(p for p in pads if p["ref"] == "BAT0")
    gnd0 = next(p for p in pads if p["ref"] == "GND0")
    pad_len, pad_h = bat["w"], bat["h"]            # 2.032 x 1.016 (file frame, rotation 180 keeps the axes)
    pitch = abs(bat["y"] - gnd0["y"])
    gap = pitch - pad_h
    # castellation copper on the module (width along the edge)
    cast_w = 1.626
    host_w = 1.50
    over = (cast_w - host_w) / 2
    out = {"cad": {"bat_pad": [pad_len, pad_h], "pad_pitch_to_gnd0": round(pitch, 4), "pad_gap": round(gap, 4),
                   "castellation_copper_width": cast_w}}
    print(f"BAT+ pad {pad_len:.3f} x {pad_h:.3f}; GND0 pitch {pitch:.3f}; pad-to-pad gap {gap:.3f}")

    # 1. post must stay on the pad
    max_off = pad_h / 2 - POST_D[0] / 2
    print(f"1. post centre may deviate at most {max_off:.3f} mm (y) from the pad centre before its edge leaves the pad "
          f"({(pad_len / 2 - POST_D[0] / 2):.3f} mm in x)")
    out["post_on_pad_max_offset_y"] = round(max_off, 3)

    # 2. flat seating: cone must enter the hole
    print("2. flat seating (cone enters the plated hole)   radial margin = (finished hole - cone)/2 [mm]")
    rows = []
    print("   finished hole:  " + "  ".join(f"{d:.2f}" for d in (1.45, 1.40, 1.35, 1.30, 1.25)))
    for cone in (0.8, 0.9, 1.0, 1.1, 1.2, 1.3):
        m = [(d - cone) / 2 for d in (1.45, 1.40, 1.35, 1.30, 1.25)]
        rows.append({"cone_d": cone, "margins": [round(x, 3) for x in m]})
        print(f"   cone Ø{cone:.1f}      " + "  ".join(f"{x:+.3f}" for x in m))
    out["flat_seating"] = rows
    print("   -> with the RB-00.6 limit Ø1.1 and a plated hole of Ø1.25-1.35 the margin is +0.075..+0.125 mm: the module "
          "must be shifted to centre the cone; it will not sit flat if the cone is Ø1.2 or more.")

    # 3. castellation overlap vs module shift
    print("3. castellation coverage vs module shift delta (host pad 1.50, module copper 1.626)")
    cov = []
    for d in (0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6):
        ov = host_w - max(0.0, abs(d) - over)
        cov.append({"shift": d, "overlap_width": round(ov, 3)})
        print(f"   shift {d:.1f} mm -> overlap {ov:.2f} mm along the edge (min needed for a visible fillet ~1.0)")
    out["castellation_coverage"] = cov

    # 4. cone to GND0
    print("4. solder cone to GND0 pad edge (module frame; independent of the host hole)")
    print("   post offset toward GND0:   " + "  ".join(f"{e:.2f}" for e in (0.0, 0.1, 0.2, max_off)))
    cg = []
    base = pitch - pad_h / 2           # BAT+ centre to GND0 pad nearest edge
    for r in (0.45, 0.55, 0.65, 0.8):
        vals = [base - e - r for e in (0.0, 0.1, 0.2, max_off)]
        cg.append({"cone_r": r, "clearance": [round(v, 3) for v in vals]})
        print(f"   cone r {r:.2f}:              " + "  ".join(f"{v:+.3f}" for v in vals))
    out["cone_to_gnd0"] = cg
    print("   (a cone cannot be wider than the pad's wettable 1.016 mm in y, so r > 0.51 only extends along x)")

    # 5. host ring to GND0 (plan view; separated by solder mask + stand-off)
    print("5. host annular ring (Ø1.90) to GND0 pad edge in plan view")
    y_usb = cad["outline"]["bbox"][1]
    bat_y_board = 32.00 - (bat["y"] - y_usb)            # RB-00.6 orientation (USB end at y = 32.00)
    hole_y = 21.862                                      # RB-00.6 §3
    hole_dy = hole_y - bat_y_board                       # +: hole is displaced toward GND0 (board y increases toward GND0)
    ring_gap0 = (pitch - pad_h / 2 - hole_dy) - RING_D / 2
    out["hole_minus_pad_centre_y"] = round(hole_dy, 3)
    print(f"   hole is {hole_dy:+.3f} mm off the pad centre (toward GND0); nominal ring-to-GND0 gap {ring_gap0:.3f} mm; shrinks by the module offset toward GND0:")
    rg = []
    for off in (0.0, 0.1, 0.2, 0.3, 0.4, 0.45):
        rg.append({"module_offset": off, "gap": round(ring_gap0 - off, 3)})
        print(f"   offset {off:.2f} -> {ring_gap0 - off:+.3f} mm {'(plan overlap, no metal contact: mask-covered)' if ring_gap0 - off < 0 else ''}")
    out["ring_to_gnd0"] = rg

    # 6. mask annulus
    print(f"6. host mask: opening Ø{MASK_OPEN} over ring Ø{RING_D}: annulus {(RING_D - MASK_OPEN) / 2:.3f} mm per side "
          f"(registration +/-0.05 typical -> >= 0.175 mm; JLC minimum mask dam 0.1 mm); ring annulus {(RING_D - HOLE_DRILL) / 2:.3f} mm")
    out["mask_annulus"] = round((RING_D - MASK_OPEN) / 2, 3)

    # 7. thermal
    print("7. differential thermal growth over the 21.1 mm module length (FR4 host vs module, dalpha assumed)")
    for da in (2e-6, 5e-6, 10e-6):
        for dT in (25, 60):
            print(f"   dalpha {da * 1e6:.0f} ppm/K, dT {dT} K -> {da * dT * 21.135 * 1000:.1f} um")

    # 8. USB insertion force sharing (estimate)
    print("8. USB-C plug insertion load (estimate; forces are assumptions: USB-C spec insertion 5-20 N)")
    for F in (5, 10, 20):
        share_post = F / 15
        print(f"   F = {F:2d} N pushed along the module axis; if only 1 of 15 joints carried it: {share_post:.1f} N each "
              f"(copper post shear capacity ~{0.204 * 150:.0f} N for Ø0.51 at 150 MPa; solder-to-pad ~15 N)")
    print("   -> the post must not be the load path: enclosure wall/E1 support and the 14 castellation fillets carry plug force.")

    # 9. bottom-side access
    print("9. bottom joint access: host B.Cu Ø3.00 pad; RB-00.6 puts no B.Cu components, so a 1.6-2.4 mm tip reaches it. "
          "Post protrusion 1.0 mm after trimming.")
    if a.json:
        a.json.write_text(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
