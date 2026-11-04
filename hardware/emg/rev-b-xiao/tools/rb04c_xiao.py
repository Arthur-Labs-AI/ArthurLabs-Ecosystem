#!/usr/bin/env python3
"""RB-04C: XIAO ESP32-S3 module-vs-canonical-board geometry audit (own parsers; no KiCad API).
    python3 rb04c_xiao.py --pcb board.kicad_pcb --seeed 'XIAO ESP32S3_V1.5.kicad_pcb' --out-dir evidence/rb04c
Module frame (u, v): u from the D0-D6 edge, v from the USB end edge (Seeed PCB: u = x - 139.6111, v = y - 94.4361).
Board placement is FITTED (least squares, rotation 180 deg) from the 14 castellation pad centres to the host pads of U1; the fit residuals
are the pad-by-pad comparison.  Everything not in the Seeed PCB (tolerances) is an explicit assumption in ASSUME."""
import argparse, csv, json, math, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import rb02a_xiao_cad_extract as X
from rb02_sexpr import parse, kids, first

ASSUME = dict(
    module_outline_tol=0.20,      # +-mm, typical PCB routing tolerance; NOT published by Seeed
    module_pad_reg=0.10,          # +-mm copper-to-outline registration; NOT published
    hand_place=0.20,              # +-mm, assembler (RB-00.6 / procedure)
    host_pad_tol=0.05,            # +-mm etch / mask (JLC typical)
    hole_pos=0.075,               # +-mm JLC drilled-hole position (RB-00.6 D-5 citing JLC)
    hole_dia_lo=1.40 - 0.08, hole_dia_hi=1.40 + 0.13,   # finished Ø, JLC PTH tolerance +0.13 / -0.08
    post_d=0.511,                 # AWG24 solid
    post_on_pad=0.25,             # procedure: centred within +-0.25
    cone_d_target=1.0, cone_d_max=1.1, cone_h_max=0.5,
)


def pts_arc(p0, pm, p1, n=8):
    ax, ay = p0; bx, by = pm; cx, cy = p1
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-9: return [p0, p1]
    ux = ((ax**2 + ay**2) * (by - cy) + (bx**2 + by**2) * (cy - ay) + (cx**2 + cy**2) * (ay - by)) / d
    uy = ((ax**2 + ay**2) * (cx - bx) + (bx**2 + by**2) * (ax - cx) + (cx**2 + cy**2) * (bx - ax)) / d
    r = math.hypot(ax - ux, ay - uy)
    a0, am, a1 = (math.atan2(y - uy, x - ux) for x, y in (p0, pm, p1))
    def norm(a, ref): 
        while a < ref: a += 2 * math.pi
        return a
    a1n = norm(a1, a0); amn = norm(am, a0)
    if amn > a1n: a1n -= 2 * math.pi
    return [(ux + r * math.cos(a0 + (a1n - a0) * i / n), uy + r * math.sin(a0 + (a1n - a0) * i / n)) for i in range(n + 1)]


