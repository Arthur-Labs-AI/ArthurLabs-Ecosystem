#!/usr/bin/env python3
"""RB-02: author the two project-local footprints from verified geometry.

    python3 rb02_make_footprints.py [--out <ARTHUR.pretty dir>] [--evidence <seeed_pcb_extract.json>]

  ARTHUR:XIAO_ESP32S3_HANDSOLDER   hand-solder interface for the Seeed XIAO ESP32-S3 (plain), 14 castellation pads,
                                   plated BAT+ post pad 23, F.Cu keep-outs for the module underside, mechanical envelopes
  ARTHUR:OSC_SCTF_SX3M_SMD3225-4P  SCTF SX3M 3.2 x 2.5 mm oscillator (manufacturer land 2.20 x 1.75 c-c, pads 1.20 x 0.95)

Module geometry (u, v) comes from the RB-02A extraction of the Seeed PCB (rb02a_xiao_cad_extract.py JSON): castellation
half-hole centres, BAT0/GND0, TP1-TP8, USB shell ovals, pad-25 window.  Host-side numbers (pad 1.50 x 2.90, toe 1.30 /
inner 1.60, ring / drill / mask / bottom pad, keep-out margins) are the frozen RB-00.6 values; each is a named constant
below so an owner decision (e.g. the post hole) is a one-line edit.

Footprint frame: origin = module outline centre, +x right, +y down, USB end toward -y (rotation 0).  The board places U1
at 180 deg with its centre at (63.89, 21.4325) in the RB-00.6 board frame.
"""
import argparse
import json
import math
import uuid
from pathlib import Path

# ---------------- frozen RB-00.6 host-side values (mm)
HOST_W, TOE, INNER = 1.50, 1.30, 1.60
PAD_RR = 0.15 / 1.50            # corner radius ratio (r = 0.15 per MOUNTING_SPEC §2)
MASK_EXP = 0.05                 # mask opening = pad + 0.05 per side
POST_DRILL, POST_RING, POST_MASK_OPEN, POST_BOT_PAD = 1.40, 1.90, 1.45, 3.00
KEEPOUT_MARGIN = 0.5
SPEC_TP_BOX = (61.27, 21.14, 66.51, 31.46)   # RB-00.6 §4, board frame, margin already included
VIA_FIELD = (57.6, 12.0, 70.2, 17.2)         # RB-00.6 §4, board frame
# module (from the RB-02A CAD extraction)
MOD_W, MOD_L = 17.78, 21.135
CX, CY = MOD_W / 2, MOD_L / 2                 # outline centre in (u, v)
BOARD_EAST, BOARD_USB = 72.78, 32.00          # module east edge and USB end edge in the board frame
XC, YC = BOARD_EAST - CX, BOARD_USB - CY      # footprint origin in the board frame (rotation 180)

# ---------------- fixed module data (also verified in rb02a evidence) ----------------
PIN_V = {n: 2.9209 + 2.54 * (n - 1) for n in range(1, 8)}               # pins 1-7  (u = 0 edge)
PIN_V.update({n: 18.1609 - 2.54 * (n - 8) for n in range(8, 15)})        # pins 8-14 (u = 17.78 edge)
BAT = (4.445, 10.160)             # u, v of BAT0 pad centre
GND0 = (4.445, 8.255)
TP = [(7.62, 1.905), (10.16, 1.905), (7.62, 4.445), (10.16, 4.445), (7.62, 6.985), (10.16, 6.985), (7.62, 9.525), (10.16, 9.525)]
SHELL = [(13.208, 1.081), (4.572, 1.081), (13.208, 5.271), (4.572, 5.271)]   # S1..S4 oval centres (u, v), 1.778 x 0.889
P25 = (8.635, 11.29, 11.385, 13.79)  # window u0, v0, u1, v1
UFL = (4.039, 19.406)
USB_W, USB_OVER, USB_DEPTH = 9.0, 1.508, 7.35


def uid():
    return str(uuid.uuid4())


def loc(u, v):
    return (round(u - CX, 4), round(v - CY, 4))


def fmt(x):
    return f"{x:.4f}".rstrip("0").rstrip(".")


