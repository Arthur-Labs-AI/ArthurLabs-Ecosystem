#!/usr/bin/env python3
"""RB-02H: underside/packaging feasibility for a placement variant (battery pocket search, lead path to J1, test-pad and
BAT+ post exposure, antenna keep-away).  Read-only; documented envelopes only, no battery model selected.

    python3 rb02h_packaging.py --pcb variant.kicad_pcb --name V1 --out <dir>

Battery envelopes (cell + tolerance, mm, thickness x width x length; "pack" adds a 10 mm PCM/lead zone at one short end, an
assumption taken from the LiPol LP503035 pack drawing which shows the PCM beside the cell):
  503035  5.3 x 30.5 x 37.0   LiPol LP503035 datasheet: 5.0 +/-0.3, 30 +/-0.5, 36 +/-1.0 (PCM, JST PHR-2)
  503040  5.3 x 30.5 x 42.0   Jauch LP503040JH product page: 42 x 30.5 mm (thickness by the T-W-L naming convention)
  603450  6.3 x 34.5 x 51.0   naming convention + the same growth allowances (+0.3/+0.5/+1.0): estimate only
"""
import argparse
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_check_placement import load  # noqa: E402

CELLS = {"503035": (5.3, 30.5, 37.0), "503040": (5.3, 30.5, 42.0), "603450": (6.3, 34.5, 51.0)}
PCM = 10.0
EDGE = 1.5            # pocket margin to the PCB outline (enclosure wall / compression margin)
POST_R = 3.0          # Ø3.0 bottom pad + ~1 mm trimmed post tail: relief or keep-out
UFL_OFF = (68.741 + 22.0 - 85.89, 12.594 - 21.4325)      # U.FL relative to the module centre (RB-02A CAD)
ANT_R = 12.2          # rule-of-thumb keep-away = lambda/10 at 2.45 GHz (122 mm / 10) for a flexible antenna element vs foil: a heuristic, not a measurement


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pcb", type=Path, required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    fps, E, z, root = load(a.pcb)
    W, H = E[2], E[3]
    u = fps["U1"]
    post = [p for p in u.pads if p["num"] == "23" and p["type"] == "thru_hole"][0]
    tps = {r: (o.x, o.y) for r, o in fps.items() if r.startswith("TP")}
    ufl = (u.x + UFL_OFF[0], u.y + UFL_OFF[1])
    j1 = fps["J1"]
    th = math.radians(j1.rot - 180.0)
    ex, ey = -math.sin(th), -math.cos(th)
    jc = ((j1.crt[0] + j1.crt[2]) / 2, (j1.crt[1] + j1.crt[3]) / 2)
    half = max(j1.crt[2] - j1.crt[0], j1.crt[3] - j1.crt[1]) / 2
    plug = (jc[0] + ex * half, jc[1] + ey * half)
    res = {}
    for name, (t, w, l) in CELLS.items():
        best = None
        best_s = None
        for orient in (0, 90):
            bw, bl = (w, l + PCM) if orient == 0 else (l + PCM, w)
            if bw > W - 2 * EDGE or bl > H - 2 * EDGE:
                continue
            x = EDGE
            while x + bw <= W - EDGE + 1e-9:
                y = EDGE
                while y + bl <= H - EDGE + 1e-9:
                    cx, cy = x + bw / 2, y + bl / 2
                    # post circle vs rectangle
                    dxp = max(x - post["x"], 0, post["x"] - (x + bw)); dyp = max(y - post["y"], 0, post["y"] - (y + bl))
                    post_gap = math.hypot(dxp, dyp)
                    covered = [r for r, (tx, ty) in tps.items() if x <= tx <= x + bw and y <= ty <= y + bl]
                    dxa = max(x - ufl[0], 0, ufl[0] - (x + bw)); dya = max(y - ufl[1], 0, ufl[1] - (y + bl))
                    ant_gap = math.hypot(dxa, dya)
                    # lead path: nearest rectangle point to the J1 plug mouth, plus 12 mm to go around the PCB edge
                    dxj = max(x - plug[0], 0, plug[0] - (x + bw)); dyj = max(y - plug[1], 0, plug[1] - (y + bl))
                    lead = math.hypot(dxj, dyj) + 12.0
                    score = (post_gap < POST_R, ant_gap < ANT_R, len(covered), lead)
                    rec = {"x": round(x, 1), "y": round(y, 1), "w": bw, "l": bl, "orient": orient, "post_gap": round(post_gap, 1),
                           "tps_covered": covered, "antenna_gap": round(ant_gap, 1), "lead_path_mm": round(lead, 1)}
                    if best is None or score < best[0]:
                        best = (score, rec)
                    # south-biased alternative: same hard constraints, then the lowest pocket on the board (under ADC/digital)
                    score_s = (post_gap < POST_R, ant_gap < ANT_R, -y, len(covered), lead)
                    if best_s is None or score_s < best_s[0]:
                        best_s = (score_s, rec)
                    y += 0.5
                x += 0.5
        res[name] = {"north_biased": best[1] if best else None, "south_biased": best_s[1] if best_s else None}
    out = {"name": a.name, "outline": (W, H), "post": (round(post["x"], 2), round(post["y"], 2)), "ufl": (round(ufl[0], 1), round(ufl[1], 1)),
           "j1_plug_mouth": (round(plug[0], 1), round(plug[1], 1)), "j1_exit": (round(ex), round(ey)),
           "test_pads": {r: (round(x, 1), round(y, 1)) for r, (x, y) in tps.items()}, "battery_fit": res}
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / f"{a.name}_packaging.json").write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))
    # picture: underside view (mirrored in x is not applied; plan view through the board)
    S = 12.0
    sv = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W*S+150:.0f}" height="{H*S+150:.0f}" font-family="DejaVu Sans, sans-serif">',
          '<rect width="100%" height="100%" fill="#fff"/>',
          f'<text x="12" y="24" font-size="16" font-weight="bold">{a.name}: battery pockets (plan view)</text>',
          f'<g transform="translate(20,40) scale({S})">',
          f'<rect x="0" y="0" width="{W}" height="{H}" rx="1" fill="#f4f1e6" stroke="#222" stroke-width="0.12"/>']
    col = {"north_biased": "#8fd19e", "south_biased": "#ffd27f"}
    for k, vv in res.items():
        if k != "503035":
            continue
        for kk in ("north_biased", "south_biased"):
            v = vv[kk]
            if not v:
                continue
            k = kk
            sv.append(f'<rect x="{v["x"]}" y="{v["y"]}" width="{v["w"]}" height="{v["l"]}" fill="{col[k]}" fill-opacity="0.35" stroke="#333" stroke-width="0.1" stroke-dasharray="0.5 0.3"/>'
                      f'<text x="{v["x"]+0.6}" y="{v["y"]+1.6}" font-size="1.3">503035 pack {v["w"]:.1f}x{v["l"]:.1f} ({kk.split("_")[0]})</text>')
    sv.append(f'<circle cx="{post["x"]}" cy="{post["y"]}" r="{POST_R}" fill="#d00" fill-opacity="0.25" stroke="#d00" stroke-width="0.1"/><text x="{post["x"]-4}" y="{post["y"]-3.4}" font-size="1.2" fill="#a00">BAT+ post tail</text>')
    for r, (x, y) in tps.items():
        sv.append(f'<circle cx="{x}" cy="{y}" r="0.75" fill="#555"/><text x="{x+0.9}" y="{y-0.6}" font-size="1.0">{r}</text>')
    sv.append(f'<circle cx="{ufl[0]:.1f}" cy="{ufl[1]:.1f}" r="{ANT_R}" fill="none" stroke="#2060c0" stroke-width="0.1" stroke-dasharray="0.6 0.4"/><circle cx="{ufl[0]:.1f}" cy="{ufl[1]:.1f}" r="0.8" fill="#2060c0"/>'
              f'<text x="{ufl[0]-6:.1f}" y="{ufl[1]-1.2:.1f}" font-size="1.2" fill="#2060c0">U.FL</text>')
    sv.append(f'<rect x="{u.x-8.89:.2f}" y="{u.y-10.5675:.2f}" width="17.78" height="21.135" fill="none" stroke="#1f5fa8" stroke-width="0.15"/>')
    sv.append(f'<circle cx="{plug[0]:.1f}" cy="{plug[1]:.1f}" r="0.9" fill="#c00"/><text x="{plug[0]-8:.1f}" y="{plug[1]-1.2:.1f}" font-size="1.2" fill="#c00">J1 plug mouth</text>')
    sv.append("</g></svg>")
    p = a.out / f"{a.name}_packaging.svg"
    p.write_text("\n".join(sv))
    import shutil, subprocess
    if shutil.which("rsvg-convert"):
        subprocess.run(["rsvg-convert", "-o", str(p.with_suffix(".png")), str(p)], check=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