def seeed_outline(path):
    t = parse(Path(path).read_text())
    segs = []
    for k in t:
        if not isinstance(k, list) or not k: continue
        if k[0] in ("gr_line", "gr_arc") and first(k, "layer") and str(first(k, "layer")[1]) == "Edge.Cuts":
            if k[0] == "gr_line":
                s, e = first(k, "start"), first(k, "end")
                segs.append([(float(s[1]), float(s[2])), (float(e[1]), float(e[2]))])
            else:
                s, m, e = first(k, "start"), first(k, "mid"), first(k, "end")
                segs.append(pts_arc((float(s[1]), float(s[2])), (float(m[1]), float(m[2])), (float(e[1]), float(e[2]))))
    return segs


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--pcb", required=True); ap.add_argument("--seeed", required=True); ap.add_argument("--out-dir", required=True)
    a = ap.parse_args(); out = Path(a.out_dir); out.mkdir(parents=True, exist_ok=True)
    S = X.extract(a.seeed)
    ox0, oy0, ox1, oy1 = S["outline"]["bbox"]
    uv = lambda x, y: (x - ox0, y - oy0)
    R = {"assume": ASSUME, "module_outline": {"w": ox1 - ox0, "h": oy1 - oy0}}
    # ---- module castellation pad centres: Ø1.27 half-hole pads of U9 (edge pads), pin number -> (u,v)
    cast = {}
    for p in S["pads"]:
        if p["ref"] == "U9" and p["type"] == "thru_hole" and abs(p["w"] - 1.27) < 1e-6:
            cast[int(p["number"])] = dict(zip("uv", uv(p["x"], p["y"])), fn=p["net"].split("/")[-1].replace("{slash}", "/"), pad_w=p["w"])
    assert len(cast) == 14, len(cast)
    # copper of the module-bottom castellation pad (custom: 1.626 x 1.208-1.325 + cap)
    for p in S["pads"]:
        if p["ref"] == "U9" and p["shape"] == "custom" and "B.Cu" in p["layers"]:
            cast[int(p["number"])]["bot_pad_bbox"] = [round(v, 3) for v in (p["bbox"][0] - ox0, p["bbox"][1] - oy0, p["bbox"][2] - ox0, p["bbox"][3] - oy0)]
    # ---- host U1 pads
    t = parse(Path(a.pcb).read_text())
    host = {}; fp = {}
    for f in kids(t, "footprint"):
        ref = [str(p[2]) for p in kids(f, "property") if str(p[1]) == "Reference"][0]
        at = first(f, "at"); fp[ref] = (float(at[1]), float(at[2]), float(at[3]) if len(at) > 3 else 0.0, f)
    fx, fy, fr, f1 = fp["U1"]
    assert abs(fr % 360 - 180) < 1e-6
    H = {}
    for p in kids(f1, "pad"):
        pa = first(p, "at"); lx, ly = float(pa[1]), float(pa[2])
        H.setdefault(str(p[1]), []).append(dict(x=fx - lx, y=fy - ly, w=float(first(p, "size")[1]), h=float(first(p, "size")[2]), net=str(first(p, "net")[1]) if first(p, "net") else "", layers=[str(v) for v in first(p, "layers")[1:]], kind=str(p[2]), drill=(float(first(p, "drill")[1]) if first(p, "drill") else None)))
    # least-squares translation for rotation 180: board = T - (u,v)  => T = board + (u,v)
    tx = [H[str(n)][0]["x"] + 0 for n in range(1, 15)]  # placeholder to keep list
    # module castellation EDGE point for pin n: u=0 for n<=7 else 17.78 ; the host pad centre is inset 0.15 (design) -> use v only plus the outline centre for u
    Tx = fx + (ox1 - ox0) / 2          # module u centre -> board: x = Tx - u  (derived below and then fitted on v only)
    ty = [H[str(n)][0]["y"] + cast[n]["v"] for n in range(1, 15)]
    Ty = sum(ty) / 14
    spread = max(ty) - min(ty)
    # centroid of module pad-centre u values vs host: u centre -> x
    tu = [H[str(n)][0]["x"] + cast[n]["u"] for n in range(1, 15)]
    Tx_fit = sum(tu) / 14                          # includes the constant 0.15 inset of host pads (+-)
    R["fit"] = dict(Ty=Ty, Ty_spread=spread, Tx_from_outline_centre=Tx, Tx_from_pad_centroid=Tx_fit)
    T = (Tx, Ty)
    bx = lambda u: T[0] - u
    by = lambda v: T[1] - v
    # ---- A: castellation table
    rows = []
    for n in range(1, 15):
        c = cast[n]; h = H[str(n)][0]
        edge_u = 0.0 if n <= 7 else ox1 - ox0
        edge_x = bx(edge_u)
        mod_x, mod_y = bx(c["u"]), by(c["v"])
        # host pad extent normal to edge
        xs = (h["x"] - h["w"] / 2, h["x"] + h["w"] / 2) if True else None
        outward = -1 if n <= 7 else 1      # board direction away from module centre: east for n<=7 (rot 180), west for n>=8
        # rot 180: pins 1-7 (u=0) are on the +x (east) side
        east = n <= 7
        toe = (max(xs) - edge_x) if east else (edge_x - min(xs))
        inner = (edge_x - min(xs)) if east else (max(xs) - edge_x)
        rows.append(dict(pin=n, module_fn=c["fn"], module_u=round(c["u"], 3), module_v=round(c["v"], 3), board_x=round(mod_x, 3), board_y=round(mod_y, 3),
                         host_x=round(h["x"], 3), host_y=round(h["y"], 3), d_along_edge=round(h["y"] - mod_y, 3), d_normal_vs_nominal_inset=round(abs(h["x"] - edge_x) - 0.15, 3),
                         host_pad=f"{h['w']}x{h['h']}", host_net=h["net"], toe_mm=round(toe, 3), under_module_mm=round(inner, 3),
                         bot_copper_bbox_board=None))
    R["castellations"] = rows
    # ---- B: BAT+/BAT-
    pads = {p["ref"]: p for p in S["pads"] if p["ref"] in ("BAT0", "GND0")}
    bat = {k: dict(u=uv(p["x"], p["y"])[0], v=uv(p["x"], p["y"])[1], w=p["w"], h=p["h"]) for k, p in pads.items()}
    for k, d in bat.items(): d["bx"], d["by"] = bx(d["u"]), by(d["v"])
    post = H["23"][0]; ring = [h for h in H["23"] if h["kind"] == "thru_hole"][0]; botpad = [h for h in H["23"] if h["kind"] == "smd"][0]
    R["bat"] = dict(module=bat, host_post=dict(x=ring["x"], y=ring["y"], drill=ring["drill"], ring=ring["w"], bot_pad=botpad["w"]),
                    hole_vs_BAT0=(round(ring["x"] - bat["BAT0"]["bx"], 3), round(ring["y"] - bat["BAT0"]["by"], 3)),
                    BAT0_to_GND0_centre=round(math.hypot(bat["BAT0"]["bx"] - bat["GND0"]["bx"], bat["BAT0"]["by"] - bat["GND0"]["by"]), 3),
                    pad_gap=round(math.hypot(bat["BAT0"]["bx"] - bat["GND0"]["bx"], bat["BAT0"]["by"] - bat["GND0"]["by"]) - 1.016, 3))
    # ---- C: underside exposed copper of the module in board coordinates
    ex = []
    for p in S["pads"]:
        if p["ref"].startswith("TP"):
            u, v = uv(p["x"], p["y"]); ex.append(dict(name=p["ref"], fn=p["net"].split("/")[-1].replace("{slash}", "/"), u=u, v=v, w=1.143, h=1.143, shape="circle"))
        if p["ref"] in ("BAT0", "GND0"):
            u, v = uv(p["x"], p["y"]); ex.append(dict(name=p["ref"], fn=p["net"].split("/")[-1], u=u, v=v, w=2.032, h=1.016, shape="rect"))
        if p["ref"] == "USB0" and p["type"] == "thru_hole":
            u, v = uv(p["x"], p["y"]); ex.append(dict(name="USB_" + p["number"], fn="GND(shell)", u=u, v=v, w=1.778, h=0.889, shape="rect"))
        if p["ref"] == "USB0" and p["type"] == "np_thru_hole":
            u, v = uv(p["x"], p["y"]); ex.append(dict(name="USB_NPTH", fn="hole", u=u, v=v, w=0.58, h=0.58, shape="circle"))
    ex.append(dict(name="PAD25_window", fn="GND(pour)", u=(8.635 + 11.385) / 2, v=(11.29 + 13.79) / 2, w=2.75, h=2.5, shape="rect"))   # RB-02A, from the Seeed B.Mask opening
    for e in ex: e["bx"], e["by"] = bx(e["u"]), by(e["v"])
    # host F.Cu copper (not U1): pads, vias, tracks
    hostobj = []
    for ref, (x, y, r, f) in fp.items():
        if ref == "U1": continue
        for p in kids(f, "pad"):
            lay = [str(v) for v in first(p, "layers")[1:]]
            if not any(l in ("F.Cu", "*.Cu") for l in lay): continue
            pa = first(p, "at"); lx, ly = float(pa[1]), float(pa[2]); th = math.radians(r)
            px = x + lx * math.cos(th) + ly * math.sin(th); py = y - lx * math.sin(th) + ly * math.cos(th)
            sz = first(p, "size"); w, h = float(sz[1]), float(sz[2])
            if int(round(r / 90)) % 2: w, h = h, w
            hostobj.append(dict(kind="pad", ref=f"{ref}.{p[1]}", x=px, y=py, w=w, h=h, net=str(first(p, "net")[1]) if first(p, "net") else "", mask_open=any("Mask" in l for l in lay)))
    for v in kids(t, "via"):
        at = first(v, "at"); hostobj.append(dict(kind="via", ref="via", x=float(at[1]), y=float(at[2]), w=float(first(v, "size")[1]), h=float(first(v, "size")[1]), net=str(first(v, "net")[1]), mask_open=False))
    for s in kids(t, "segment"):
        if str(first(s, "layer")[1]) != "F.Cu": continue
        a_, b_ = first(s, "start"), first(s, "end"); hostobj.append(dict(kind="track", ref="trk", x0=float(a_[1]), y0=float(a_[2]), x1=float(b_[1]), y1=float(b_[2]), w=float(first(s, "width")[1]), net=str(first(s, "net")[1]), mask_open=False))
    def rect_dist(px, py, hw, hh, qx, qy, qhw, qhh):
        dx = max(abs(px - qx) - hw - qhw, 0); dy = max(abs(py - qy) - hh - qhh, 0); return math.hypot(dx, dy)
    def seg_rect_dist(o, e):
        # distance from rect e (centre bx,by, half w/2,h/2) to track segment (sampled)
        n = max(2, int(math.hypot(o["x1"] - o["x0"], o["y1"] - o["y0"]) / 0.05))
        best = 9
        for i in range(n + 1):
            qx = o["x0"] + (o["x1"] - o["x0"]) * i / n; qy = o["y0"] + (o["y1"] - o["y0"]) * i / n
            best = min(best, rect_dist(qx, qy, o["w"] / 2, o["w"] / 2, e["bx"], e["by"], e["w"] / 2, e["h"] / 2))
        return best
    for e in ex:
        near = []
        for o in hostobj:
            d = seg_rect_dist(o, e) if o["kind"] == "track" else rect_dist(o["x"], o["y"], o["w"] / 2, o["h"] / 2, e["bx"], e["by"], e["w"] / 2, e["h"] / 2)
            if d < 2.0: near.append((round(d, 3), o["kind"], o["ref"], o["net"], o["mask_open"]))
        near.sort()
        e["host_f_cu_within_2mm"] = near[:6]
        e["min_clear_host_copper"] = near[0][0] if near else None
        e["overlap_exposed_host_copper"] = [n for n in near if n[0] <= 0 and n[4]]
    R["underside"] = ex
    # ---- D: host objects overlapping module outline + 1.5 margin (components), U.FL, USB
    mod_x0, mod_x1 = bx(ox1 - ox0), bx(0.0)
    mod_y0, mod_y1 = by(oy1 - oy0), by(0.0)
    R["module_board_bbox"] = dict(x0=mod_x0, x1=mod_x1, y0=mod_y0, y1=mod_y1)
    near = []
    for ref, (x, y, r, f) in fp.items():
        if ref == "U1": continue
        cy = [k for k in f if isinstance(k, list) and k[0] == "fp_rect" and str(first(k, "layer")[1]) == "F.CrtYd"]
        if not cy: continue
        s_, e_ = first(cy[0], "start"), first(cy[0], "end"); th = math.radians(r)
        cs = []
        for (lx, ly) in ((float(s_[1]), float(s_[2])), (float(e_[1]), float(e_[2]))):
            cs.append((x + lx * math.cos(th) + ly * math.sin(th), y - lx * math.sin(th) + ly * math.cos(th)))
        x0, x1 = sorted((cs[0][0], cs[1][0])); y0, y1 = sorted((cs[0][1], cs[1][1]))
        dx = max(mod_x0 - x1, x0 - mod_x1, 0); dy = max(mod_y0 - y1, y0 - mod_y1, 0)
        d = math.hypot(dx, dy)
        if d < 4.0: near.append((round(d, 2), ref, [round(v, 2) for v in (x0, y0, x1, y1)]))
    near.sort(); R["host_courtyards_within_4mm_of_module"] = near
    # U.FL & USB
    uf = [f for f in S["footprints"] if f["ref"] == "ANT1"][0]; us = [f for f in S["footprints"] if f["ref"] == "USB0"][0]
    R["ufl"] = dict(centre_board=(bx(uv(uf["x"], uf["y"])[0]), by(uv(uf["x"], uf["y"])[1])), crtyd=uf["boxes"].get("F.CrtYd"))
    R["usb"] = dict(centre_u=uv(us["x"], us["y"])[0], width=9.0, overhang_beyond_module_edge=1.508,
                    board_edge_y=None)
    # board outline from Edge.Cuts of the host
    xs = []; ys = []
    for k in t:
        if isinstance(k, list) and k and k[0] in ("gr_line", "gr_arc", "gr_rect") and first(k, "layer") and str(first(k, "layer")[1]) == "Edge.Cuts":
            for nm in ("start", "end", "mid"):
                q = first(k, nm)
                if q: xs.append(float(q[1])); ys.append(float(q[2]))
    R["host_outline"] = [min(xs), min(ys), max(xs), max(ys)]
    R["usb"]["module_usb_edge_y"] = mod_y1
    R["usb"]["inset_from_board_edge"] = round(max(ys) - mod_y1, 3)
    # segments for overlay
    R["_seeed_outline_u_v"] = [[(round(px - ox0, 3), round(py - oy0, 3)) for px, py in s] for s in seeed_outline(a.seeed)]
    R["_T"] = T
    json.dump(R, open(out / "xiao_geometry.json", "w"), indent=1, default=list)
    with open(out / "castellation_comparison.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    print(json.dumps({k: R[k] for k in ("fit", "bat", "module_board_bbox", "usb", "host_outline", "ufl")}, indent=1, default=list)[:3000])
    for r in rows: print(r["pin"], r["module_fn"], r["host_net"][-24:], r["d_along_edge"], r["d_normal_vs_nominal_inset"], r["toe_mm"], r["under_module_mm"])
    for e in ex: print(e["name"], e["fn"], round(e["bx"], 2), round(e["by"], 2), "min clear", e["min_clear_host_copper"], e["host_f_cu_within_2mm"][:2], "EXPOSED OVERLAP" if e["overlap_exposed_host_copper"] else "")
    print("courtyards <4 mm:", near)


if __name__ == "__main__":
    main()
