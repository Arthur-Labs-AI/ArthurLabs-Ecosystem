#!/usr/bin/env python3
"""RB-02E: JLCPCB Economic PCBA design-compatibility audit of the placed Rev B board (read-only).

    python3 rb02e_economic_audit.py --pcb ARTHUR_EMG_RevB.kicad_pcb --netlist revb.xml --out <dir>

Writes <dir>/assembly_inventory.json|.csv, <dir>/edge_clearance.json|.csv, <dir>/economic_audit.json.
Rules are encoded from the JLCPCB pages recorded in REVB_RB02E_ECONOMIC_PCBA_AUDIT.md (read 2026-10-10); each rule carries
its status (MANDATORY-AS-WRITTEN / RECOMMENDED / CAPABILITY).  Nothing here is a statement of factory acceptance.
"""
import argparse
import csv
import json
import math
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_check_placement import load  # noqa: E402
from rb02_sexpr import first, kids  # noqa: E402

# --- official numbers (see REVB_RB02E_ECONOMIC_PCBA_AUDIT.md section 1 for URLs) ---
BODY_TO_EDGE_TC = 2.5      # Terms and Conditions of JLCPCB Assembly Service, 2. Notes on DFM, item 3 ("must be equal or greater than 2.5mm")
COPPER_PART_TO_EDGE_FAQ = 0.3   # PCB Assembly FAQs (Part 2), item 14 "Reminder for economic assembly design" ("suggest ... more than 0.3mm")
NEAR = 3.0                 # RB-02 screening distance (the 35-component list)
ECON = {"layers": (2, 4, 6), "single_pcb_mm": ((10, 10), (470, 500)), "panel_mm": ((10, 10), (250, 250)), "thickness_mm": (0.8, 1.6),
        "min_ic_pitch_mm": 0.40, "min_package": "0402", "qty": (2, 50)}
# JST datasheet (ePH.pdf, "PH connector header SMT type"): overall length B and the drawn depth, mm
JST = {"B2B-PH-SM4-TB": {"length": 7.95, "depth": 6.6, "entry": "top (plug enters from +Z)"},
       "S2B-PH-SM4-TB": {"length": 7.9, "depth": 5.5, "entry": "side (plug enters in plane, cable leaves in the opening direction)"}}


def rot(px, py, a):
    t = math.radians(a)
    return (px * math.cos(t) + py * math.sin(t), -px * math.sin(t) + py * math.cos(t))


def fab_bbox(fp_node, x, y, a, layer):
    want = "F.Fab" if layer == "F.Cu" else "B.Fab"
    pts = []
    for kind in ("fp_line", "fp_rect", "fp_arc", "fp_circle", "fp_poly"):
        for it in kids(fp_node, kind):
            ly = first(it, "layer")
            if not ly or str(ly[1]) != want:
                continue
            for key in ("start", "end", "mid"):
                q = first(it, key)
                if q:
                    pts.append((float(q[1]), float(q[2])))
            c = first(it, "center")
            if c:
                e = first(it, "end")
                r = math.hypot(float(e[1]) - float(c[1]), float(e[2]) - float(c[2]))
                pts += [(float(c[1]) + dx, float(c[2]) + dy) for dx, dy in ((r, 0), (-r, 0), (0, r), (0, -r))]
            pp = first(it, "pts")
            if pp:
                pts += [(float(q[1]), float(q[2])) for q in kids(pp, "xy")]
    if not pts:
        return None
    xs, ys = [], []
    for px, py in pts:
        rx, ry = rot(px, py, a)
        xs.append(x + rx); ys.append(y + ry)
    return (min(xs), min(ys), max(xs), max(ys))


def edge_dist(b, E):
    return min(b[0] - E[0], b[1] - E[1], E[2] - b[2], E[3] - b[3])


def edge_name(b, E):
    d = {"west": b[0] - E[0], "north": b[1] - E[1], "east": E[2] - b[2], "south": E[3] - b[3]}
    return min(d, key=d.get)


