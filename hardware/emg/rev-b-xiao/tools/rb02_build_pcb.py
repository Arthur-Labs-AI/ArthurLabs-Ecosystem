#!/usr/bin/env python3
"""RB-02: build ARTHUR_EMG_RevB.kicad_pcb (placement only, no tracks, no vias, no fill) from
   * a fresh KiCad XML netlist of the frozen schematic (components, footprints, pad nets, sheet paths),
   * the project footprint libraries (fp-libs/*.pretty),
   * the placement table rb02_placement.py.

    kicad-cli sch export netlist --format kicadxml -o revb.xml ARTHUR_EMG_RevB.kicad_sch
    python3 rb02_build_pcb.py --netlist revb.xml --out ../kicad/ARTHUR_EMG_RevB/ARTHUR_EMG_RevB.kicad_pcb

The generator is a build tool, not an oracle: electrical correctness of the board is checked by KiCad DRC with
--schematic-parity and by rb02_check_placement.py.
"""
import argparse
import math
import sys
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rb02_placement as PL  # noqa: E402
from rb02_sexpr import Q, dump, first, kids, parse  # noqa: E402

HERE = Path(__file__).resolve().parent
FPLIBS = HERE.parent / "kicad/ARTHUR_EMG_RevB/fp-libs"

LAYER_SWAP = {"F.Cu": "B.Cu", "B.Cu": "F.Cu", "F.Mask": "B.Mask", "B.Mask": "F.Mask", "F.Paste": "B.Paste", "B.Paste": "F.Paste",
              "F.SilkS": "B.SilkS", "B.SilkS": "F.SilkS", "F.Fab": "B.Fab", "B.Fab": "F.Fab", "F.CrtYd": "B.CrtYd", "B.CrtYd": "F.CrtYd",
              "F.Adhes": "B.Adhes", "B.Adhes": "F.Adhes"}


def uid():
    return Q(str(uuid.uuid4()))


def num(x):
    return float(x)


def load_fp(libid):
    lib, name = libid.split(":", 1)
    return parse((FPLIBS / f"{lib}.pretty" / f"{name}.kicad_mod").read_text())


def flip_y(node):
    """mirror local y (top/bottom flip) of positions inside a footprint item"""
    if not isinstance(node, list) or not node:
        return node
    head = node[0]
    if head == "effects" and not any(isinstance(c, list) and c and c[0] == "justify" for c in node):
        return [*node, ["justify", "mirror"]]
    if head in ("start", "end", "mid", "center", "at", "xy") and len(node) >= 3:
        out = [*node]
        out[2] = -float(node[2])
        if head == "at" and len(node) > 3:
            out[3] = (-float(node[3])) % 360
        return out
    return [flip_y(c) if isinstance(c, list) else c for c in node]


def swap_layers(node):
    """mirror layer names (and y) of a footprint node for back-side placement"""
    if isinstance(node, list):
        out = []
        for i, c in enumerate(node):
            out.append(swap_layers(c))
        return out
    if isinstance(node, Q) and str(node) in LAYER_SWAP:
        return Q(LAYER_SWAP[str(node)])
    if isinstance(node, Q) and str(node) == "*.Cu":
        return node
    return node