class FP:
    def __init__(self, name, descr, tags, attr):
        self.name, self.descr, self.tags, self.attr = name, descr, tags, attr
        self.items = []

    def add(self, s):
        self.items.append(s)

    def line(self, x0, y0, x1, y1, layer, w=0.12, typ="solid"):
        self.add(f'\t(fp_line\n\t\t(start {fmt(x0)} {fmt(y0)})\n\t\t(end {fmt(x1)} {fmt(y1)})\n\t\t(stroke\n\t\t\t(width {w})\n\t\t\t(type {typ})\n\t\t)\n\t\t(layer "{layer}")\n\t)')

    def rect(self, x0, y0, x1, y1, layer, w=0.12, typ="solid"):
        self.add(f'\t(fp_rect\n\t\t(start {fmt(x0)} {fmt(y0)})\n\t\t(end {fmt(x1)} {fmt(y1)})\n\t\t(stroke\n\t\t\t(width {w})\n\t\t\t(type {typ})\n\t\t)\n\t\t(fill no)\n\t\t(layer "{layer}")\n\t)')

    def circle(self, cx, cy, r, layer, w=0.12, fill="no"):
        self.add(f'\t(fp_circle\n\t\t(center {fmt(cx)} {fmt(cy)})\n\t\t(end {fmt(cx + r)} {fmt(cy)})\n\t\t(stroke\n\t\t\t(width {w})\n\t\t\t(type solid)\n\t\t)\n\t\t(fill {fill})\n\t\t(layer "{layer}")\n\t)')

    def arc(self, sx, sy, mx, my, ex, ey, layer, w=0.12):
        self.add(f'\t(fp_arc\n\t\t(start {fmt(sx)} {fmt(sy)})\n\t\t(mid {fmt(mx)} {fmt(my)})\n\t\t(end {fmt(ex)} {fmt(ey)})\n\t\t(stroke\n\t\t\t(width {w})\n\t\t\t(type solid)\n\t\t)\n\t\t(layer "{layer}")\n\t)')

    def text(self, s, x, y, layer, size=0.8, rot=0):
        mir = "\n\t\t\t(justify mirror)" if layer.startswith("B.") else ""
        self.add(f'\t(fp_text user "{s}"\n\t\t(at {fmt(x)} {fmt(y)} {rot})\n\t\t(layer "{layer}")\n\t\t(effects\n\t\t\t(font\n\t\t\t\t(size {size} {size})\n\t\t\t\t(thickness 0.1)\n\t\t\t){mir}\n\t\t)\n\t)')

    def pad(self, num, typ, shape, x, y, w, h, layers, drill=None, mask_margin=None, rr=None, paste_margin=None, extra=""):
        s = f'\t(pad "{num}" {typ} {shape}\n\t\t(at {fmt(x)} {fmt(y)})\n\t\t(size {fmt(w)} {fmt(h)})\n'
        if drill:
            s += f'\t\t(drill {fmt(drill)})\n'
        s += "\t\t(layers " + " ".join(f'"{l}"' for l in layers) + ")\n"
        if rr is not None:
            s += f'\t\t(roundrect_rratio {rr:.4f})\n'
        if mask_margin is not None:
            s += f'\t\t(solder_mask_margin {fmt(mask_margin)})\n'
        if paste_margin is not None:
            s += f'\t\t(solder_paste_margin {fmt(paste_margin)})\n'
        s += extra + f'\t\t(uuid "{uid()}")\n\t)'
        self.add(s)

    def keepout(self, x0, y0, x1, y1, layers, tracks="not_allowed", vias="not_allowed", pour="not_allowed", pads="allowed", name=""):
        lay = " ".join(f'"{l}"' for l in layers)
        self.add(f'\t(zone\n\t\t(net 0)\n\t\t(net_name "")\n\t\t(layers {lay})\n\t\t(uuid "{uid()}")\n\t\t(name "{name}")\n'
                 f'\t\t(hatch edge 0.5)\n\t\t(connect_pads\n\t\t\t(clearance 0)\n\t\t)\n\t\t(min_thickness 0.25)\n\t\t(filled_areas_thickness no)\n'
                 f'\t\t(keepout\n\t\t\t(tracks {tracks})\n\t\t\t(vias {vias})\n\t\t\t(pads {pads})\n\t\t\t(copperpour {pour})\n\t\t\t(footprints allowed)\n\t\t)\n'
                 f'\t\t(placement\n\t\t\t(enabled no)\n\t\t\t(sheetname "")\n\t\t)\n'
                 f'\t\t(fill\n\t\t\t(thermal_gap 0.5)\n\t\t\t(thermal_bridge_width 0.5)\n\t\t)\n'
                 f'\t\t(polygon\n\t\t\t(pts\n\t\t\t\t(xy {fmt(x0)} {fmt(y0)}) (xy {fmt(x1)} {fmt(y0)}) (xy {fmt(x1)} {fmt(y1)}) (xy {fmt(x0)} {fmt(y1)})\n\t\t\t)\n\t\t)\n\t)')

    def render(self, ref_at, val_at, ref_layer="F.SilkS"):
        head = (f'(footprint "{self.name}"\n\t(version 20260206)\n\t(generator "rb02_make_footprints")\n\t(generator_version "1.0")\n'
                f'\t(layer "F.Cu")\n\t(descr "{self.descr}")\n\t(tags "{self.tags}")\n'
                f'\t(property "Reference" "REF**"\n\t\t(at {fmt(ref_at[0])} {fmt(ref_at[1])} 0)\n\t\t(layer "{ref_layer}")\n\t\t(effects\n\t\t\t(font\n\t\t\t\t(size 1 1)\n\t\t\t\t(thickness 0.15)\n\t\t\t)\n\t\t)\n\t)\n'
                f'\t(property "Value" "{self.name}"\n\t\t(at {fmt(val_at[0])} {fmt(val_at[1])} 0)\n\t\t(layer "F.Fab")\n\t\t(effects\n\t\t\t(font\n\t\t\t\t(size 1 1)\n\t\t\t\t(thickness 0.15)\n\t\t\t)\n\t\t)\n\t)\n'
                f'\t(attr {self.attr})\n\t(duplicate_pad_numbers_are_jumpers no)\n')
        return head + "\n".join(self.items) + "\n)\n"


