#!/usr/bin/env python3
"""RB-03R: incremental repair of a routed board: remove every via that is inside or too close to an SMD pad (< 0.25 mm centre to
pad copper) by ripping up and strictly re-routing the nets involved (no via-in-pad fallback), escalating to the neighbouring nets
when the net alone cannot be placed.  Works on the router's own state loaded from the board file.

    python3 rb03r_repair.py --pcb in.kicad_pcb --out out.kicad_pcb [--log log.json] [--max-escalation 2]
(run it on a SCRATCH project copy: pcbnew is used to read the pads)
"""
import argparse
import json
import math
import sys
from pathlib import Path

import pcbnew
import sys as _sys, pathlib as _pl
_sys.path.insert(0, str(_pl.Path(__file__).resolve().parent))
from rb03r_safe import safe_pcb  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rb03_router as RT  # noqa: E402
from rb02_sexpr import Q, dump, first, kids, parse  # noqa: E402

LN = {"F.Cu": RT.L_F, "B.Cu": RT.L_B, "In2.Cu": RT.L_I2}
NM = 1e6
GAP = 0.25


def load_state(r, root):
    for s in kids(root, "segment"):
        st, en = first(s, "start"), first(s, "end")
        r.add_track(str(first(s, "net")[1]), LN[str(first(s, "layer")[1])], float(st[1]), float(st[2]), float(en[1]), float(en[2]), float(first(s, "width")[1]))
    for v in kids(root, "via"):
        at = first(v, "at")
        r.add_via(str(first(v, "net")[1]), float(at[1]), float(at[2]))


def offenders(b, r):
    """vias whose centre is closer than GAP to any SMD pad copper (true shape)"""
    bad = []
    pads = []
    for fp in b.GetFootprints():
        for p in fp.Pads():
            if p.GetAttribute() != pcbnew.PAD_ATTRIB_PTH:
                pads.append((fp.GetReference(), p.GetNumber(), p))
    for (net, x, y) in r.vias:
        pos = pcbnew.VECTOR2I(int(round(x * NM)), int(round(y * NM)))
        for ref, num, p in pads:
            if p.HitTest(pos, int(GAP * NM) - 2000):
                bad.append((net, x, y, f"{ref}.{num}"))
                break
    return bad


def rip(r, nets):
    r.tracks = [t for t in r.tracks if t[0] not in nets]
    r.vias = [v for v in r.vias if v[0] not in nets]
    for L in r.copper:
        r.copper[L] = [c for c in r.copper[L] if not (c[4] in nets and c[5] in ("track", "via"))]


def snapshot(r):
    return (list(r.tracks), list(r.vias), {L: list(v) for L, v in r.copper.items()}, set(r.gnd_done))


def restore(r, snap):
    r.tracks, r.vias, r.copper, r.gnd_done = list(snap[0]), list(snap[1]), {L: list(v) for L, v in snap[2].items()}, set(snap[3])


def route_strict(r, net):
    r.relax_via_in_pad = False
    r.own_pad_via_gap = GAP
    ok, info = r._route_net(net, RT.klass(net), r.nets_by_name[net])
    return ok


def neighbours(r, nets, radius):
    """non-GND nets with copper within `radius` of any pad of the given nets"""
    pts = [(p["x"], p["y"]) for n in nets for p in r.nets_by_name[n]]
    out = set()
    for (n, L, xa, ya, xb, yb, w) in r.tracks:
        if n == "GND" or n in nets:
            continue
        if any(min(math.hypot(xa - x, ya - y), math.hypot(xb - x, yb - y)) < radius for x, y in pts):
            out.add(n)
    for (n, x, y) in r.vias:
        if n != "GND" and n not in nets and any(math.hypot(x - px, y - py) < radius for px, py in pts):
            out.add(n)
    return out


