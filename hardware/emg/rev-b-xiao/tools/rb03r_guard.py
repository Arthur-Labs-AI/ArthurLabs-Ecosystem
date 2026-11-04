#!/usr/bin/env python3
"""RB-03R verification-integrity guard (fail closed).

    python3 rb03r_guard.py check   --project <dir> [--netlist revb.xml]        compare .kicad_pro/.kicad_dru with the baseline
    python3 rb03r_guard.py canary  --project <dir> --pcb board.kicad_pcb --work <scratch>   run the canary DRC
    python3 rb03r_guard.py write-baseline --project <dir> --netlist revb.xml   (re)create the reviewed baseline
Exit status != 0 on ANY discrepancy.  The baseline (tools/baseline/project_baseline.json) is reviewed text: netclass table, the
pattern list, the net -> class map, the sha256 of the .kicad_dru and the list of rules that must be present and enabled.

Why: pcbnew rewrites .kicad_pro on save and drops the netclasses; KiCad then evaluates every custom rule as "no match" and prints
a clean DRC.  The canary DRC proves, on every run, that each critical rule still FIRES on a synthetic violation and that the
documented exemptions still HOLD, using exactly the project files that the real DRC will use.
"""
import argparse
import copy
import fnmatch
import hashlib
import json
import re
import shutil
import subprocess
import sys
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_sexpr import Q, dump, first, kids, parse  # noqa: E402

HERE = Path(__file__).resolve().parent
BASELINE = HERE / "baseline/project_baseline.json"
CRITICAL_RULES = ["hiz_outer_only_in2", "hiz_outer_only_in1", "hiz_no_vias", "hiz_leakage", "hiz_track_to_foreign_pad",
                  "hiz_pad_to_foreign_track", "spi_to_hiz", "spi_to_buf", "zone_a_no_digital", "no_via_in_smd_pad"]
KEEP_REFS = ("R106", "U501", "R101")      # footprints reused in the canary board (a hi-Z resistor, a TLV9064, a Rs resistor)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read_project(project):
    pro = json.loads((Path(project) / "ARTHUR_EMG_RevB.kicad_pro").read_text())
    dru = (Path(project) / "ARTHUR_EMG_RevB.kicad_dru").read_text()
    return pro, dru


def classes_of(pro):
    ns = pro.get("net_settings", {})
    cls = {c["name"]: {k: c.get(k) for k in ("track_width", "clearance", "via_diameter", "via_drill")} for c in ns.get("classes", [])}
    pats = [(p["netclass"], p["pattern"]) for p in ns.get("netclass_patterns", [])]
    return cls, pats


def class_map(pats, nets):
    out = {}
    for n in nets:
        k = "Default"
        for c, p in pats:
            if fnmatch.fnmatchcase(n, p):
                k = c
                break
        out[n] = k
    return out


def netlist_nets(xml):
    r = ET.parse(xml).getroot()
    nets = set()
    for n in r.findall("./nets/net"):
        nm = n.get("name")
        nets.add(nm.replace("/", "{slash}") if nm.startswith("unconnected-(") else nm)
    return sorted(nets)


def rules_in(dru):
    return re.findall(r'\(rule\s+"([^"]+)"', dru)


DESIGN_RULE_KEYS = ("min_clearance", "min_track_width", "min_via_diameter", "min_through_hole_diameter", "min_copper_edge_clearance", "min_connection",
                    "min_via_annular_width", "min_hole_clearance", "min_hole_to_hole", "solder_mask_to_copper_clearance")
# KiCad defaults these to error; the project must not lower them (absent key = default = error)
MUST_BE_ERROR = ("clearance", "hole_clearance", "physical_hole_clearance", "physical_clearance", "copper_edge_clearance", "shorting_items", "courtyards_overlap",
                 "track_width", "via_diameter", "annular_width", "drill_out_of_range", "items_not_allowed", "tracks_crossing", "unconnected_items",
                 "solder_mask_bridge", "zones_intersect", "invalid_outline", "malformed_courtyard", "through_hole_pad_without_hole", "item_on_disabled_layer",
                 "unresolved_variable", "starved_thermal", "padstack_missing", "clearance_to_other")


