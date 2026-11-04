#!/usr/bin/env python3
"""RB-02F: build a SCRATCH what-if placement (never the project PCB) and report body-to-edge status + courtyard overlaps.

    python3 rb02f_variant.py --netlist revb.xml --spec spec.json --out <dir>

spec.json: {"name":..., "moves": {"R101": [dx, dy] | [dx, dy, new_rot]}, "grow": {"north":0,"south":0,"west":0,"east":0},
            "set": {"J1": [x', y, rot]}}
Coordinates are the RB-02 x' frame (board x = x' + DX).  Growing north shifts every part south by that amount (the USB end
stays on the south edge); growing west increases DX.  The project PCB and rb02_placement.py are not modified.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import rb02_placement as PL  # noqa: E402
import rb02_build_pcb as B  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--netlist", type=Path, required=True)
    ap.add_argument("--spec", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    spec = json.loads(a.spec.read_text())
    a.out.mkdir(parents=True, exist_ok=True)
    pl = PL.place
    for ref, v in spec.get("set", {}).items():
        x, y, r = v
        pl[ref] = (x, y, r, pl[ref][3])
    for ref, v in spec.get("moves", {}).items():
        x, y, r, s = pl[ref]
        pl[ref] = (x + v[0], y + v[1], v[2] if len(v) > 2 else r, s)
    g = spec.get("grow", {})
    n, s_, w, e = (g.get(k, 0.0) for k in ("north", "south", "west", "east"))
    if n:
        for ref, (x, y, r, s) in list(pl.items()):
            pl[ref] = (x, y + n, r, s)
    if s_:                      # south growth: the USB end must stay at the edge, so only U1 and its rotation anchor move
        pass
    PL.DX = PL.DX + w
    PL.BOARD_W = PL.BOARD_W + w + e
    PL.BOARD_H = PL.BOARD_H + n + s_
    B.PL = PL
    pcb = a.out / "variant.kicad_pcb"
    sys.argv = ["rb02_build_pcb", "--netlist", str(a.netlist), "--out", str(pcb)]
    B.main()
    if n:
        # keep the RB-02 absolute frame: undo the south shift of everything, so the outline simply extends to y = -n
        from rb02_sexpr import dump, kids, parse
        root = parse(pcb.read_text())

        def sh(node):
            for key in ("at", "start", "end", "mid", "center"):
                for q in kids(node, key):
                    q[2] = format(float(q[2]) - n, ".6g")
            for pts in kids(node, "pts"):
                for q in kids(pts, "xy"):
                    q[2] = format(float(q[2]) - n, ".6g")

        for it in root:
            if not isinstance(it, list) or not it:
                continue
            if it[0] == "footprint":
                for q in kids(it, "at"):
                    q[2] = format(float(q[2]) - n, ".6g")
                for z in kids(it, "zone"):
                    for pg in kids(z, "polygon"):
                        sh(pg)
            elif it[0] in ("gr_line", "gr_arc", "gr_rect", "gr_circle", "gr_text"):
                sh(it)
                for k in ("start", "end", "mid", "center"):
                    pass
            elif it[0] == "zone":
                for pg in kids(it, "polygon"):
                    sh(pg)
        pcb.write_text(dump(root))
    return 0


if __name__ == "__main__":
    sys.exit(main())