def make_instance(comp, libid, pos, nets, sheetpath, tstamp, sheetname, sheetfile, flags, zones_out=None):
    fp = load_fp(libid)
    x, y, rot, side = pos
    rest = []
    descr = first(fp, "descr")
    tags = first(fp, "tags")
    attr_src = first(fp, "attr")
    attrs = list(attr_src[1:]) if attr_src else []
    for f in flags:
        if f not in attrs:
            attrs.append(f)
    props = {p[1]: p[2] for p in kids(fp, "property")}
    ref, value = comp["ref"], comp["value"]
    layer = "F.Cu" if side == "F" else "B.Cu"
    node = ["footprint", Q(libid), ["layer", Q(layer)], ["uuid", uid()], ["at", x, y] + ([float(rot)] if rot % 360 else [])]
    if descr:
        node.append(descr)
    if tags:
        node.append(tags)
    tl = "F" if side == "F" else "B"
    def prop(name, val, ly, hide=False, dy=0.0):
        eff = ["effects", ["font", ["size", 0.6, 0.6], ["thickness", 0.09]]] + ([["justify", "mirror"]] if side == "B" else [])
        p = ["property", Q(name), Q(val), ["at", 0.0, dy, 0.0], ["layer", Q(ly)]]
        if hide:
            p.append(["hide", "yes"])
        p += [["uuid", uid()], eff]
        return p
    node.append(prop("Reference", ref, f"{tl}.Fab", dy=-1.6))
    node.append(prop("Value", value, f"{tl}.Fab", True, dy=1.6))
    node.append(prop("Datasheet", comp.get("datasheet", ""), f"{tl}.Fab", True))
    node.append(prop("Description", comp.get("description", ""), f"{tl}.Fab", True))
    for k_, v_ in comp.get("fields", {}).items():
        if k_ in ("Footprint", "Datasheet", "Description", "Value", "Reference"):
            continue
        node.append(prop(k_, v_, f"{tl}.Fab", True))
    node.append(["path", Q(sheetpath + tstamp)])
    node.append(["sheetname", Q(sheetname)])
    node.append(["sheetfile", Q(sheetfile)])
    node.append(["attr"] + attrs)
    for c in fp:
        if not isinstance(c, list) or not c:
            continue
        k = c[0]
        if k in ("version", "generator", "generator_version", "layer", "descr", "tags", "property", "attr", "uuid", "at",
                 "embedded_fonts", "model", "path", "sheetname", "sheetfile"):
            continue
        c = flip_y(swap_layers(c)) if side == "B" else c
        if k == "pad":
            c = [*c]
            num_ = c[1]
            at = first(c, "at")
            ang = (num(at[3]) if len(at) > 3 else 0.0) + rot
            ang = ang % 360
            idx = c.index(at)
            c[idx] = ["at", at[1], at[2]] + ([ang] if abs(ang) > 1e-9 else [])
            # drop previous nets, add ours
            c = [i for i in c if not (isinstance(i, list) and i and i[0] in ("net", "uuid"))]
            net = nets.get((ref, str(num_)))
            if net:
                c.append(["net", Q(net)])
            c.append(["uuid", uid()])
        elif k in ("fp_text",):
            at = first(c, "at")
            c = [*c]
            c[c.index(at)] = ["at", at[1], at[2], ((num(at[3]) if len(at) > 3 else 0.0) + rot) % 360]
        elif k == "zone":
            # zones are stored in ABSOLUTE board coordinates inside a board footprint (verified with DRC vias)
            th = math.radians(rot)
            def _abs(p):
                lx, ly = num(p[1]), num(p[2])
                return ["xy", x + lx * math.cos(th) + ly * math.sin(th), y - lx * math.sin(th) + ly * math.cos(th)]
            c = [*c]
            poly = first(c, "polygon")
            pi = c.index(poly)
            pts = first(poly, "pts")
            c[pi] = ["polygon", ["pts"] + [_abs(p) for p in kids(pts, "xy")]]
            c = [i for i in c if not (isinstance(i, list) and i and i[0] == "uuid")] + [["uuid", uid()]]
            if zones_out is not None:
                # KiCad's DRC ignores keep-outs that sit inside a DNP footprint, so the rule areas are emitted at board level
                zones_out.append(c)
                continue
        node.append(c)
    node.append(["embedded_fonts", "no"])
    return node


