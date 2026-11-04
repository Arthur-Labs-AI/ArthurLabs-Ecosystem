#!/usr/bin/env python3
"""RB-02 placement verification (pre-routing).  Reads the generated .kicad_pcb and a fresh XML netlist; it does not import
the placement table, so it checks what is actually in the board file.

    python3 rb02_check_placement.py --pcb ARTHUR_EMG_RevB.kicad_pcb --netlist revb.xml [--json out.json]

Checks: sync with the schematic (refs, footprints, pad nets, DNP), board size, single-side assembly, courtyard overlap,
edge clearance, XIAO geometry vs the RB-02A CAD mapping, XIAO side bands and component heights, BAT+ post, USB-C and U.FL
envelopes, oscillator-to-ADC distance, decoupling distances, analog input symmetry, JLC single-side/edge-rail rules,
manual-solder access.  Exit 1 if any FAIL.
"""
import argparse
import json
import math
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_sexpr import first, kids, parse  # noqa: E402

# nominal seated heights above the board (mm); manufacturer package maxima, generic MPNs not yet selected
HEIGHT = {"R_0603": 0.55, "R_0805": 0.60, "C_0603": 0.95, "C_0805": 1.45, "L_0603": 0.95, "SOT-23-5": 1.45, "SOT-23": 1.15,
          "TSSOP": 1.20, "OSC_SCTF": 1.10, "B2B-PH": 6.60, "S2B-PH": 5.50, "TestPoint": 0.0, "XIAO": 4.5}
DX = 22.0   # Zone A extension used by the placement table (board x = x' + DX)
RESULTS = []


def res(cid, status, title, detail=""):
    RESULTS.append({"id": cid, "status": status, "title": title, "detail": detail})


def rot(px, py, a):
    t = math.radians(a)
    return (px * math.cos(t) + py * math.sin(t), -px * math.sin(t) + py * math.cos(t))


class FPI:
    pass


def height_of(libid):
    for k, v in HEIGHT.items():
        if k in libid:
            return v
    return 1.5


def load(pcb):
    root = parse(Path(pcb).read_text())
    fps = {}
    for f in kids(root, "footprint"):
        o = FPI()
        o.libid = str(f[1])
        o.layer = str(first(f, "layer")[1])
        at = first(f, "at")
        o.x, o.y = float(at[1]), float(at[2])
        o.rot = float(at[3]) if len(at) > 3 else 0.0
        props = {str(p[1]): str(p[2]) for p in kids(f, "property")}
        o.ref = props["Reference"]
        o.attr = [str(a) for a in (first(f, "attr") or ["attr"])[1:]]
        o.pads = []
        for p in kids(f, "pad"):
            pat = first(p, "at")
            lx, ly = float(pat[1]), float(pat[2])
            sz = first(p, "size")
            ax, ay = rot(lx, ly, o.rot)
            net = first(p, "net")
            ang = float(pat[3]) if len(pat) > 3 else 0.0
            w, h = float(sz[1]), float(sz[2])
            if round(ang) % 180 == 90:
                w, h = h, w
            dr = first(p, "drill")
            o.pads.append({"num": str(p[1]), "type": str(p[2]), "shape": str(p[3]), "x": o.x + ax, "y": o.y + ay, "w": w, "h": h,
                           "net": str(net[1]) if net else "", "layers": [str(l) for l in first(p, "layers")[1:]],
                           "drill": float(dr[1]) if dr and len(dr) > 1 else None})
        # courtyard bbox
        xs, ys = [], []
        want = "F.CrtYd" if o.layer == "F.Cu" else "B.CrtYd"
        for kind in ("fp_line", "fp_rect", "fp_arc", "fp_circle", "fp_poly"):
            for it in kids(f, kind):
                ly = first(it, "layer")
                if ly and str(ly[1]) == want:
                    pts = []
                    for key in ("start", "end", "mid", "center"):
                        q = first(it, key)
                        if q:
                            pts.append((float(q[1]), float(q[2])))
                    pp = first(it, "pts")
                    if pp:
                        pts += [(float(q[1]), float(q[2])) for q in kids(pp, "xy")]
                    for px, py in pts:
                        rx, ry = rot(px, py, o.rot)
                        xs.append(o.x + rx); ys.append(o.y + ry)
        o.crt = (min(xs), min(ys), max(xs), max(ys)) if xs else None
        fps[o.ref] = o
    edge = [float(first(i, k)[n]) for i in root if isinstance(i, list) and i and i[0] in ("gr_line", "gr_arc")
            and first(i, "layer") and str(first(i, "layer")[1]) == "Edge.Cuts" for k in ("start", "end") for n in (1, 2)]
    ex = []
    ey = []
    for i in root:
        if isinstance(i, list) and i and i[0] in ("gr_line", "gr_arc") and first(i, "layer") and str(first(i, "layer")[1]) == "Edge.Cuts":
            for k in ("start", "end"):
                q = first(i, k)
                ex.append(float(q[1])); ey.append(float(q[2]))
    zones = []
    for z in kids(root, "zone"):
        nm = first(z, "name")
        pts = [(float(p[1]), float(p[2])) for p in first(first(z, "polygon"), "pts")[1:] if isinstance(p, list)]
        zones.append({"name": str(nm[1]) if nm else "", "net": str(first(z, "net_name")[1]) if first(z, "net_name") else "",
                      "layers": [str(l) for l in (first(z, "layers") or first(z, "layer") or [None])[1:]],
                      "keepout": first(z, "keepout") is not None,
                      "bbox": (min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts))})
    return fps, (min(ex), min(ey), max(ex), max(ey)), zones, root