def pcb_setup(pcb):
    """manufacturing-relevant board setup read from the .kicad_pcb text: stack-up, mask clearance, tenting, finish, 4 copper layers, outline box"""
    from rb02_sexpr import first, kids, parse
    root = parse(Path(pcb).read_text())
    st = first(root, "setup")
    su = first(st, "stackup")
    layers = []
    for l in kids(su, "layer"):
        th = first(l, "thickness")
        mt = first(l, "material")
        layers.append([str(l[1]), float(th[1]) if th else None, str(mt[1]) if mt else None])
    ten = first(st, "tenting")
    xs, ys = [], []
    for n in root:
        if isinstance(n, list) and n and n[0] in ("gr_line", "gr_arc") and str(first(n, "layer")[1]) == "Edge.Cuts":
            for k in ("start", "end"):
                p = first(n, k)
                xs.append(float(p[1])); ys.append(float(p[2]))
    ncu = sum(1 for n in first(root, "layers")[1:] if isinstance(n, list) and len(n) > 1 and str(n[1]).endswith(".Cu"))
    return {"stackup": layers, "tenting": str(ten), "pad_to_mask_clearance": str(first(st, "pad_to_mask_clearance")),
            "copper_finish": str(first(su, "copper_finish")), "copper_layers": ncu,
            "outline_bbox": [round(min(xs), 2), round(min(ys), 2), round(max(xs), 2), round(max(ys), 2)]}


def write_baseline(project, xml, pcb=None):
    pro, dru = read_project(project)
    cls, pats = classes_of(pro)
    nets = netlist_nets(xml)
    b = {"classes": cls, "patterns": pats, "net_class": class_map(pats, nets), "dru_sha256": hashlib.sha256(dru.encode()).hexdigest(),
         "rules": rules_in(dru), "critical_rules": CRITICAL_RULES,
         "design_rules": {k: pro["board"]["design_settings"]["rules"].get(k) for k in DESIGN_RULE_KEYS},
         "pcb_setup": pcb_setup(pcb) if pcb else None}
    BASELINE.parent.mkdir(exist_ok=True)
    BASELINE.write_text(json.dumps(b, indent=1))
    print("baseline written:", BASELINE, "|", len(cls), "classes,", len(pats), "patterns,", len(b["net_class"]), "nets,", len(b["rules"]), "rules")


def check(project, xml=None, pcb=None):
    fails = []
    b = json.loads(BASELINE.read_text())
    try:
        pro, dru = read_project(project)
    except Exception as e:  # noqa: BLE001
        return [f"cannot read project files: {e}"]
    cls, pats = classes_of(pro)
    if cls != b["classes"]:
        fails.append(f"netclass table differs from baseline ({sorted(set(cls) ^ set(b['classes'])) or 'values changed'})")
    if [list(p) for p in pats] != [list(p) for p in b["patterns"]]:
        fails.append(f"netclass patterns differ from baseline ({len(pats)} vs {len(b['patterns'])})")
    present = rules_in(dru)
    for r in b["critical_rules"]:
        if r not in present:
            fails.append(f"critical rule '{r}' missing from the .kicad_dru")
    if hashlib.sha256(dru.encode()).hexdigest() != b["dru_sha256"]:
        fails.append("ARTHUR_EMG_RevB.kicad_dru differs from the reviewed baseline hash")
    if re.search(r'\(severity\s+ignore\)', dru):
        fails.append("a custom rule carries (severity ignore)")
    sev = pro["board"]["design_settings"].get("rule_severities", {})
    for k in MUST_BE_ERROR:
        if sev.get(k, "error") != "error":
            fails.append(f"rule severity of '{k}' relaxed to '{sev[k]}' in the project")
    if pcb and b.get("pcb_setup"):
        cur = pcb_setup(pcb)
        for k, v in b["pcb_setup"].items():
            if cur.get(k) != v:
                fails.append(f"board setup '{k}' differs from the reviewed baseline")
    for k, v in b["design_rules"].items():
        if pro["board"]["design_settings"]["rules"].get(k) != v:
            fails.append(f"design rule {k} differs ({pro['board']['design_settings']['rules'].get(k)} vs {v})")
    if xml:
        nets = netlist_nets(xml)
        cm = class_map(pats, nets)
        diff = [n for n in nets if cm.get(n) != b["net_class"].get(n)]
        missing = [n for n in b["net_class"] if n not in cm]
        if diff or missing:
            fails.append(f"net -> class assignment differs for {len(diff)} nets (e.g. {diff[:3]}), {len(missing)} baseline nets missing")
        if any(c == "Default" for n, c in cm.items() if n and not n.startswith("unconnected")) and "Default" not in b["net_class"].values():
            fails.append("a net fell back to the Default class")
    return fails


