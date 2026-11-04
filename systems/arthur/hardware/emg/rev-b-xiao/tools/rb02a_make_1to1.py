#!/usr/bin/env python3
"""RB-02A: 1:1 mounting reference drawing generated from the Seeed PCB geometry (not from typed-in coordinates).

    python3 rb02a_make_1to1.py --pcb <XIAO ESP32S3_V1.5.kicad_pcb> --out ../../XIAO_RB02A_CAD_1TO1.pdf

The SVG is authored in millimetres (width="210mm" height="297mm", viewBox 0 0 210 297) and converted with rsvg-convert,
so 1 user unit = 1 mm on the page.  A PDF page size of A4 is NOT evidence of scale: verify the printed rulers
(P2 150.0 +/- 0.5 mm, P3 50 x 50 mm +/- 0.3 mm) and print with "Actual size / 100 %".
Layers: blue = module copper from CAD (top castellation pads incl. header-hole caps), grey = RB-00.6 host pads (1.50 x 2.90),
green = BAT+/hole, red = module underside exposed copper (GND0, TP pads, USB shell ovals), magenta = U.FL / USB outline.
"""
import argparse
import math
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rb02a_xiao_cad_extract as X  # noqa: E402

BW, BH = 75.0, 32.0
EAST_X, USB_Y = 72.78, 32.00
OX, OY = 67.5, 40.0           # page position of the board's NW corner (board 75 x 32 centred on A4 width 210)


