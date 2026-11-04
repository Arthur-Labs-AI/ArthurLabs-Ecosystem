#!/usr/bin/env python3
"""RB-04E: realistic worst-case + Monte-Carlo stack for the BAT+ post (circular PTH variants), 2-D (u normal to the castellation edge, v along it).
    python3 rb04e_post_stack.py --out evidence/rb04e/post_stack_rb04e.json
Constraints (u = toe direction, v = along the pad rows where BAT- (GND0) lies at -1.905):
  s_u <= toe_nom - toe_min - t_edge - t_pad   (visible toe >= 1.0 mm for every castellation)
  s_v <= overlap budget                       (host/module copper overlap >= 1.0 mm)
  cone must enter the finished hole:  |e - s| <= R_hole_min - r_cone
  BAT- air gap (plan view) = pad-edge distance - ring radius - shift toward GND0 - copper tolerances >= GAP_MIN
All tolerances are ASSUMPTIONS unless marked JLC; Seeed publishes none."""
import argparse, json, math, random
T = dict(
    toe_nom=1.30, toe_min=1.0, t_edge=0.10, t_pad=0.05,          # toe: module edge +-0.10 (assumed), host pad end +-0.05 (assumed)
    mod_cu=1.626, host_w=1.50, ov_min=1.0, t_ov=0.05,
    j=0.25,                                                       # post-on-pad (procedure, hand)
    p=0.10,                                                       # module BAT pad to castellation copper registration (assumed, conservative)
    h=0.075,                                                      # JLC drill position
    reg=0.05,                                                     # host copper-to-drill registration (assumed)
    datum=0.022,
    hole_lo=0.08, hole_hi=0.13,                                   # JLC finished-size tolerance
    gnd0_edge=1.397, t_gnd=0.05, t_ring=0.05,                    # GND0 pad position, ring copper size (assumed)
    gap_min=0.10,
)
S_U = T["toe_nom"] - T["toe_min"] - T["t_edge"] - T["t_pad"]
S_V = (T["mod_cu"] + T["host_w"]) / 2 - T["ov_min"] - T["t_ov"]
VAR = {"V0 current 1.40/1.90": (1.40, 1.90), "R1 1.70/2.10": (1.70, 2.10), "R1b 1.90/2.30": (1.90, 2.30), "V1.8/2.2": (1.80, 2.20), "V2.0/2.4": (2.0, 2.4)}
E_MAX = T["j"] + T["p"] + T["h"] + T["reg"] + T["datum"]


def worst(h, ring, cone):
    R = (h - T["hole_lo"]) / 2; m = R - cone / 2
    su_need = max(0.0, E_MAX - m)                 # per-axis worst case, shift along the same axis
    sv_need = max(0.0, E_MAX - m)
    gap_nom = T["gnd0_edge"] - ring / 2
    gap_wc = gap_nom - T["t_gnd"] - T["t_ring"] - sv_need
    return dict(R_min=round(R, 3), margin_centred=round(m, 3), shift_u_needed=round(su_need, 3), shift_u_allowed=round(S_U, 3),
                margin_u=round(S_U - su_need, 3), shift_v_needed=round(sv_need, 3), shift_v_allowed=round(S_V, 3),
                bat_minus_gap_nominal=round(gap_nom, 3), bat_minus_gap_worst=round(gap_wc, 3), annulus_nominal=round((ring - h) / 2, 3))


def mc(h, ring, cone, n=200000, seed=1):
    """Monte Carlo: uniform independent errors; the assembler applies the MINIMUM module shift that brings the cone inside the hole
    (u limited by the toe rule, the rest along v).  GND0 lies at -v: a +v cone error is corrected by moving the module toward GND0."""
    rnd = random.Random(seed); fails_cone = fails_gap = 0
    for _ in range(n):
        eu = sum(rnd.uniform(-x, x) for x in (T["j"], T["p"], T["h"], T["reg"], T["datum"]))
        ev = sum(rnd.uniform(-x, x) for x in (T["j"], T["p"], T["h"], T["reg"], T["datum"]))
        R = (h - T["hole_lo"] + rnd.uniform(0, T["hole_lo"] + T["hole_hi"])) / 2
        m = R - cone / 2
        d = math.hypot(eu, ev)
        if d <= m:
            su = sv = 0.0
        else:
            k = 1 - m / d; su, sv = abs(eu) * k, abs(ev) * k
            if su > S_U:                                  # u limited: push the remainder into v
                su = S_U; ru = abs(eu) - S_U
                if ru > m: fails_cone += 1; continue
                sv = max(0.0, abs(ev) - math.sqrt(m * m - ru * ru))
            if sv > S_V: fails_cone += 1; continue
        toward = sv if ev > 0 else 0.0
        gap = T["gnd0_edge"] + rnd.uniform(-T["t_gnd"], T["t_gnd"]) - (ring / 2 + rnd.uniform(-T["t_ring"], T["t_ring"])) - toward
        if gap < T["gap_min"]: fails_gap += 1
    return dict(P_cone_not_fitting=fails_cone / n, P_bat_minus_gap_below_min=fails_gap / n)


ap = argparse.ArgumentParser(); ap.add_argument("--out", required=True); a = ap.parse_args()
out = dict(tolerances=T, allowed=dict(s_u=round(S_U, 3), s_v=round(S_V, 3)), e_max_per_axis=round(E_MAX, 3), variants={})
for name, (h, ring) in VAR.items():
    out["variants"][name] = {f"cone_{c}": dict(worst_case=worst(h, ring, c), monte_carlo=mc(h, ring, c)) for c in (1.0, 1.1)}
json.dump(out, open(a.out, "w"), indent=1)
print("allowed shifts u/v:", round(S_U, 3), round(S_V, 3), "error per axis (linear):", round(E_MAX, 3))
for name, d in out["variants"].items():
    for c, r in d.items():
        w = r["worst_case"]
        print(f"{name:22s} {c}: m={w['margin_centred']:.3f} s_u need {w['shift_u_needed']:.3f}/{w['shift_u_allowed']:.3f} (margin {w['margin_u']:+.3f}) "
              f"BAT- gap nom {w['bat_minus_gap_nominal']:.3f} worst {w['bat_minus_gap_worst']:+.3f} annulus {w['annulus_nominal']:.2f} | MC P(cone) {r['monte_carlo']['P_cone_not_fitting']:.4f} P(gap) {r['monte_carlo']['P_bat_minus_gap_below_min']:.4f}")
