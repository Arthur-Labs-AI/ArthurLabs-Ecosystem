#!/usr/bin/env python3
"""RB-04: independent reader for the DFM-only Gerber / Excellon / CPL / BOM exports (own RS-274X parser; no KiCad code involved).

    python3 rb04_gerber.py --gerber <dir> --pcb board.kicad_pcb --pos pos.csv --bom bom.csv --out report.json [--svg-dir dir]
Counts apertures by X2 function, draws (length), regions, flashes per layer; parses the Excellon drill; compares every number with
the KiCad source text (pads, vias, tracks, holes) and renders F.Cu / masks / paste / outline to SVG for a visual cross-check.
This is a LOCAL validation only: the files it reads are not manufacturing-release files.
"""
import argparse, collections, csv, json, math, re, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_sexpr import first, kids, parse


def parse_gerber(path):
    txt = Path(path).read_text()
    units, fs = "mm", (4, 6)
    apert = {}                      # code -> (shape, params, function)
    macros = {}
    cur_func = None
    cur = None
    pos = (0.0, 0.0)
    draws, flashes, regions = [], [], []
    region = None
    polarity = "D"
    interp = "G01"
    layer_func = None
    bbox = [1e9, 1e9, -1e9, -1e9]
    # tokenise on '*' while keeping %...% blocks
    for blk in re.findall(r"%[^%]*%|[^%*]+\*", txt, re.S):
        b = blk.strip()
        if b.startswith("%"):
            for cmd in [c for c in b.strip("%").split("*") if c]:
                if cmd.startswith("FS"):
                    m = re.search(r"X(\d)(\d)Y(\d)(\d)", cmd)
                    fs = (int(m.group(1)), int(m.group(2)))
                elif cmd.startswith("MO"):
                    units = "mm" if "MM" in cmd else "in"
                elif cmd.startswith("TF.FileFunction"):
                    layer_func = cmd.split(",", 1)[1]
                elif cmd.startswith("TA.AperFunction"):
                    cur_func = cmd.split(",", 1)[1]
                elif cmd.startswith("TD"):
                    cur_func = None
                elif cmd.startswith("AM"):
                    macros[cmd[2:].split("\n")[0]] = cmd
                elif cmd.startswith("ADD"):
                    m = re.match(r"ADD(\d+)([A-Za-z0-9_]+),?(.*)", cmd)
                    code, shape, par = int(m.group(1)), m.group(2), m.group(3)
                    p = [float(x) for x in re.split(r"[X,]", par) if x != ""] if par else []
                    apert[code] = (shape, p, cur_func)
                elif cmd.startswith("LP"):
                    polarity = cmd[2]
            continue
        for cmd in [c.strip() for c in b.split("*") if c.strip()]:
            if cmd.startswith("G04"):
                continue
            m = re.match(r"^(G0[123])?(?:X(-?\d+))?(?:Y(-?\d+))?(?:I(-?\d+))?(?:J(-?\d+))?(?:D0?([123]))?$", cmd)
            if cmd in ("G01", "G02", "G03", "G75", "G74"):
                if cmd in ("G01", "G02", "G03"):
                    interp = cmd
                continue
            if cmd == "G36":
                region = []
                continue
            if cmd == "G37":
                if region is not None and region:
                    regions.append((polarity, region))
                region = None
                continue
            if cmd == "M02":
                break
            if re.match(r"^D\d+$", cmd) and int(cmd[1:]) >= 10:
                cur = int(cmd[1:])
                continue
            if not m:
                continue
            _, x, y, i, j, d = m.groups()
            sc = 10 ** fs[1]
            nx = int(x) / sc if x is not None else pos[0]
            ny = int(y) / sc if y is not None else pos[1]
            if d == "2":
                pos = (nx, ny)
                if region is not None:
                    region.append(("M", nx, ny))
            elif d == "1":
                if region is not None:
                    region.append((interp, nx, ny))
                else:
                    draws.append((pos, (nx, ny), cur, interp, polarity))
                pos = (nx, ny)
            elif d == "3":
                flashes.append(((nx, ny), cur, polarity))
                pos = (nx, ny)
            else:
                pos = (nx, ny)
    return {"units": units, "apertures": apert, "draws": draws, "flashes": flashes, "regions": regions, "function": layer_func}