# ----------------------------------------------------------------------------------------------- canary board
def seg(x0, y0, x1, y1, net, layer="F.Cu", w=0.2):
    return ["segment", ["start", x0, y0], ["end", x1, y1], ["width", w], ["layer", Q(layer)], ["net", Q(net)], ["uuid", Q(str(uuid.uuid4()))]]


def via(x, y, net):
    return ["via", ["at", x, y], ["size", 0.6], ["drill", 0.3], ["layers", Q("F.Cu"), Q("B.Cu")], ["net", Q(net)], ["uuid", Q(str(uuid.uuid4()))]]


def rect_zone(name, x0, y0, x1, y1):
    return ["zone", ["net", 0], ["net_name", Q("")], ["layers", Q("F.Cu"), Q("In1.Cu"), Q("In2.Cu"), Q("B.Cu")], ["uuid", Q(str(uuid.uuid4()))],
            ["name", Q(name)], ["hatch", "edge", 0.5], ["connect_pads", ["clearance", 0]], ["min_thickness", 0.25], ["filled_areas_thickness", "no"],
            ["keepout", ["tracks", "allowed"], ["vias", "allowed"], ["pads", "allowed"], ["copperpour", "allowed"], ["footprints", "allowed"]],
            ["placement", ["enabled", "no"], ["sheetname", Q("")]], ["fill", ["thermal_gap", 0.5], ["thermal_bridge_width", 0.5]],
            ["polygon", ["pts", ["xy", x0, y0], ["xy", x1, y0], ["xy", x1, y1], ["xy", x0, y1]]]]


def move_fp(fp, x, y, rot=None):
    fp = copy.deepcopy(fp)
    at = first(fp, "at")
    at[1], at[2] = x, y
    if rot is not None:
        if len(at) > 3:
            at[3] = rot
        else:
            at.append(rot)
    for n in kids(fp, "uuid"):
        n[1] = Q(str(uuid.uuid4()))
    return fp


def canary_cases():
    """(label, expected_rule or None, list of nodes builder) -- coordinates are in a block OUTSIDE the real board (x >= 100)."""
    return None


def build_canary(pcb_path, out_path):
    root = parse(Path(pcb_path).read_text())
    keep = []
    fps = {}
    for n in root:
        if not (isinstance(n, list) and n):
            keep.append(n)
            continue
        if n[0] == "footprint":
            ref = [p for p in kids(n, "property") if str(p[1]) == "Reference"][0][2]
            if str(ref) in KEEP_REFS:
                fps[str(ref)] = n
            continue
        if n[0] in ("segment", "via", "zone", "gr_line", "gr_arc", "gr_text", "gr_rect", "gr_circle", "group"):
            continue
        keep.append(n)
    # a small board outline so DRC has an outline
    keep.append(["gr_rect", ["start", 90, -10], ["end", 260, 60], ["stroke", ["width", 0.1], ["type", "solid"]], ["fill", "no"], ["layer", Q("Edge.Cuts")], ["uuid", Q(str(uuid.uuid4()))]])
    items = []
    cases = []

    def case(label, expect, nodes):
        cases.append((label, expect))
        items.extend(nodes)

    # ---- (1) hi-Z track vs AFE_3V0 track 0.20 mm apart in open space: hiz_leakage must fire
    case("hiz track vs foreign track outside every escape area", "hiz_leakage",
         [seg(100, 0, 105, 0, "/CH1/HIZ_P"), seg(100, 0.4, 105, 0.4, "AFE_3V0")])
    # ---- (2) via on a hi-Z net
    case("via on a hi-Z net", "hiz_no_vias", [via(110, 0, "/CH2/HIZ_P")])
    # ---- (3) hi-Z track on In1 / In2
    case("hi-Z track on In1", "hiz_outer_only_in1", [seg(115, 0, 118, 0, "/CH3/HIZ_N", "In1.Cu")])
    case("hi-Z track on In2", "hiz_outer_only_in2", [seg(120, 0, 123, 0, "/CH3/HIZ_N", "In2.Cu")])
    # ---- (4) SPI vs hi-Z 2 mm, SPI vs buffered 1 mm
    case("SPI track 1.0 mm from a hi-Z track", "spi_to_hiz", [seg(130, 0, 135, 0, "/CH4/HIZ_P"), seg(130, 1.2, 135, 1.2, "/SCLK")])
    case("SPI track 0.5 mm from a buffered track", "spi_to_buf", [seg(140, 0, 145, 0, "/CH1_P"), seg(140, 0.7, 145, 0.7, "/MOSI")])
    # ---- (5) SPI track inside ZONE_A (real ZONE_A area is copied below at its real place)
    case("SPI track inside ZONE_A", "zone_a_no_digital", [seg(10, 10, 14, 10, "/SCLK")])
    # ---- (6) real footprints moved into the canary block: R106 (pad 1 VCM, pad 2 hi-Z), U501 (TLV9064)
    if "R106" in fps:
        r = move_fp(fps["R106"], 150, 0)
        # absolute pad positions are derived by KiCad; the canary tracks are placed relative to the footprint origin
        case("foreign-net track beside a hi-Z pad of a non-TLV component", "hiz_pad_to_foreign_track", [])
        items.append(r)
    return root, keep, items, cases, fps


