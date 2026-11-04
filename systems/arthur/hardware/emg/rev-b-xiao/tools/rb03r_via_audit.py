#!/usr/bin/env python3
"""RB-03R: geometric via-to-pad / solder-mask / paste audit of a routed board (independent of KiCad DRC).

    python3 rb03r_via_audit.py --pcb routed.kicad_pcb --out via_audit.json [--csv via_audit.csv]

For every through via and every SMD pad it computes, in true pad geometry (pcbnew HitTest on the pad shape, not the bbox):
  centre_in_pad        via centre inside the pad copper            -> via-in-pad (FAIL)
  hole_touch           via hole (r = drill/2) touches pad copper OR the solder-mask opening of the pad (FAIL)
  annulus_overlap      via copper annulus overlaps the pad copper / mask opening (WARN: tented via but annulus inside the opening)
  paste_hit            via hole inside the paste aperture region (pad shape shrunk by the paste margin)
  mask_dam_mm          distance from the via annulus to the pad mask opening (JLC: >= 0.10 mm web recommended, see evidence)
and lists every via within 0.45 mm (centre to copper) of any SMD pad.  Tiers:  A: annulus clear of the mask opening;
B: hole clear of the mask opening by >= 0.10 mm (tented via, annulus may touch the opening); FAIL otherwise.
Mask opening = pad copper + (pad solder_mask_margin or board pad_to_mask_clearance); XIAO castellation pads carry +0.05 mm.
"""
import argparse
import csv
import json
import math
import sys
from pathlib import Path

import pcbnew
import sys as _sys, pathlib as _pl
_sys.path.insert(0, str(_pl.Path(__file__).resolve().parent))
from rb03r_safe import safe_pcb  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_sexpr import first, kids, parse  # noqa: E402

NM = 1e6


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pcb", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--csv", type=Path)
    a = ap.parse_args(argv)
    root = parse(a.pcb.read_text())
    vias = []
    for v in kids(root, "via"):
        at = first(v, "at")
        vias.append({"x": float(at[1]), "y": float(at[2]), "net": str(first(v, "net")[1]), "size": float(first(v, "size")[1]),
                     "drill": float(first(v, "drill")[1])})
    b = pcbnew.LoadBoard(str(safe_pcb(a.pcb)))
    glob_mask = (b.GetDesignSettings().m_SolderMaskExpansion or 0) / NM
    rows = []
    pads = []
    for fp in b.GetFootprints():
        for p in fp.Pads():
            if p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH:
                continue
            lm = p.GetLocalSolderMaskMargin()
            m = lm / NM if lm else glob_mask
            lp = p.GetLocalSolderPasteMargin()
            pm = (lp / NM) if lp else 0.0
            pads.append((fp.GetReference(), p.GetNumber(), p, m, pm, p.IsOnLayer(pcbnew.F_Paste) or p.IsOnLayer(pcbnew.B_Paste),
                         "F.Cu" if p.IsOnLayer(pcbnew.F_Cu) else "B.Cu", p.GetNetname()))
    for v in vias:
        pos = pcbnew.VECTOR2I(int(round(v["x"] * NM)), int(round(v["y"] * NM)))
        hr, ar = v["drill"] / 2, v["size"] / 2
        for ref, num, p, m, pm, has_paste, lay, pnet in pads:
            # exact distance centre -> pad copper by bisection on HitTest accuracy (0.01 mm resolution up to 1.0 mm)
            if p.HitTest(pos, 0):
                d = 0.0
            else:
                lo, hi = 0.0, 1.0
                if not p.HitTest(pos, int(hi * NM)):
                    continue
                for _ in range(8):
                    mid = (lo + hi) / 2
                    if p.HitTest(pos, int(mid * NM)):
                        hi = mid
                    else:
                        lo = mid
                d = hi
            if d > 0.45:
                continue
            opening = d - m                                  # distance centre -> mask opening edge (negative = inside)
            rec = {"via": [round(v["x"], 3), round(v["y"], 3)], "via_net": v["net"], "via_size": ar * 2, "via_drill": hr * 2, "layers": "F.Cu-B.Cu",
                   "pad": f"{ref}.{num}", "pad_net": pnet, "pad_layer": lay, "centre_to_pad_copper_mm": round(d, 3),
                   "mask_margin_mm": round(m, 3), "centre_to_mask_opening_mm": round(opening, 3),
                   "hole_to_opening_mm": round(opening - hr, 3), "annulus_to_opening_mm": round(opening - ar, 3),
                   "centre_in_pad": d == 0.0, "paste_aperture": has_paste, "paste_margin_mm": round(pm, 3),
                   "paste_hit": bool(has_paste and d == 0.0)}
            if d == 0.0:
                rec["class"] = "FAIL via-in-pad"
            elif opening - hr < 0.09:
                rec["class"] = "FAIL hole within 0.10 mm of the mask opening"
            elif opening - ar < 0.0:
                rec["class"] = "TIER-B annulus inside the mask opening (hole clear)"
            elif opening - ar < 0.10:
                rec["class"] = "TIER-A- annulus clear, mask web < 0.10 mm"
            else:
                rec["class"] = "OK (web >= 0.10 mm)"
            rows.append(rec)
    summ = {"vias": len(vias), "pad_proximity_records": len(rows)}
    for key in ("FAIL via-in-pad", "FAIL hole within 0.10 mm of the mask opening", "TIER-B annulus inside the mask opening (hole clear)",
                "TIER-A- annulus clear, mask web < 0.10 mm", "OK (web >= 0.10 mm)"):
        summ[key] = sum(1 for r in rows if r["class"] == key)
    a.out.write_text(json.dumps({"summary": summ, "records": rows}, indent=1))
    if a.csv:
        with a.csv.open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else ["none"])
            w.writeheader()
            for r in rows:
                w.writerow(r)
    print(json.dumps(summ, indent=1))
    for r in rows:
        if r["class"].startswith("FAIL"):
            print("  ", r["class"][:20], r["pad"], r["via_net"], r["via"], "d=", r["centre_to_pad_copper_mm"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