def write_board(root, r, out):
    keep = [n for n in root if not (isinstance(n, list) and n and n[0] in ("segment", "via"))]
    tmpl_seg = next(n for n in root if isinstance(n, list) and n and n[0] == "segment")
    import uuid
    new = []
    for (net, L, xa, ya, xb, yb, w) in r.tracks:
        if abs(xa - xb) < 1e-9 and abs(ya - yb) < 1e-9:
            continue
        new.append(["segment", ["start", xa, ya], ["end", xb, yb], ["width", w], ["layer", Q({v: k for k, v in LN.items()}[L])],
                    ["net", Q(net)], ["uuid", Q(str(uuid.uuid4()))]])
    for (net, x, y) in r.vias:
        new.append(["via", ["at", x, y], ["size", 0.6], ["drill", 0.3], ["layers", Q("F.Cu"), Q("B.Cu")], ["net", Q(net)], ["uuid", Q(str(uuid.uuid4()))]])
    # insert before the first zone to keep the usual file order
    idx = next((i for i, n in enumerate(keep) if isinstance(n, list) and n and n[0] == "zone"), len(keep))
    root[:] = keep[:idx] + new + keep[idx:]
    Path(out).write_text(dump(root) + "\n")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pcb", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--log", type=Path)
    ap.add_argument("--radius", type=float, default=4.0)
    a = ap.parse_args(argv)
    root = parse(a.pcb.read_text())
    b = pcbnew.LoadBoard(str(safe_pcb(a.pcb)))
    # the router reads pads / zones / keep-outs from the board; copper of tracks/vias is injected from the file
    r = RT.Router(b)
    r.slack = 0.03
    r.own_pad_via_gap = GAP
    r.gnd_rects = [(x0, y0, x1, y1) for (x0, y0, x1, y1, n, k) in r.copper[RT.L_F] if n == "GND" and k == "pad"]
    r.route_all(only={"__none__"})            # prepares net tables (hiz/buf/spi sets, clearances); routes nothing
    load_state(r, root)
    # GND pads that already have a via/stub are "done"
    for fp in b.GetFootprints():
        for p in fp.Pads():
            if p.GetNetname() == "GND":
                r.gnd_done.add((fp.GetReference(), p.GetNumber()))
    log = {"rounds": []}
    for rnd in range(6):
        bad = offenders(b, r)
        log["rounds"].append({"offenders": [f"{n}:{pad}@({x:.2f},{y:.2f})" for n, x, y, pad in bad]})
        print(f"round {rnd}: {len(bad)} offending vias", flush=True)
        if not bad:
            break
        progress = False
        nets = []
        for (n, x, y, pad) in bad:
            if n != "GND" and n not in nets:
                nets.append(n)
        gnd = [(x, y, pad) for (n, x, y, pad) in bad if n == "GND"]
        for n in nets:
            if not [v for v in r.vias if v[0] == n and any(abs(v[1] - x) < 1e-6 and abs(v[2] - y) < 1e-6 for (nn, x, y, pp) in bad if nn == n)]:
                continue            # already repaired as a neighbour
            ok = False
            for esc in (0, 1, 2):
                snap = snapshot(r)
                group = {n}
                if esc:
                    group |= neighbours(r, {n}, a.radius * esc)
                    group = {g for g in group if RT.klass(g) not in ("EMG_ELECTRODE",)}
                rip(r, group)
                order = [n] + sorted(group - {n}, key=lambda g: (RT.PRIORITY.index(RT.klass(g)) if RT.klass(g) in RT.PRIORITY else 99, g))
                good = all(route_strict(r, g) for g in order)
                if good:
                    print(f"  repaired {n} (escalation {esc}, ripped {len(group)} nets)", flush=True)
                    ok = True
                    progress = True
                    log.setdefault("repaired", []).append({"net": n, "escalation": esc, "ripped": sorted(group)})
                    break
                restore(r, snap)
            if not ok:
                print(f"  FAILED {n}", flush=True)
                log.setdefault("failed", []).append(n)
        for (x, y, pad) in gnd:
            # drop the via and the short GND stub chain, re-tie the pad strictly
            snap = snapshot(r)
            ref, num = pad.split(".")
            r.vias = [v for v in r.vias if not (v[0] == "GND" and abs(v[1] - x) < 1e-6 and abs(v[2] - y) < 1e-6)]
            r.copper[RT.L_F] = [c for c in r.copper[RT.L_F] if not (c[5] == "via" and c[4] == "GND" and abs((c[0] + c[2]) / 2 - x) < 1e-6 and abs((c[1] + c[3]) / 2 - y) < 1e-6)]
            r.copper[RT.L_B] = [c for c in r.copper[RT.L_B] if not (c[5] == "via" and c[4] == "GND" and abs((c[0] + c[2]) / 2 - x) < 1e-6 and abs((c[1] + c[3]) / 2 - y) < 1e-6)]
            r.copper[RT.L_I2] = [c for c in r.copper[RT.L_I2] if not (c[5] == "via" and c[4] == "GND" and abs((c[0] + c[2]) / 2 - x) < 1e-6 and abs((c[1] + c[3]) / 2 - y) < 1e-6)]
            # remove GND tracks that touch the removed via (stub chain, at most 3 hops)
            ends = [(x, y)]
            for _ in range(3):
                nxt = []
                keep = []
                for t in r.tracks:
                    if t[0] == "GND" and any(abs(t[2] - ex) < 1e-6 and abs(t[3] - ey) < 1e-6 or abs(t[4] - ex) < 1e-6 and abs(t[5] - ey) < 1e-6 for ex, ey in ends):
                        nxt += [(t[2], t[3]), (t[4], t[5])]
                    else:
                        keep.append(t)
                r.tracks = keep
                ends = nxt
            r.copper[RT.L_F] = [c for c in r.copper[RT.L_F] if True]
            r.gnd_done.discard((ref, num))
            r.relax_via_in_pad = False
            r.gnd_vias(prefixes={pad})
            if (ref, num) in r.gnd_done and not offenders_for_pad(b, r, pad):
                print("  repaired GND", pad, flush=True)
                progress = True
                log.setdefault("repaired", []).append({"net": "GND", "pad": pad})
            else:
                restore(r, snap)
                print("  FAILED GND", pad, flush=True)
                log.setdefault("failed", []).append("GND:" + pad)
        if not progress:
            break
    log["remaining"] = [f"{n}:{pad}@({x:.2f},{y:.2f})" for n, x, y, pad in offenders(b, r)]
    write_board(root, r, a.out)
    if a.log:
        a.log.write_text(json.dumps(log, indent=1))
    print("remaining offenders:", len(log["remaining"]))
    return 0


def offenders_for_pad(b, r, pad):
    return [o for o in offenders(b, r) if o[3] == pad and o[0] == "GND"]


if __name__ == "__main__":
    sys.exit(main())
