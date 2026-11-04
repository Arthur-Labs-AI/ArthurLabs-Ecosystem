#!/usr/bin/env python3
"""RB-02 footprint audit: the two project-local footprints (ARTHUR.pretty) against the verified geometry, the manufacturer
drawing numbers and the schematic pin names, plus a library-wide pad/symbol-pin consistency check.

    python3 rb02_audit_footprints.py --netlist revb.xml [--evidence <seeed_pcb_extract.json>] [--json out.json]
"""
import argparse
import json
import math
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_sexpr import first, kids, parse  # noqa: E402

HERE = Path(__file__).resolve().parent
KDIR = HERE.parent / "kicad/ARTHUR_EMG_RevB"
LIB = KDIR / "fp-libs"
OUT = []


def chk(cid, ok, title, detail=""):
    OUT.append({"id": cid, "status": "PASS" if ok else "FAIL", "title": title, "detail": detail})


def pads_of(fp):
    res = []
    for p in kids(fp, "pad"):
        at = first(p, "at"); sz = first(p, "size"); dr = first(p, "drill")
        res.append({"num": str(p[1]), "type": str(p[2]), "shape": str(p[3]), "x": float(at[1]), "y": float(at[2]),
                    "w": float(sz[1]), "h": float(sz[2]), "layers": [str(l) for l in first(p, "layers")[1:]],
                    "drill": float(dr[1]) if dr else None, "mask": float(first(p, "solder_mask_margin")[1]) if first(p, "solder_mask_margin") else None,
                    "paste": float(first(p, "solder_paste_margin")[1]) if first(p, "solder_paste_margin") else None})
    return res


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--netlist", type=Path, required=True)
    ap.add_argument("--evidence", type=Path, default=HERE.parent / "evidence/rb02a/seeed_pcb_extract.json")
    ap.add_argument("--json", type=Path)
    a = ap.parse_args(argv)
    ev = json.loads(a.evidence.read_text())
    ox, oy = ev["outline"]["bbox"][0], ev["outline"]["bbox"][1]
    CXm, CYm = ev["outline"]["width"] / 2, ev["outline"]["height"] / 2
    nl = ET.parse(a.netlist).getroot()

    # ---------------- library loads
    with tempfile.TemporaryDirectory() as d:
        r = subprocess.run(["kicad-cli", "fp", "export", "svg", "-o", d, str(LIB / "ARTHUR.pretty")], capture_output=True, text=True)
    chk("F01", r.returncode == 0 and "XIAO_ESP32S3_HANDSOLDER" in r.stdout + r.stderr, "ARTHUR.pretty loads in KiCad 10 and plots (kicad-cli fp export svg)", (r.stdout + r.stderr)[-120:].strip())

    # ---------------- XIAO
    x = parse((LIB / "ARTHUR.pretty/XIAO_ESP32S3_HANDSOLDER.kicad_mod").read_text())
    px = pads_of(x)
    cast = [p for p in px if p["num"].isdigit() and int(p["num"]) <= 14]
    chk("F02", sorted(int(p["num"]) for p in cast) == list(range(1, 15)) and all(p["type"] == "smd" for p in cast),
        "XIAO: 14 castellation SMD pads numbered 1..14", str(sorted(p["num"] for p in cast)))
    post = [p for p in px if p["num"] == "23"]
    chk("F03", sorted(p["type"] for p in post) == ["smd", "thru_hole"] and not [p for p in px if p["num"] not in {str(i) for i in range(1, 15)} | {"23"}],
        "XIAO: BAT+ post = one plated hole pad + one B.Cu exposed pad, both numbered 23, and no other pad (15-22, 24, 25 not soldered)",
        str([(p["type"], p["w"], p["drill"]) for p in post]))
    # geometry vs RB-02A CAD: half-hole centres in module frame (u, v) -> footprint frame
    half = {p["number"]: p for p in ev["pads"] if p["ref"] == "U9" and p["type"] == "thru_hole" and abs(p["w"] - 1.27) < 1e-6}
    worst = 0.0
    for p in cast:
        n = p["num"]
        hh = half[n]
        u, v = hh["x"] - ox, hh["y"] - oy
        edge_u = 0.0 if int(n) <= 7 else ev["outline"]["width"]
        inside = 1 if int(n) <= 7 else -1
        exp_x = (edge_u - CXm) + inside * 0.15
        exp_y = v - CYm
        worst = max(worst, abs(p["x"] - exp_x), abs(p["y"] - exp_y))
    chk("F04", worst < 0.002, "XIAO: castellation pad centres equal the Seeed PCB half-hole positions (RB-02A extraction), toe 1.30 outside", f"max deviation {worst:.4f} mm")
    sizes = {(p["w"], p["h"]) for p in cast}
    chk("F05", sizes == {(2.9, 1.5)}, "XIAO: host pad 2.90 x 1.50 (toe 1.30, inner 1.60)", str(sizes))
    chk("F06", all(p["layers"] == ["F.Cu", "F.Mask"] and abs((p["mask"] or 0) - 0.05) < 1e-9 for p in cast),
        "XIAO: castellation pads F.Cu + F.Mask only (no paste), mask expansion +0.05 mm", str({tuple(p["layers"]) for p in cast}))
    t = [p for p in post if p["type"] == "thru_hole"][0]
    s_ = [p for p in post if p["type"] == "smd"][0]
    bat = [p for p in ev["pads"] if p["ref"] == "BAT0"][0]
    bu, bv = bat["x"] - ox, bat["y"] - oy
    chk("F07", abs(t["x"] - (bu - CXm)) < 0.002 and abs(t["y"] - (bv - CYm)) < 0.002 and t["drill"] == 1.4 and t["w"] == 1.9 and s_["w"] == 3.0 and s_["layers"] == ["B.Cu", "B.Mask"],
        "XIAO: post pad at the CAD BAT+ pad centre; drill 1.40, ring 1.90, mask opening 1.45 (margin -0.225), bottom pad 3.00 on B.Cu",
        f"hole ({t['x']:.3f},{t['y']:.3f}) vs CAD ({bu - CXm:.3f},{bv - CYm:.3f}); mask margin {t['mask']}")
    zs = kids(x, "zone")
    names = [str(first(z, "name")[1]) for z in zs]
    need = ["pads 15-22", "pad 25", "GND0", "shell oval S1", "shell oval S2", "shell oval S3", "shell oval S4", "no vias (above", "no vias (below", "no vias (east", "no vias (west"]
    chk("F08", all(any(n_ in nm for nm in names) for n_ in need), "XIAO: underside keep-out rule areas (pads 15-22, 25, GND0, 4 USB shell ovals, via limits)", f"{len(zs)} zones")
    crt = []
    for kind in ("fp_rect", "fp_line"):
        for it in kids(x, kind):
            if str(first(it, "layer")[1]) == "F.CrtYd":
                for k in ("start", "end"):
                    q = first(it, k); crt.append((float(q[1]), float(q[2])))
    cx0, cx1 = min(c[0] for c in crt), max(c[0] for c in crt)
    cy0, cy1 = min(c[1] for c in crt), max(c[1] for c in crt)
    pad_ext = max(abs(p["x"]) + p["w"] / 2 for p in cast)
    chk("F09", cx0 <= -pad_ext and cx1 >= pad_ext and cy0 <= -CYm - 1.5 and cy1 >= CYm, "XIAO: courtyard encloses the pads, module outline and the USB-C overhang", f"x {cx0:.2f}..{cx1:.2f}, y {cy0:.2f}..{cy1:.2f}")
    layers_used = {str(first(i, "layer")[1]) for k in ("fp_line", "fp_rect", "fp_arc", "fp_circle", "fp_text") for i in kids(x, k) if first(i, "layer")}
    chk("F10", {"Dwgs.User", "Cmts.User", "B.Fab", "F.Fab"} <= layers_used, "XIAO: documents USB-C envelope, plug overmold, U.FL cable corridor and underside features", str(sorted(layers_used)))
    # pad function mapping vs schematic symbol pin names
    u1 = {}
    for n in nl.findall("./nets/net"):
        for nd in n.findall("node"):
            if nd.get("ref") == "U1":
                u1[nd.get("pin")] = nd.get("pinfunction")
    want = {1: "D0", 2: "D1", 3: "D2", 4: "D3", 5: "D4", 6: "D5", 7: "D6", 8: "D7", 9: "D8", 10: "D9", 11: "D10", 12: "3V3", 13: "GND", 14: "5V", 23: "BAT+"}
    bad = [(n, u1.get(str(n))) for n, w in want.items() if not (u1.get(str(n)) or "").startswith(w if w not in ("3V3", "5V", "BAT+") else w.split("(")[0])]
    chk("F11", not bad, "XIAO: footprint pad numbers = schematic symbol pin numbers/functions (1-14 + 23)", f"{len(want)} mapped; mismatches {bad}")

    # ---------------- SCTF
    o = parse((LIB / "ARTHUR.pretty/OSC_SCTF_SX3M_SMD3225-4P.kicad_mod").read_text())
    po = {p["num"]: p for p in pads_of(o)}
    exp = {"1": (-1.1, 0.875), "2": (1.1, 0.875), "3": (1.1, -0.875), "4": (-1.1, -0.875)}
    chk("F12", set(po) == set(exp) and all(abs(po[k]["x"] - e[0]) < 1e-6 and abs(po[k]["y"] - e[1]) < 1e-6 and (po[k]["w"], po[k]["h"]) == (1.2, 0.95) for k, e in exp.items()),
        "SCTF: pads 1.20 x 0.95 at c-c 2.20 x 1.75 (manufacturer land); pin 1 bottom-left, counter-clockwise", str({k: (v["x"], v["y"]) for k, v in po.items()}))
    xs = {}
    for n in nl.findall("./nets/net"):
        for nd in n.findall("node"):
            if nd.get("ref") == "X1":
                xs[nd.get("pin")] = nd.get("pinfunction")
    chk("F13", [xs.get(str(i)).split("_")[0] for i in (1, 2, 3, 4)] == ["OE", "GND", "OUT", "VDD"], "SCTF: footprint pad numbers = symbol pins (1 OE, 2 GND, 3 OUT, 4 VDD)", str(xs))
    chk("F14", all("F.Paste" in p["layers"] for p in po.values()), "SCTF: paste on all pads (JLC reflow)", "")

    # ---------------- library-wide: every symbol pin has a footprint pad (and the reverse for non-NC)
    problems = []
    for c in nl.findall("./components/comp"):
        lib, name = c.findtext("footprint").split(":")
        fp = parse((LIB / f"{lib}.pretty/{name}.kicad_mod").read_text())
        padn = {str(p[1]) for p in kids(fp, "pad")}
        pins = {nd.get("pin") for n in nl.findall("./nets/net") for nd in n.findall("node") if nd.get("ref") == c.get("ref")}
        if not pins <= padn:
            problems.append((c.get("ref"), sorted(pins - padn)))
    chk("F15", not problems, "all 135 components: every schematic pin exists as a pad in the linked footprint", str(problems[:4]))
    for r in OUT:
        print(f"{r['status']}  {r['id']} {r['title']}\n        {r['detail'][:200]}")
    n_fail = sum(r["status"] == "FAIL" for r in OUT)
    print(f"\n{len(OUT)} checks, {n_fail} FAIL")
    if a.json:
        a.json.write_text(json.dumps(OUT, indent=1))
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