def f(v):
    return f"{v:.3f}"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pcb", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--sha", default="")
    a = ap.parse_args(argv)
    cad = X.extract(a.pcb)
    bb = cad["outline"]["bbox"]
    x0, y0 = bb[0], bb[1]
    L = cad["outline"]["height"]
    BX = lambda X_: EAST_X - (X_ - x0)
    BY = lambda Y_: USB_Y - (Y_ - y0)
    P = lambda x, y: (OX + x - 0.0 - 0.0 + 0.0, OY + y)
    # shift so that the 75 x 32 board is centred horizontally on A4 (ox = (210-75)/2)
    ox = (210 - BW) / 2
    oy = 45.0
    el = []

    def pg(x, y):
        return ox + x, oy + y

    def rect(x0_, y0_, x1_, y1_, st):
        a_, b_ = pg(x0_, y0_)
        el.append(f'<rect x="{f(a_)}" y="{f(b_)}" width="{f(x1_ - x0_)}" height="{f(y1_ - y0_)}" style="{st}"/>')

    def circ(x, y, r, st):
        a_, b_ = pg(x, y)
        el.append(f'<circle cx="{f(a_)}" cy="{f(b_)}" r="{f(r)}" style="{st}"/>')

    def line(x0_, y0_, x1_, y1_, st):
        a_, b_ = pg(x0_, y0_)
        c_, d_ = pg(x1_, y1_)
        el.append(f'<line x1="{f(a_)}" y1="{f(b_)}" x2="{f(c_)}" y2="{f(d_)}" style="{st}"/>')

    def text(x, y, t, sz=1.7, anchor="start", st="fill:#000"):
        a_, b_ = pg(x, y)
        t = t.replace("&", "&amp;").replace("<", "&lt;")
        el.append(f'<text x="{f(a_)}" y="{f(b_)}" font-family="Helvetica,Arial,sans-serif" font-size="{sz}" text-anchor="{anchor}" style="{st}">{t}</text>')

    def ptext(x, y, t, sz=2.6, st="fill:#000", anchor="start"):
        t = t.replace("&", "&amp;").replace("<", "&lt;")
        el.append(f'<text x="{f(x)}" y="{f(y)}" font-family="Helvetica,Arial,sans-serif" font-size="{sz}" text-anchor="{anchor}" style="{st}">{t}</text>')

    TH = "stroke:#000;stroke-width:0.25;fill:none"
    HAIR = "stroke:#000;stroke-width:0.1;fill:none"
    DASH = "stroke:#777;stroke-width:0.1;fill:none;stroke-dasharray:0.8,0.5"

    # board outline and module outline (R1.905 corners)
    rect(0, 0, BW, BH, TH)
    mx0, mx1 = EAST_X - 17.78, EAST_X
    my0, my1 = USB_Y - L, USB_Y
    r = 1.905
    rect(mx0, my0, mx1, my1, f"stroke:#0a0;stroke-width:0.2;fill:none;stroke-dasharray:1,0.4")
    for cx, cy in ((mx0 + r, my0 + r), (mx1 - r, my0 + r), (mx0 + r, my1 - r), (mx1 - r, my1 - r)):
        circ(cx, cy, 0.15, "fill:#0a0")
    text(mx0 + 0.8, my0 + 1.2, f"module {17.78:.2f} x {L:.3f} (Edge.Cuts, R{r})", 1.1, st="fill:#0a0")

    # host pads (RB-00.6): 1.50 x 2.90
    ys = [13.86, 16.40, 18.94, 21.48, 24.02, 26.56, 29.10]
    for y in ys:
        rect(53.70, y - 0.75, 56.60, y + 0.75, "stroke:#888;stroke-width:0.15;fill:#ddd")
        rect(71.18, y - 0.75, 74.08, y + 0.75, "stroke:#888;stroke-width:0.15;fill:#ddd")

    # module top copper (castellation SMD pads with cap) from CAD
    for p in cad["pads"]:
        if p["ref"] == "U9" and p["type"] == "smd" and "F.Cu" in p["layers"]:
            b = p["bbox"]
            xs = sorted([BX(b[0]), BX(b[2])])
            yy = sorted([BY(b[1]), BY(b[3])])
            rect(xs[0], yy[0], xs[1], yy[1], "stroke:#00a;stroke-width:0.15;fill:none")
            text((xs[0] + xs[1]) / 2, (yy[0] + yy[1]) / 2 + 0.5, p["number"], 1.2, "middle", "fill:#00a")
        if p["ref"] == "U9" and p["type"] == "thru_hole":
            circ(BX(p["x"]), BY(p["y"]), p["drill"] / 2, "stroke:#00a;stroke-width:0.1;fill:#fff")

    # underside exposed copper (module)
    for p in cad["pads"]:
        if p["ref"] in ("BAT0", "GND0") or p["ref"].startswith("TP") or (p["ref"] == "USB0" and p["number"] in ("S1", "S2", "S3", "S4")):
            b = p["bbox"]
            xs = sorted([BX(b[0]), BX(b[2])]); yy = sorted([BY(b[1]), BY(b[3])])
            col = "#c00"
            if p["ref"] == "BAT0":
                col = "#080"
            if p["shape"] == "circle" or p["ref"].startswith("TP"):
                circ((xs[0] + xs[1]) / 2, (yy[0] + yy[1]) / 2, (xs[1] - xs[0]) / 2, f"stroke:{col};stroke-width:0.15;fill:none")
            else:
                rect(xs[0], yy[0], xs[1], yy[1], f"stroke:{col};stroke-width:0.15;fill:none")
            label = {"BAT0": "BAT+ (23)", "GND0": "GND0 (24)"}.get(p["ref"], p["ref"] if p["ref"].startswith("TP") else "GND S" + p["number"][1:])
            text((xs[0] + xs[1]) / 2, yy[0] - 0.4, label, 1.0, "middle", f"fill:{col}")
    for z in cad["zones"]:
        if "B.Mask" in z["layers"]:
            b = z["bbox"]
            xs = sorted([BX(b[0]), BX(b[2])]); yy = sorted([BY(b[1]), BY(b[3])])
            rect(xs[0], yy[0], xs[1], yy[1], "stroke:#c00;stroke-width:0.15;fill:none")
            text((xs[0] + xs[1]) / 2, (yy[0] + yy[1]) / 2 + 0.4, "25 GND", 1.0, "middle", "fill:#c00")

    # BAT+ hole and rings (RB-00.6)
    hx, hy = 68.335, 21.862
    circ(hx, hy, 0.70, "stroke:#080;stroke-width:0.2;fill:none")
    circ(hx, hy, 0.95, "stroke:#080;stroke-width:0.1;fill:none;stroke-dasharray:0.5,0.4")
    circ(hx, hy, 1.50, "stroke:#080;stroke-width:0.1;fill:none;stroke-dasharray:0.3,0.5")
    line(hx - 3, hy, hx + 3, hy, "stroke:#080;stroke-width:0.08")
    line(hx, hy - 3, hx, hy + 3, "stroke:#080;stroke-width:0.08")
    text(hx + 1.0, hy - 2.2, "Ø1.40 hole (68.335, 21.862)", 1.0, st="fill:#080")

    # USB-C and U.FL
    rect(BX(153.001), BY(100.278), BX(144.001) if False else BX(144.001), BY(92.928), "stroke:#c0c;stroke-width:0.2;fill:none")
    ant = next(f_ for f_ in cad["footprints"] if f_["ref"] == "ANT1")
    ax, ay = BX(ant["x"]), BY(ant["y"])
    rect(ax - 1.3, ay - 1.3, ax + 1.3, ay + 1.3, "stroke:#c0c;stroke-width:0.2;fill:none")
    text(ax - 4.0, ay - 2.0, "U.FL", 1.1, st="fill:#c0c")
    text(BX(148.5011) - 1.5, 33.1, "USB-C", 1.1, st="fill:#c0c")

    # axes labels
    for x in (55.0, 72.78):
        line(x, -1.5, x, 0, HAIR)
        text(x, -2.0, f"x={x:g}", 1.0, "middle")
    text(0.0, -4.0, "RB-00.6 mounting orientation 180 deg: USB-C south, D0-D6 east. Origin = board NW corner.", 1.5)

    # scale references (page coordinates, absolute mm)
    ptext(105, 14, "XIAO ESP32-S3 mounting reference from Seeed PCB geometry (RB-02A)", 4.2, "fill:#000;font-weight:bold", "middle")
    ptext(105, 21, "PRINT AT 100 % / 'Actual size' (no fit-to-page). Check P2 and P3 before using the drawing.", 3.0, "fill:#c00", "middle")
    ptext(105, 27, f"Source: {a.pcb.name}  {a.sha[:16]}", 2.4, "fill:#444", "middle")
    # P2 ruler 150 mm
    rx0, ry = 30.0, 258.0
    el.append(f'<line x1="{rx0}" y1="{ry}" x2="{rx0 + 150}" y2="{ry}" style="stroke:#000;stroke-width:0.3"/>')
    for k in range(0, 151, 10):
        h = 4 if k % 50 == 0 else 2
        el.append(f'<line x1="{rx0 + k}" y1="{ry}" x2="{rx0 + k}" y2="{ry - h}" style="stroke:#000;stroke-width:0.25"/>')
        ptext(rx0 + k, ry + 5, str(k), 2.4, "fill:#000", "middle")
    ptext(rx0, ry + 11, "P2: ruler 0-150 mm  (measure: 150.0 +/- 0.5 mm)", 2.8)
    # P3 square 50x50
    sx, sy = 30.0, 195.0
    el.append(f'<rect x="{sx}" y="{sy}" width="50" height="50" style="stroke:#000;stroke-width:0.3;fill:none"/>')
    ptext(sx + 25, sy + 25, "P3: 50 x 50 mm (+/- 0.3 mm)", 2.8, "fill:#000", "middle")
    # P4 board outline note
    ptext(105, 94, "P4: board outline 75.0 x 32.0 mm (+/- 0.3 mm)", 2.8, "fill:#000", "middle")
    # legend
    lg = 100.0
    for i, (col, t) in enumerate((("#ddd", "grey: RB-00.6 host pads 1.50 x 2.90 (toe 1.30 / inner 1.60)"),
                                  ("#00a", "blue: module top copper + Ø0.95 header holes (CAD)"),
                                  ("#080", "green: module outline, BAT+ pad, Ø1.40 post hole"),
                                  ("#c00", "red: module underside exposed copper (GND0, pads 15-22, 25, USB shell S1-S4)"),
                                  ("#c0c", "magenta: USB-C receptacle (9.0 mm, overhang 1.51) / U.FL 2.6 x 2.6"))):
        ptext(105, 110 + i * 5.5, t, 2.6, f"fill:{'#000' if col == '#ddd' else col}", "middle")
    ptext(105, 150, "Scale is only valid if P2/P3 measure correctly. Dimensions are nominal CAD, not manufacturer-guaranteed tolerances.", 2.4, "fill:#444", "middle")

    svg = (f'<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" '
           f'viewBox="0 0 210 297">\n<rect x="0" y="0" width="210" height="297" fill="#fff"/>\n' + "\n".join(el) + "\n</svg>\n")
    svgp = a.out.with_suffix(".svg")
    svgp.write_text(svg)
    subprocess.run(["rsvg-convert", "-f", "pdf", "-o", str(a.out), str(svgp)], check=True)
    print("wrote", a.out, "and", svgp)
    return 0


if __name__ == "__main__":
    sys.exit(main())
