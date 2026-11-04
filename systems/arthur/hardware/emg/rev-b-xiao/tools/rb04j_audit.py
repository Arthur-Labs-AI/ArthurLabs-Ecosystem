#!/usr/bin/env python3
"""RB-04J: independent read-only recalculation of the BAT+ post interface from the canonical files (PCB, library footprint, QUOTE-ONLY Gerber/drill zip,
netlist, Seeed module extract).  Writes evidence/rb04j/audit.json.   python3 rb04j_audit.py"""
import json, math, sys, zipfile, tempfile, subprocess, shutil, xml.etree.ElementTree as ET
from pathlib import Path
R = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_sexpr import parse, kids, first
from rb04_gerber import parse_gerber, excellon
PCB = R / "kicad/ARTHUR_EMG_RevB/ARTHUR_EMG_RevB.kicad_pcb"
LIB = R / "kicad/ARTHUR_EMG_RevB/fp-libs/ARTHUR.pretty/XIAO_ESP32S3_HANDSOLDER.kicad_mod"
ZIP = R / "quote-package/staging_R1b_QUOTE_ONLY/ARTHUR_EMG_RevB_R1b_QUOTE-ONLY_Gerbers.zip"
out = {}
t = parse(PCB.read_text()); lib = parse(LIB.read_text())
# ---- 1. pad 23 in the three sources
def pad23(fp):
    r = {}
    for p in kids(fp, "pad"):
        if str(p[1]) != "23": continue
        k = str(p[2])
        r[k] = dict(size=float(first(p, "size")[1]), drill=float(first(p, "drill")[1]) if first(p, "drill") else None,
                    mask_margin=float(first(p, "solder_mask_margin")[1]) if first(p, "solder_mask_margin") else 0.0,
                    layers=[str(x) for x in first(p, "layers")[1:]], net=str(first(p, "net")[1]) if first(p, "net") else None, at=[float(first(p, "at")[1]), float(first(p, "at")[2])])
    return r
u1 = [f for f in kids(t, "footprint") if any(str(p[1]) == "Reference" and str(p[2]) == "U1" for p in kids(f, "property"))][0]
at = first(u1, "at"); FX, FY = float(at[1]), float(at[2])
pcb23 = pad23(u1); lib23 = pad23(lib)
for r_ in (pcb23, lib23):
    for k in r_: r_[k]["opening"] = round(r_[k]["size"] + 2 * r_[k]["mask_margin"], 3)
out["pad23_pcb"] = pcb23; out["pad23_library"] = lib23
out["pad23_abs"] = [FX - pcb23["thru_hole"]["at"][0], FY - pcb23["thru_hole"]["at"][1]]
with tempfile.TemporaryDirectory() as d:
    zipfile.ZipFile(ZIP).extractall(d)
    G = {}
    for f in Path(d).iterdir():
        if f.suffix == ".drl": holes, pts = excellon(f); G["drill"] = dict(holes=holes, ph=pts.get(1.9, []), tool_attr=[l for l in f.read_text().splitlines() if "ComponentDrill" in l or "ViaDrill" in l])
        else:
            g = parse_gerber(f); hits = [(g["apertures"][c][0], g["apertures"][c][1][0], g["apertures"][c][2]) for pos, c, pol in g["flashes"] if abs(pos[0] - out["pad23_abs"][0]) < 0.002 and abs(pos[1] + out["pad23_abs"][1]) < 0.002]
            if hits: G[f.name.split("-", 1)[-1]] = hits
out["gerber_at_post"] = G
# ---- 2. net connectivity
nl = Path(tempfile.mkdtemp()); shutil.copytree(R / "kicad/ARTHUR_EMG_RevB", nl / "p", ignore=shutil.ignore_patterns(".history", "*.lck"))
subprocess.run(["chmod", "-R", "u+w", str(nl / "p")])
subprocess.run(["kicad-cli", "sch", "export", "netlist", "--format", "kicadxml", "-o", str(nl / "n.xml"), "ARTHUR_EMG_RevB.kicad_sch"], cwd=nl / "p", capture_output=True)
root = ET.parse(nl / "n.xml").getroot()
nets = {n.get("name"): [(x.get("ref"), x.get("pin")) for x in n.iter("node")] for n in root.iter("net")}
out["VBAT_nodes"] = nets["VBAT"]
out["U1_pin23_nets"] = [n for n, nodes in nets.items() if ("U1", "23") in nodes]
out["nets_containing_U1_pins_1_14_5V_3V3_GND"] = {p: [n for n, nodes in nets.items() if ("U1", p) in nodes] for p in ("12", "13", "14")}
# VBAT copper attached to the land
segs = [dict(layer=str(first(s, "layer")[1]), x0=float(first(s, "start")[1]), y0=float(first(s, "start")[2]), x1=float(first(s, "end")[1]), y1=float(first(s, "end")[2]), w=float(first(s, "width")[1]), net=str(first(s, "net")[1])) for s in kids(t, "segment")]
vias = [dict(x=float(first(v, "at")[1]), y=float(first(v, "at")[2]), r=float(first(v, "size")[1]) / 2, net=str(first(v, "net")[1])) for v in kids(t, "via")]
px, py = out["pad23_abs"]
def seg_pt(s, x, y):
    dx, dy = s["x1"] - s["x0"], s["y1"] - s["y0"]; L = dx * dx + dy * dy
    tt = 0 if L == 0 else max(0, min(1, ((x - s["x0"]) * dx + (y - s["y0"]) * dy) / L))
    return math.hypot(s["x0"] + tt * dx - x, s["y0"] + tt * dy - y)
