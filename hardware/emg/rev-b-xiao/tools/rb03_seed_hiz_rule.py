#!/usr/bin/env python3
"""RB-03: prove that the amended hiz_leakage rule still fires (outside the three TLV9064 courtyards) and is silent inside them.
Seeds one foreign track 0.20 mm (edge to edge) from a hi-Z track in a scratch copy of the routed board and counts
hiz_leakage violations with kicad-cli.   python3 rb03_seed_hiz_rule.py <routed.kicad_pcb> <scratch dir>"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pcbnew

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_sexpr import first, kids, parse  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb03r_safe import safe_pcb  # noqa: E402
src, scratch = safe_pcb(sys.argv[1]), Path(sys.argv[2])
K = src.parent                          # a scratch project directory (never the main one: pcbnew rewrites .kicad_pro)
root = parse(src.read_text())
courts = {}
for fp in kids(root, "footprint"):
    ref = [p for p in kids(fp, "property") if str(p[1]) == "Reference"][0][2]
    if str(ref) in ("U501", "U502", "U503"):
        at = first(fp, "at")
        courts[str(ref)] = (float(at[1]), float(at[2]))
hz = []
for s in kids(root, "segment"):
    n = str(first(s, "net")[1])
    if "HIZ" in n:
        a, b = first(s, "start"), first(s, "end")
        ax, ay, bx, by = float(a[1]), float(a[2]), float(b[1]), float(b[2])
        hz.append((n, ax, ay, bx, by))


def inside_u(x, y):
    return any(abs(x - cx) < 5.0 and abs(y - cy) < 3.5 for cx, cy in courts.values())


def run(tag, x0, y0, x1, y1, dx, dy, net="AFE_3V0", layer=pcbnew.F_Cu):
    d = scratch / tag
    shutil.rmtree(d, ignore_errors=True)
    shutil.copytree(K, d, ignore=shutil.ignore_patterns("~*", ".history"))
    b = pcbnew.LoadBoard(str(d / src.name))
    t = pcbnew.PCB_TRACK(b)
    t.SetStart(pcbnew.VECTOR2I(int((x0 + dx) * 1e6), int((y0 + dy) * 1e6)))
    t.SetEnd(pcbnew.VECTOR2I(int((x1 + dx) * 1e6), int((y1 + dy) * 1e6)))
    t.SetWidth(200000)
    t.SetLayer(layer)
    t.SetNet(b.FindNet(net))
    b.Add(t)
    pcbnew.SaveBoard(str(d / src.name), b)
    subprocess.run(["kicad-cli", "pcb", "drc", "--schematic-parity", "--severity-all", "--format", "json", "-o", str(d / "drc.json"), str(d / src.name)],
                   capture_output=True, cwd=d)
    j = json.loads((d / "drc.json").read_text())
    hz = sum(1 for v in j["violations"] if "hiz_leakage" in v["description"])
    other = [v["type"] for v in j["violations"] if v["type"] not in ("lib_footprint_mismatch", "track_dangling", "clearance")]
    return hz, other


def seed(cands, want_hit):
    for (n, ax, ay, bx, by) in cands:
        horizontal = abs(ay - by) < 1e-6
        for sgn in (1, -1):
            dx, dy = (0.0, 0.4 * sgn) if horizontal else (0.4 * sgn, 0.0)
            hz, other = run("seed_tmp", ax, ay, bx, by, dx, dy)
            if other:
                continue            # seeded track touches or crosses something else: not a clean test
            if (hz >= 1) == want_hit:
                return {"segment": [n, ax, ay, bx, by], "offset_centre_mm": [dx, dy], "hiz_leakage_violations": hz}
    return None


res = {}
outside = [h for h in hz if not inside_u(h[1], h[2]) and (abs(h[1] - h[3]) > 0.8 or abs(h[2] - h[4]) > 0.8)]
inside = [h for h in hz if inside_u(h[1], h[2]) and (abs(h[1] - h[3]) > 0.15 or abs(h[2] - h[4]) > 0.15)]
res["outside_TLV9064_courtyards (rule must fire)"] = seed(outside, True)
res["inside_TLV9064_courtyards (rule exempt)"] = seed(inside, False)
print(json.dumps(res, indent=1))