def xiao():
    f = FP("XIAO_ESP32S3_HANDSOLDER",
           "Seeed XIAO ESP32-S3 (plain) hand-solder interface, RB-02: 14 castellation pads 1.50x2.90 (toe 1.30), plated BAT+ post pad 23, "
           "underside keep-outs. Origin = module outline centre, USB end toward -y. Source geometry: Seeed v1.5 PCB (RB-02A).",
           "XIAO ESP32S3 castellated hand solder BAT+ post", "through_hole dnp")
    # --- 14 castellation pads (F.Cu + F.Mask only: no paste, the XIAO is hand-soldered and DNP)
    xe = CX - (INNER - TOE) / 2 - 0.0          # centre of the pad measured from the outline centre
    for n in range(1, 15):
        u_edge = 0.0 if n <= 7 else MOD_W
        sign = 1 if n <= 7 else -1             # direction "inside" the module
        pc_u = u_edge + sign * (INNER - TOE) / 2
        x, y = loc(pc_u, PIN_V[n])
        f.pad(n, "smd", "roundrect", x, y, HOST_W if False else (TOE + INNER), HOST_W, ["F.Cu", "F.Mask"], rr=PAD_RR, mask_margin=MASK_EXP)
    # --- BAT+ post: plated hole + ring on all copper layers, mask opening only slightly larger than the hole,
    #     separate exposed B.Cu pad for the underside joint (same number 23, same net by definition)
    bx, by = loc(*BAT)
    f.pad(23, "thru_hole", "circle", bx, by, POST_RING, POST_RING, ["*.Cu", "F.Mask", "B.Mask"], drill=POST_DRILL,
          mask_margin=(POST_MASK_OPEN - POST_RING) / 2)
    f.pad(23, "smd", "circle", bx, by, POST_BOT_PAD, POST_BOT_PAD, ["B.Cu", "B.Mask"], mask_margin=0)
    # --- documentation graphics: module outline (R1.905), USB receptacle, U.FL, underside features
    r = 1.905
    x0, y0 = -CX, -CY
    x1, y1 = CX, CY
    f.line(x0 + r, y0, x1 - r, y0, "F.Fab", 0.1)
    f.line(x0 + r, y1, x1 - r, y1, "F.Fab", 0.1)
    f.line(x0, y0 + r, x0, y1 - r, "F.Fab", 0.1)
    f.line(x1, y0 + r, x1, y1 - r, "F.Fab", 0.1)
    k = r * (1 - math.sqrt(0.5))
    f.arc(x0, y0 + r, x0 + k, y0 + k, x0 + r, y0, "F.Fab", 0.1)
    f.arc(x1 - r, y0, x1 - k, y0 + k, x1, y0 + r, "F.Fab", 0.1)
    f.arc(x0 + r, y1, x0 + k, y1 - k, x0, y1 - r, "F.Fab", 0.1)
    f.arc(x1, y1 - r, x1 - k, y1 - k, x1 - r, y1, "F.Fab", 0.1)
    ux0, uy0 = loc(CX - USB_W / 2, -USB_OVER)
    ux1, uy1 = loc(CX + USB_W / 2, -USB_OVER + USB_DEPTH)
    f.rect(ux0, uy0, ux1, uy1, "F.Fab", 0.1)
    f.text("USB-C", 0, uy0 + 1.2, "F.Fab", 0.9)
    ax, ay = loc(*UFL)
    f.rect(ax - 1.3, ay - 1.3, ax + 1.3, ay + 1.3, "F.Fab", 0.1)
    f.text("U.FL", ax, ay, "F.Fab", 0.7)
    # underside (module bottom) features on B.Fab
    gx, gy = loc(*GND0)
    f.rect(gx - 1.016, gy - 0.508, gx + 1.016, gy + 0.508, "B.Fab", 0.1)
    f.rect(bx - 1.016, by - 0.508, bx + 1.016, by + 0.508, "B.Fab", 0.1)
    f.text("BAT-", gx, gy, "B.Fab", 0.5)
    for u, v in TP:
        tx, ty = loc(u, v)
        f.circle(tx, ty, 0.5715, "B.Fab", 0.1)
    for u, v in SHELL:
        sx, sy = loc(u, v)
        f.rect(sx - 0.889, sy - 0.4445, sx + 0.889, sy + 0.4445, "B.Fab", 0.1)
    wx0, wy0 = loc(P25[0], P25[1]); wx1, wy1 = loc(P25[2], P25[3])
    f.rect(wx0, wy0, wx1, wy1, "B.Fab", 0.1)
    # assembly marks (silk): USB-end line and outline corners, kept clear of the pads
    arm = 1.5
    for sx_ in (-1, 1):
        for sy_ in (-1, 1):
            cx_, cy_ = sx_ * CX, sy_ * CY
            cx2, cy2 = cx_ - sx_ * 0.25, cy_ - sy_ * 0.25      # 0.25 mm inside the module edge (silk must not cross the board edge)
            f.line(cx2, cy2, cx2 - sx_ * arm, cy2, "F.SilkS", 0.15)
            f.line(cx2, cy2, cx2, cy2 - sy_ * arm, "F.SilkS", 0.15)
    f.text("USB END = BOARD EDGE", 0, -CY + 1.0, "F.SilkS", 0.8)
    # --- courtyard: module + toes (host parts may not be placed here); the USB overhang is part of it
    pad_out = CX + TOE + 0.5
    f.rect(-pad_out, -CY - USB_OVER - 0.1, pad_out, CY + 0.5, "F.CrtYd", 0.05)
    # --- mechanical envelopes (user drawings, not enforced by DRC)
    f.rect(-6.2, uy0 - 10.0, 6.2, uy0, "Dwgs.User", 0.1, "dash")
    f.text("mated USB-C plug overmold ~12.4 wide (length assumed 10)", 0, uy0 - 5.0, "Dwgs.User", 0.6)
    f.rect(ax - 2.0 - 8.0, ay - 2.0, ax - 1.3, ay + 2.0, "Cmts.User", 0.1, "dash")
    f.text("U.FL cable corridor (east): keep clear of parts and mind bend radius", ax - 6, ay - 2.6, "Cmts.User", 0.6)
    # --- F.Cu keep-outs, board-frame boxes -> footprint frame (rotation 180: local = (XC - x, YC - y))
    def L(x, y):
        return (XC - x, YC - y)

    def box(bx0, by0, bx1, by1):
        a, b = L(bx0, by0); c, d = L(bx1, by1)
        return (min(a, c), min(b, d), max(a, c), max(b, d))
    # pads 15-22 (TP1-TP8): RB-00.6 box (conservative, built from the Seeed Ø1.7 pads) ; pad 25 window; GND0
    f.keepout(*box(*SPEC_TP_BOX), ["F.Cu"], name="XIAO pads 15-22 underside")
    wb = [BOARD_EAST - P25[2] - KEEPOUT_MARGIN, BOARD_USB - P25[3] - KEEPOUT_MARGIN, BOARD_EAST - P25[0] + KEEPOUT_MARGIN, BOARD_USB - P25[1] + KEEPOUT_MARGIN]
    f.keepout(*box(*wb), ["F.Cu"], name="XIAO pad 25 GND window")
    g = [BOARD_EAST - (GND0[0] + 1.016) - KEEPOUT_MARGIN, BOARD_USB - (GND0[1] + 0.508) - KEEPOUT_MARGIN,
         BOARD_EAST - (GND0[0] - 1.016) + KEEPOUT_MARGIN, BOARD_USB - (GND0[1] - 0.508) + KEEPOUT_MARGIN]
    f.keepout(*box(*g), ["F.Cu"], name="XIAO GND0 (BAT-) pad")
    # USB shell ovals (GND): no tracks/vias (a GND pour is allowed beneath)
    for i, (u, v) in enumerate(SHELL, 1):
        b = [BOARD_EAST - u - 0.889 - KEEPOUT_MARGIN, BOARD_USB - v - 0.4445 - KEEPOUT_MARGIN,
             BOARD_EAST - u + 0.889 + KEEPOUT_MARGIN, BOARD_USB - v + 0.4445 + KEEPOUT_MARGIN]
        f.keepout(*box(*b), ["F.Cu"], tracks="not_allowed", vias="not_allowed", pour="allowed", name=f"XIAO USB shell oval S{i} (GND)")
    # no vias inside the module outline except the tented via field (RB-00.6 §4)
    mx0, mx1 = BOARD_EAST - MOD_W, BOARD_EAST
    my0, my1 = BOARD_USB - MOD_L, BOARD_USB
    vf = VIA_FIELD
    for name, rect_ in (("below via field", (mx0, vf[3], mx1, my1)), ("above via field", (mx0, my0, mx1, vf[1])),
                        ("west of via field", (mx0, vf[1], vf[0], vf[3])), ("east of via field", (vf[2], vf[1], mx1, vf[3]))):
        f.keepout(*box(*rect_), ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"], tracks="allowed", vias="not_allowed", pour="allowed", name=f"XIAO no vias ({name})")
    return f.render((0, -CY - 2.2), (0, CY + 1.6))


def sctf():
    f = FP("OSC_SCTF_SX3M_SMD3225-4P",
           "SCTF SX3M 8.192 MHz CMOS oscillator, SMD3225-4P 3.2x2.5x0.95; manufacturer land 2.20x1.75 c-c, pads 1.20x0.95 "
           "(SCTF Multi Voltage MHz Crystal Oscillator 3CM, rev 05/12/2026). 1 OE, 2 GND, 3 OUT, 4 VDD",
           "oscillator SMD 3225 SCTF SX3M", "smd")
    pw, ph, cx, cy = 1.20, 0.95, 1.10, 0.875
    for n, (x, y) in {1: (-cx, cy), 2: (cx, cy), 3: (cx, -cy), 4: (-cx, -cy)}.items():
        f.pad(n, "smd", "roundrect", x, y, pw, ph, ["F.Cu", "F.Mask", "F.Paste"], rr=0.25)
    f.rect(-1.6, -1.25, 1.6, 1.25, "F.Fab", 0.1)
    f.line(-1.6, 0.85, -1.2, 1.25, "F.Fab", 0.1)
    f.circle(-2.1, 1.25, 0.15, "F.SilkS", 0.1, "solid")
    f.line(-1.1, -1.5, 1.1, -1.5, "F.SilkS", 0.12)
    f.line(-1.1, 1.5, 1.1, 1.5, "F.SilkS", 0.12)
    f.rect(-1.95, -1.6, 1.95, 1.6, "F.CrtYd", 0.05)
    f.text("${REFERENCE}", 0, 0, "F.Fab", 0.6)
    return f.render((0, -2.3), (0, 2.3))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[1] / "kicad/ARTHUR_EMG_RevB/fp-libs/ARTHUR.pretty")
    a = ap.parse_args(argv)
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "XIAO_ESP32S3_HANDSOLDER.kicad_mod").write_text(xiao())
    (a.out / "OSC_SCTF_SX3M_SMD3225-4P.kicad_mod").write_text(sctf())
    print("wrote", a.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
