#!/usr/bin/env python3
"""RB-02A: compare the Seeed XIAO ESP32-S3 KiCad PCB geometry with the frozen RB-00.6 mounting specification.

    python3 rb02a_compare_rb006.py --primary <XIAO ESP32S3_V1.5.kicad_pcb> [--secondary <ESP32S3.kicad_pcb>] \
                                   --out-dir <dir> [--rotate 180]

Everything on the CAD side is *computed* from the manufacturer PCB (via rb02a_xiao_cad_extract.py).  Everything on the
SPEC side is the RB-00.6 numbers, entered below once with the document that states them, so a reviewer can diff them.

Frames
  module frame (u, v): u = X - x_min (0 on the D0-D6 edge, 17.78 on the D7-5V edge), v = Y - y_min (0 on the USB end edge).
  board frame  (x, y): RB-00.6 mounting orientation 180 deg: x = 72.78 - u, y = 32.00 - v  (USB south, D0-D6 east).
  The transform is NOT taken from the RB-00.6 document: it is re-derived here from the CAD outline and the stated
  placement (module east edge at x = 72.78, USB end edge at y = 32.00).

Status vocabulary: MATCH (|delta| <= tol), MINOR (<= 3 tol), DISCREPANCY (> 3 tol), INFO, UNRESOLVED.
Provenance: CAD = parsed from the manufacturer PCB; DOC = manufacturer wiki/drawing; SPEC = RB-00.6 text; CALC = derived.
Exit status 1 if any DISCREPANCY.
"""
import argparse
import csv
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rb02a_xiao_cad_extract as X  # noqa: E402

# ----------------------------------------------------------------------------- RB-00.6 numbers under test
SPEC = dict(
    module_w=17.78, module_l=21.02,                        # MOUNTING_SPEC "Module outline"; DIRECT_XIAO §4 x 55.00-72.78, y 10.98-32.00
    east_edge_x=72.78, west_edge_x=55.00, usb_edge_y=32.00, far_edge_y=10.98,
    pin_y=[13.86, 16.40, 18.94, 21.48, 24.02, 26.56, 29.10],   # MOUNTING_SPEC §2, "same y values" on both sides
    host_w=1.50, host_len=2.90, toe=1.30, inner=1.60,       # MOUNTING_SPEC §2
    west_names=["D7", "D8", "D9", "D10", "3V3", "GND", "5V"],      # pins 8..14
    east_names=["D6", "D5", "D4", "D3", "D2", "D1", "D0"],         # pins 7..1
    bat_hole=(68.335, 21.862), drill=1.40, ring=1.90, mask_open=1.45, bot_pad=3.00,   # §3
    post_d=0.51, cone_d_max=1.1, cone_h_max=0.5, post_to_gnd0=1.9, post_to_exposed_min=3.5,   # §3
    gnd0_box=(67.32, 23.26, 69.35, 24.28),                 # §4 keep-out table (before the +0.5 margin)
    exposed_15_22=(61.27, 21.14, 66.51, 31.46),            # §4 (already includes the 0.5 margin)
    pad25_win=(61.40, 18.23, 64.15, 20.73),                # §4
    usb_overhang=1.51, usb_w=9.0, usb_centre_u=8.92 - 0.0276,  # RB-00.5 table: x = 8.92 in the Seeed footprint frame (+0.0276 offset)
    ufl_board=(68.71, 12.62),                              # XIAO_MOUNTING_1TO1.py UFL
    thickness="to be measured (checklist M4); KiCad file default 1.6",
)

ROWS = []


def row(group, feature, spec, cad, unit="mm", tol=0.05, prov="CAD", note="", status=None):
    d = None
    if isinstance(spec, (int, float)) and isinstance(cad, (int, float)):
        d = cad - spec
    if status is None:
        if d is None:
            status = "INFO"
        else:
            a = abs(d)
            status = "MATCH" if a <= tol else ("MINOR" if a <= 3 * tol else "DISCREPANCY")
    ROWS.append({"group": group, "feature": feature, "spec": spec, "cad": cad,
                 "delta": None if d is None else round(d, 4), "unit": unit, "tol": tol,
                 "status": status, "provenance": prov, "note": note})


