#!/usr/bin/env python3
"""RB-02F: annotated top-view image of the placed board showing the 2.5 mm body keep-in line, the 37 parts whose body is
closer than 2.5 mm to the outline, J1, J5001 and the closest SMT parts.  Read-only.

    python3 rb02f_annotate.py --pcb ARTHUR_EMG_RevB.kicad_pcb --netlist revb.xml --out <dir>/rb02f_edge_map
Writes <out>.svg and (if rsvg-convert exists) <out>.png, plus <out>_ne.png and <out>_w.png zoom views.
"""
import argparse
import html
import json
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_check_placement import load  # noqa: E402
from rb02_sexpr import kids  # noqa: E402
from rb02e_economic_audit import fab_bbox, edge_dist  # noqa: E402

S = 14.0   # px per mm


def render(parts, E, view, title, labels, out):
    x0, y0, x1, y1 = view
    W, H = (x1 - x0) * S, (y1 - y0) * S
    pad_top = 46
    leg = 118
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{max(W+40, 760):.0f}" height="{H+pad_top+leg:.0f}" font-family="DejaVu Sans, sans-serif">',
           f'<rect width="100%" height="100%" fill="#ffffff"/>',
           f'<text x="20" y="28" font-size="17" font-weight="bold">{html.escape(title)}</text>',
           f'<clipPath id="c"><rect x="20" y="{pad_top}" width="{W:.1f}" height="{H:.1f}"/></clipPath>',
           f'<g clip-path="url(#c)"><g transform="translate(20,{pad_top}) scale({S}) translate({-x0},{-y0})">']

    def r(b, **kw):
        a = " ".join(f'{k.replace("_", "-")}="{v}"' for k, v in kw.items())
        svg.append(f'<rect x="{b[0]:.3f}" y="{b[1]:.3f}" width="{b[2]-b[0]:.3f}" height="{b[3]-b[1]:.3f}" {a}/>')
    # board
    svg.append(f'<rect x="{E[0]}" y="{E[1]}" width="{E[2]-E[0]}" height="{E[3]-E[1]}" rx="1" fill="#f4f1e6" stroke="#222" stroke-width="0.12"/>')
    # 2.5 mm keep-in
    r((E[0] + 2.5, E[1] + 2.5, E[2] - 2.5, E[3] - 2.5), fill="none", stroke="#c00000", stroke_width=0.08, stroke_dasharray="0.6 0.4")
    for p in parts:
        if p["layer"] != "F.Cu":
            continue
        if p["crt"]:
            r(p["crt"], fill="none", stroke="#9aa0a6", stroke_width=0.04)
        if p["ref"] == "U1":
            r(p["body"], fill="#cfe3f7", fill_opacity=0.6, stroke="#1f5fa8", stroke_width=0.1)
            continue
        col = {"PASS": "#8fd19e", "UNKNOWN": "#ff8a65", "FAIL": "#d50000"}.get(p["status"], "#cccccc")
        for pb in p["pads"]:
            r(pb, fill="#d9a441", stroke="none", opacity=0.9)
        r(p["body"], fill=col, fill_opacity=0.75 if p["status"] != "PASS" else 0.35, stroke="#333" if p["hl"] else "#777", stroke_width=0.1 if p["hl"] else 0.04)
    for (ref, tx, ty, txt) in labels:
        p = next(q for q in parts if q["ref"] == ref)
        cx, cy = (p["body"][0] + p["body"][2]) / 2, (p["body"][1] + p["body"][3]) / 2
        svg.append(f'<line x1="{cx:.2f}" y1="{cy:.2f}" x2="{tx:.2f}" y2="{ty:.2f}" stroke="#000" stroke-width="0.06"/>')
        svg.append(f'<text x="{tx:.2f}" y="{ty:.2f}" font-size="0.95" font-weight="bold" fill="#000" stroke="#fff" stroke-width="0.18" paint-order="stroke">{html.escape(txt)}</text>')
    svg.append("</g></g>")
    ly = H + pad_top + 22
    items = [("#8fd19e", "body ≥ 2.5 mm and copper ≥ 0.3 mm (PASS)"), ("#ff8a65", "body < 2.5 mm, copper ≥ 0.3 mm (UNKNOWN: applicability not stated by JLC)"),
             ("#d50000", "copper < 0.3 mm (FAIL) — none"), ("#cfe3f7", "XIAO module (DNP, hand-soldered)")]
    for i, (c, t) in enumerate(items):
        svg.append(f'<rect x="20" y="{ly+i*20-12}" width="16" height="12" fill="{c}" stroke="#555"/><text x="44" y="{ly+i*20-2}" font-size="13">{html.escape(t)}</text>')
    svg.append(f'<line x1="20" y1="{ly+4*20-6}" x2="36" y2="{ly+4*20-6}" stroke="#c00000" stroke-dasharray="4 3" stroke-width="2"/>'
               f'<text x="44" y="{ly+4*20-2}" font-size="13">2.5 mm body keep-in line (JLC Assembly T&amp;C, DFM item 3); grey = courtyard, gold = pads</text>')
    svg.append("</svg>")
    out.with_suffix(".svg").write_text("\n".join(svg))
    if shutil.which("rsvg-convert"):
        subprocess.run(["rsvg-convert", "-o", str(out.with_suffix(".png")), str(out.with_suffix(".svg"))], check=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pcb", type=Path, required=True)
    ap.add_argument("--edge-json", type=Path, required=True, help="edge_clearance.json from rb02e_economic_audit.py")
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    fps, E, z, root = load(a.pcb)
    nodes = {}
    for f in kids(root, "footprint"):
        nodes[{str(p[1]): str(p[2]) for p in kids(f, "property")}["Reference"]] = f
    st = {r["ref"]: r for r in json.loads(a.edge_json.read_text())}
    parts = []
    for ref, o in fps.items():
        fb = fab_bbox(nodes[ref], o.x, o.y, o.rot, o.layer)
        if ref == "U1":
            fb = (o.x - 8.89, o.y - 10.5675, o.x + 8.89, o.y + 10.5675)
        pads = [(p["x"] - p["w"] / 2, p["y"] - p["h"] / 2, p["x"] + p["w"] / 2, p["y"] + p["h"] / 2) for p in o.pads if "F.Cu" in p["layers"]]
        parts.append({"ref": ref, "layer": o.layer, "crt": o.crt, "body": fb or (o.x - 1, o.y - 1, o.x + 1, o.y + 1), "pads": pads,
                      "status": st[ref]["status"], "hl": st[ref]["status"] == "UNKNOWN"})
    full = (-1, -7, 98, 37)
    lab = [("C101", 1.0, -1.6, "24× 0603 row, body 2.40 mm (north)"), ("R4001", 44.0, -1.6, "R4001 2.39 mm"),
           ("J1", 50.0, -3.6, "J1: body 0.80 mm to the north edge, opening faces the edge"),
           ("R7107", 60.0, -5.6, "R7107 / R7108 / C7103: 1.69-1.70 mm (east edge)"),
           ("R7106", 30.0, 35.0, "R7106: 1.64 mm (south)"), ("J5001", 0.0, 36.2, "J5001: body 1.23 mm (west)"),
           ("R5003", 20.0, 36.2, "R5003: 1.19 mm (west)")]
    render(parts, E, full, "Rev B placement: body-to-edge map, top view (y down), 97 x 32 mm; 37 parts below 2.5 mm", lab, a.out)
    render(parts, E, (58, -5, 98, 17), "Zoom north-east: J1 and the east strip", [("J1", 60.0, -3.4, "J1 body 0.80 mm to north edge; plug leaves through the edge"),
           ("R7108", 74.0, 15.5, "R7107 / R7108 / C7103 1.69-1.70 mm to east edge")], a.out.with_name(a.out.name + "_ne"))
    render(parts, E, (-2, 14, 40, 37), "Zoom south-west: J5001, R5003 and the connector row", [("J5001", 14.0, 20.5, "J5001 body 1.23 mm to west edge"),
           ("R5003", 1.0, 16.0, "R5003 1.19 mm"), ("J101", 22.0, 35.2, "J101 body 3.00 mm; tails 0.50 mm to south edge")], a.out.with_name(a.out.name + "_w"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
