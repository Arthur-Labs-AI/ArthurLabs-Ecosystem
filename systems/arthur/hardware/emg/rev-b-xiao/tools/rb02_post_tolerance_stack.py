#!/usr/bin/env python3
"""RB-02: BAT+ post tolerance stack (post diameter, solder cone, finished hole, alignment, BAT- clearance) for the frozen
RB-00.6 geometry and the candidate adjustments.  Worst-case and uniform Monte-Carlo.

    python3 rb02_post_tolerance_stack.py [--json out.json]

Inputs (provenance):
  CAD (RB-02A, Seeed PCB):   BAT+ pad 2.032 x 1.016, GND0 pad 1.905 mm from BAT+, hole 0.022 mm from the pad centre toward GND0
  JLCPCB capabilities page (read 2026-10-10): plated through-hole size tolerance +0.13/-0.08 mm on the size given in the
      Gerber/drill file (the file size is the FINISHED size), hole position tolerance +/-0.075 mm, PTH annular ring
      recommended >= 0.20 / absolute minimum 0.15 mm (multilayer, 1 oz), soldermask bridge 0.10 mm, board outline +/-0.1 mm
  RB-00.6: post AWG24 solid (0.511 mm bare, tinned assumed <= 0.56), cone <= 1.1 mm / 0.5 mm, castellation host pad 1.50
  ASSUMPTIONS (not published by anybody; swept): post position error on the module pad, module placement error
"""
import argparse
import json
import random

PAD_H, PAD_L = 1.016, 2.032
PITCH = 1.905                       # BAT+ to GND0 centre distance
HOLE_OFF = 0.022                    # hole centre is this far from the BAT+ pad centre, toward GND0
MOD_CU_W, HOST_W = 1.626, 1.50      # castellation copper along the edge vs host pad
POST_D = (0.50, 0.56)               # bare AWG24 0.511 ... tinned
JLC_TOL = (-0.08, +0.13)            # finished hole size tolerance
JLC_POS = 0.075                     # hole position tolerance
JLC_AR_MIN, JLC_AR_REC = 0.15, 0.20
MASK_DAM = 0.10

OPTIONS = {
    "A frozen (RB-00.6): drill 1.40, ring 1.90, mask 1.45, cone <= 1.1": dict(drill=1.40, ring=1.90, mask=1.45, cone=1.10),
    "B = A with cone target <= 1.0 (process control only)": dict(drill=1.40, ring=1.90, mask=1.45, cone=1.00),
    "E = B with mask opening 1.55 (mask edit only; ring, drill unchanged)": dict(drill=1.40, ring=1.90, mask=1.55, cone=1.00),
    "C = B with ring 2.00 / mask 1.55 (copper + mask edit, drill unchanged)": dict(drill=1.40, ring=2.00, mask=1.55, cone=1.00),
    "D = drill 1.50, ring 2.10, mask 1.60, cone <= 1.1": dict(drill=1.50, ring=2.10, mask=1.60, cone=1.10),
}


def metrics(o, hole, post, cone, ep, th, mod_off):
    """hole: finished diameter; ep: post offset on the module pad toward GND0 (>=0 worse); th: hole position error toward GND0;
    mod_off: residual module placement error toward GND0 after the post has located it."""
    play = (hole - post) / 2
    cone_margin = (hole - cone) / 2                      # >= 0 : the cone enters the hole and the module sits flat
    shift = abs(ep) + abs(th)                            # module shift needed so that post and hole coincide (vs castellation pads)
    overlap = HOST_W - max(0.0, shift + abs(mod_off) - (MOD_CU_W - HOST_W) / 2)
    cone_gnd0 = PITCH - PAD_H / 2 - ep - cone / 2        # module frame: cone edge to GND0 pad edge
    ring_gnd0 = PITCH - PAD_H / 2 - HOLE_OFF - o["ring"] / 2 - (shift + abs(mod_off))
    annulus = (o["ring"] - hole) / 2
    mask_over = (o["mask"] - hole) / 2                   # < 0 : mask edge lies inside the hole
    mask_dam = (o["ring"] - o["mask"]) / 2               # mask annulus over the ring
    return dict(play=play, cone_margin=cone_margin, overlap=overlap, cone_gnd0=cone_gnd0, ring_gnd0=ring_gnd0,
                annulus=annulus, mask_over=mask_over, mask_dam=mask_dam)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--json")
    ap.add_argument("--n", type=int, default=200000)
    a = ap.parse_args(argv)
    random.seed(20261010)
    out = {}
    for name, o in OPTIONS.items():
        lo, hi = o["drill"] + JLC_TOL[0], o["drill"] + JLC_TOL[1]
        # worst case per metric
        wc = {
            "finished hole range": (round(lo, 3), round(hi, 3)),
            "post play (min..max)": (round((lo - POST_D[1]) / 2, 3), round((hi - POST_D[0]) / 2, 3)),
            "cone-in-hole margin, worst": round((lo - o["cone"]) / 2, 3),
            "annular ring, worst (hole max)": round((o["ring"] - hi) / 2, 3),
            "mask opening minus hole, worst (hole max)": round((o["mask"] - hi) / 2, 3),
            "mask annulus over the ring": round((o["ring"] - o["mask"]) / 2, 3),
        }
        worst = metrics(o, lo, POST_D[1], o["cone"], 0.253, JLC_POS, 0.2)
        wc["castellation overlap, worst (post 0.253 off, hole +/-0.075, module +/-0.2)"] = round(worst["overlap"], 3)
        wc["cone to GND0 pad edge, worst (post 0.253 toward GND0)"] = round(worst["cone_gnd0"], 3)
        wc["host ring to GND0 pad edge, worst plan gap"] = round(worst["ring_gnd0"], 3)
        # Monte Carlo (uniform within the stated bounds)
        n_cone = n_ring = n_over = n_ar = 0
        gmin = 9.0
        for _ in range(a.n):
            hole = o["drill"] + random.uniform(*JLC_TOL)
            post = random.uniform(*POST_D)
            cone = random.uniform(0.8, o["cone"])
            ep = random.uniform(-0.253, 0.253)
            th = random.uniform(-JLC_POS, JLC_POS)
            mo = random.uniform(-0.2, 0.2)
            m = metrics(o, hole, post, cone, ep, th, mo)
            n_cone += m["cone_margin"] < 0
            n_ring += m["ring_gnd0"] < 0
            n_over += m["overlap"] < 1.0
            n_ar += m["annulus"] < JLC_AR_REC
            gmin = min(gmin, m["cone_gnd0"])
        wc["MC P(cone does not fit)"] = round(n_cone / a.n, 5)
        wc["MC P(ring plan-overlaps GND0 pad)"] = round(n_ring / a.n, 5)
        wc["MC P(castellation overlap < 1.0 mm)"] = round(n_over / a.n, 5)
        wc["MC P(annular ring < 0.20 recommended)"] = round(n_ar / a.n, 5)
        wc["MC min cone-to-GND0 clearance"] = round(gmin, 3)
        out[name] = wc
        print("\n" + name)
        for k, v in wc.items():
            print(f"   {k:70s} {v}")
    if a.json:
        open(a.json, "w").write(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