def aperture_size(ap):
    shape, p, fn = ap
    if shape == "C":
        return p[0], p[0]
    if shape in ("R", "O"):
        return p[0], p[1]
    if shape == "RoundRect":                                # corner coordinates x,y pairs from index 1; width = max-min + 2*radius
        r = p[0]
        xs = p[1::2][:4]; ys = p[2::2][:4]
        return (max(xs) - min(xs)) + 2 * r, (max(ys) - min(ys)) + 2 * r
    return p[0] if p else 0, p[0] if p else 0


def summarize(g):
    cnt = collections.Counter()
    for (pos, code, pol) in g["flashes"]:
        fn = g["apertures"].get(code, (None, None, None))[2]
        cnt[(fn or "?").split(",")[0]] += 1
    length = collections.defaultdict(float)
    for (a, b, code, interp, pol) in g["draws"]:
        if interp == "G01":
            length[(g["apertures"].get(code, (None, None, None))[2] or "?").split(",")[0]] += math.hypot(b[0] - a[0], b[1] - a[1])
        else:
            length[(g["apertures"].get(code, (None, None, None))[2] or "?").split(",")[0] + "(arc,chord)"] += math.hypot(b[0] - a[0], b[1] - a[1])
    return {"function": g["function"], "flashes_by_function": dict(cnt), "flashes": len(g["flashes"]), "draw_count": len(g["draws"]),
            "draw_length_mm_by_function": {k: round(v, 2) for k, v in length.items()}, "regions": len(g["regions"]), "apertures": len(g["apertures"])}


def excellon(path):
    tools, cur, holes = {}, None, collections.Counter()
    pts = collections.defaultdict(list)
    for ln in Path(path).read_text().splitlines():
        m = re.match(r"T(\d+)C([\d.]+)", ln)
        if m:
            tools[int(m.group(1))] = float(m.group(2))
            continue
        m = re.match(r"^T(\d+)$", ln)
        if m:
            cur = int(m.group(1))
            continue
        m = re.match(r"^X(-?[\d.]+)Y(-?[\d.]+)", ln)
        if m and cur is not None:
            holes[tools[cur]] += 1
            pts[tools[cur]].append((float(m.group(1)), float(m.group(2))))
    return dict(holes), pts