def layers_block():
    L = [(0, "F.Cu", "signal"), (4, "In1.Cu", "signal"), (6, "In2.Cu", "signal"), (2, "B.Cu", "signal"),
         (9, "F.Adhes", "user", "F.Adhesive"), (11, "B.Adhes", "user", "B.Adhesive"), (13, "F.Paste", "user"), (15, "B.Paste", "user"),
         (5, "F.SilkS", "user", "F.Silkscreen"), (7, "B.SilkS", "user", "B.Silkscreen"), (1, "F.Mask", "user"), (3, "B.Mask", "user"),
         (17, "Dwgs.User", "user", "User.Drawings"), (19, "Cmts.User", "user", "User.Comments"), (21, "Eco1.User", "user", "User.Eco1"),
         (23, "Eco2.User", "user", "User.Eco2"), (25, "Edge.Cuts", "user"), (27, "Margin", "user"), (31, "F.CrtYd", "user", "F.Courtyard"),
         (29, "B.CrtYd", "user", "B.Courtyard"), (35, "F.Fab", "user"), (33, "B.Fab", "user")]
    out = ["layers"]
    for t in L:
        out.append([t[0], Q(t[1]), t[2]] + ([Q(t[3])] if len(t) > 3 else []))
    return out


def setup_block():
    def lay(name, typ, thick=None, mat=None, eps=None, tan=None, color=None):
        n = ["layer", Q(name), ["type", Q(typ)]]
        if color:
            n.append(["color", Q(color)])
        if thick is not None:
            n.append(["thickness", thick])
        if mat:
            n.append(["material", Q(mat)])
        if eps is not None:
            n += [["epsilon_r", eps], ["loss_tangent", tan]]
        return n
    stack = ["stackup",
             lay("F.SilkS", "Top Silk Screen"), lay("F.Paste", "Top Solder Paste"),
             lay("F.Mask", "Top Solder Mask", 0.01, "Solder Mask", 3.8, 0.02),
             lay("F.Cu", "copper", 0.035), lay("dielectric 1", "prepreg", 0.2104, "7628", 4.4, 0.02),
             lay("In1.Cu", "copper", 0.0152), lay("dielectric 2", "core", 1.065, "FR4", 4.6, 0.02),
             lay("In2.Cu", "copper", 0.0152), lay("dielectric 3", "prepreg", 0.2104, "7628", 4.4, 0.02),
             lay("B.Cu", "copper", 0.035),
             lay("B.Mask", "Bottom Solder Mask", 0.01, "Solder Mask", 3.8, 0.02),
             lay("B.Paste", "Bottom Solder Paste"), lay("B.SilkS", "Bottom Silk Screen"),
             ["copper_finish", Q("HASL(with lead)")], ["dielectric_constraints", "no"]]
    return ["setup", stack, ["pad_to_mask_clearance", 0], ["allow_soldermask_bridges_in_footprints", "no"],
            ["tenting", ["front", "yes"], ["back", "yes"]],
            ["covering", ["front", "no"], ["back", "no"]], ["plugging", ["front", "no"], ["back", "no"]],
            ["capping", "no"], ["filling", "no"],
            ["pcbplotparams", ["layerselection", "0x00000000_00000000_55555555_5755f5ff"], ["plot_on_all_layers_selection", "0x00000000_00000000_00000000_00000000"],
             ["disableapertmacros", "no"], ["usegerberextensions", "no"], ["usegerberattributes", "yes"], ["usegerberadvancedattributes", "yes"],
             ["creategerberjobfile", "yes"], ["dashed_line_dash_ratio", 12.0], ["dashed_line_gap_ratio", 3.0], ["svgprecision", 4],
             ["plotframeref", "no"], ["mode", 1], ["useauxorigin", "no"], ["hpglpennumber", 1], ["hpglpenspeed", 20], ["hpglpendiameter", 15.0],
             ["pdf_front_fp_property_popups", "yes"], ["pdf_back_fp_property_popups", "yes"], ["pdf_metadata", "yes"], ["pdf_single_document", "no"],
             ["dxfpolygonmode", "yes"], ["dxfimperialunits", "yes"], ["dxfusepcbnewfont", "yes"], ["psnegative", "no"], ["psa4output", "no"],
             ["plot_black_and_white", "yes"], ["sketchpadsonfab", "no"], ["plotpadnumbers", "no"], ["hidednponfab", "no"], ["sketchdnponfab", "yes"],
             ["crossoutdnponfab", "yes"], ["subtractmaskfromsilk", "no"], ["outputformat", 1], ["mirror", "no"], ["drillshape", 1],
             ["scaleselection", 1], ["outputdirectory", Q("")]]]


