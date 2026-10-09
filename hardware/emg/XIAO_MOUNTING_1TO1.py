#!/usr/bin/env python3
"""Generate XIAO_MOUNTING_1TO1.pdf (RB-00.6) — 1:1 XIAO mounting check drawing.

Page 1 is exactly 1:1 (A4, SVG in mm -> PDF via rsvg-convert).
Page 2 is a 5:1 detail sheet (NOT for paper fit check).
All geometry comes from REVB_XIAO_MOUNTING_SPEC.md; board frame origin is the
board's top-left (north-west) corner, +x east, +y south, units mm.
"""
import subprocess, sys, pathlib

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "XIAO_MOUNTING_1TO1.pdf"

# ---------------- geometry (board frame, mm) ----------------
BW, BH = 75.0, 32.0
ZAB, ZBC, ZCD = 39.0, 48.0, 53.7
X0, X1 = 55.0, 72.78          # module west / east edge (17.78 wide)
Y0, Y1 = 10.98, 32.0           # module north edge / USB end (21.02 long)
PIN_Y = [13.86, 16.40, 18.94, 21.48, 24.02, 26.56, 29.10]
WEST = ["D7", "D8", "D9", "D10", "3V3", "GND", "5V"]       # pins 8..14
EAST = ["D6", "D5", "D4", "D3", "D2", "D1", "D0"]          # pins 7..1
TOE, INNER, PADW = 1.30, 1.60, 1.50
BAT = (68.335, 21.862); GND0 = (68.335, 23.767)
DRILL, RING, BOTPAD = 1.40, 1.90, 3.00
UFL = (68.71, 12.62)
USB = (59.36, 26.16, 68.36, 33.51)
ESP = (62.34, 19.83)
EXPOSED = [(65.16, 30.112, "15"), (62.62, 30.112, "16"), (65.16, 27.572, "17 EN"),
           (62.62, 27.572, "18"), (65.16, 25.032, "19"), (62.62, 25.032, "20"),
           (65.16, 22.492, "21 D-"), (62.62, 22.492, "22 D+")]
P25 = (62.77, 19.48, 2.75, 2.5)
JBAT = (57.5, 0.6, 66.0, 7.0)   # approx S2B-PH-SM4-TB envelope, mating face north
VIAFIELD = (57.6, 12.0, 70.2, 17.2)
CHANNEL = (69.65, 11.5, 70.95, 29.9)

def f(v): return f"{v:.3f}"

class SVG:
    def __init__(s, w=210, h=297): s.w, s.h, s.el = w, h, []
    def add(s, e): s.el.append(e)
    def rect(s, x0, y0, x1, y1, st="stroke:#000;stroke-width:0.15;fill:none"):
        s.add(f'<rect x="{f(x0)}" y="{f(y0)}" width="{f(x1-x0)}" height="{f(y1-y0)}" style="{st}"/>')
    def line(s, x0, y0, x1, y1, st="stroke:#000;stroke-width:0.15"):
        s.add(f'<line x1="{f(x0)}" y1="{f(y0)}" x2="{f(x1)}" y2="{f(y1)}" style="{st}"/>')
    def circ(s, x, y, r, st="stroke:#000;stroke-width:0.15;fill:none"):
        s.add(f'<circle cx="{f(x)}" cy="{f(y)}" r="{f(r)}" style="{st}"/>')
    def text(s, x, y, t, sz=1.6, anchor="start", st="fill:#000", rot=0):
        t = t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        tr = f' transform="rotate({rot} {f(x)} {f(y)})"' if rot else ""
        s.add(f'<text x="{f(x)}" y="{f(y)}" font-family="Helvetica,Arial,sans-serif" font-size="{sz}" text-anchor="{anchor}" style="{st}"{tr}>{t}</text>')
    def svg(s):
        body = "\n".join(s.el)
        return (f'<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" '
                f'width="{s.w}mm" height="{s.h}mm" viewBox="0 0 {s.w} {s.h}">\n'
                f'<rect x="0" y="0" width="{s.w}" height="{s.h}" style="fill:#fff"/>\n{body}\n</svg>\n')

