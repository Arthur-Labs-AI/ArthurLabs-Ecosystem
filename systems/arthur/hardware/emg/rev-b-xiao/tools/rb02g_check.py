#!/usr/bin/env python3
"""RB-02G: run the RB-02 placement checker (rb02_check_placement.py) on a variant PCB.

The RB-02 checker hard-codes the XIAO frame (module at (85.89, 21.4325), rotation 180).  Variants keep the module footprint,
rotation and USB-end-on-edge relation unchanged, so the variant is translated rigidly into that frame before checking; every
module-relative check (castellation positions, BAT+ post, keep-outs, iron-access bands, USB-C/U.FL corridors, decoupling,
ADC/oscillator, analog symmetry, AIN network) is then evaluated exactly as in RB-02.  C06 (board size) is expected to FAIL for
any variant; C08/C09 use the translated outline and remain valid.

    python3 rb02g_check.py --pcb variant.kicad_pcb --netlist revb.xml --json out.json
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rb02_check_placement as C  # noqa: E402

REF = (85.89, 21.4325)
_orig = C.load


def _shifted(pcb):
    fps, edge, zones, root = _orig(pcb)
    u = fps["U1"]
    ox, oy = u.x - REF[0], u.y - REF[1]
    # USB end of the module must sit on the south outline (RB-00.6): checked here because the translation hides it
    usb_end = u.y + 10.5675
    C.res("C29", "PASS" if abs(usb_end - edge[3]) < 0.02 else "FAIL", "XIAO USB end sits on the south board edge (translation-independent)",
          f"USB end y {usb_end:.3f}, outline south {edge[3]:.3f}")
    for o in fps.values():
        o.x -= ox; o.y -= oy
        for p in o.pads:
            p["x"] -= ox; p["y"] -= oy
        if o.crt:
            o.crt = (o.crt[0] - ox, o.crt[1] - oy, o.crt[2] - ox, o.crt[3] - oy)
    # J1 (side-entry) mating-plug corridor: 7 mm wide, 9 mm long in front of the opening, must be free of other parts
    import math
    j = fps["J1"]
    th = math.radians(j.rot - 180.0)
    ex = (-math.sin(th), -math.cos(th))      # the RB-02 opening direction (0, -1) rotated by the footprint rotation rule
    cx = (j.crt[0] + j.crt[2]) / 2; cy = (j.crt[1] + j.crt[3]) / 2
    if abs(ex[0]) > 0.5:
        x0c, x1c = (j.crt[2], j.crt[2] + 9.0) if ex[0] > 0 else (j.crt[0] - 9.0, j.crt[0])
        corr = (x0c, cy - 3.5, x1c, cy + 3.5)
    else:
        y0c, y1c = (j.crt[3], j.crt[3] + 9.0) if ex[1] > 0 else (j.crt[1] - 9.0, j.crt[1])
        corr = (cx - 3.5, y0c, cx + 3.5, y1c)
    blocked = [r for r, o in fps.items() if r != "J1" and o.crt and o.layer == "F.Cu" and o.crt[0] < corr[2] and corr[0] < o.crt[2] and o.crt[1] < corr[3] and corr[1] < o.crt[3]]
    C.res("C30", "PASS" if not blocked else "FAIL", "J1 mating-plug corridor (7 x 9 mm in front of the opening) free of components",
          f"opening direction ({ex[0]:+.0f},{ex[1]:+.0f}); blocked by {blocked}")
    edge = (edge[0] - ox, edge[1] - oy, edge[2] - ox, edge[3] - oy)
    for z in zones:
        b = z["bbox"]
        z["bbox"] = (b[0] - ox, b[1] - oy, b[2] - ox, b[3] - oy)
    return fps, edge, zones, root


C.load = _shifted

if __name__ == "__main__":
    sys.exit(C.main())