def bbox_union(bs):
    bs = [b for b in bs if b]
    return (min(b[0] for b in bs), min(b[1] for b in bs), max(b[2] for b in bs), max(b[3] for b in bs)) if bs else None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pcb", type=Path, required=True)
    ap.add_argument("--netlist", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    a.out.mkdir(parents=True, exist_ok=True)
    fps, E, zones, root = load(a.pcb)
    nodes = {}
    for f in kids(root, "footprint"):
        nodes[{str(p[1]): str(p[2]) for p in kids(f, "property")}["Reference"]] = f
    nl = ET.parse(a.netlist).getroot()
    fields = {}
    for c in nl.findall("./components/comp"):
        fields[c.get("ref")] = {x.get("name"): x.text for x in c.findall("./fields/field")} | {"value": c.findtext("value")}

    # board / stackup facts
    W, H = E[2] - E[0], E[3] - E[1]
    layers = [str(l[1]) for l in kids(first(root, "layers"), "*")] if False else None
    cu = [str(c[1]) for c in first(root, "layers")[1:] if isinstance(c, list) and str(c[1]).endswith(".Cu")]
    thick = None
    st = first(first(root, "setup"), "stackup")
    if st:
        tt = 0.0
        for ly in kids(st, "layer"):
            t = first(ly, "thickness")
            if t:
                tt += float(t[1])
        thick = round(tt, 3)

    # ---- inventory
    inv = []
    for ref in sorted(fps, key=lambda r: (r.rstrip("0123456789"), int(''.join(c for c in r if c.isdigit()) or 0))):
        o = fps[ref]
        fl = fields.get(ref, {})
        attr = o.attr
        types = sorted({p["type"] for p in o.pads})
        is_tp = o.libid.startswith("TestPoint:")
        dnp = "dnp" in attr
        if dnp:
            method, jlc = "DNP: not assembled by JLC; retail module hand-soldered after delivery", False
        elif is_tp:
            method, jlc = "bare copper pad: no component, not assembled", False
        elif "thru_hole" in types:
            method, jlc = "THT (needs wave/manual)", True
        else:
            method, jlc = "SMT reflow, single side", True
        inv.append({"ref": ref, "value": fl.get("value"), "mpn": fl.get("MPN"), "lcsc": fl.get("LCSC"), "jlc_class": fl.get("JLC_Class"),
                    "footprint": o.libid, "package": o.libid.split(":")[1], "side": "top" if o.layer == "F.Cu" else "bottom",
                    "layer": o.layer, "pad_types": types, "n_pads": len(o.pads), "attr": attr,
                    "excluded_from_pos": "exclude_from_pos_files" in attr, "excluded_from_bom": "exclude_from_bom" in attr,
                    "dnp": dnp, "assembly_method": method, "jlc_assembled": jlc,
                    "x": round(o.x, 3), "y": round(o.y, 3), "rot": o.rot})
    top = [r for r in inv if r["jlc_assembled"] and r["side"] == "top"]
    bot = [r for r in inv if r["jlc_assembled"] and r["side"] == "bottom"]
    tht = [r for r in inv if r["jlc_assembled"] and "thru_hole" in r["pad_types"]]
    bot_nonexcl = [r["ref"] for r in inv if r["side"] == "bottom" and not r["excluded_from_pos"] and not r["dnp"]]
    # what a DNP-aware CPL export would contain
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "pos.csv"
        subprocess.run(["kicad-cli", "pcb", "export", "pos", "--format", "csv", "--units", "mm", "--side", "both", "--exclude-dnp",
                        "-o", str(out), str(a.pcb)], capture_output=True, text=True)
        cpl = [l.split(",")[0].strip('"') for l in out.read_text().splitlines()[1:]] if out.exists() else []
        cpl_side = {}
        for l in out.read_text().splitlines()[1:]:
            c = l.replace('"', "").split(",")
            cpl_side[c[0]] = c[-1] if c else ""
    cpl_bottom = [r for r, s in cpl_side.items() if s.strip() == "bottom"]
    inv_csv = a.out / "assembly_inventory.csv"
    with inv_csv.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(inv[0].keys()))
        w.writeheader()
        for r in inv:
            w.writerow({k: (";".join(v) if isinstance(v, list) else v) for k, v in r.items()})
    (a.out / "assembly_inventory.json").write_text(json.dumps(inv, indent=1))

    # ---- edge clearance, every footprint (35 near ones are the subject)
    edge_rows = []
    for ref, o in fps.items():
        f = nodes[ref]
        padb = bbox_union([(p["x"] - p["w"] / 2, p["y"] - p["h"] / 2, p["x"] + p["w"] / 2, p["y"] + p["h"] / 2) for p in o.pads])
        fabb = fab_bbox(f, o.x, o.y, o.rot, o.layer)
        body = fabb or padb
        crt = o.crt
        env = bbox_union([padb, body])     # pads + body: what actually exists (retention tabs are pads)
        d_body, d_crt, d_pad = edge_dist(body, E), edge_dist(crt, E) if crt else None, edge_dist(padb, E)
        row = {"ref": ref, "mpn": fields[ref].get("MPN"), "footprint": o.libid, "side": "top" if o.layer == "F.Cu" else "bottom",
               "x": round(o.x, 2), "y": round(o.y, 2), "nearest_edge": edge_name(env, E), "body_src": "F.Fab outline" if fabb else "pads",
               "centre_to_edge": round(min(o.x - E[0], o.y - E[1], E[2] - o.x, E[3] - o.y), 3),
               "body_to_edge": round(d_body, 3), "courtyard_to_edge": round(d_crt, 3) if d_crt is not None else None,
               "pad_to_edge": round(d_pad, 3), "envelope_to_edge": round(edge_dist(env, E), 3),
               "overhangs_outline": edge_dist(env, E) < 0 or (d_crt is not None and d_crt < 0)}
        mp = fields[ref].get("MPN") or ""
        for k, v in JST.items():
            if mp.startswith(k):
                row["datasheet_length"] = v["length"]
                row["datasheet_depth"] = v["depth"]
                row["entry"] = v["entry"]
                # datasheet overall footprint envelope vs the pad+fab envelope in the board
                ew, eh = env[2] - env[0], env[3] - env[1]
                row["board_envelope_w_h"] = (round(ew, 2), round(eh, 2))
                row["datasheet_covered"] = bool(max(ew, eh) >= v["length"] - 0.05 and min(ew, eh) >= min(v["depth"], 5.5) - 0.6)
        edge_rows.append(row)
    near = [r for r in edge_rows if r["side"] == "top" and r["ref"] != "U1" and min(r["body_to_edge"], r["courtyard_to_edge"] or 9, r["pad_to_edge"]) < NEAR]
    # RB-02 listed 35 "within 3 mm of the long edges": long edges are north/south (y), board is 97 wide
    near_long = [r for r in near if r["nearest_edge"] in ("north", "south")]
    near_short = [r for r in near if r["nearest_edge"] in ("west", "east")]
    for r in edge_rows:
        # the 2.5 mm T&C note is written for the component BODY; the 0.3 mm Economic note covers traces and components (pads included)
        db, de = r["body_to_edge"], r["envelope_to_edge"]
        r["shift_for_2p5_mm"] = round(max(0.0, BODY_TO_EDGE_TC - db), 3)
        if r["ref"] == "U1":
            r["status"], r["note"] = "N/A", "DNP, hand-soldered module; not placed by JLC. USB-C overhang is intentional (module, not a JLC part)"
        elif r["side"] == "bottom":
            r["status"], r["note"] = "N/A", "bare test pad, no component"
        elif de < COPPER_PART_TO_EDGE_FAQ:
            r["status"], r["note"] = "FAIL", f"{de:.2f} mm: below the 0.3 mm Economic depanelling note"
        elif db >= BODY_TO_EDGE_TC:
            r["status"], r["note"] = "PASS", f"body {db:.2f} mm >= 2.5 mm (T&C DFM item 3); copper/tails {r['pad_to_edge']:.2f} mm >= 0.3 mm (FAQ 14)"
        else:
            r["status"], r["note"] = "UNKNOWN", f"body {db:.2f} mm < 2.5 mm literal T&C note (needs {r['shift_for_2p5_mm']:.2f} mm inward); >= 0.3 mm Economic note; applicability of 2.5 mm to JLC-panelised Economic boards not stated"
    for r in edge_rows:
        r["near3"] = r in near
        # the RB-02 C26 screening list: courtyard within 3 mm of the north/south edges, top side, connectors/TP/U1 excluded
        fo = fps[r["ref"]]
        r["rb02_c26"] = bool(fo.layer == "F.Cu" and fo.crt and r["ref"] != "U1" and not r["ref"].startswith(("J", "TP"))
                             and (fo.crt[1] - E[1] < 3.0 or E[3] - fo.crt[3] < 3.0))
    edge_csv = a.out / "edge_clearance.csv"
    keys = ["ref", "rb02_c26", "mpn", "footprint", "x", "y", "nearest_edge", "centre_to_edge", "body_src", "body_to_edge", "courtyard_to_edge",
            "pad_to_edge", "envelope_to_edge", "shift_for_2p5_mm", "overhangs_outline", "status", "note"]
    with edge_csv.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
        w.writeheader()
        for r in sorted(edge_rows, key=lambda r: r["envelope_to_edge"]):
            if r["near3"] or r["rb02_c26"] or r["ref"] == "U1":
                w.writerow(r)
    (a.out / "edge_clearance.json").write_text(json.dumps(edge_rows, indent=1))

    smt = [r for r in edge_rows if r["side"] == "top" and r["ref"] != "U1"]
    stat = lambda rows: {s: sum(1 for r in rows if r["status"] == s) for s in ("PASS", "UNKNOWN", "FAIL")}
    min_pkg = sorted({r["package"] for r in top})
    # bottom-side paste / pads: any B.Paste pad would make the factory print paste on the back
    bpaste = [(r, p["num"]) for r, o in fps.items() for p in o.pads if "B.Paste" in p["layers"]]
    bcu_pads = sorted({(r, p["num"], p["type"]) for r, o in fps.items() for p in o.pads if "B.Cu" in p["layers"] and p["type"] == "smd"})
    joints = sum(len(fps[r["ref"]].pads) for r in top)
    uniq_ext = sorted({r["mpn"] for r in top if r["jlc_class"] and "Extended" in r["jlc_class"]})
    generic = sorted({(r["value"], r["package"]) for r in top if (r["mpn"] or "").startswith("GENERIC")})
    summary = {
        "board": {"width": round(W, 3), "height": round(H, 3), "copper_layers": len(cu), "stackup_thickness_mm": thick},
        "economic_limits": ECON,
        "assembly": {"footprints": len(inv), "jlc_assembled_top": len(top), "jlc_assembled_bottom": len(bot), "tht_by_jlc": len(tht),
                     "dnp": [r["ref"] for r in inv if r["dnp"]], "bare_pads": sum(1 for r in inv if r["assembly_method"].startswith("bare")),
                     "bottom_footprints_not_excluded_from_pos": bot_nonexcl, "cpl_bottom_rows_with_exclude_dnp": cpl_bottom,
                     "cpl_rows_with_exclude_dnp": len(cpl), "cpl_contains_U1": "U1" in cpl, "packages": min_pkg,
                     "extended_part_lines_expected": uniq_ext, "generic_value_package_lines_basic_unconfirmed": generic,
                     "pads_with_B_Paste": bpaste, "bottom_smd_pads": bcu_pads, "smt_pad_count_top": joints},
        "edge": {"parts_within_3mm_any_edge": len(near), "within_3mm_long_edges": len(near_long), "within_3mm_short_edges": len(near_short),
                 "status_all_top_smt": stat(smt), "status_near3": stat(near),
                 "min_envelope_to_edge": min(r["envelope_to_edge"] for r in smt),
                 "overhang": [r["ref"] for r in edge_rows if r["overhangs_outline"]],
                 "rb02_c26_count": sum(1 for r in edge_rows if r["rb02_c26"]),
                 "rb02_c26_status": stat([r for r in edge_rows if r["rb02_c26"]])},
    }
    (a.out / "economic_audit.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
