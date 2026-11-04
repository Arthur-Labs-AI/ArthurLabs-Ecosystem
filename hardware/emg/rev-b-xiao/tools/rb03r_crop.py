#!/usr/bin/env python3
"""RB-03R: crop a region of a board (all copper + mask + silkscreen by default) to PNG, optionally with annotation circles.
    python3 rb03r_crop.py --pcb x.kicad_pcb --box x0 y0 x1 y1 --out out.png [--layers F.Cu,B.Cu,Edge.Cuts] [--scale 60]
                          [--mark x,y[,label] ...]"""
import argparse, re, subprocess, sys, tempfile, shutil
from pathlib import Path
ap = argparse.ArgumentParser()
ap.add_argument("--pcb", required=True); ap.add_argument("--box", nargs=4, type=float, required=True); ap.add_argument("--out", required=True)
ap.add_argument("--layers", default="F.Cu,B.Cu,Edge.Cuts,F.Mask,F.Paste"); ap.add_argument("--scale", type=float, default=60)
ap.add_argument("--mark", nargs="*", default=[])
a = ap.parse_args()
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb03r_safe import safe_pcb  # noqa: E402
a.pcb = str(safe_pcb(a.pcb))
d = Path(tempfile.mkdtemp())
svg = d / "f.svg"
subprocess.run(["kicad-cli", "pcb", "export", "svg", "--layers", a.layers, "--mode-single", "--page-size-mode", "2", "--exclude-drawing-sheet",
                "-o", str(svg), a.pcb], capture_output=True)
s = svg.read_text()
vb = [float(v) for v in re.search(r'viewBox="([^"]+)"', s).group(1).split()]
x0, y0, x1, y1 = a.box
# page = board bounding box (mm); the svg user unit is mm
marks = ""
for m in a.mark:
    p = m.split(",")
    mx, my = float(p[0]), float(p[1])
    marks += f'<circle cx="{vb[0]+mx}" cy="{vb[1]+my}" r="0.55" fill="none" stroke="#00c000" stroke-width="0.08"/>'
    if len(p) > 2:
        marks += f'<text x="{vb[0]+mx+0.6}" y="{vb[1]+my-0.5}" font-size="0.7" fill="#006000">{p[2]}</text>'
s = s.replace("</svg>", marks + "</svg>")
s = re.sub(r'viewBox="[^"]+"', f'viewBox="{vb[0]+x0} {vb[1]+y0} {x1-x0} {y1-y0}"', s, 1)
s = re.sub(r'width="[^"]+"', f'width="{(x1-x0)*a.scale}"', s, 1)
s = re.sub(r'height="[^"]+"', f'height="{(y1-y0)*a.scale}"', s, 1)
(d / "o.svg").write_text(s)
subprocess.run(["rsvg-convert", "-o", a.out, str(d / "o.svg")], check=True)
shutil.rmtree(d)