DASH = "stroke-dasharray:0.8,0.5"
DOT = "stroke-dasharray:0.3,0.4"

def board_drawing(s, ox, oy, k=1.0, labels=True):
    """Draw the board at offset (ox,oy), scale k."""
    X = lambda x: ox + k * x
    Y = lambda y: oy + k * y
    sw = 0.15 if k == 1 else 0.2
    # zones
    s.rect(X(0), Y(0), X(BW), Y(BH), f"stroke:#000;stroke-width:{sw*2};fill:none")
    for zx, name in ((ZAB, ""), (ZBC, ""), (ZCD, "")):
        s.line(X(zx), Y(0), X(zx), Y(BH), f"stroke:#777;stroke-width:{sw};{DASH}")
    for x0, x1, t in ((0, ZAB, "ZONE A  analog AFE"), (ZAB, ZBC, "B  ADC"), (ZBC, ZCD, "C"), (ZCD, BW, "")):
        if t: s.text(X((x0 + x1) / 2), Y(3.0), t, 1.6 * k, "middle", "fill:#555")
    # zone A electrode connectors (indicative) and ADC
    for i in range(5):
        cx = 4.5 + i * 7.5
        s.rect(X(cx - 3), Y(25.5), X(cx + 3), Y(31.5), f"stroke:#999;stroke-width:{sw};fill:none;{DOT}")
        s.text(X(cx), Y(29), ("J101", "J201", "J301", "J401", "J5001")[i], 1.1 * k, "middle", "fill:#999")
    s.rect(X(41.5), Y(11.5), X(45.9), Y(18.0), f"stroke:#999;stroke-width:{sw};fill:none;{DOT}")
    s.text(X(43.7), Y(15.2), "U6001", 1.0 * k, "middle", "fill:#999")
    s.rect(X(46.6), Y(13.2), X(49.1), Y(16.4), f"stroke:#999;stroke-width:{sw};fill:none;{DOT}")
    s.text(X(47.85), Y(12.8), "X1", 1.0 * k, "middle", "fill:#999")
    # component height keep-outs west of the XIAO toes
    s.rect(X(ZCD - 1.5), Y(Y0 + 1.5), X(ZCD), Y(Y1 - 1.0), f"stroke:none;fill:#f3b0b0")
    s.rect(X(ZCD - 4.0), Y(Y0 + 1.5), X(ZCD - 1.5), Y(Y1 - 1.0), f"stroke:none;fill:#f8dcdc")
    # battery connector
    s.rect(X(JBAT[0]), Y(JBAT[1]), X(JBAT[2]), Y(JBAT[3]), f"stroke:#0a0;stroke-width:{sw};fill:none")
    s.text(X((JBAT[0] + JBAT[2]) / 2), Y(4.2), "J_BAT (JST-PH 2p SMD)", 1.2 * k, "middle", "fill:#0a0")
    # XIAO module body
    s.rect(X(X0), Y(Y0), X(X1), Y(Y1), f"stroke:#00f;stroke-width:{sw*2};fill:none")
    # USB-C receptacle (on module top) + overhang
    s.rect(X(USB[0]), Y(USB[1]), X(USB[2]), Y(USB[3]), f"stroke:#00f;stroke-width:{sw};fill:none;{DASH}")
    # U.FL and ESP32
    s.rect(X(UFL[0] - 1.3), Y(UFL[1] - 1.3), X(UFL[0] + 1.3), Y(UFL[1] + 1.3), f"stroke:#c0c;stroke-width:{sw};fill:none")
    s.rect(X(ESP[0] - 3.5), Y(ESP[1] - 3.5), X(ESP[0] + 3.5), Y(ESP[1] + 3.5), f"stroke:#00f;stroke-width:{sw};fill:none;{DOT}")
    # exposed module bottom pads (keep F.Cu copper-free)
    s.rect(X(61.27), Y(21.14), X(66.51), Y(31.46), f"stroke:#f80;stroke-width:{sw};fill:none;{DASH}")
    for x, y, t in EXPOSED:
        s.circ(X(x), Y(y), k * 0.85, f"stroke:#f80;stroke-width:{sw};fill:none")
    s.rect(X(P25[0] - P25[2] / 2), Y(P25[1] - P25[3] / 2), X(P25[0] + P25[2] / 2), Y(P25[1] + P25[3] / 2),
           f"stroke:#f80;stroke-width:{sw};fill:none")
    # BAT+ / GND0 module pads, post hole, bottom VBAT pad
    for (x, y) in (BAT, GND0):
        s.rect(X(x - 1.016), Y(y - 0.508), X(x + 1.016), Y(y + 0.508), f"stroke:#f00;stroke-width:{sw};fill:none;{DOT}")
    s.circ(X(BAT[0]), Y(BAT[1]), k * BOTPAD / 2, f"stroke:#f00;stroke-width:{sw};fill:none;{DASH}")
    s.circ(X(BAT[0]), Y(BAT[1]), k * RING / 2, f"stroke:#f00;stroke-width:{sw};fill:none")
    s.circ(X(BAT[0]), Y(BAT[1]), k * DRILL / 2, f"stroke:#f00;stroke-width:{sw};fill:#f00")
    # via field + routing channel
    s.rect(X(VIAFIELD[0]), Y(VIAFIELD[1]), X(VIAFIELD[2]), Y(VIAFIELD[3]), f"stroke:#080;stroke-width:{sw};fill:none;{DOT}")
    s.rect(X(CHANNEL[0]), Y(CHANNEL[1]), X(CHANNEL[2]), Y(CHANNEL[3]), f"stroke:#080;stroke-width:{sw};fill:none;{DOT}")
    # castellations: host pads + module castellation marks
    for i, y in enumerate(PIN_Y):
        s.rect(X(X0 - TOE), Y(y - PADW / 2), X(X0 + INNER), Y(y + PADW / 2), f"stroke:#000;stroke-width:{sw};fill:#bbb")
        s.rect(X(X1 - INNER), Y(y - PADW / 2), X(X1 + TOE), Y(y + PADW / 2), f"stroke:#000;stroke-width:{sw};fill:#bbb")
        s.circ(X(X0), Y(y), k * 0.5, f"stroke:#00f;stroke-width:{sw};fill:none")
        s.circ(X(X1), Y(y), k * 0.5, f"stroke:#00f;stroke-width:{sw};fill:none")
        if labels:
            s.text(X(X0 + INNER + 0.3), Y(y + 0.4 * k), WEST[i], 0.9 * k, "start", "fill:#00f")
            s.text(X(X1 - INNER - 0.3), Y(y + 0.4 * k), EAST[i], 0.9 * k, "end", "fill:#00f")

