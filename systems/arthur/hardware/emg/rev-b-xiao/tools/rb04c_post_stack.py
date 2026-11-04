#!/usr/bin/env python3
"""RB-04C: worst-case (linear) and RSS tolerance stack for the BAT+ post, castellations and USB end.  All tolerances are ASSUMPTIONS stated here
(Seeed publishes none).   python3 rb04c_post_stack.py --out evidence/rb04c/post_stack.json"""
import json, math, sys
from pathlib import Path
A = dict(
    hole_nom=1.40, hole_tol_lo=0.08, hole_tol_hi=0.13,       # JLC PTH finished-size tolerance (RB-00.6 D-5)
    hole_pos=0.075,                                           # JLC drilled position
    datum=0.022,                                              # RB-02A datum uncertainty of the hole-to-pad nominal
    pad_reg=0.10,                                             # module copper registration relative to castellations (assumed)
    post_on_pad=0.25,                                         # procedure limit
    place=0.20, outline=0.20,                                 # hand placement / module outline (assumed)
    post_d=0.511,
    pad_w=2.032, pad_h=1.016, gnd0_pitch=1.905, ring_d=1.90, mask_open=1.45,
    host_pad_w=1.50, host_pad_len=2.90, toe_nom=1.30, inner_nom=1.60, mod_cu=1.626,
)
out = {}
R_hole_min = (A["hole_nom"] - A["hole_tol_lo"]) / 2
rho_lin = A["post_on_pad"] + A["pad_reg"] + A["hole_pos"] + A["datum"]
rho_rss = math.sqrt(A["post_on_pad"] ** 2 + A["pad_reg"] ** 2 + A["hole_pos"] ** 2 + A["datum"] ** 2)
cones = {}
for d in (0.8, 1.0, 1.1, 1.2):
    margin_nom = R_hole_min - d / 2
    cones[str(d)] = dict(radial_margin_centred=round(margin_nom, 3), shift_needed_linear=round(max(0, rho_lin - margin_nom), 3),
                         shift_needed_rss=round(max(0, rho_rss - margin_nom), 3))
out["cone_in_hole"] = dict(R_hole_min=R_hole_min, rho_linear=round(rho_lin, 3), rho_rss=round(rho_rss, 3), by_cone_diameter=cones)
# available module shift (hand-centred on the cone) before castellation / toe limits
s_along = (A["mod_cu"] + A["host_pad_w"]) / 2 - 1.0 - 0.05          # keep >= 1.0 mm copper overlap (spec), 0.05 host etch
s_toe_spec = A["toe_nom"] - 1.0 - 0.10                              # visible toe >= 1.0 mm with +-0.10 module width
s_toe_func = A["toe_nom"] - 0.75 - 0.10                             # relaxed: toe >= 0.75 mm still touchable with 1.6 mm chisel (assumption)
out["available_shift"] = dict(along_edge=round(s_along, 3), normal_toe_ge_1p0=round(s_toe_spec, 3), normal_toe_ge_0p75=round(s_toe_func, 3))
# neighbouring copper under worst shift
s = max(rho_lin, 0.0)
out["gnd0"] = dict(pad_edge_from_bat_centre=round(A["gnd0_pitch"] - A["pad_h"] / 2, 3),
                   cone_edge_to_gnd0_edge_worst=round(A["gnd0_pitch"] - A["pad_h"] / 2 - (1.1 / 2 + 0.253), 3),     # post at +0.253 toward GND0 (pad limit), cone Ø1.1
                   host_ring_to_gnd0_edge_nominal=round(A["gnd0_pitch"] - A["pad_h"] / 2 - A["ring_d"] / 2, 3),
                   host_mask_opening_to_gnd0_edge_nominal=round(A["gnd0_pitch"] - A["pad_h"] / 2 - A["mask_open"] / 2, 3),
                   gnd0_over_mask_covered_ring_at_shift=round(A["gnd0_pitch"] - A["pad_h"] / 2 - A["ring_d"] / 2 - 0.45, 3),
                   gnd0_to_mask_opening_at_shift_0p45=round(A["gnd0_pitch"] - A["pad_h"] / 2 - A["mask_open"] / 2 - 0.45, 3))
# castellations at the worst module shifts
out["castellation"] = {f"shift_{d}": dict(overlap_along=round((A["mod_cu"] + A["host_pad_w"]) / 2 - d, 3),
                                           toe_min=round(A["toe_nom"] - d - 0.10, 3), toe_max=round(A["toe_nom"] + d + 0.10, 3),
                                           neighbour_cu_gap=round(2.54 - A["host_pad_w"] / 2 - A["mod_cu"] / 2 - d, 3))
                       for d in (0.0, 0.2, 0.45, 0.6)}
out["usb_end"] = dict(nominal_inset_from_board_edge=0.0, range=[-round(A["place"] + A["outline"] / 2, 3), round(A["place"] + A["outline"] / 2, 3)],
                      note="negative = module end beyond the board edge; receptacle overhang 1.508 beyond the module end")
out["assumptions"] = A
json.dump(out, open(sys.argv[sys.argv.index("--out") + 1], "w"), indent=1)
print(json.dumps(out, indent=1)[:2500])
