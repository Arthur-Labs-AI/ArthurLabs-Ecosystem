#!/usr/bin/env python3
"""RB-02G: top-view image of a variant PCB (outline, courtyards, pads, body fab outlines coloured by functional block,
2.5 mm body keep-in line, module).  Read-only.

    python3 rb02g_render.py --pcb variant.kicad_pcb --title "V1 ..." --out image_stem [--refs]
"""
import argparse
import html
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_check_placement import load  # noqa: E402
from rb02_sexpr import kids  # noqa: E402
from rb02e_economic_audit import fab_bbox  # noqa: E402
import rb02g_layouts as L  # noqa: E402

COL = {"A12": "#7fb3ff", "A34": "#4f8fe8", "REF": "#c3a1ff", "AIN": "#ffd27f", "ADC": "#ffb347", "PWR": "#9be39b", "BATT": "#ff8f8f", "XIAO": "#cfe3f7"}
LABEL = {"A12": "Ch1+Ch2", "A34": "Ch3+Ch4", "REF": "Ref/RLD", "AIN": "ADC input net", "ADC": "ADC/clock/SPI", "PWR": "Power/inhibit", "BATT": "Battery", "XIAO": "XIAO"}
S = 13.0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pcb", type=Path, required=True)
    ap.add_argument("--title", default="")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--refs", action="store_true", help="print reference designators on every part")
    a = ap.parse_args(argv)
    fps, E, z, root = load(a.pcb)
    nodes = {}
    for f in kids(root, "footprint"):
        nodes[{str(p[1]): str(p[2]) for p in kids(f, "property")}["Reference"]] = f
    blk = {}
    for k in ("A12", "A34", "REF", "AIN", "ADC", "PWR", "BATT", "XIAO"):
        for r in L.BLOCKS[k]:
            blk[r] = k
    W, H = E[2] - E[0], E[3] - E[1]
    m = 3.0
    x0, y0, x1, y1 = E[0] - m, E[1] - m, E[2] + m, E[3] + m + 2.0
    pw, ph = (x1 - x0) * S, (y1 - y0) * S
    top, leg = 40, 150
    sv = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{max(pw, 640):.0f}" height="{ph+top+leg:.0f}" font-family="DejaVu Sans, sans-serif">',
          '<rect width="100%" height="100%" fill="#fff"/>',
          f'<text x="12" y="26" font-size="17" font-weight="bold">{html.escape(a.title)}</text>',
          f'<g transform="translate(0,{top}) scale({S}) translate({-x0},{-y0})">',
          f'<rect x="{E[0]}" y="{E[1]}" width="{W}" height="{H}" rx="1" fill="#f4f1e6" stroke="#222" stroke-width="0.14"/>',
          f'<rect x="{E[0]+2.5}" y="{E[1]+2.5}" width="{W-5}" height="{H-5}" fill="none" stroke="#c00000" stroke-width="0.07" stroke-dasharray="0.6 0.4"/>']
    for ref, o in fps.items():
        if o.layer != "F.Cu":
            continue
        fb = fab_bbox(nodes[ref], o.x, o.y, o.rot, o.layer)
        if ref == "U1":
            fb = (o.x - 8.89, o.y - 10.5675, o.x + 8.89, o.y + 10.5675)
        if o.crt:
            c = o.crt
            sv.append(f'<rect x="{c[0]:.2f}" y="{c[1]:.2f}" width="{c[2]-c[0]:.2f}" height="{c[3]-c[1]:.2f}" fill="none" stroke="#999" stroke-width="0.05"/>')
        for p in o.pads:
            if "F.Cu" in p["layers"]:
                sv.append(f'<rect x="{p["x"]-p["w"]/2:.2f}" y="{p["y"]-p["h"]/2:.2f}" width="{p["w"]:.2f}" height="{p["h"]:.2f}" fill="#d9a441" opacity="0.9"/>')
        if fb:
            col = COL.get(blk.get(ref), "#ccc")
            sv.append(f'<rect x="{fb[0]:.2f}" y="{fb[1]:.2f}" width="{fb[2]-fb[0]:.2f}" height="{fb[3]-fb[1]:.2f}" fill="{col}" fill-opacity="0.7" stroke="#333" stroke-width="0.07"/>')
            if a.refs and ref != "U1":
                sv.append(f'<text x="{(fb[0]+fb[2])/2:.2f}" y="{(fb[1]+fb[3])/2+0.3:.2f}" font-size="0.85" text-anchor="middle">{ref}</text>')
    for ref, o in fps.items():
        if o.layer == "B.Cu":
            sv.append(f'<circle cx="{o.x:.2f}" cy="{o.y:.2f}" r="0.75" fill="none" stroke="#555" stroke-width="0.1" stroke-dasharray="0.3 0.3"/>')
    # block labels
    for k in ("A12", "A34", "REF", "AIN", "ADC", "PWR", "BATT", "XIAO"):
        rs = [r for r in L.BLOCKS[k] if r in fps and fps[r].crt]
        if not rs:
            continue
        cx = sum((fps[r].crt[0] + fps[r].crt[2]) / 2 for r in rs) / len(rs)
        cy = sum((fps[r].crt[1] + fps[r].crt[3]) / 2 for r in rs) / len(rs)
        if k == "XIAO":
            sv.append(f'<text x="{cx:.1f}" y="{cy:.1f}" font-size="1.5" font-weight="bold" text-anchor="middle" fill="#1f5fa8">XIAO ESP32-S3</text>'
                      f'<text x="{cx:.1f}" y="{cy+1.9:.1f}" font-size="1.1" text-anchor="middle" fill="#1f5fa8">USB-C at edge</text>')
    sv.append("</g>")
    # dimension text
    sv.append(f'<text x="{(E[0]-x0)*S:.0f}" y="{top+(E[3]-y0)*S+34:.0f}" font-size="14" font-weight="bold">{W:.1f} x {H:.1f} mm  (area {W*H:.0f} mm2)</text>')
    ly = top + ph + 24 - 8
    for i, k in enumerate(("A12", "A34", "REF", "AIN", "ADC", "PWR", "BATT", "XIAO")):
        cx = 12 + (i % 4) * 150
        cy = ly + (i // 4) * 20
        sv.append(f'<rect x="{cx}" y="{cy-11}" width="14" height="12" fill="{COL[k]}" stroke="#333"/><text x="{cx+20}" y="{cy}" font-size="12">{LABEL[k]}</text>')
    sv.append(f'<line x1="12" y1="{ly+46}" x2="30" y2="{ly+46}" stroke="#c00000" stroke-dasharray="4 3" stroke-width="2"/>'
              f'<text x="38" y="{ly+50}" font-size="12">2.5 mm body keep-in line; grey = courtyard, gold = pads, dashed circle = bottom test pad</text>')
    sv.append("</svg>")
    out = a.out.with_suffix(".svg")
    out.write_text("\n".join(sv))
    if shutil.which("rsvg-convert"):
        subprocess.run(["rsvg-convert", "-o", str(a.out.with_suffix(".png")), str(out)], check=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