out["VBAT_copper_touching_land"] = [f"{s['layer']} w{s['w']} ({s['x0']},{s['y0']})-({s['x1']},{s['y1']})" for s in segs if s["net"] == "VBAT" and seg_pt(s, px, py) < 1.15 + s["w"] / 2 + 0.01]
# ---- 3. nearby foreign copper (distance from land edge, F.Cu and B.Cu)
near = []
for s in segs:
    if s["net"] == "VBAT": continue
    d = seg_pt(s, px, py) - s["w"] / 2
    land = 1.5 if s["layer"] == "B.Cu" else 1.15
    if d < 4: near.append((round(d - land, 3), s["layer"], s["net"], "track", f"to {'B.Cu Ø3.0 land' if s['layer']=='B.Cu' else 'Ø2.3 land/inner pad'}"))
for v in vias:
    if v["net"] == "VBAT": continue
    d = math.hypot(v["x"] - px, v["y"] - py) - v["r"]
    if d < 4: near.append((round(d - 1.15, 3), "via(F/In/B)", v["net"], "via", "to Ø2.3 land (F.Cu) / B.Cu land edge %.3f" % round(d - 1.5, 3)))
for f in kids(t, "footprint"):
    ref = [str(p[2]) for p in kids(f, "property") if str(p[1]) == "Reference"][0]
    if ref == "U1": continue
    a = first(f, "at"); x, y = float(a[1]), float(a[2]); r = float(a[3]) if len(a) > 3 else 0; th = math.radians(r)
    for p in kids(f, "pad"):
        pa = first(p, "at"); lx, ly = float(pa[1]), float(pa[2]); sz = first(p, "size"); w, h = float(sz[1]), float(sz[2])
        ax = x + lx * math.cos(th) + ly * math.sin(th); ay = y - lx * math.sin(th) + ly * math.cos(th)
        if int(round(r / 90)) % 2: w, h = h, w
        dx = max(abs(ax - px) - w / 2, 0); dy = max(abs(ay - py) - h / 2, 0); d = math.hypot(dx, dy)
        if d < 4 and (first(p, "net") is None or str(first(p, "net")[1]) != "VBAT"): near.append((round(d - 1.15, 3), "F.Cu", f"{ref}.{p[1]}", "pad", "to Ø2.3 land"))
near.sort(); out["foreign_copper_within_4mm_of_post"] = near[:14]
out["nearest_foreign_to_F_Cu_ring_edge"] = near[0]
# ---- 4. module pads (Seeed CAD fitted to the canonical U1)
xg = json.load(open(R / "evidence/rb04g/xiao/xiao_geometry.json"))
bat = xg["bat"]["module"]; out["module_pads_board"] = {k: dict(x=round(v["bx"], 3), y=round(v["by"], 3), w=v["w"], h=v["h"]) for k, v in bat.items()}
g0 = bat["GND0"]; b0 = bat["BAT0"]
out["BAT0_to_GND0_pitch"] = round(math.hypot(g0["bx"] - b0["bx"], g0["by"] - b0["by"]), 3)
out["module_underside_other_pads_nearest_to_BAT0"] = sorted((round(math.hypot(e["bx"] - b0["bx"], e["by"] - b0["by"]), 2), e["name"], e["fn"]) for e in xg["underside"] if e["name"] not in ("BAT0",))[:5]
# ---- 5. exposed-conductor separation matrix (worst case, explicit assumptions)
P = dict(gnd0_edge=math.hypot(g0["bx"] - b0["bx"], g0["by"] - b0["by"]) - g0["h"] / 2, reg=0.05, gnd_tol=0.05, hole_pos=0.075, p=0.10, host_reg=0.05, datum=0.022, post_on_pad=0.25,
         hole_lo=0.08, hole_hi=0.13, ring_tol=0.025, post_d=0.511, cone_d=1.0, pad_half_v=b0["h"] / 2, mask_open=pcb23["thru_hole"]["opening"], drill=pcb23["thru_hole"]["drill"],
         ring=pcb23["thru_hole"]["size"], bcu=pcb23["smd"]["size"])