def _prep_work(project, work):
    work = Path(work)
    shutil.rmtree(work, ignore_errors=True)
    shutil.copytree(project, work, ignore=shutil.ignore_patterns("~*", ".history", "*.kicad_pcb", "fp-libs"))
    shutil.copytree(Path(project) / "fp-libs", work / "fp-libs")
    return work


def _split_board(pcb):
    root = parse(Path(pcb).read_text())
    areas, fps, keep = {}, {}, []
    for n in root:
        if not (isinstance(n, list) and n):
            keep.append(n)
            continue
        if n[0] == "footprint":
            ref = str([p for p in kids(n, "property") if str(p[1]) == "Reference"][0][2])
            fps[ref] = n
            if ref not in ("R106", "U501"):
                # every other footprint is parked far away so that all nets stay defined (KiCad re-nets items with unknown nets)
                keep.append(move_fp(n, float(first(n, "at")[1]) + 400.0, float(first(n, "at")[2]), None))
            continue
        if n[0] == "zone":
            nm = first(n, "name")
            nm = str(nm[1]) if nm else ""
            if nm == "ZONE_A" or nm.startswith("HIZ_ESC_U501"):
                areas[nm] = n
            continue
        if n[0] in ("segment", "via", "gr_line", "gr_arc", "gr_text", "gr_rect", "gr_circle", "group"):
            continue
        keep.append(n)
    return root, keep, areas, fps


def _drc(work, root, keep, items):
    root[:] = keep + items
    pcb_out = work / "ARTHUR_EMG_RevB.kicad_pcb"
    pcb_out.write_text(dump(root) + "\n")
    subprocess.run(["kicad-cli", "pcb", "drc", "--severity-all", "--format", "json", "-o", str(work / "drc.json"), str(pcb_out)], capture_output=True, cwd=work)
    rep = json.loads((work / "drc.json").read_text())
    return " ".join(v["description"] for v in rep["violations"]), len(rep["violations"])


def _shift_area(node, dx, dy):
    n = copy.deepcopy(node)
    for xy in kids(first(n, "polygon")[1], "xy") if False else kids(first(first(n, "polygon"), "pts"), "xy"):
        xy[1], xy[2] = float(xy[1]) + dx, float(xy[2]) + dy
    first(n, "uuid")[1] = Q(str(uuid.uuid4()))
    return n