def page1():
    s = SVG()
    s.text(105, 12, "A.R.T.H.U.R EMG Rev B — XIAO ESP32-S3 direct-mount check drawing (RB-00.6)", 4.0, "middle")
    s.text(105, 18, "PRINT AT 100 % / ACTUAL SIZE — NO 'FIT TO PAGE'.  This page is 1:1.  Verify both rulers before use.", 2.6, "middle", "fill:#c00")
    ox, oy = 67.5, 40.0
    board_drawing(s, ox, oy, 1.0)
    # overall dims
    s.line(ox, oy - 4, ox + BW, oy - 4); s.line(ox, oy - 5, ox, oy - 3); s.line(ox + BW, oy - 5, ox + BW, oy - 3)
    s.text(ox + BW / 2, oy - 5, "75.00 board", 1.8, "middle")
    s.line(ox - 4, oy, ox - 4, oy + BH); s.line(ox - 5, oy, ox - 3, oy); s.line(ox - 5, oy + BH, ox - 3, oy + BH)
    s.text(ox - 5.5, oy + BH / 2, "32.00", 1.8, "middle", rot=-90)
    s.line(ox + X0, oy + BH + 6.5, ox + X1, oy + BH + 6.5)
    s.text(ox + (X0 + X1) / 2, oy + BH + 9.0, "XIAO 17.78", 1.6, "middle", "fill:#00f")
    s.line(ox + X1 + 6.0, oy + Y0, ox + X1 + 6.0, oy + Y1)
    s.text(ox + X1 + 8.5, oy + (Y0 + Y1) / 2, "XIAO 21.02 (USB end flush with south edge)", 1.4, "middle", "fill:#00f", rot=-90)
    s.text(ox + 63.86 - 12, oy + 35.2, "USB-C overhang 1.51 (enclosure wall) →", 1.6, "end", "fill:#00f")
    s.line(ox + UFL[0] + 1.3, oy + UFL[1], ox + BW + 12, oy + UFL[1] - 6, "stroke:#c0c;stroke-width:0.15")
    s.text(ox + BW + 12.5, oy + UFL[1] - 6.3, "U.FL: antenna cable exits EAST", 1.4, "start", "fill:#c0c")
    # legend
    L = [("#bbb", "Rev B hand-solder castellation pad 1.50 × 2.90 (toe 1.30 outside XIAO edge, 1.60 under); 14×, pitch 2.54"),
         ("#00f", "XIAO ESP32-S3 body 17.78 × 21.02, castellations (circles), ESP32 (dotted), USB-C receptacle (dashed)"),
         ("#f00", "BAT+ post: plated hole Ø1.40 drill under XIAO BAT+ pad; top ring Ø1.90 (masked); bottom VBAT pad Ø3.00 (dashed)"),
         ("#f80", "XIAO exposed bottom pads 15–22 + 25: NO F.Cu copper, NO vias, solder mask only (dashed = keep-out)"),
         ("#080", "Tented-via field (dotted) and D0–D3 F.Cu routing channel east of BAT+ (dotted)"),
         ("#0a0", "J_BAT battery connector (approx. envelope, north strip, Zone D)"),
         ("#f3b0b0", "No component within 1.5 mm of toe pads;  pink-light: parts ≤ 1.2 mm tall only (1.5–4.0 mm)"),
         ("#999", "Indicative neighbours: electrode connectors, U6001, X1 (final positions in RB-02)")]
    y = 92
    for col, t in L:
        s.rect(20, y - 2.2, 24, y + 0.2, f"stroke:#000;stroke-width:0.1;fill:{col}")
        s.text(26, y, t, 2.1); y += 5
    # print-scale rulers
    ry = 150
    s.text(20, ry - 6, "SCALE CHECK 1: this ruler must measure exactly 150.0 mm (±0.5) end to end.", 2.4)
    s.line(20, ry, 170, ry, "stroke:#000;stroke-width:0.2")
    for i in range(0, 151):
        h = 4 if i % 10 == 0 else (2.5 if i % 5 == 0 else 1.5)
        s.line(20 + i, ry, 20 + i, ry + h, "stroke:#000;stroke-width:0.12")
        if i % 10 == 0: s.text(20 + i, ry + 7, str(i), 2.0, "middle")
    s.text(20, ry + 16, "SCALE CHECK 2: the square below must be exactly 50.0 × 50.0 mm; the XIAO must match its 17.78 × 21.02 outline above.", 2.4)
    s.rect(20, ry + 22, 70, ry + 72, "stroke:#000;stroke-width:0.25;fill:none")
    s.text(45, ry + 48, "50.0 × 50.0", 3.0, "middle")
    # procedure box
    tx, ty = 80, ry + 24
    for t in ("PAPER FIT CHECK (before ordering PCBs):",
              "1. Measure both scale checks. Reject print if error > 0.5 mm.",
              "2. Lay a real (header-less) XIAO ESP32-S3 on the blue outline,",
              "   USB-C end on the board's south edge line.",
              "3. Each castellation must sit on a grey pad centre (±0.2 mm) and",
              "   ≥ 1.0 mm of grey toe must remain visible on BOTH sides.",
              "4. XIAO BAT+ pad (bottom) must sit over the red hole.",
              "5. U.FL must fall inside the magenta square.",
              "6. Record results in REVB_XIAO_MECHANICAL_CHECKLIST.md.",
              "Board frame origin = north-west corner; +x east, +y south."):
        s.text(tx, ty, t, 2.2); ty += 4.6
    s.text(105, 290, "Generated by XIAO_MOUNTING_1TO1.py — geometry per REVB_XIAO_MOUNTING_SPEC.md (RB-00.6). Page 1 of 2.", 1.8, "middle", "fill:#555")
    return s