def gr_line(x0, y0, x1, y1, layer, w=0.1, typ=None):
    return ["gr_line", ["start", x0, y0], ["end", x1, y1], ["stroke", ["width", w], ["type", typ or "solid"]], ["layer", Q(layer)], ["uuid", uid()]]


def gr_arc(sx, sy, mx, my, ex, ey, layer, w=0.1):
    return ["gr_arc", ["start", sx, sy], ["mid", mx, my], ["end", ex, ey], ["stroke", ["width", w], ["type", "solid"]], ["layer", Q(layer)], ["uuid", uid()]]


def gr_text(s, x, y, layer, size=1.0, rot=0.0):
    return ["gr_text", Q(s), ["at", x, y, rot], ["layer", Q(layer)], ["uuid", uid()],
            ["effects", ["font", ["size", size, size], ["thickness", 0.15]]]]


def zone(net, layer, pts, name, prio=0):
    return ["zone", ["net", Q(net)], ["net_name", Q(net)], ["layer", Q(layer)], ["uuid", uid()], ["name", Q(name)],
            ["hatch", "edge", 0.5], ["priority", prio], ["connect_pads", ["clearance", 0.2]], ["min_thickness", 0.2],
            ["filled_areas_thickness", "no"], ["fill", ["thermal_gap", 0.3], ["thermal_bridge_width", 0.3]],
            ["polygon", ["pts"] + [["xy", a, b] for a, b in pts]]]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--netlist", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    root = ET.parse(a.netlist).getroot()
    nets = {}
    for n in root.findall("./nets/net"):
        for node in n.findall("node"):
            nm = n.get("name")
            if nm.startswith("unconnected-("):
                nm = nm.replace("/", "{slash}")
            nets[(node.get("ref"), node.get("pin"))] = nm
    board = ["kicad_pcb", ["version", 20260206], ["generator", Q("pcbnew")], ["generator_version", Q("10.0")],
             ["general", ["thickness", 1.6], ["legacy_teardrops", "no"]], ["paper", Q("A4")],
             ["title_block", ["title", Q("A.R.T.H.U.R EMG Rev B - RB-02 placement")], ["date", Q("2026-10-10")], ["rev", Q("B / RB-02")],
              ["company", Q("A.R.T.H.U.R EMG")], ["comment", 1, Q("PLACEMENT ONLY: no routing, no vias, no fill, not for manufacture")]],
             layers_block(), setup_block()]
    missing = []
    extra_zones = []
    for c in root.findall("./components/comp"):
        ref = c.get("ref")
        libid = c.findtext("footprint")
        props = {p.get("name"): p.get("value") for p in c.findall("property")}
        fields = {f.get("name"): (f.text or "") for f in c.findall("./fields/field")}
        flags = []
        if "dnp" in props:
            flags.append("dnp")
        if "exclude_from_bom" in props:
            flags.append("exclude_from_bom")
        if "exclude_from_pos_files" in props:
            flags.append("exclude_from_pos_files")
        sp = c.find("sheetpath")
        spath = sp.get("tstamps") if sp is not None else "/"
        ts = c.findtext("tstamps") or ""
        comp = {"ref": ref, "value": c.findtext("value", ""), "datasheet": c.findtext("datasheet", ""), "description": c.findtext("description", ""), "fields": fields}
        if ref not in PL.place:
            missing.append(ref)
            continue
        board.append(make_instance(comp, libid, PL.place[ref] if False else _board_pos(PL.place[ref]), nets, spath, ts,
                                   props.get("Sheetname", ""), props.get("Sheetfile", ""), flags, extra_zones))
    board.extend(extra_zones)
    # ---- outline with rounded corners
    W, H, r = PL.BOARD_W, PL.BOARD_H, PL.CORNER_R
    k = r * (1 - math.sqrt(0.5))
    for (x0, y0, x1, y1) in ((r, 0, W - r, 0), (W, r, W, H - r), (W - r, H, r, H), (0, H - r, 0, r)):
        board.append(gr_line(x0, y0, x1, y1, "Edge.Cuts", 0.1))
    board.append(gr_arc(0, r, k, k, r, 0, "Edge.Cuts"))
    board.append(gr_arc(W - r, 0, W - k, k, W, r, "Edge.Cuts"))
    board.append(gr_arc(W, H - r, W - k, H - k, W - r, H, "Edge.Cuts"))
    board.append(gr_arc(r, H, k, H - k, 0, H - r, "Edge.Cuts"))
    # ---- zone boundaries and notes (user layers)
    dx = PL.DX
    for xz, label in ((39.0 + dx, "A | B"), (48.0 + dx, "B | C"), (53.7 + dx, "C | D")):
        board.append(gr_line(xz, 0, xz, H, "Dwgs.User", 0.1, "dash"))
        board.append(gr_text(label, xz, 1.0, "Cmts.User", 0.8))
    board.append(gr_text("ZONE A: EMG inputs / analog front end", (0 + 39 + dx) / 2, H - 0.5, "Cmts.User", 0.9))
    board.append(gr_text("ZONE D: XIAO / battery / RF", 53.7 + dx + 8, 0.6, "Cmts.User", 0.9))
    # ---- ZONE_A rule area (used by the zone_a_no_digital custom rule): x' < 39 -> board x < 39 + DX, all copper layers
    za = (39.0 + dx, H)
    board.append(["zone", ["net", 0], ["net_name", Q("")], ["layers", Q("F.Cu"), Q("In1.Cu"), Q("In2.Cu"), Q("B.Cu")], ["uuid", uid()], ["name", Q("ZONE_A")],
                  ["hatch", "edge", 0.5], ["connect_pads", ["clearance", 0]], ["min_thickness", 0.25], ["filled_areas_thickness", "no"],
                  ["keepout", ["tracks", "allowed"], ["vias", "allowed"], ["pads", "allowed"], ["copperpour", "allowed"], ["footprints", "allowed"]],
                  ["placement", ["enabled", "no"], ["sheetname", Q("")]], ["fill", ["thermal_gap", 0.5], ["thermal_bridge_width", 0.5]],
                  ["polygon", ["pts", ["xy", 0.0, 0.0], ["xy", za[0], 0.0], ["xy", za[0], za[1]], ["xy", 0.0, za[1]]]]])
    # ---- copper zone outlines (unfilled): In1 GND everywhere, In2 GND under zones A/B only (RB-00.6 §5 of the power doc)
    m = 0.3
    board.append(zone("GND", "In1.Cu", [(m, m), (W - m, m), (W - m, H - m), (m, H - m)], "In1 GND plane", 0))
    board.append(zone("GND", "In2.Cu", [(m, m), (48.0 + dx, m), (48.0 + dx, H - m), (m, H - m)], "In2 GND zones A/B", 0))
    a.out.write_text(dump(board) + "\n")
    print(f"wrote {a.out}: {len(root.findall('./components/comp')) - len(missing)} footprints placed, missing placement: {missing}")
    return 1 if missing else 0


def _board_pos(p):
    x, y, rot, side = p
    return (x + PL.DX, y, rot, side)


if __name__ == "__main__":
    sys.exit(main())