def run_canary(project, pcb, work):
    """negative canaries (each critical rule MUST fire) + positive controls (documented exemptions MUST hold), in two synthetic
    boards derived from `pcb`, evaluated with the project files in `project` exactly as the real DRC will see them"""
    from rb02_check_placement import load as load_pcb
    fails = []
    report = {"negative": [], "positive": []}
    work = Path(work)
    # ------------------------------------------------ negative canaries
    w1 = _prep_work(project, work / "neg")
    root, keep, areas, fps = _split_board(pcb)
    items, expect = [], []

    def case(label, rule, nodes):
        expect.append((label, rule))
        items.extend(nodes)
    case("hi-Z track vs foreign track outside every escape area", "hiz_leakage", [seg(100, 0, 105, 0, "/CH1/HIZ_P"), seg(100, 0.45, 105, 0.45, "AFE_3V0")])
    case("via on a hi-Z net", "hiz_no_vias", [via(110, 0, "/CH2/HIZ_P")])
    case("hi-Z track on In1", "hiz_outer_only_in1", [seg(115, 0, 118, 0, "/CH3/HIZ_N", "In1.Cu")])
    case("hi-Z track on In2", "hiz_outer_only_in2", [seg(120, 0, 123, 0, "/CH3/HIZ_N", "In2.Cu")])
    case("SPI track 1.0 mm from a hi-Z track", "spi_to_hiz", [seg(130, 0, 135, 0, "/CH4/HIZ_P"), seg(130, 1.2, 135, 1.2, "/SCLK")])
    case("SPI track 0.5 mm from a buffered track", "spi_to_buf", [seg(140, 0, 145, 0, "/CH1_P"), seg(140, 0.7, 145, 0.7, "/MOSI")])
    if "ZONE_A" in areas:
        za = areas["ZONE_A"]
        pts = [(float(p[1]), float(p[2])) for p in first(first(za, "polygon"), "pts")[1:] if isinstance(p, list)]
        x0, y0 = min(p[0] for p in pts) + 8, min(p[1] for p in pts) + 8
        case("SPI track inside ZONE_A", "zone_a_no_digital", [seg(x0, y0, x0 + 4, y0, "/SCLK")])
        items.append(copy.deepcopy(za))
    if "R106" in fps:
        from rb02_check_placement import load as _load
        fa, _E, _z, _r = _load(pcb)
        r6 = fa["R106"]
        dxr, dyr = 150 - r6.x, 0 - r6.y
        items.append(move_fp(fps["R106"], 150, 0, None))
        pd = {p["num"]: (p["x"] + dxr, p["y"] + dyr, p["w"], p["h"], p["net"]) for p in r6.pads}
        hz_n = [n for n, v in pd.items() if "HIZ" in v[4]][0]
        fo_n = [n for n in pd if n != hz_n][0]
        hx_, hy_, hw_, hh_, _n = pd[hz_n]
        fx_, fy_, fw_, fh_, fnet = pd[fo_n]
        # unit vector from the foreign pad to the hi-Z pad: tracks are put on the OUTER side of the pad they are tested against
        ux, uy = (hx_ - fx_), (hy_ - fy_)
        ln = (ux * ux + uy * uy) ** 0.5
        ux, uy = ux / ln, uy / ln
        # seeded track beside the hi-Z pad: 0.25 mm edge gap on the far side (track half width 0.1)
        ox = hx_ + ux * (abs(ux) * hw_ / 2 + abs(uy) * hh_ / 2 + 0.25 + 0.1)
        oy = hy_ + uy * (abs(ux) * hw_ / 2 + abs(uy) * hh_ / 2 + 0.25 + 0.1)
        px_, py_ = (-uy, ux)
        case("foreign track 0.25 mm from a hi-Z pad of a non-TLV component", "hiz_pad_to_foreign_track",
             [seg(ox - px_ * 0.6, oy - py_ * 0.6, ox + px_ * 0.6, oy + py_ * 0.6, "AFE_3V0")])
        qx = fx_ - ux * (abs(ux) * fw_ / 2 + abs(uy) * fh_ / 2 + 0.25 + 0.1)
        qy = fy_ - uy * (abs(ux) * fw_ / 2 + abs(uy) * fh_ / 2 + 0.25 + 0.1)
        case("hi-Z track 0.25 mm from the foreign pad of a non-TLV component", "hiz_track_to_foreign_pad",
             [seg(qx - px_ * 0.6, qy - py_ * 0.6, qx + px_ * 0.6, qy + py_ * 0.6, "/CH1/HIZ_P")])

    hits, nv = _drc(w1, root, keep, items)
    for label, rule in expect:
        ok = f"rule '{rule}'" in hits
        report["negative"].append({"case": label, "rule": rule, "fired": ok})
        if not ok:
            fails.append(f"canary '{label}': rule {rule} did NOT fire")
    # ------------------------------------------------ positive controls and the escape-area boundary (U501 moved to x=200)
    w2 = _prep_work(project, work / "pos")
    root, keep, areas, fps = _split_board(pcb)
    fps_all, E, z, _ = load_pcb(pcb)
    u = fps_all["U501"]
    dx, dy = 200 - u.x, 0 - u.y
    items = [move_fp(fps["U501"], 200, 0, None)]
    # the footprint keeps its rotation; areas follow it
    for nm, node in areas.items():
        if nm.startswith("HIZ_ESC_U501"):
            items.append(_shift_area(node, dx, dy))
    pads = {p["num"]: (p["x"] + dx, p["y"] + dy) for p in u.pads}
    hz = [n for n, p in pads.items() if True]
    # pick the right-column hi-Z pad and its neighbour: use the netlist names stored in the pad nets of the copied footprint
    pad_nets = {p["num"]: p["net"] for p in u.pads}
    hiz_pads = [n for n, nt in pad_nets.items() if "HIZ" in nt]
    afe_pads = [n for n, nt in pad_nets.items() if nt == "AFE_3V0"]
    right = [n for n in hiz_pads if pads[n][0] > 200]
    hp = right[0]
    hx, hy = pads[hp]
    ap_ = min((n for n in afe_pads if pads[n][0] > 200), key=lambda n: abs(pads[n][1] - hy))
    ax, ay = pads[ap_]
    # P1: foreign track fully inside the pin-column area, 0.1 mm from the hi-Z pad  -> hiz_pad_to_foreign_track must NOT fire
    items.append(seg(hx + 0.6, hy - 0.35, hx + 1.0, hy - 0.35, "AFE_3V0"))
    # P2: hi-Z escape track and the neighbouring AFE_3V0 escape track, both inside the area, 0.45 mm centre distance -> hiz_leakage must NOT fire
    items.append(seg(hx, hy, hx + 0.7, hy, "/CH1/HIZ_P"))
    sgn = 1.0 if ay > hy else -1.0
    ay2 = hy + sgn * 0.40
    items.append(seg(ax, ay2, ax + 0.7, ay2, "AFE_3V0"))
    # a via centred in an SMD pad of its own net must be flagged (the RB-02 hole_clearance rule could not see this case)
    items.append(via(pads[afe_pads[0]][0] if False else hx, hy, pad_nets[hp]))
    hits_p, _ = _drc(w2, root, keep, items)
    okv = "rule 'no_via_in_smd_pad'" in hits_p
    report["negative"].append({"case": "via centred in an SMD pad of its own net", "rule": "no_via_in_smd_pad", "fired": okv})
    if not okv:
        fails.append("canary 'via inside its own SMD pad': rule no_via_in_smd_pad did NOT fire")
    for rule in ("hiz_leakage", "hiz_pad_to_foreign_track", "hiz_track_to_foreign_pad"):
        ok = f"rule '{rule}'" not in hits_p
        report["positive"].append({"case": "TLV9064 pin-column exemption", "rule": rule, "silent": ok})
        if not ok:
            fails.append(f"positive control: rule {rule} fired inside the documented TLV9064 pin-column exemption")
    # N2: same geometry but the foreign track leaves the area (long) -> must fire
    root, keep, areas, fps = _split_board(pcb)
    items2 = [move_fp(fps["U501"], 200, 0, None)] + [_shift_area(n, dx, dy) for nm, n in areas.items() if nm.startswith("HIZ_ESC_U501")]
    items2 += [seg(hx, hy, hx + 0.7, hy, "/CH1/HIZ_P"), seg(ax, ay2, ax + 6.0, ay2, "AFE_3V0")]
    w3 = _prep_work(project, work / "neg2")
    hits_n2, _ = _drc(w3, root, keep, items2)
    ok = "rule 'hiz_leakage'" in hits_n2
    report["negative"].append({"case": "foreign track leaving the pin-column area beside a hi-Z track", "rule": "hiz_leakage", "fired": ok})
    if not ok:
        fails.append("canary 'foreign track leaves the TLV9064 area': hiz_leakage did NOT fire")
    return fails, report


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=("check", "canary", "write-baseline"))
    ap.add_argument("--project", required=True)
    ap.add_argument("--netlist")
    ap.add_argument("--pcb")
    ap.add_argument("--work")
    a = ap.parse_args()
    if a.cmd == "write-baseline":
        write_baseline(a.project, a.netlist, a.pcb)
        return 0
    if a.cmd == "check":
        f = check(a.project, a.netlist, a.pcb)
    else:
        f, rep = run_canary(a.project, a.pcb, a.work)
        print(json.dumps(rep))
    for x in f:
        print("GUARD FAIL:", x)
    print("GUARD", "PASS" if not f else "FAIL")
    return 1 if f else 0


if __name__ == "__main__":
    sys.exit(main())
