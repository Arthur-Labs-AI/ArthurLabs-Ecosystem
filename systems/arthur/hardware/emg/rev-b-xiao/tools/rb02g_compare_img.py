#!/usr/bin/env python3
"""RB-02G: to-scale outline comparison image of the current board and the compact variants (from evidence summary.json)."""
import json, shutil, subprocess, sys
from pathlib import Path
rows = json.loads(Path(sys.argv[1]).read_text())
out = Path(sys.argv[2])
pick = [r for r in rows if r["name"] in ("RB02_current", "V1", "V2", "V1R")]
S = 6.0
x = 20
sv = []
H = max(r["H"] for r in pick) * S + 120
for r in pick:
    w, h = r["W"] * S, r["H"] * S
    col = {"RB02_current": "#c7c7c7", "V1": "#8fd19e", "V2": "#9ec5ff", "V1R": "#ffe08a"}[r["name"]]
    sv.append(f'<rect x="{x}" y="50" width="{w:.1f}" height="{h:.1f}" rx="6" fill="{col}" stroke="#222" stroke-width="2"/>')
    # module marker at the bottom (USB end on the south edge)
    sv.append(f'<rect x="{x + w - 22*S*0.98 - 2:.1f}" y="{50 + h - 21.1*S:.1f}" width="{17.8*S:.1f}" height="{21.1*S:.1f}" fill="#cfe3f7" stroke="#1f5fa8" opacity="0.9"/>' if r["name"] != "RB02_current"
              else f'<rect x="{x + w - 22.7*S:.1f}" y="{50 + h - 21.1*S:.1f}" width="{17.8*S:.1f}" height="{21.1*S:.1f}" fill="#cfe3f7" stroke="#1f5fa8" opacity="0.9"/>')
    sv.append(f'<text x="{x+6}" y="{50 + h + 22}" font-size="14" font-weight="bold">{r["name"]}: {r["W"]:.1f} x {r["H"]:.1f} mm</text>')
    sv.append(f'<text x="{x+6}" y="{50 + h + 40}" font-size="12">area {r["area"]} mm2, aspect {r["aspect"]}</text>')
    sv.append(f'<text x="{x+6}" y="{50 + h + 56}" font-size="12">body &lt; 2.5 mm to edge: {r["body_lt_2p5"]}</text>')
    x += w + 30
W = x + 10
svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="{W:.0f}" height="{H:.0f}" font-family="DejaVu Sans, sans-serif"><rect width="100%" height="100%" fill="#fff"/>' \
      f'<text x="20" y="28" font-size="17" font-weight="bold">Rev B outline options, same scale (blue = XIAO module, USB-C end on the south edge)</text>' + "".join(sv) + "</svg>"
out.with_suffix(".svg").write_text(svg)
if shutil.which("rsvg-convert"):
    subprocess.run(["rsvg-convert", "-o", str(out.with_suffix(".png")), str(out.with_suffix(".svg"))], check=True)