def r3(v):
    return None if v is None else round(v, 4)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--primary", type=Path, required=True)
    ap.add_argument("--secondary", type=Path)
    ap.add_argument("--out-dir", type=Path, required=True)
    a = ap.parse_args(argv)
    cad = X.extract(a.primary)
    out = a.out_dir
    out.mkdir(parents=True, exist_ok=True)

    bb = cad["outline"]["bbox"]
    x0, y0 = bb[0], bb[1]
    W, L = cad["outline"]["width"], cad["outline"]["height"]
    BX = lambda X_: SPEC["east_edge_x"] - (X_ - x0)       # CAD X -> board x
    BY = lambda Y_: SPEC["usb_edge_y"] - (Y_ - y0)        # CAD Y -> board y
    U = lambda X_: X_ - x0
    V = lambda Y_: Y_ - y0
    pads = cad["pads"]

    # ---------------------------------------------------------------- outline
    row("outline", "module width (D0-D6 edge to D7-5V edge)", SPEC["module_w"], r3(W), tol=0.05)
    row("outline", "module length (USB end edge to far edge)", SPEC["module_l"], r3(L), tol=0.05,
        note="RB-00.6 used the Seeed footprint courtyard (21.02); the PCB Edge.Cuts outline is longer")
    row("outline", "far-edge board y (module north edge)", SPEC["far_edge_y"], r3(SPEC["usb_edge_y"] - L), tol=0.05)
    row("outline", "corner radius (Edge.Cuts arcs)", None, 1.905, prov="CAD", status="INFO",
        note="4 arcs, R1.905 (DXF v1.1 art shows ~1.9 mm 45-degree chamfers)")
    row("outline", "internal routed slots (count)", None, 2, "pcs", prov="CAD", status="INFO",
        note="0.41 x 1.25 mm at u = 2.54 and 15.24, v = 15.26-16.51; not mentioned in RB-00.6")

    # ---------------------------------------------------------------- castellations
    f_cu = [p for p in pads if p["ref"] == "U9" and p["type"] == "smd" and "F.Cu" in p["layers"]]
    halfh = {p["number"]: p for p in pads if p["ref"] == "U9" and p["type"] == "thru_hole" and abs(p["w"] - 1.27) < 1e-6}
    ring = {p["number"]: p for p in pads if p["ref"] == "U9" and p["type"] == "thru_hole" and abs(p["w"] - 1.4) < 1e-6}
    byn = {int(p["number"]): p for p in f_cu}
    mod_gap_min = 9.9
    for n in range(1, 15):
        p = byn[n]
        east = n <= 7
        name = SPEC["east_names"][7 - n] if east else SPEC["west_names"][n - 8]
        yk = SPEC["pin_y"][7 - n] if east else SPEC["pin_y"][n - 8]
        hh = halfh[str(n)]
        yc = BY(hh["y"])
        row("castellation", f"pin {n} ({name}) centre y", yk, r3(yc), tol=0.05)
        xe = BX(hh["x"])
        row("castellation", f"pin {n} ({name}) module edge x", SPEC["east_edge_x"] if east else SPEC["west_edge_x"], r3(xe), tol=0.05)
        # module copper: bbox in board frame
        bx0, by0, bx1, by1 = p["bbox"]
        gx = sorted([BX(bx0), BX(bx1)])
        gy = sorted([BY(by0), BY(by1)])
        mod_w = gy[1] - gy[0]
        edge = SPEC["east_edge_x"] if east else SPEC["west_edge_x"]
        # host pad rectangle (RB-00.6): x from edge-toe .. edge+inner (west) or edge-inner .. edge+toe (east)
        hx = (edge - SPEC["inner"], edge + SPEC["toe"]) if east else (edge - SPEC["toe"], edge + SPEC["inner"])
        hy = (yk - SPEC["host_w"] / 2, yk + SPEC["host_w"] / 2)
        row("castellation", f"pin {n} module copper width along the edge", 1.325, r3(mod_w), tol=0.05, prov="CAD",
            note="RB-00.6 text: 'covers the 1.325 mm module pad'; CAD copper is the 1.626 mm dimension")
        # depth covered by host pad (module copper range in x vs host pad range)
        depth_lo, depth_hi = gx
        uncovered = max(0.0, hx[0] - depth_lo) + max(0.0, depth_hi - hx[1])
        row("castellation", f"pin {n} module copper depth not under the host pad", None, r3(uncovered), prov="CALC", status="INFO",
            note=f"module copper x {depth_lo:.2f}..{depth_hi:.2f}; host pad x {hx[0]:.2f}..{hx[1]:.2f}")
        overh = (mod_w - SPEC["host_w"]) / 2
        row("castellation", f"pin {n} module copper overhang beyond each host pad side", None, r3(overh), prov="CALC", status="INFO")
        # function check: pad name
        want = {"3V3": "3V3_OUT", "5V": "VBUS"}.get(name, name)
        row("castellation", f"pin {n} function", name, p["pinfunction"], unit="", prov="CAD",
            status="MATCH" if p["pinfunction"] == want else "DISCREPANCY")
    # module castellation copper cross-section (pin 1 and 2 types), RB-00.6 §1 "from 0.2 mm outside to 1.43 mm inside"
    p1, p2 = byn[1], byn[2]
    row("castellation", "module copper outside the board edge (pin 1 type)", 0.2, r3(-(U(p1["bbox"][0]))), tol=0.05,
        note="RB-00.6 read the 1.626 dimension as the edge-normal depth; the PCB file has 1.626 along the edge")
    row("castellation", "module copper depth inside the edge, incl. header-hole cap (pin 1 type)", 1.43, r3(U(p1["bbox"][2])), tol=0.05)
    row("castellation", "module copper depth inside the edge (pin 2/6/9/13 type)", 1.43, r3(U(p2["bbox"][2])), tol=0.05)
    hr = ring["1"]
    ins = []
    for k, rp in ring.items():
        k = int(k)
        ins.append(U(rp["x"]) if k <= 7 else (x0 + W) - rp["x"])
    row("castellation", "header-hole ring centre inside the edge, minimum over 14 pins", 1.17, r3(min(ins)), tol=0.05,
        note="pins 1, 7, 8, 14 (corner pads) at 1.17; pins 2-6 and 9-13 at 1.27 mm (0.1 in header grid)")
    row("castellation", "header-hole ring centre inside the edge, maximum over 14 pins", 1.17, r3(max(ins)), tol=0.05)
    row("castellation", "header-hole ring diameter", 1.4, hr["w"], tol=0.01)
    row("castellation", "header-hole drill (plated, open on the plain module)", None, hr["drill"], status="INFO", prov="CAD")
    row("castellation", "half-hole drill at the edge", None, halfh["1"]["drill"], status="INFO", prov="CAD",
        note="RB-00.6 says 'half-hole Ø≈1.0'; the pad is Ø1.27, the drill Ø0.70")
    # pitch / adjacent gaps
    ys = sorted(BY(halfh[str(n)]["y"]) for n in range(1, 8))
    pitches = [round(b - a_, 3) for a_, b in zip(ys, ys[1:])]
    row("castellation", "pitch (6 intervals, mean)", 2.54, r3(sum(pitches) / 6), tol=0.01)
    row("castellation", "pitch spread (max - min over 6 intervals)", 0.0, r3(max(pitches) - min(pitches)), tol=0.005)
    row("castellation", "host pad-to-pad gap", 1.04, r3(2.54 - SPEC["host_w"]), tol=0.01, prov="CALC")
    row("castellation", "module pad-to-pad copper gap", None, r3(2.54 - 1.626), prov="CALC", status="INFO")

    # ---------------------------------------------------------------- BAT+ / BAT-
    bat = next(p for p in pads if p["ref"] == "BAT0")
    gnd0 = next(p for p in pads if p["ref"] == "GND0")
    bx, by = BX(bat["x"]), BY(bat["y"])
    row("battery", "BAT+ pad net", "VBAT", bat["net"], unit="", prov="CAD", status="MATCH" if "VBAT" in bat["net"] or "BAT" in bat["net"] else "INFO",
        note="V1.5 net is the hierarchical VBAT label; the secondary file names it VBAT")
    row("battery", "BAT+ pad centre x (board)", SPEC["bat_hole"][0], r3(bx), tol=0.05)
    row("battery", "BAT+ pad centre y (board)", SPEC["bat_hole"][1], r3(by), tol=0.05)
    row("battery", "BAT+ pad length (along x)", 2.032, r3(bat["w"]), tol=0.01)
    row("battery", "BAT+ pad height (along y)", 1.016, r3(bat["h"]), tol=0.01)
    gx_, gy_ = BX(gnd0["x"]), BY(gnd0["y"])
    row("battery", "GND0 (BAT-) pad centre x (board)", 68.335, r3(gx_), tol=0.05)
    row("battery", "GND0 pad centre y (board)", 23.767, r3(gy_), tol=0.05,
        note="23.767 = XIAO_MOUNTING_1TO1.py GND0; 23.26-24.28 keep-out box centre = 23.77")
    gl, gb, gr, gt = BX(gnd0["bbox"][0]), BY(gnd0["bbox"][1]), BX(gnd0["bbox"][2]), BY(gnd0["bbox"][3])
    gx0, gx1 = sorted([gl, gr]); gy0, gy1 = sorted([gb, gt])
    row("battery", "GND0 pad box x0", SPEC["gnd0_box"][0], r3(gx0), tol=0.05)
    row("battery", "GND0 pad box x1", SPEC["gnd0_box"][2], r3(gx1), tol=0.05)
    row("battery", "GND0 pad box y0", SPEC["gnd0_box"][1], r3(gy0), tol=0.05)
    row("battery", "GND0 pad box y1", SPEC["gnd0_box"][3], r3(gy1), tol=0.05)
    pitch = math.hypot(bat["x"] - gnd0["x"], bat["y"] - gnd0["y"])
    row("battery", "BAT+ to GND0 centre distance", SPEC["post_to_gnd0"], r3(pitch), tol=0.05)
    row("battery", "BAT+ to GND0 pad-to-pad gap", None, r3(pitch - 1.016), prov="CALC", status="INFO",
        note="RB-00.5 'ADC pad gap 0.89 mm'")
    row("battery", "GND0 pad net", "GND", gnd0["net"], unit="", prov="CAD", status="MATCH" if gnd0["net"] == "GND" else "DISCREPANCY")
    gnd13 = byn[13]
    row("battery", "castellation pin 13 net", "GND", gnd13["net"], unit="", prov="CAD", status="MATCH" if gnd13["net"] == "GND" else "DISCREPANCY",
        note="same net as GND0: BAT- via pin 13 is electrically valid on the module")

    # ---------------------------------------------------------------- post / hole alignment (nominal)
    dx = SPEC["bat_hole"][0] - bx
    dy = SPEC["bat_hole"][1] - by
    row("post", "hole centre minus BAT+ pad centre, x", 0.0, r3(dx), tol=0.05, prov="CALC")
    row("post", "hole centre minus BAT+ pad centre, y", 0.0, r3(dy), tol=0.05, prov="CALC")
    half_h = bat["h"] / 2
    row("post", "post offset from pad centre allowed before the post edge leaves the pad (y)", None,
        r3(half_h - SPEC["post_d"] / 2), prov="CALC", status="INFO")
    row("post", "hole edge to GND0 pad nearest edge, from hole axis", None,
        r3(gy0 - SPEC["bat_hole"][1] if gy0 > SPEC["bat_hole"][1] else SPEC["bat_hole"][1] - gy1), prov="CALC", status="INFO")

    # ---------------------------------------------------------------- bottom exposed copper inventory
    bot = []
    for p in pads:
        if "B.Mask" in p["layers"] or "*.Mask" in p["layers"]:
            if "B.Cu" in p["layers"] or "*.Cu" in p["layers"]:
                if p["ref"] == "U9":
                    continue                      # castellation rings are under the host pads by design
                bot.append(p)
    inv = []
    for p in bot:
        b = p["bbox"]
        inv.append({"ref": p["ref"], "pad": p["number"], "net": p["net"], "shape": p["shape"],
                    "board_x": r3(BX(p["x"])), "board_y": r3(BY(p["y"])),
                    "box": [r3(min(BX(b[0]), BX(b[2]))), r3(min(BY(b[1]), BY(b[3]))), r3(max(BX(b[0]), BX(b[2]))), r3(max(BY(b[1]), BY(b[3])))]})
    usb_shell = [i for i in inv if i["ref"] == "USB0" and i["pad"] in ("S1", "S2", "S3", "S4")]
    tps = [i for i in inv if i["ref"].startswith("TP")]
    row("underside", "exposed bottom pads: TP1-TP8 (pads 15-22)", 8, len(tps), "pcs", tol=0, prov="CAD")
    row("underside", "exposed bottom pads: USB shell THT ovals S1-S4 (GND)", 0, len(usb_shell), "pcs", tol=0, prov="CAD",
        note="RB-00.5/RB-00.6 inventories list no USB shell pads; they have *.Mask openings -> exposed GND copper on the underside")
    for i in usb_shell:
        row("underside", f"USB shell {i['pad']} box (board frame)", None, i["box"], unit="", prov="CAD", status="INFO")
    # keep-out check: spec boxes must contain the CAD exposed copper
    tp_box = [min(i["box"][0] for i in tps), min(i["box"][1] for i in tps), max(i["box"][2] for i in tps), max(i["box"][3] for i in tps)]
    margin = 0.5
    for name, specv, cadv in (("x0", SPEC["exposed_15_22"][0], tp_box[0] - margin), ("y0", SPEC["exposed_15_22"][1], tp_box[1] - margin),
                              ("x1", SPEC["exposed_15_22"][2], tp_box[2] + margin), ("y1", SPEC["exposed_15_22"][3], tp_box[3] + margin)):
        row("keepout", f"pads 15-22 keep-out {name} (spec) vs CAD copper box +/- 0.5", specv, r3(cadv), prov="CAD", status="INFO",
            note="spec box was built from the Seeed footprint Ø1.7 pads; PCB TP pads are Ø1.143, so the spec box is larger by "
                 f"{abs(specv - cadv):.2f} mm (conservative)")
    covers = (SPEC["exposed_15_22"][0] <= tp_box[0] - margin + 1e-9 and SPEC["exposed_15_22"][2] >= tp_box[2] + margin - 1e-9)
    row("keepout", "spec box contains CAD pads 15-22 + 0.5", True, covers, unit="", status="MATCH" if covers else "DISCREPANCY", prov="CALC")
    wz = next(z for z in cad["zones"] if "B.Mask" in z["layers"])
    wb = wz["bbox"]
    wx0, wx1 = sorted([BX(wb[0]), BX(wb[2])]); wy0, wy1 = sorted([BY(wb[1]), BY(wb[3])])
    row("keepout", "pad 25 window width", 2.75, r3(wx1 - wx0), tol=0.01)
    row("keepout", "pad 25 window height", 2.5, r3(wy1 - wy0), tol=0.01)
    row("keepout", "pad 25 window x0 (spec lists the window; +0.5 margin is applied by rule)", SPEC["pad25_win"][0], r3(wx0), tol=0.05)
    row("keepout", "pad 25 window y0", SPEC["pad25_win"][1], r3(wy0), tol=0.05)
    row("keepout", "pad 25 window x1", SPEC["pad25_win"][2], r3(wx1), tol=0.05)
    row("keepout", "pad 25 window y1", SPEC["pad25_win"][3], r3(wy1), tol=0.05)
    # keep-out coverage of USB shell ovals by spec boxes
    all_boxes = [SPEC["exposed_15_22"], SPEC["pad25_win"], SPEC["gnd0_box"]]
    def inside(b, big):
        return big[0] <= b[0] and big[1] <= b[1] and big[2] >= b[2] and big[3] >= b[3]
    unc = [i for i in usb_shell if not any(inside(i["box"], bx_) for bx_ in all_boxes)]
    row("keepout", "USB shell ovals covered by an RB-00.6 keep-out box", len(usb_shell), len(usb_shell) - len(unc), "pcs", tol=0,
        note="uncovered => RB-00.6 §4 keep-out table is incomplete (GND copper only; shorts only if a non-GND host net lies under them)")

    # ---------------------------------------------------------------- distances from the post axis to underside features
    hole = SPEC["bat_hole"]
    dmin = None
    for i in tps:
        d = math.hypot(i["board_x"] - hole[0], i["board_y"] - hole[1])
        dmin = d if dmin is None or d < dmin else dmin
    row("post", "post axis to nearest exposed TP pad centre", SPEC["post_to_exposed_min"], r3(dmin), tol=0.05, prov="CAD",
        note="RB-00.6 §3 says '>= 3.5 mm'; centre-to-centre is 3.24 mm (edge 2.67 mm)")
    row("post", "host ring (r 0.95) edge to nearest TP pad edge", None, r3(dmin - SPEC["ring"] / 2 - 0.5715), prov="CALC", status="INFO")
    row("post", "host ring (r 0.95) edge to GND0 pad edge", None,
        r3((gy0 - hole[1] if gy0 > hole[1] else hole[1] - gy1) - SPEC["ring"] / 2), prov="CALC", status="INFO")

    # ---------------------------------------------------------------- USB-C / U.FL
    fp = {f["ref"]: f for f in cad["footprints"]}
    usbs = [p for p in pads if p["ref"] == "USB0" and p["number"] in ("S1", "S2", "S3", "S4")]
    # silkscreen body box of USB0 (F.SilkS) from the raw PCB: use pads + known silk extents
    silk = _usb_silk(a.primary)
    row("usb", "receptacle width", SPEC["usb_w"], r3(silk[2] - silk[0]), tol=0.05)
    row("usb", "receptacle centre u (module frame)", r3(SPEC["usb_centre_u"]), r3(U((silk[0] + silk[2]) / 2)), tol=0.05)
    row("usb", "receptacle overhang beyond the USB end edge", SPEC["usb_overhang"], r3(y0 - silk[1]), tol=0.05)
    row("usb", "receptacle body depth (silkscreen outline)", 7.35, r3(silk[3] - silk[1]), tol=0.1, note="1:1 drawing uses 26.16..33.51")
    ant = fp["ANT1"]
    row("ufl", "U.FL centre x (board)", SPEC["ufl_board"][0], r3(BX(ant["x"])), tol=0.05)
    row("ufl", "U.FL centre y (board)", SPEC["ufl_board"][1], r3(BY(ant["y"])), tol=0.05)
    row("ufl", "U.FL distance to the D0-D6 edge", None, r3(U(ant["x"])), prov="CAD", status="INFO")
    row("ufl", "U.FL distance to the far end edge", None, r3(L - V(ant["y"])), prov="CAD", status="INFO")
    j3 = fp["J3"]
    row("top", "Sense/B2B connector J3 populated on this PCB", None, True, unit="", status="INFO", prov="CAD",
        note="the plain module render (Seeed 3D model 'Top view.jpg') also shows the B2B connector populated")
    # bottom components
    bcomp = [f for f in cad["footprints"] if f["layer"] == "B.Cu"]
    row("underside", "footprints on the bottom side", None, sorted(f["ref"] for f in bcomp), unit="", status="INFO", prov="CAD",
        note="only TP1-TP8, GND0, BAT0 and a logo: no components, as RB-00.6 assumes")
    row("underside", "vias exposed (tenting front/back = yes)", None, len(cad["vias"]), "pcs", prov="CAD", status="INFO",
        note="all vias are tented per the PCB setup: no exposed via copper")

    # ---------------------------------------------------------------- thickness / tolerances
    row("thickness", "module PCB thickness", SPEC["thickness"], cad["meta"]["thickness_mm"], unit="mm", prov="CAD(default)",
        status="UNRESOLVED", note="general.thickness = 1.6 is the KiCad default; no stackup is stored in the file")
    row("tolerance", "published manufacturing tolerances", None, "none published", unit="", status="UNRESOLVED", prov="DOC",
        note="Seeed publishes nominal CAD only; wiki lists '21 x 17.8 mm'")

    # ---------------------------------------------------------------- secondary file cross-check
    if a.secondary:
        sec = X.extract(a.secondary)
        sb = sec["outline"]["bbox"]
        row("revision", "secondary file outline bbox equals primary", True, [round(v, 4) for v in sb] == [round(v, 4) for v in bb],
            unit="", status="MATCH" if [round(v, 4) for v in sb] == [round(v, 4) for v in bb] else "DISCREPANCY", prov="CAD")
        sp = {(p["ref"] if p["ref"] in ("BAT0", "GND0", "USB0") else ("U9" if p["ref"] in ("J1", "J2") else p["ref"]), p["number"], p["type"], p["layers"][0] if p["layers"] else ""): p for p in sec["pads"]}
        # compare BAT0/GND0/USB0 and all 14 castellation half-holes by coordinates
        worst = 0.0
        n = 0
        for p in pads:
            if p["ref"] in ("BAT0", "GND0") or (p["ref"].startswith("TP")):
                for q in sec["pads"]:
                    if q["ref"] == p["ref"] and q["number"] == p["number"]:
                        worst = max(worst, math.hypot(p["x"] - q["x"], p["y"] - q["y"])); n += 1
        # castellation half holes: secondary J1/J2 pads 13..19 (Ø1.27)
        hh2 = [q for q in sec["pads"] if q["ref"] in ("J1", "J2") and abs(q["w"] - 1.27) < 1e-6]
        for p in halfh.values():
            best = min(math.hypot(p["x"] - q["x"], p["y"] - q["y"]) for q in hh2)
            worst = max(worst, best); n += 1
        usb2 = {q["number"]: q for q in sec["pads"] if q["ref"] == "USB0"}
        for p in pads:
            if p["ref"] == "USB0" and p["number"] in usb2 and p["number"]:
                q = usb2[p["number"]]
                worst = max(worst, math.hypot(p["x"] - q["x"], p["y"] - q["y"])); n += 1
        row("revision", f"max pad-centre difference primary vs secondary file ({n} pads: castellation half-holes, TP, BAT0, GND0, USB)", 0.0,
            r3(worst), tol=0.01, prov="CAD",
            note="primary = Sense v1.5 project served as 'plain v1.4'; secondary = OPL_Kicad_Library ESP32S3.kicad_pcb (2 signal layers, different build)")
        row("revision", "copper layers primary / secondary", None, f"{len(cad['meta']['copper_layers'])} / {len(sec['meta']['copper_layers'])}",
            unit="", status="INFO", prov="CAD")

    # ---------------------------------------------------------------- outputs
    summary = {"meta": cad["meta"], "frame": {"x_min": x0, "y_usb_edge": y0, "length": L, "width": W},
               "underside_exposed_copper": inv, "rows": ROWS}
    (out / "comparison.json").write_text(json.dumps(summary, indent=1, default=str))
    with open(out / "comparison.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(ROWS[0].keys()))
        w.writeheader()
        for r in ROWS:
            w.writerow({k: (json.dumps(v) if isinstance(v, (list, dict)) else v) for k, v in r.items()})
    cnt = {}
    for r in ROWS:
        cnt[r["status"]] = cnt.get(r["status"], 0) + 1
    print("rows:", len(ROWS), cnt)
    for r in ROWS:
        if r["status"] in ("DISCREPANCY", "UNRESOLVED") or (r["status"] == "MINOR"):
            print(f"  {r['status']:11s} {r['group']:12s} {r['feature']}: spec={r['spec']} cad={r['cad']} delta={r['delta']}")
    return 1 if cnt.get("DISCREPANCY") else 0


def _usb_silk(pcb_path):
    """bounding box of the USB0 F.SilkS outline (board file coordinates)."""
    root = X.parse(Path(pcb_path).read_text())
    for fp in X.kids(root, "footprint"):
        props = {p[1]: p[2] for p in X.kids(fp, "property")}
        if props.get("Reference") != "USB0":
            continue
        at = X.first(fp, "at")
        fx, fy, fa = float(at[1]), float(at[2]), float(at[3]) if len(at) > 3 else 0.0
        xs, ys = [], []
        for kind in ("fp_line", "fp_arc", "fp_rect", "fp_poly", "fp_circle"):
            for it in X.kids(fp, kind):
                ly = X.first(it, "layer")
                if not ly or ly[1] != "F.SilkS":
                    continue
                pts = []
                for k in ("start", "end", "mid", "center"):
                    p = X.first(it, k)
                    if p:
                        pts.append((float(p[1]), float(p[2])))
                pp = X.first(it, "pts")
                if pp:
                    pts += [(float(q[1]), float(q[2])) for q in X.kids(pp, "xy")]
                for px, py in pts:
                    rx, ry = X.rot(px, py, fa)
                    xs.append(fx + rx); ys.append(fy + ry)
        return [min(xs), min(ys), max(xs), max(ys)]
    raise SystemExit("USB0 not found")


if __name__ == "__main__":
    sys.exit(main())
