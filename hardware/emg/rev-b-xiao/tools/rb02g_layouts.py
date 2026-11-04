#!/usr/bin/env python3
"""RB-02G: compact-board placement variants built from rigid blocks of the validated RB-02 placement.

A variant is a dict: {"name", "W", "H", "blocks": [(block, theta_deg, x0, y0), ...], "zone_a": [rects], "zone_d_cut": (x0,y0)}
Each block is rotated by theta about its own courtyard-bbox centre (multiples of 90 deg) and then translated so that the min
corner of its rotated bbox sits at (x0, y0) in the new board frame.  Block membership is fixed below.
Nothing here edits the project PCB; rb02g_build.py turns a variant into a scratch .kicad_pcb.
"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rb02_placement as PL  # noqa: E402

DX0 = 22.0   # the RB-02 board frame


def _legs(c):
    b = c * 100
    r = []
    for o in (1, 2):
        r += [f"R{b+o}", f"D{b+o}", f"C{b+2+o}", f"R{b+4+o}", f"C{b+o}", f"R{b+2+o}", f"R{b+6+o}"]
    return r


BLOCKS = {
    "A12": ["J101", "J201", "U501", "C501"] + _legs(1) + _legs(2),
    "A34": ["J301", "J401", "U502", "C502"] + _legs(3) + _legs(4),
    "REF": ["J5001", "U503", "C503", "R5002", "R5003", "R5004", "R5005", "C5001", "C5002", "TP4", "TP5"],
    "AIN": [f"{p}{c*100+n}" for c in (1, 2, 3, 4) for p, n in (("D", 3), ("D", 4), ("C", 6), ("C", 7))] +
           ["C105", "C205", "C305", "C405", "TP6", "TP7", "TP8"],
    "ADC": ["U6001", "C6007", "C6008", "X1", "C6010", "C6009", "R6001", "R6002", "R6003", "R7103", "R7104", "R7101", "R7102",
            "FB1", "C7101", "C7102", "R3009", "R7105", "R7106", "TP3"],
    "PWR": ["U4002", "C4005", "C4006", "R3007", "R3008", "R3004", "R3006", "Q3001", "R4001", "C4007", "TP1", "TP2"],
    "BATT": ["J1", "R7107", "R7108", "C7103"],
    "XIAO": ["U1"],
}
# convenience: the validated Zone B/C/D arrangement as one rigid block
BLOCKS["CORE"] = BLOCKS["AIN"] + BLOCKS["ADC"] + BLOCKS["XIAO"]
BLOCKS["CORE_PWR"] = BLOCKS["CORE"] + BLOCKS["PWR"] + BLOCKS["BATT"]
BLOCKS["ALLA"] = BLOCKS["A12"] + BLOCKS["A34"] + BLOCKS["REF"]
BLOCKS["J1"] = ["J1"]
BLOCKS["TRIO"] = ["R7107", "R7108", "C7103"]
BLOCKS["CORE_NOBATT"] = BLOCKS["CORE"] + BLOCKS["PWR"]


def check_partition():
    seen = {}
    for k in ("A12", "A34", "REF", "AIN", "ADC", "PWR", "BATT", "XIAO"):
        for r in BLOCKS[k]:
            assert r not in seen, (r, k, seen[r])
            seen[r] = k
    missing = set(PL.place) - set(seen)
    assert not missing, sorted(missing)
    extra = set(seen) - set(PL.place)
    assert not extra, sorted(extra)


def base_board_pos():
    """RB-02 placement in the 97x32 board frame: ref -> (x, y, rot, side)"""
    return {r: (x + DX0, y, rot, s) for r, (x, y, rot, s) in PL.place.items()}


def _rot(px, py, a):
    t = math.radians(a)
    return (px * math.cos(t) + py * math.sin(t), -px * math.sin(t) + py * math.cos(t))


def bbox_of(refs, crt):
    xs0 = [crt[r][0] for r in refs if r in crt]; ys0 = [crt[r][1] for r in refs if r in crt]
    xs1 = [crt[r][2] for r in refs if r in crt]; ys1 = [crt[r][3] for r in refs if r in crt]
    return (min(xs0), min(ys0), max(xs1), max(ys1))


def rect_rot(b, theta, pivot):
    px, py = pivot
    pts = [(b[0], b[1]), (b[2], b[1]), (b[0], b[3]), (b[2], b[3])]
    out = [_rot(x - px, y - py, theta) for x, y in pts]
    return (min(p[0] for p in out) + px, min(p[1] for p in out) + py, max(p[0] for p in out) + px, max(p[1] for p in out) + py)


def apply(variant, crt):
    """crt: ref -> courtyard bbox in the RB-02 board frame (F.Cu parts; TP pads use their pad box).  Returns place dict (board frame)."""
    base = base_board_pos()
    new = {}
    info = {}
    for name, theta, x0, y0 in variant["blocks"]:
        refs = BLOCKS[name]
        bb = bbox_of(refs, crt)
        piv = ((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2)
        rb = rect_rot(bb, theta, piv)
        tx, ty = x0 - rb[0], y0 - rb[1]
        for r in refs:
            x, y, rot, s = base[r]
            dx, dy = _rot(x - piv[0], y - piv[1], theta)
            new[r] = (piv[0] + dx + tx, piv[1] + dy + ty, (rot + theta) % 360, s)
        info[name] = (round(x0, 2), round(y0, 2), round(rb[2] - rb[0], 2), round(rb[3] - rb[1], 2))
    for r, v in variant.get("single", {}).items():      # per-part overrides in the new board frame: (dx, dy[, rot])
        x, y, rot, s = new[r]
        new[r] = (x + v[0], y + v[1], v[2] if len(v) > 2 else rot, s)
    for r, v in variant.get("abs", {}).items():         # absolute overrides in the new board frame: (x, y, rot)
        new[r] = (v[0], v[1], v[2], base[r][3])
    return new, info


def part_boxes(variant, crt):
    """courtyard (or pad) boxes of every part after the block transforms: ref -> (x0, y0, x1, y1) in the new frame"""
    out = {}
    for name, theta, x0, y0 in variant["blocks"]:
        refs = BLOCKS[name]
        bb = bbox_of(refs, crt)
        piv = ((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2)
        rb = rect_rot(bb, theta, piv)
        tx, ty = x0 - rb[0], y0 - rb[1]
        for r in refs:
            b = rect_rot(crt[r], theta, piv)
            out[r] = (b[0] + tx, b[1] + ty, b[2] + tx, b[3] + ty)
    return out


def min_gap_vertical(fixed_refs, moving_refs, boxes, gap=0.0):
    """smallest extra upward shift dy (<=0) of the moving set so that no moving courtyard overlaps a fixed one (gap mm apart)"""
    lo, hi = -80.0, 0.0
    def ok(dy):
        for m in moving_refs:
            a = boxes[m]
            for f in fixed_refs:
                b = boxes[f]
                if a[0] < b[2] + gap and b[0] < a[2] + gap and a[1] + dy < b[3] + gap and b[1] < a[3] + dy + gap:
                    return False
        return True
    if not ok(0.0):
        return None
    for _ in range(40):
        mid = (lo + hi) / 2
        if ok(mid):
            hi = mid
        else:
            lo = mid
    return hi