def page2():
    s = SVG()
    s.text(105, 12, "Detail sheet — 5 : 1  (NOT FOR PAPER FIT CHECK)", 4.0, "middle", "fill:#c00")
    k = 5.0
    # castellation detail: one west-side pad (pin 11, D10) at 5:1
    ox, oy = 40, 40
    y = 0.0
    s.text(105, 30, "A. Hand-solder castellation pad (west side shown; east side mirrored)", 2.8, "middle")
    s.rect(ox + k * (0), oy - 2, ox + k * 12, oy + k * 8, "stroke:none;fill:#fff")
    s.rect(ox + k * 3.0, oy + k * 0.0, ox + k * 12, oy + k * 7.0, "stroke:#00f;stroke-width:0.4;fill:none")  # XIAO edge at x=3
    s.text(ox + k * 7.5, oy + k * 6.3, "XIAO body", 2.4, "middle", "fill:#00f")
    for py in (1.0, 3.54, 6.08):
        s.rect(ox + k * (3.0 - TOE), oy + k * (py - PADW / 2), ox + k * (3.0 + INNER), oy + k * (py + PADW / 2), "stroke:#000;stroke-width:0.3;fill:#bbb")
        s.rect(ox + k * (3.0 - 0.2), oy + k * (py - 1.325 / 2), ox + k * (3.0 + 1.43), oy + k * (py + 1.325 / 2), "stroke:#00f;stroke-width:0.25;fill:none;stroke-dasharray:1,0.6")
        s.circ(ox + k * 3.0, oy + k * py, k * 0.5, "stroke:#00f;stroke-width:0.3;fill:#fff")
    # dims
    s.line(ox + k * 1.7, oy + k * 7.6, ox + k * 3.0, oy + k * 7.6, "stroke:#000;stroke-width:0.2")
    s.text(ox + k * 2.35, oy + k * 8.3, "toe 1.30", 2.2, "middle")
    s.line(ox + k * 3.0, oy + k * 7.6, ox + k * 4.6, oy + k * 7.6, "stroke:#000;stroke-width:0.2")
    s.text(ox + k * 3.8, oy + k * 8.9, "1.60 under", 2.2, "middle")
    s.text(ox + k * 1.0, oy + k * 1.2, "pad 1.50", 2.2, "end")
    s.text(ox + k * 1.0, oy + k * 2.4, "gap 1.04", 2.2, "end")
    s.text(ox + k * 1.0, oy + k * 3.6, "pitch 2.54", 2.2, "end")
    s.text(ox + k * 1.0, oy + k * 4.8, "mask +0.05/side", 2.2, "end")
    s.text(ox + k * 1.0, oy + k * 6.0, "NO paste", 2.2, "end")
    s.text(ox + k * 12.5, oy + k * 1.0, "grey  = Rev B pad (HASL, no stencil paste)", 2.2)
    s.text(ox + k * 12.5, oy + k * 2.0, "blue  = XIAO castellation half-hole + bottom pad", 2.2)
    s.text(ox + k * 12.5, oy + k * 3.0, "(module pad 1.626 × 1.325, ≈0.2 past edge)", 2.2)
    s.text(ox + k * 12.5, oy + k * 4.0, "Fillet: wets ≥ 1.0 mm of toe and climbs the", 2.2)
    s.text(ox + k * 12.5, oy + k * 5.0, "castellation wall ≥ 50 % of XIAO PCB thickness.", 2.2)
    # BAT post cross-section
    ox, oy = 40, 140
    s.text(105, oy - 12, "B. BAT+ post cross-section (through Rev B PCB, 1.6 mm)", 2.8, "middle")
    s.rect(ox, oy, ox + k * 20, oy + k * 1.6, "stroke:#000;stroke-width:0.3;fill:#e8e0b0")   # PCB
    s.text(ox + k * 20.5, oy + k * 0.9, "Rev B PCB 1.6", 2.2)
    cx = ox + k * 10
    s.rect(cx - k * 0.7, oy, cx + k * 0.7, oy + k * 1.6, "stroke:#000;stroke-width:0.3;fill:#fff")  # hole
    s.rect(cx - k * 0.95, oy - k * 0.04, cx + k * 0.95, oy, "stroke:#c60;stroke-width:0.2;fill:#c60")  # top ring
    s.rect(cx - k * 1.5, oy + k * 1.6, cx + k * 1.5, oy + k * 1.64, "stroke:#c60;stroke-width:0.2;fill:#c60")  # bottom pad
    s.rect(ox + k * 2, oy - k * 1.1, ox + k * 18, oy - k * 0.05, "stroke:#00f;stroke-width:0.3;fill:#dde")  # XIAO pcb
    s.text(ox + k * 2.2, oy - k * 1.35, "XIAO PCB (sits on Rev B solder mask)", 2.2, "start", "fill:#00f")
    s.rect(cx - k * 1.016, oy - k * 0.07, cx + k * 1.016, oy - k * 0.05, "stroke:#f00;stroke-width:0.3;fill:#f00")  # BAT pad
    s.rect(cx - k * 0.255, oy - k * 0.05, cx + k * 0.255, oy + k * 2.6, "stroke:#555;stroke-width:0.3;fill:#999")  # post
    s.add(f'<path d="M {f(cx - k*0.55)} {f(oy)} Q {f(cx)} {f(oy - k*0.1)} {f(cx + k*0.55)} {f(oy)} L {f(cx + k*0.255)} {f(oy + k*0.35)} L {f(cx - k*0.255)} {f(oy + k*0.35)} Z" style="fill:#ccc;stroke:#555;stroke-width:0.2"/>')
    s.add(f'<path d="M {f(cx - k*1.3)} {f(oy + k*1.64)} Q {f(cx)} {f(oy + k*2.2)} {f(cx + k*1.3)} {f(oy + k*1.64)} Z" style="fill:#ccc;stroke:#555;stroke-width:0.2"/>')
    notes = ["Post: AWG 24 solid tinned Cu (Ø0.51), straight, soldered ⟂ to XIAO BAT+ BEFORE mounting.",
             "Solder cone on XIAO pad: centred, Ø ≤ 1.1 mm, height ≤ 0.5 mm (sinks into the Ø1.3 finished hole).",
             "Hole: plated, drill Ø1.40 (finished ≈ Ø1.30); radial clearance ≈ 0.4 mm = locating pin for the XIAO.",
             "Top ring Ø1.90 is covered by solder mask (tented ring, hole open); 0.45 mm from XIAO GND0 pad edge.",
             "Bottom: Ø3.00 VBAT pad on B.Cu, thermal-relief to VBAT; solder from underside, trim post to ≈ 1 mm.",
             "No bend, no insulation needed: no exposed length exists between XIAO and Rev B (gap ≤ 0.1 mm)."]
    y = oy + k * 4.2
    for n in notes:
        s.text(20, y, n, 2.3); y += 5
    s.text(105, 290, "Generated by XIAO_MOUNTING_1TO1.py (RB-00.6). Page 2 of 2 — 5:1 detail, do not measure against a real part.", 1.8, "middle", "fill:#555")
    return s

def main():
    tmp = HERE / ".xiao_1to1_tmp"
    tmp.mkdir(exist_ok=True)
    p1, p2 = tmp / "p1.svg", tmp / "p2.svg"
    p1.write_text(page1().svg()); p2.write_text(page2().svg())
    subprocess.run(["rsvg-convert", "-f", "pdf", "-o", str(OUT), str(p1), str(p2)], check=True)
    for p in (p1, p2): p.unlink()
    tmp.rmdir()
    print(OUT)

if __name__ == "__main__":
    sys.exit(main())