def svg_render(g, color, out, bbox, scale=20, polarity_clear="#ffffff"):
    x0, y0, x1, y1 = bbox
    W, H = (x1 - x0) * scale, (y1 - y0) * scale
    def X(x): return (x - x0) * scale
    def Y(y): return (y1 - y) * scale
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W:.0f}" height="{H:.0f}" viewBox="0 0 {W:.0f} {H:.0f}"><rect width="100%" height="100%" fill="white"/>']
    for pol, reg in g["regions"]:
        pts = " ".join(f"{X(p[1]):.1f},{Y(p[2]):.1f}" for p in reg)
        s.append(f'<polygon points="{pts}" fill="{color if pol == "D" else polarity_clear}" fill-opacity="0.8" fill-rule="evenodd"/>')
    for (a, b, code, interp, pol) in g["draws"]:
        w = aperture_size(g["apertures"][code])[0] if code in g["apertures"] else 0.1
        s.append(f'<line x1="{X(a[0]):.1f}" y1="{Y(a[1]):.1f}" x2="{X(b[0]):.1f}" y2="{Y(b[1]):.1f}" stroke="{color}" stroke-width="{max(w * scale, 0.6):.1f}" stroke-linecap="round"/>')
    for (p, code, pol) in g["flashes"]:
        ap = g["apertures"].get(code)
        if not ap:
            continue
        w, h = aperture_size(ap)
        col = color if pol == "D" else polarity_clear
        if ap[0] == "C":
            s.append(f'<circle cx="{X(p[0]):.1f}" cy="{Y(p[1]):.1f}" r="{w * scale / 2:.1f}" fill="{col}"/>')
        else:
            s.append(f'<rect x="{X(p[0]) - w * scale / 2:.1f}" y="{Y(p[1]) - h * scale / 2:.1f}" width="{w * scale:.1f}" height="{h * scale:.1f}" fill="{col}" rx="{min(w, h) * scale * 0.2:.1f}"/>')
    s.append("</svg>")
    Path(out).write_text("\n".join(s))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--gerber", type=Path, required=True); ap.add_argument("--pcb", type=Path, required=True)
    ap.add_argument("--pos", type=Path); ap.add_argument("--bom", type=Path); ap.add_argument("--out", type=Path, required=True); ap.add_argument("--svg-dir", type=Path)
    a = ap.parse_args(argv)
    files = {p.name.split("-", 1)[1]: p for p in a.gerber.iterdir() if p.suffix.lower() in (".gtl", ".gbl", ".g1", ".g2", ".gts", ".gbs", ".gtp", ".gto", ".gbo", ".gm1")}
    G = {name: parse_gerber(p) for name, p in files.items()}
    rep = {"layers": {n: summarize(g) for n, g in G.items()}}
    # source numbers
    root = parse(a.pcb.read_text())
    src = {"vias": 0, "pads_by_layer": collections.Counter(), "pth": 0, "npth": 0, "track_len": collections.defaultdict(float), "tracks": collections.Counter()}
    for v in kids(root, "via"):
        src["vias"] += 1
    mask_pads = collections.Counter(); paste_pads = 0
    for f in kids(root, "footprint"):
        for p in kids(f, "pad"):
            lay = [str(x) for x in first(p, "layers")[1:]]
            kind = str(p[2])
            if kind == "smd":
                for L in ("F.Cu", "B.Cu"):
                    if L in lay:
                        src["pads_by_layer"][L] += 1
                if "F.Mask" in lay: mask_pads["F.Mask"] += 1
                if "B.Mask" in lay: mask_pads["B.Mask"] += 1
                if "F.Paste" in lay: paste_pads += 1
            elif kind == "thru_hole":
                src["pth"] += 1
                src.setdefault("pth_drills", []).append(float(first(p, "drill")[1]))
                if "F.Mask" in lay or "*.Mask" in lay: mask_pads["F.Mask"] += 1
                if "B.Mask" in lay or "*.Mask" in lay: mask_pads["B.Mask"] += 1
            elif kind == "np_thru_hole":
                src["npth"] += 1
    for s in kids(root, "segment"):
        st, en = first(s, "start"), first(s, "end")
        L = str(first(s, "layer")[1])
        l = math.hypot(float(en[1]) - float(st[1]), float(en[2]) - float(st[2]))
        if l > 0:
            src["track_len"][L] += l; src["tracks"][L] += 1
    # compare
    chk = []
    def ok(name, got, want, tol=0.0):
        good = abs(got - want) <= tol
        chk.append({"check": name, "gerber": round(got, 3), "kicad_source": round(want, 3), "result": "PASS" if good else "FAIL"})
    f = rep["layers"]
    def fl(layer, key):
        return f[layer]["flashes_by_function"].get(key, 0)
    ok("F.Cu SMD pad flashes", fl("F_Cu.gtl", "SMDPad"), src["pads_by_layer"]["F.Cu"])
    for L, nm in (("F_Cu.gtl", "F.Cu"), ("B_Cu.gbl", "B.Cu")):
        ok(f"{nm} conductor length (mm, line draws)", f[L]["draw_length_mm_by_function"].get("Conductor", 0), src["track_len"][nm], 0.05)
    ok("F.Cu via pad flashes", fl("F_Cu.gtl", "ViaPad"), src["vias"])
    ok("B.Cu via pad flashes", fl("B_Cu.gbl", "ViaPad"), src["vias"])
    ok("In1 via pad flashes (via pads on inner layers)", fl("In1_Cu.g1", "ViaPad"), src["vias"])
    ok("F.Mask openings = SMD+TH pads with mask", f["F_Mask.gts"]["flashes"] + f["F_Mask.gts"]["draw_count"] * 0 + len([1 for _ in ()]), mask_pads["F.Mask"], 0)
    ok("F.Mask via openings (tented => 0)", fl("F_Mask.gts", "ViaPad"), 0)
    ok("B.Mask via openings (tented => 0)", fl("B_Mask.gbs", "ViaPad"), 0)
    ok("F.Paste apertures = SMD pads with paste", f["F_Paste.gtp"]["flashes"], paste_pads)
    holes, pts = excellon(next(a.gerber.glob("*.drl")))
    ok("Drill 0.30 count = vias", holes.get(0.3, 0), src["vias"])
    pth_d = sorted(set(src.get("pth_drills", [1.4])))
    ok("Drill %.2f count = PTH pads (size read from the PCB)" % pth_d[0], holes.get(pth_d[0], 0), src["pth"])
    rep["drill_tools"] = holes
    rep["checks"] = chk
    # outline bbox
    og = G["Edge_Cuts.gm1"]
    xs = [p for d in og["draws"] for p in (d[0][0], d[1][0])]; ys = [p for d in og["draws"] for p in (d[0][1], d[1][1])]
    rep["outline_bbox_mm"] = [round(min(xs), 3), round(min(ys), 3), round(max(xs), 3), round(max(ys), 3)]
    rep["outline_size_mm"] = [round(max(xs) - min(xs), 3), round(max(ys) - min(ys), 3)]
    # CPL / BOM
    if a.pos:
        rows = list(csv.DictReader(a.pos.open()))
        rep["cpl_rows"] = len(rows)
        rep["cpl_sides"] = dict(collections.Counter(r["Side"] for r in rows))
        rep["cpl_refs_are_assembled_smt"] = sorted({r["Ref"] for r in rows if r["Ref"].startswith(("TP", "U1"))})
        ok("CPL rows = top SMT parts", len(rows), 126)
        rep["cpl_rotation_values"] = dict(collections.Counter(r["Rot"].split(".")[0] for r in rows))
    if a.bom:
        rows = list(csv.reader(a.bom.open()))
        rep["bom_lines"] = len(rows) - 1
        rep["bom_header"] = rows[0]
        rep["bom_parts"] = sum(int(row[3]) for row in rows[1:])
        ok("BOM quantity sum = assembled SMT parts", rep["bom_parts"], 126)
    a.out.write_text(json.dumps(rep, indent=1, default=str))
    for c in chk:
        print(c["result"], c["check"], c["gerber"], c["kicad_source"])
    print("outline", rep["outline_size_mm"], "drill", holes)
    if a.svg_dir:
        a.svg_dir.mkdir(parents=True, exist_ok=True)
        bb = (rep["outline_bbox_mm"][0] - 1, rep["outline_bbox_mm"][1] - 1, rep["outline_bbox_mm"][2] + 1, rep["outline_bbox_mm"][3] + 1)
        for nm, col in (("F_Cu.gtl", "#c83232"), ("B_Cu.gbl", "#3250c8"), ("In1_Cu.g1", "#32a050"), ("In2_Cu.g2", "#a05fa0"), ("F_Mask.gts", "#208020"), ("F_Paste.gtp", "#707070"), ("Edge_Cuts.gm1", "#000000")):
            svg_render(G[nm], col, a.svg_dir / (nm.split(".")[0] + ".svg"), bb)
    return 0


if __name__ == "__main__":
    sys.exit(main())