gap_pad = P["gnd0_edge"] - P["pad_half_v"]       # distance BAT0 pad edge -> GND0 pad edge
E = P["post_on_pad"] + P["p"] + P["hole_pos"] + P["host_reg"] + P["datum"]
Rmin = (P["drill"] - P["hole_lo"]) / 2
shift = max(0.0, E - (Rmin - P["cone_d"] / 2))
M = {}
M["BAT0_pad_edge_to_GND0_pad_edge"] = round(gap_pad, 3)
M["post_edge_to_GND0_pad_edge (post at the pad limit toward GND0: edge at pad half-height)"] = round(P["gnd0_edge"] - P["pad_half_v"] - P["gnd_tol"], 3)
M["solder_cone_to_GND0_pad_edge (cone wets the pad only; +0.10 meniscus overflow)"] = round(gap_pad - 0.10 - P["gnd_tol"], 3)
M["exposed_host_VBAT_copper (opening edge + registration) to GND0 pad edge, incl. module shift"] = round(P["gnd0_edge"] - P["mask_open"] / 2 - P["reg"] - P["gnd_tol"] - shift, 3)
M["exposed_host_VBAT_copper to GND0, no module shift"] = round(P["gnd0_edge"] - P["mask_open"] / 2 - P["reg"] - P["gnd_tol"], 3)
M["mask_covered_ring_edge_to_GND0 (plan view; NOT an exposed-metal clearance)"] = round(P["gnd0_edge"] - P["ring"] / 2 - P["ring_tol"] - P["gnd_tol"] - shift, 3)
M["B.Cu_land_and_bottom_fillet_to_GND0 (3-D: through 1.6 mm board; plan overlap is not a clearance)"] = ">= 1.6 mm (board thickness; In1/In2 planes between)"
M["nearest_other_module_underside_pad_to_BAT0_centre"] = out["module_underside_other_pads_nearest_to_BAT0"][0]
out["separation_matrix"] = M; out["parameters"] = P
out["stack"] = dict(e_axis_linear=round(E, 3), hole_radius_min=round(Rmin, 3), cone_margin_centred=round(Rmin - P["cone_d"] / 2, 3),
                    shift_needed=round(shift, 3), u_allowed=round(1.30 - 1.0 - 0.10 - 0.05, 3), v_allowed=round((1.626 + 1.5) / 2 - 1.0 - 0.05, 3))
out["stack"]["by_cone"] = {str(c): round(max(0, E - (Rmin - c / 2)), 3) for c in (0.8, 1.0, 1.1, 1.2)}
# ---- 6. production-compensation vs mask-opening table
comp = {}
for c in (0.0, 0.05, 0.10, 0.15):
    tool = P["drill"] + c
    comp[f"compensation +{c:.2f}"] = dict(drill_tool=round(tool, 2), **{f"opening {o:.2f} minus tool": round(o - tool, 2) for o in (1.95, 2.05, 2.10, 2.15)})
out["compensation_vs_mask_opening"] = comp
# ---- 7. solder volumes
cap = lambda d, h: math.pi * h * (3 * (d / 2) ** 2 + h * h) / 6
out["solder_volume_mm3"] = dict(
    cone_d1p0_h0p4=round(cap(1.0, 0.4), 3), cone_d1p0_h0p5=round(cap(1.0, 0.5), 3), cone_d1p1_h0p5=round(cap(1.1, 0.5), 3),
    slug_1mm_of_0p5mm_wire=round(math.pi * 0.25 ** 2 * 1.0, 3), slug_1mm_of_0p8mm_wire=round(math.pi * 0.4 ** 2 * 1.0, 3))
json.dump(out, open(R / "evidence/rb04j/audit.json", "w"), indent=1, default=str)
for k in ("pad23_pcb", "pad23_library", "pad23_abs", "gerber_at_post", "U1_pin23_nets", "VBAT_nodes", "VBAT_copper_touching_land", "foreign_copper_within_4mm_of_post", "module_pads_board", "BAT0_to_GND0_pitch", "module_underside_other_pads_nearest_to_BAT0", "separation_matrix", "stack", "compensation_vs_mask_opening", "solder_volume_mm3"):
    print(k, json.dumps(out[k], default=str)[:900])
