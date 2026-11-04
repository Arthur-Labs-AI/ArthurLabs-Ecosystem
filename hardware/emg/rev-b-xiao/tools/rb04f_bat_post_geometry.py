#!/usr/bin/env python3
"""RB-04F: hole / mask / annulus / BAT- geometry matrix for BAT+ post candidates (worst case, explicit assumptions).
    python3 rb04f_bat_post_geometry.py --out evidence/rb04f/bat_post_geometry.json
Process T0 = solder cone made on the module pad first, then module lowered so the cone enters the host hole (current procedure).
Process T1 = module soldered by its castellations first, post inserted from below and soldered through the hole to the blind module pad."""
import argparse, json, math
TOL = dict(hole_lo=0.08, hole_hi=0.13, wander=0.075, reg=0.05, ring_tol=0.025, gnd_tol=0.05, e_axis=0.497, cone_d=1.0, gnd0_edge=1.397, post_d=0.511,
           pad_half_v=0.508, s_v_max=0.513)
CAND = {
    "C0 current 1.40/1.90/1.45 (T0)": (1.40, 1.90, 1.45, "T0"),
    "R1 1.70/2.10/1.75 (T0)": (1.70, 2.10, 1.75, "T0"),
    "R1b 1.90/2.30/1.95 (T0)": (1.90, 2.30, 1.95, "T0"),
    "R1c 1.90/2.30/2.05 (T0)": (1.90, 2.30, 2.05, "T0"),
    "R1d 1.90/2.30/2.15 (T0)": (1.90, 2.30, 2.15, "T0"),
    "A1 1.40/1.90/1.65 (T1)": (1.40, 1.90, 1.65, "T1"),
    "A2 1.10/1.50/1.35 (T1)": (1.10, 1.50, 1.35, "T1"),
    "A3 0.80/1.20/1.00 (T1)": (0.80, 1.20, 1.00, "T1"),
}
def row(D, Rg, O, proc):
    Rh_max = (D + TOL["hole_hi"]) / 2; Rh_min = (D - TOL["hole_lo"]) / 2
    ann_nom = (Rg - D) / 2
    ann_worst = ann_nom - TOL["hole_hi"] / 2 - TOL["wander"] - TOL["ring_tol"]
    lip = max(0.0, Rh_max + TOL["wander"] + TOL["reg"] - O / 2)
    lip_typ = max(0.0, (D + 0.05) / 2 - O / 2)                       # finished = nominal +0.05 (typical), centred
    dam_nom = (Rg - O) / 2
    dam_worst = dam_nom - TOL["reg"] - TOL["ring_tol"]
    shift_v = max(0.0, TOL["e_axis"] - (Rh_min - TOL["cone_d"] / 2)) if proc == "T0" else 0.0
    covered_nom = TOL["gnd0_edge"] - Rg / 2
    covered_worst = covered_nom - TOL["gnd_tol"] - TOL["ring_tol"] - shift_v
    exposed_edge_r = O / 2 + TOL["reg"]
    exposed_gap_worst = TOL["gnd0_edge"] - TOL["gnd_tol"] - exposed_edge_r - shift_v
    out = dict(drill=D, ring=Rg, mask=O, finished_hole=[round(D - TOL["hole_lo"], 2), round(D + TOL["hole_hi"], 2)],
               annulus_nominal=round(ann_nom, 3), annulus_worst=round(ann_worst, 3), mask_lip_into_hole_typical=round(lip_typ, 3),
               mask_lip_into_hole_worst=round(lip, 3), mask_dam_over_ring_nominal=round(dam_nom, 3), mask_dam_over_ring_worst=round(dam_worst, 3),
               covered_ring_to_GND0_nominal=round(covered_nom, 3), covered_ring_to_GND0_worst=round(covered_worst, 3),
               exposed_copper_to_GND0_worst=round(exposed_gap_worst, 3))
    if proc == "T0":
        out["cone_fit_shift_needed"] = round(shift_v, 3)
        out["cone_fit_u_margin"] = round(0.150 - max(0.0, TOL["e_axis"] - (Rh_min - TOL["cone_d"] / 2)), 3)
        out["bottom_joint_radial_gap_post_to_barrel"] = round(Rh_min - TOL["post_d"] / 2, 3)
    else:
        out["post_to_barrel_radial_gap_min_max"] = [round(Rh_min - TOL["post_d"] / 2, 3), round(Rh_max - TOL["post_d"] / 2, 3)]
        # solder is confined to the hole: nearest solder point to GND0 = hole-centre offset toward GND0 + finished hole radius
        out["solder_front_to_GND0_worst"] = round(TOL["gnd0_edge"] - TOL["gnd_tol"] - (0.247 + Rh_max), 3)
        off = 0.247 + (Rh_min - TOL["post_d"] / 2)     # hole position error + float of the post inside the hole
        # fraction of the post cross-section that lands on the pad (pad half-height 0.508 in v), post r = 0.2555
        r = TOL["post_d"] / 2
        if off + r <= TOL["pad_half_v"]: frac = 1.0
        else:
            ov = TOL["pad_half_v"] - (off - r)             # chord depth on the pad side
            t = max(0.0, min(2 * r, ov))
            a = r * r * math.acos((r - t) / r) - (r - t) * math.sqrt(max(0.0, 2 * r * t - t * t)) if t < 2 * r else math.pi * r * r
            frac = a / (math.pi * r * r)
        out["post_offset_from_pad_centre_worst"] = round(off, 3)
        out["post_area_fraction_on_pad_worst"] = round(frac, 2)
    return out
ap = argparse.ArgumentParser(); ap.add_argument("--out", required=True); a = ap.parse_args()
res = {k: row(*v) for k, v in CAND.items()}
json.dump(dict(tolerances=TOL, candidates=res), open(a.out, "w"), indent=1)
for k, r in res.items():
    print(k)
    for kk, vv in r.items(): print("   ", kk, vv)