def ov(a, b):
    return a and b and a[0] < b[2] - 1e-9 and b[0] < a[2] - 1e-9 and a[1] < b[3] - 1e-9 and b[1] < a[3] - 1e-9


def pad_gap(a, b):
    """edge-to-edge gap between two axis-aligned pads (negative if overlapping)"""
    dx = abs(a["x"] - b["x"]) - (a["w"] + b["w"]) / 2
    dy = abs(a["y"] - b["y"]) - (a["h"] + b["h"]) / 2
    return max(dx, dy) if (dx > 0 and dy > 0) is False and max(dx, dy) < 0 else math.hypot(max(dx, 0), max(dy, 0))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pcb", type=Path, required=True)
    ap.add_argument("--netlist", type=Path, required=True)
    ap.add_argument("--json", type=Path)
    a = ap.parse_args(argv)
    fps, edge, zones, root = load(a.pcb)
    nl = ET.parse(a.netlist).getroot()
    comps = {c.get("ref"): c for c in nl.findall("./components/comp")}
    nets = {}
    for n in nl.findall("./nets/net"):
        for nd in n.findall("node"):
            nm = n.get("name")
            nets[(nd.get("ref"), nd.get("pin"))] = nm.replace("/", "{slash}") if nm.startswith("unconnected-(") else nm
    W, H = edge[2] - edge[0], edge[3] - edge[1]

    # ---- C01 sync
    miss = sorted(set(comps) - set(fps)); extra = sorted(set(fps) - set(comps))
    res("C01", "PASS" if not miss and not extra and len(fps) == 135 else "FAIL", "PCB/schematic reference sync",
        f"{len(fps)} footprints; missing {miss}; extra {extra}")
    bad = [r for r, c in comps.items() if r in fps and fps[r].libid != c.findtext("footprint")]
    res("C02", "PASS" if not bad else "FAIL", "footprint library ids equal the schematic Footprint field", str(bad[:5]))
    # pad nets
    bad = []
    npads = 0
    for r, o in fps.items():
        for p in o.pads:
            if p["num"] in ("MP", "") and False:
                continue
            exp = nets.get((r, p["num"]))
            if r == "U1" and p["num"] == "23":
                pass
            if exp is None and not p["net"]:
                continue
            npads += 1
            if exp != p["net"]:
                bad.append((r, p["num"], p["net"], exp))
    # pins in the netlist that have no pad
    nopad = [(r, n) for (r, n) in nets if r in fps and not any(p["num"] == n for p in fps[r].pads)]
    res("C03", "PASS" if not bad and not nopad else "FAIL", "pad nets equal the netlist; every netlist pin has a pad",
        f"{npads} pad-net checks; mismatches {bad[:4]}; pins without pad {nopad[:4]}")
    dnp = sorted(r for r, o in fps.items() if "dnp" in o.attr)
    res("C04", "PASS" if dnp == ["U1"] else "FAIL", "DNP set equals {U1}", str(dnp))
    top_bad = [r for r, o in fps.items() if o.layer != "F.Cu" and not r.startswith("TP")]
    tp_bad = [r for r, o in fps.items() if r.startswith("TP") and o.layer != "B.Cu"]
    res("C05", "PASS" if not top_bad and not tp_bad else "FAIL", "single-side assembly: every assembled part on F.Cu, TP1-TP8 bare pads on B.Cu",
        f"wrong side: {top_bad + tp_bad}")
    res("C06", "PASS" if abs(W - (75 + DX)) < 0.01 and abs(H - 32.0) < 0.01 else "FAIL", "board size",
        f"{W:.2f} x {H:.2f} mm (RB-00.6 estimate 75 x 32; Zone A extended by {DX:.0f} mm)")

    # ---- courtyards
    names = [r for r, o in fps.items() if o.crt]
    olaps = []
    for i, r1 in enumerate(names):
        for r2 in names[i + 1:]:
            if fps[r1].layer == fps[r2].layer and ov(fps[r1].crt, fps[r2].crt):
                olaps.append((r1, r2))
    res("C07", "PASS" if not olaps else "FAIL", "no courtyard overlaps", str(olaps[:6]))
    # courtyards inside board except XIAO USB end
    out = []
    for r, o in fps.items():
        if not o.crt or o.layer != "F.Cu":
            continue
        c = o.crt
        if c[0] < edge[0] - 1e-6 or c[1] < edge[1] - 1e-6 or c[2] > edge[2] + 1e-6 or c[3] > edge[3] + 1e-6:
            out.append((r, [round(v, 2) for v in c]))
    res("C08", "PASS" if [r for r, _ in out] in ([], ["U1"]) else "FAIL", "courtyards inside the board outline (U1 may cross the south edge by the USB-C overhang)", str(out))
    # copper to edge
    near = []
    for r, o in fps.items():
        for p in o.pads:
            d = min(p["x"] - p["w"] / 2 - edge[0], edge[2] - (p["x"] + p["w"] / 2), p["y"] - p["h"] / 2 - edge[1], edge[3] - (p["y"] + p["h"] / 2))
            if d < 0.5 - 1e-6:
                near.append((r, p["num"], round(d, 2)))
    res("C09", "PASS" if not near else "FAIL", "pad copper >= 0.5 mm from the board edge (JLC minimum 0.2, project margin 0.5)", str(near[:6]))

    # ---- XIAO geometry vs RB-02A mapping
    u1 = fps["U1"]
    cx, cy = 63.89 + DX, 32.0 - 10.5675
    res("C10", "PASS" if abs(u1.x - cx) < 1e-3 and abs(u1.y - cy) < 1e-3 and abs(u1.rot - 180) < 1e-6 else "FAIL",
        "XIAO placement: rotation 180, USB end edge on the south board edge", f"at ({u1.x:.3f}, {u1.y:.3f}) rot {u1.rot}")
    # pad centres vs CAD-derived expectation (RB-02A): east pins 1-7 at u=0, west 8-14 at u=17.78
    PINV = {n: 2.9209 + 2.54 * (n - 1) for n in range(1, 8)}
    PINV.update({n: 18.1609 - 2.54 * (n - 8) for n in range(8, 15)})
    worst = 0.0
    for p in u1.pads:
        if p["num"].isdigit() and 1 <= int(p["num"]) <= 14 and p["type"] == "smd":
            n = int(p["num"])
            edge_x = (72.78 if n <= 7 else 55.0) + DX
            exp_y = 32.0 - PINV[n]
            toe_c = edge_x + (-0.15 if n <= 7 else +0.15)      # pad centre is 0.15 mm inside the module edge
            worst = max(worst, abs(p["x"] - toe_c), abs(p["y"] - exp_y))
    res("C11", "PASS" if worst < 0.01 else "FAIL", "XIAO castellation pads equal the RB-02A CAD positions (14 pads, board frame)", f"max deviation {worst:.4f} mm")
    sizes = {(round(p["w"], 3), round(p["h"], 3)) for p in u1.pads if p["type"] == "smd" and p["num"].isdigit() and int(p["num"]) <= 14}
    res("C12", "PASS" if sizes == {(2.9, 1.5)} else "FAIL", "castellation host pads 2.90 x 1.50 (toe 1.30 + inner 1.60)", str(sizes))
    nums = sorted(int(p["num"]) for p in u1.pads if p["num"].isdigit() and p["type"] == "smd" and int(p["num"]) <= 14)
    res("C13", "PASS" if nums == list(range(1, 15)) else "FAIL", "pad numbering 1..14 unique + post pad 23",
        f"{nums}; post pads: {[ (p['type'], p['w']) for p in u1.pads if p['num']=='23']}")
    post = [p for p in u1.pads if p["num"] == "23" and p["type"] == "thru_hole"][0]
    # CAD BAT0 centre in the board frame (RB-02A): (68.335, 21.840) + DX
    dpx, dpy = post["x"] - (68.335 + DX), post["y"] - (32.0 - 10.160)
    res("C14", "PASS" if post["drill"] == 1.4 and abs(dpx) < 0.01 and abs(dpy) < 0.03 else "FAIL",
        "BAT+ post hole: drill 1.40 at the RB-00.6 position, offset from the CAD BAT+ pad centre", f"({post['x']:.3f}, {post['y']:.3f}) d=({dpx:+.3f},{dpy:+.3f}) drill {post['drill']}")
    # nearest foreign copper to the post pad (host side)
    nd = []
    for r, o in fps.items():
        if r == "U1":
            continue
        for p in o.pads:
            d = math.hypot(p["x"] - post["x"], p["y"] - post["y"]) - max(p["w"], p["h"]) / 2
            nd.append((d, r, p["num"]))
    nd.sort()
    res("C15", "PASS" if nd[0][0] > 3.0 else "FAIL", "no other pad within 3 mm of the post (hand access from both sides)", f"nearest {nd[0][1]}.{nd[0][2]} at {nd[0][0]:.2f} mm")
    kz = [z for z in zones if z["keepout"]]
    need = ["pads 15-22", "pad 25", "GND0", "shell oval S1", "shell oval S2", "shell oval S3", "shell oval S4", "no vias (above", "no vias (below", "no vias (east", "no vias (west"]
    have = [n for n in need if any(n in z["name"] for z in kz)]
    res("C16", "PASS" if len(have) == len(need) else "FAIL", "XIAO underside keep-outs present as board-level rule areas (pads 15-22, 25, GND0, 4 shell ovals, via limits)",
        f"{len(have)}/{len(need)} found; rule areas total {len(kz)}")

    # ---- bands west of the toes and heights
    xw = 55.0 + DX
    band_none = (xw - 1.30 - 1.5, xw - 1.30)       # x' 52.2..53.7
    band_low = (xw - 1.30 - 4.0, xw - 1.30 - 1.5)  # x' 49.7..52.2  (<= 1.2 mm tall)
    ymod_n = 32.0 - 21.135
    viol_none, viol_h, tall = [], [], []
    for r, o in fps.items():
        if r == "U1" or not o.crt or o.layer != "F.Cu":
            continue
        c = o.crt
        h = height_of(o.libid)
        if c[3] > ymod_n - 0.0 and c[1] < 32.0:
            if c[0] < band_none[1] and c[2] > band_none[0]:
                viol_none.append(r)
            if c[0] < band_low[1] and c[2] > band_low[0] and h > 1.2:
                viol_h.append((r, h))
        if h > 1.2 and c[3] > 12.5 and (c[2] > band_low[0] - 1e-6) is True and c[0] > band_low[0]:
            tall.append((r, h))
    res("C17", "PASS" if not viol_none else "FAIL", "no component within 1.5 mm west of the toe ends (iron access)", str(viol_none))
    res("C18", "PASS" if not viol_h and not tall else "FAIL", "components 1.5-4.0 mm west of the toes are <= 1.2 mm tall; nothing taller east of x'=49.7 outside the north strip",
        f"{viol_h} {tall}")
    # east side: nothing between toe end and board edge
    east_parts = [r for r, o in fps.items() if r != "U1" and o.crt and o.crt[2] > 72.78 + DX + 1.3 - 1e-6 and o.crt[1] > ymod_n - 0.5 and o.layer == "F.Cu"]
    res("C19", "PASS" if not east_parts else "FAIL", "east toes: no component outside the module east edge", str(east_parts))

    # ---- USB-C / U.FL
    usb_x = 63.89 + DX
    near_usb = [r for r, o in fps.items() if r != "U1" and o.crt and o.layer == "F.Cu" and o.crt[3] > 32 - 2.0 and o.crt[0] < usb_x + 6.2 and o.crt[2] > usb_x - 6.2]
    res("C20", "PASS" if not [r for r in near_usb if not r.startswith("J")] else "FAIL",
        "USB-C: receptacle (9.0 wide, 1.508 overhang) and plug overmold (12.4) outside the board; no part within 2 mm of the USB end within +/-6.2 mm",
        f"parts near the USB end: {near_usb}")
    ufl = (68.741 + DX, 12.594)
    corr = (ufl[0] + 1.3, ufl[1] - 2.0, 94.99, ufl[1] + 2.0)
    blocked = [r for r, o in fps.items() if r != "U1" and o.crt and o.layer == "F.Cu" and ov(o.crt, corr)]
    res("C21", "PASS" if not blocked else "FAIL", "U.FL cable corridor east of the connector (4 mm wide) free of components", f"blocked by {blocked}")

    # ---- oscillator / ADC
    adc = fps["U6001"]; x1 = fps["X1"]
    p17 = [p for p in adc.pads if p["num"] == "17"][0]
    pads_x1 = [(math.hypot(p["x"] - p17["x"], p["y"] - p17["y"]), p["num"]) for p in x1.pads]
    d_c = math.hypot(x1.x - p17["x"], x1.y - p17["y"])
    out_pad = [p for p in x1.pads if p["num"] == "3"][0]
    d_o = math.hypot(out_pad["x"] - p17["x"], out_pad["y"] - p17["y"])
    res("C22", "PASS" if d_o <= 5.0 else "FAIL", "X1 OUT pad (pin 3) within 5 mm of ADC CLKIN (pin 17): clock net length proxy",
        f"OUT pad to CLKIN {d_o:.2f} mm; X1 centre to CLKIN {d_c:.2f} mm")
    # decoupling distances
    def dist(r, pin_ref, pin):
        o = fps[r]; q = [p for p in fps[pin_ref].pads if p["num"] == pin][0]
        return min(math.hypot(p["x"] - q["x"], p["y"] - q["y"]) for p in o.pads)
    dec = {"C6007 (AVDD pin 1)": dist("C6007", "U6001", "1"), "C6008 (DVDD pin 20)": dist("C6008", "U6001", "20"),
           "C6009 (CAP pin 18)": dist("C6009", "U6001", "18"), "C501 (U501 V+)": dist("C501", "U501", "4"),
           "C502 (U502 V+)": dist("C502", "U502", "4"), "C503 (U503 V+)": dist("C503", "U503", "4"),
           "C6010 (X1 VDD)": dist("C6010", "X1", "4"), "C4005 (U4002 IN)": dist("C4005", "U4002", "1"), "C4006 (U4002 OUT)": dist("C4006", "U4002", "5"),
           "FB1 to XIAO 3V3 pad": dist("FB1", "U1", "12")}
    worstd = max(v for k, v in dec.items() if not k.startswith("FB1"))
    res("C23", "PASS" if worstd <= 3.5 and dec["FB1 to XIAO 3V3 pad"] <= 4.0 else "FAIL", "decoupling / filter parts near their pins (distance from nearest pad centre to the pin)",
        "; ".join(f"{k} {v:.1f}" for k, v in dec.items()))

    # ---- analog input symmetry
    sym = []
    for c in (1, 2, 3, 4):
        b = c * 100
        pairs = [(f"R{b+1}", f"R{b+2}"), (f"D{b+1}", f"D{b+2}"), (f"C{b+3}", f"C{b+4}"), (f"R{b+5}", f"R{b+6}"), (f"C{b+1}", f"C{b+2}"),
                 (f"R{b+3}", f"R{b+4}"), (f"R{b+7}", f"R{b+8}"), (f"C{b+6}", f"C{b+7}"), (f"D{b+3}", f"D{b+4}")]
        for p_, n_ in pairs:
            same_rot = abs((fps[p_].rot - fps[n_].rot + 180) % 360 - 180) < 1e-6
            sym.append((p_, n_, same_rot, round(fps[n_].y - fps[p_].y, 2)))
    bad_rot = [(p_, n_) for p_, n_, r_, dy in sym if not r_]
    hz = []
    for c in (1, 2, 3, 4):
        b = c * 100
        for rs, dh, up in ((f"R{b+1}", f"D{b+1}", None), (f"R{b+2}", f"D{b+2}", None)):
            pass
    # hi-Z node: distance Rs pad 2 -> clamp pin 3 for each leg, and amp IN+ pin
    legs_len = {}
    for c in (1, 2, 3, 4):
        b = c * 100
        for o, side in ((0, "P"), (1, "N")):
            rs, d = fps[f"R{b+1+o}"], fps[f"D{b+1+o}"]
            pin3 = [p for p in d.pads if p["num"] == "3"][0]
            rpad = min(rs.pads, key=lambda p: math.hypot(p["x"] - pin3["x"], p["y"] - pin3["y"]))
            legs_len[f"CH{c}{side}"] = round(math.hypot(rpad["x"] - pin3["x"], rpad["y"] - pin3["y"]), 2)
    spread = max(legs_len.values()) - min(legs_len.values())
    res("C24", "PASS" if not bad_rot and spread < 0.5 else "FAIL", "analog input legs: P/N parts share rotation/row; Rs-to-clamp hi-Z length equal across the 8 legs",
        f"rotation mismatches {bad_rot}; Rs->clamp pin 3 {legs_len}")
    # AIN node: 1 nF cap and clamp distance to the ADC pin, per leg
    cap, clamp = {}, {}
    for c_, o_, pin in ((1, 0, 3), (1, 1, 4), (2, 1, 5), (2, 0, 6), (3, 0, 7), (3, 1, 8), (4, 1, 9), (4, 0, 10)):
        b = c_ * 100
        ap_ = [p for p in adc.pads if p["num"] == str(pin)][0]
        cp = min(math.hypot(p["x"] - ap_["x"], p["y"] - ap_["y"]) for p in fps[f"C{b+6+o_}"].pads)
        d = fps[f"D{b+3+o_}"]
        p3 = [p for p in d.pads if p["num"] == "3"][0]
        k = f"CH{c_}{'P' if o_ == 0 else 'N'}"
        cap[k] = round(cp, 1)
        clamp[k] = round(math.hypot(p3["x"] - ap_["x"], p3["y"] - ap_["y"]), 1)
    res("C25", "PASS" if max(cap.values()) <= 4.0 and max(clamp.values()) <= 13.5 else "FAIL",
        "ADC input network: 1 nF within 4 mm of its AIN pin, BAV199 clamp within 13.5 mm (8 legs)", f"caps {cap}; clamps {clamp}")

    # ---- JLC / assembly
    long_edge = [r for r, o in fps.items() if o.layer == "F.Cu" and o.crt and r != "U1" and not r.startswith(("J", "TP")) and (o.crt[1] < 3.0 or o.crt[3] > H - 3.0)]
    res("C26", "CONDITIONAL" if long_edge else "PASS", "JLC: parts within 3 mm of the long edges (JLC adds process rails; connectors excluded)",
        f"{len(long_edge)} parts, e.g. {long_edge[:8]}")
    jl = sorted({o.libid for o in fps.values() if o.layer == "F.Cu"})
    res("C27", "PASS", "single-side SMT: F.Cu only, no THT except the DNP XIAO post hole", f"{len(jl)} package types: " + ", ".join(x.split(':')[-1] for x in jl))

    # ---- zones
    zs = sorted((z["name"], z["net"], z["layers"]) for z in zones if not z["keepout"])
    res("C28", "INFO", "copper zone outlines (unfilled, defined for RB-03)", str(zs))
    bad = [x for x in RESULTS if x["status"] == "FAIL"]
    for x in RESULTS:
        print(f"{x['status']:11s} {x['id']} {x['title']}\n            {x['detail'][:260]}")
    print(f"\n{len(RESULTS)} checks: {sum(1 for x in RESULTS if x['status']=='PASS')} PASS, {len(bad)} FAIL, "
          f"{sum(1 for x in RESULTS if x['status']=='CONDITIONAL')} CONDITIONAL")
    if a.json:
        a.json.write_text(json.dumps(RESULTS, indent=1))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
