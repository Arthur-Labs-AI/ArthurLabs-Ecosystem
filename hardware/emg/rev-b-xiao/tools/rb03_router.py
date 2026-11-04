#!/usr/bin/env python3
"""RB-03: project-specific grid router for the Rev B board (pure Python + KiCad pcbnew API; no third-party router).

    python3 rb03_router.py --pcb in.kicad_pcb --out routed.kicad_pcb [--log log.json] [--only NET ...]

* orthogonal routing on a 0.1 mm grid, layers F.Cu / B.Cu / In2.Cu (In2 only inside the module/RF half, where RB-02 left it
  free of the ground zone); In1 stays one solid GND plane.
* every net is routed with its own netclass width / clearance, per-pair rules of REVB_MANUFACTURING_CONSTRAINTS section 3.1
  (hi-Z: outer layer only, no vias, 0.4 mm to foreign tracks/vias; SPI/CTRL tracks never enter ZONE_A).
* keep-outs of the XIAO underside (rule areas), copper-to-edge 0.5 mm, via >= 0.6/0.3, no via-in-pad.
* GND pads receive a via to In1 within 3 mm.
Routing order = priority list in PRIORITY below.  The router is deterministic.
"""
import argparse
import fnmatch
import heapq
import json
import math
import sys
import time
from pathlib import Path

import pcbnew

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_write_project import CLASSES, PATTERNS  # noqa: E402

G = 0.1                      # grid, mm
NM = 1e6
VIA_D, VIA_DRILL = 0.6, 0.3
EDGE_CU = 0.5
L_F, L_B, L_I2 = 0, 1, 2
LNAME = {L_F: "F.Cu", L_B: "B.Cu", L_I2: "In2.Cu"}
LID = {L_F: pcbnew.F_Cu, L_B: pcbnew.B_Cu, L_I2: pcbnew.In2_Cu}

CLASS_W = {k: v[0] for k, v in CLASSES.items()}
CLASS_C = {k: v[1] for k, v in CLASSES.items()}
HIZ_TRACK_CLEAR = 0.40       # hi-Z track/via to foreign track/via (hiz_leakage)
PRIORITY = ["EMG_ELECTRODE", "EMG_HIZ", "ADC_CAP", "ANALOG_REF", "EMG_BUF", "SPI_FAST", "PWR_AFE", "PWR_DVDD", "PWR_VBAT",
            "CTRL_SLOW", "VBUS_SENSE"]


def klass(net):
    for c, p in PATTERNS:
        if fnmatch.fnmatchcase(net, p):
            return c
    return "Default"


class Router:
    def __init__(self, board):
        self.b = board
        bb = board.GetBoardEdgesBoundingBox()
        self.x0, self.y0 = bb.GetLeft() / NM + 0.05, bb.GetTop() / NM + 0.05          # outline centre lines
        self.W = (bb.GetRight() - bb.GetLeft()) / NM - 0.1
        self.H = (bb.GetBottom() - bb.GetTop()) / NM - 0.1
        self.nx = int(round(self.W / G)) + 1
        self.ny = int(round(self.H / G)) + 1
        self.copper = {L_F: [], L_B: [], L_I2: []}          # (x0, y0, x1, y1, net, kind)
        self.keepout_tr = {L_F: [], L_B: [], L_I2: []}      # rect areas where tracks are not allowed
        self.keepout_via = []
        self.zone_a = None
        self.u50x_rects = set()
        self.post_keep = None
        self.in2_region = None                               # (x0, y0) lower-right quadrant free of the In2 GND zone
        self.tracks = []                                     # (net, layer, x0, y0, x1, y1, w)
        self.gnd_done = set()
        self.slack = 0.03
        self.relax_via_in_pad = False
        self.vip_nets = set()
        self.tight_via_nets = set()
        self.use_ladder = False
        self.pair_partner = {}
        self.hiz_snap = 0.09             # hi-Z track/via margin for pad-centre stub snapping (0 for exact-grid local edits)
        self.hiz_snap_pad = 0.05
        self.gnd_rect_margin = 0.35      # GND via targets keep this distance from every GND pad rectangle (0.25 = the own-pad via gap)
        self.in2_edge_margin = 0.4       # vias keep via_r + this from the cut edge of the In2 GND zone (0.0 keeps the annulus inside the pour)
        self.pair_reach = 0.8
        self.allow_vip_fallback = True
        self.own_pad_via_gap = 0.25          # via centre >= 0.25 mm from the edge of any pad: hole (r 0.15) stays 0.10 mm outside the copper
        self.narrow_refs = ("U501", "U502", "U503")
        self.hiz_nets, self.buf_nets, self.electrode_nets, self.net_clear = set(), set(), set(), {"GND": 0.2}
        self.spi_nets = set()
        self.vias = []                                       # (net, x, y)
        self.read_board()

    # ---------------------------------------------------------------- board
    def read_board(self):
        b = self.b
        for fp in b.GetFootprints():
            for p in fp.Pads():
                bb = p.GetBoundingBox()
                r = (bb.GetLeft() / NM, bb.GetTop() / NM, bb.GetRight() / NM, bb.GetBottom() / NM)
                net = p.GetNetname() or f"~nc{id(p)}"
                if net.startswith("unconnected") and "PadMP" not in net:
                    net = f"~{net}"
                if fp.GetReference() in ("U501", "U502", "U503"):
                    self.u50x_rects.add(tuple(round(v, 4) for v in r))
                for lid, L in ((pcbnew.F_Cu, L_F), (pcbnew.B_Cu, L_B)):
                    if p.IsOnLayer(lid):
                        self.copper[L].append((*r, net, "pad"))
                if p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH:
                    self.copper[L_I2].append((*r, net, "pad"))
                if fp.GetReference() == "U1" and p.GetNumber() == "23" and p.IsOnLayer(pcbnew.B_Cu) and p.GetAttribute() != pcbnew.PAD_ATTRIB_PTH:
                    # RB-00.6 mounting spec: no B.Cu copper of another net within 0.5 mm of the bottom post pad (hand-soldering access)
                    self.post_keep = (r[0] - 0.5, r[1] - 0.5, r[2] + 0.5, r[3] + 0.5, net)
        for z in b.Zones():
            nm = z.GetZoneName()
            bb = z.GetBoundingBox()
            r = (bb.GetLeft() / NM, bb.GetTop() / NM, bb.GetRight() / NM, bb.GetBottom() / NM)
            if nm == "ZONE_A":
                self.zone_a = r
            if z.GetIsRuleArea():
                if z.GetDoNotAllowTracks():
                    for lid, L in ((pcbnew.F_Cu, L_F), (pcbnew.B_Cu, L_B), (pcbnew.In2_Cu, L_I2)):
                        if z.IsOnLayer(lid):
                            self.keepout_tr[L].append(r)
                if z.GetDoNotAllowVias():
                    self.keepout_via.append(r)
            if nm.startswith("In2 GND"):
                self.in2_zone_bbox = r
        # In2 GND zone is the L-shape of the variant: in2 is free in the lower-right quadrant beyond the cut
        # (read the polygon corners)
        for z in b.Zones():
            if z.GetZoneName().startswith("In2 GND"):
                ol = z.Outline().COutline(0)
                pts = [(ol.CPoint(i).x / NM, ol.CPoint(i).y / NM) for i in range(ol.PointCount())]
                if len(pts) == 6:
                    # (m,m),(W-m,m),(W-m,cy),(cx,cy),(cx,H-m),(m,H-m): cut-out is x>cx, y>cy
                    self.in2_region = (pts[3][0], pts[3][1])
        self.dbg = {"nx": self.nx, "ny": self.ny, "in2_region": self.in2_region, "zone_a": self.zone_a}

    # ---------------------------------------------------------------- masks
    def mark(self, arr, r, infl):
        x0, y0, x1, y1 = r
        i0 = max(0, int(math.ceil((x0 - infl - self.x0) / G - 1e-9)))
        i1 = min(self.nx - 1, int(math.floor((x1 + infl - self.x0) / G + 1e-9)))
        j0 = max(0, int(math.ceil((y0 - infl - self.y0) / G - 1e-9)))
        j1 = min(self.ny - 1, int(math.floor((y1 + infl - self.y0) / G + 1e-9)))
        if i1 < i0 or j1 < j0:
            return
        run = b"\x01" * (i1 - i0 + 1)
        nx = self.nx
        for j in range(j0, j1 + 1):
            base = j * nx
            arr[base + i0: base + i1 + 1] = run

    def masks(self, net, hw, clr, hiz, via_r, kind_class):
        """track mask (per layer) and via mask (single, for F+B[+In2]) for routing `net`"""
        nx, ny = self.nx, self.ny
        tm = {L: bytearray(nx * ny) for L in (L_F, L_B, L_I2)}
        self.tpad = {L: bytearray(nx * ny) for L in (L_F, L_B, L_I2)}        # blocking that comes from foreign PADS only
        vm = bytearray(nx * ny)
        for L in (L_F, L_B, L_I2):
            for (x0, y0, x1, y1, n, kind) in self.copper[L]:
                if n == net:
                    if kind == "via":                        # own vias: hole-to-hole 0.5 mm (ties to an existing via are explicit targets)
                        self.mark(vm, (x0, y0, x1, y1), via_r + 0.5)
                    elif kind == "pad" and not self.relax_via_in_pad:    # no via in (or touching) any SMD pad, own net included
                        self.mark(vm, (x0, y0, x1, y1), self.own_pad_via_gap)
                    continue
                c = max(clr, self.net_clear.get(n, 0.2)) + self.slack        # grid / stub rounding slack
                ch = False
                if kind in ("track", "via") and n in self.hiz_nets:
                    c = max(c, HIZ_TRACK_CLEAR)       # a foreign track/via next to a hi-Z track/via
                if hiz and kind in ("track", "via") and n != "GND":
                    c = max(c, HIZ_TRACK_CLEAR)
                if kind in ("track", "via") and (hiz or n in self.hiz_nets) and n != "GND":
                    c += self.hiz_snap                     # extra margin around hi-Z tracks: pad-centre stubs snap by up to 0.05-0.1 mm
                # RB-03R narrowed leakage rules: hi-Z track vs ANY foreign non-GND pad, and foreign track/via vs ANY hi-Z pad, keep
                # 0.4 mm; only the pins of the three TLV9064 are exempt (package pin pitch)
                isu = tuple(round(v, 4) for v in (x0, y0, x1, y1)) in self.u50x_rects
                if kind == "pad" and not isu and n != "GND":
                    if hiz and n not in self.hiz_nets:
                        c = max(c, HIZ_TRACK_CLEAR) + self.hiz_snap_pad
                    elif n in self.hiz_nets and not hiz:
                        c = max(c, HIZ_TRACK_CLEAR) + self.hiz_snap_pad
                if kind_class == "SPI_FAST":
                    if n in self.hiz_nets:
                        c = max(c, 2.0)                    # spi_to_hiz
                    elif n in self.buf_nets:
                        c = max(c, 1.0)                    # spi_to_buf
                elif n in self.spi_nets and (net in self.hiz_nets or net in self.buf_nets):
                    c = max(c, 2.0 if net in self.hiz_nets else 1.0)      # same rules when the SPI net was routed first
                r = (x0, y0, x1, y1)
                cv = c
                if kind == "pad" and isu and n in self.hiz_nets and net not in self.hiz_nets and n != "GND":
                    cv = max(c, HIZ_TRACK_CLEAR) + self.hiz_snap_pad      # the TLV9064 pin exemption is for TRACKS; vias keep the 0.4 mm
                self.mark(self.tpad[L] if kind == "pad" else tm[L], r, hw + c)
                self.mark(vm, r, via_r + cv)
        for L in (L_F, L_B, L_I2):
            for r in self.keepout_tr[L]:
                self.mark(tm[L], r, hw)
        for r in self.keepout_via:
            self.mark(vm, r, via_r)
        if self.post_keep and net != self.post_keep[4]:           # BAT+ bottom pad: no foreign copper within 0.5 mm
            self.mark(tm[L_B], self.post_keep[:4], hw)
            self.mark(vm, self.post_keep[:4], via_r)
        # board edge margin
        for L in (L_F, L_B, L_I2):
            self.edge_mark(tm[L], hw + EDGE_CU)
        self.edge_mark(vm, via_r + EDGE_CU)
        # In2 only inside its free region
        if self.in2_region is None:
            tm[L_I2] = bytearray(b"\x01" * (nx * ny))
        else:
            cx, cy = self.in2_region
            for j in range(ny):
                y = self.y0 + j * G
                base = j * nx
                for i in range(nx):
                    if not (self.x0 + i * G > cx + 0.3 and y > cy + 0.3):
                        tm[L_I2][base + i] = 1
        # keep vias away from the cut edge of the In2 GND zone (avoids thin copper spurs)
        if self.in2_region:
            cx, cy = self.in2_region
            self.mark(vm, (cx, cy, cx, self.y0 + self.H), via_r + self.in2_edge_margin)
            self.mark(vm, (cx, cy, self.x0 + self.W, cy), via_r + self.in2_edge_margin)
        self.tm_nopad = {L: bytearray(tm[L]) for L in tm}            # tracks / vias / keep-outs / edge only
        for L in tm:
            a = int.from_bytes(tm[L], "little") | int.from_bytes(self.tpad[L], "little")
            tm[L] = bytearray(a.to_bytes(nx * ny, "little"))
        return tm, vm

    def edge_mark(self, arr, m):
        nx, ny = self.nx, self.ny
        k = int(math.ceil(m / G - 1e-9))
        for j in range(ny):
            base = j * nx
            if j < k or j >= ny - k:
                arr[base: base + nx] = b"\x01" * nx
            else:
                arr[base: base + k] = b"\x01" * k
                arr[base + nx - k: base + nx] = b"\x01" * k

    # ---------------------------------------------------------------- A*
    def cell(self, x, y):
        return int(round((x - self.x0) / G)), int(round((y - self.y0) / G))

    def xy(self, i, j):
        return self.x0 + i * G, self.y0 + j * G

    def search(self, sources, targets, tm, vm, allow_vias, layers_ok, cost_via=60, bend=3, max_exp=600000, layer_pref=None, attract=None):
        """A* from the set `sources` ({(L,i,j)}) to any cell in `targets` ({(L,i,j)}). Returns list of (L,i,j) or None"""
        nx, ny = self.nx, self.ny
        tl = list(targets)
        if not tl:
            return None
        tx0 = min(t[1] for t in tl); tx1 = max(t[1] for t in tl)
        ty0 = min(t[2] for t in tl); ty1 = max(t[2] for t in tl)

        def h(i, j):
            dx = tx0 - i if i < tx0 else (i - tx1 if i > tx1 else 0)
            dy = ty0 - j if j < ty0 else (j - ty1 if j > ty1 else 0)
            return (dx + dy) * 10

        tset = set(targets)
        heap = []
        g = {}
        parent = {}
        for (L, i, j) in sources:
            for d in range(5):                       # 4 directions + "no direction"
                key = (L, i, j, d)
                g[key] = 0
                heapq.heappush(heap, (h(i, j), 0, key))
        exp = 0
        while heap:
            f, gc, key = heapq.heappop(heap)
            if g.get(key, 1 << 60) < gc:
                continue
            L, i, j, d = key
            if (L, i, j) in tset:
                path = [(L, i, j)]
                k = key
                while k in parent:
                    k = parent[k]
                    if (k[0], k[1], k[2]) != path[-1]:
                        path.append((k[0], k[1], k[2]))
                path.reverse()
                return path
            exp += 1
            if exp > max_exp:
                return None
            arr = tm[L]
            for nd, (di, dj) in enumerate(((1, 0), (-1, 0), (0, 1), (0, -1))):
                ni, nj = i + di, j + dj
                if ni < 0 or nj < 0 or ni >= nx or nj >= ny:
                    continue
                if arr[nj * nx + ni] and (L, ni, nj) not in tset:
                    continue
                c = 10 + (bend if (d != 4 and d != nd) else 0)
                if layer_pref and L == layer_pref[0]:
                    c += layer_pref[1]
                if attract is not None and not attract[L][nj * nx + ni]:
                    c += 4                          # prefer cells close to the partner net of a pair (balanced pick-up)
                ng = gc + c
                nk = (L, ni, nj, nd)
                if ng < g.get(nk, 1 << 60):
                    g[nk] = ng
                    parent[nk] = key
                    heapq.heappush(heap, (ng + h(ni, nj), ng, nk))
            if allow_vias and not vm[j * nx + i]:
                for L2 in layers_ok:
                    if L2 == L:
                        continue
                    if tm[L2][j * nx + i] and (L2, i, j) not in tset:
                        continue
                    ng = gc + cost_via
                    nk = (L2, i, j, 4)
                    if ng < g.get(nk, 1 << 60):
                        g[nk] = ng
                        parent[nk] = key
                        heapq.heappush(heap, (ng + h(i, j), ng, nk))
        return None

    # ---------------------------------------------------------------- tree bookkeeping
    def add_track(self, net, L, x0, y0, x1, y1, w):
        self.tracks.append((net, L, x0, y0, x1, y1, w))
        r = (min(x0, x1) - w / 2, min(y0, y1) - w / 2, max(x0, x1) + w / 2, max(y0, y1) + w / 2)
        self.copper[L].append((*r, net, "track"))

    def add_via(self, net, x, y):
        self.vias.append((net, x, y))
        r = (x - VIA_D / 2, y - VIA_D / 2, x + VIA_D / 2, y + VIA_D / 2)
        for L in (L_F, L_B, L_I2):
            self.copper[L].append((*r, net, "via"))

    def commit(self, net, path, w, pad_from=None, pad_to=None):
        """turn a cell path into tracks/vias; stub exact pad centres at both ends"""
        pts = [(L, *self.xy(i, j)) for (L, i, j) in path]
        segs = []
        k = 0
        n = len(pts)
        while k < n - 1:
            L, x, y = pts[k]
            L2, x2, y2 = pts[k + 1]
            if L2 != L:                             # via here
                self.add_via(net, x, y)
                k += 1
                continue
            # extend straight run
            e = k + 1
            dx, dy = x2 - x, y2 - y
            while e + 1 < n and pts[e + 1][0] == L and abs((pts[e + 1][1] - pts[e][1]) - dx) < 1e-9 and abs((pts[e + 1][2] - pts[e][2]) - dy) < 1e-9:
                e += 1
            segs.append((L, x, y, pts[e][1], pts[e][2]))
            k = e
        for (L, xa, ya, xb, yb) in segs:
            self.add_track(net, L, xa, ya, xb, yb, w)

    # ---------------------------------------------------------------- driver
    def route_all(self, only=None, log=None, front=()):
        b = self.b
        self.net_clear = {}
        nets = {}
        for fp in b.GetFootprints():
            for p in fp.Pads():
                n = p.GetNetname()
                if not n or n == "GND" or (n.startswith("unconnected") and "PadMP" not in n):
                    continue
                bb = p.GetBoundingBox()
                lay = [L for lid, L in ((pcbnew.F_Cu, L_F), (pcbnew.B_Cu, L_B)) if p.IsOnLayer(lid)]
                nets.setdefault(n, []).append({"obj": p, "ref": fp.GetReference(), "num": p.GetNumber(), "x": p.GetPosition().x / NM, "y": p.GetPosition().y / NM,
                                               "rect": (bb.GetLeft() / NM, bb.GetTop() / NM, bb.GetRight() / NM, bb.GetBottom() / NM), "layers": lay,
                                               "th": p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH})
        self.nets_by_name = nets
        self.hiz_nets = {n for n in nets if klass(n) == "EMG_HIZ"}
        self.buf_nets = set()
        self.spi_nets = {n for n in nets if klass(n) == "SPI_FAST"}
        for n in nets:
            self.net_clear[n] = CLASS_C.get(klass(n), 0.2)
        self.net_clear["GND"] = 0.2
        self.electrode_nets = {n for n in nets if klass(n) == "EMG_ELECTRODE"}
        for c in (1, 2, 3, 4):
            self.pair_partner[f"/CH{c}_N"] = f"/CH{c}_P"        # the N run follows the P run (ADC inputs)
        self.buf_nets = {n for n in nets if klass(n) == "EMG_BUF"}
        order = sorted((n for n in nets if len(nets[n]) >= 2),
                       key=lambda n: (front.index(n) if n in front else len(front), PRIORITY.index(klass(n)) if klass(n) in PRIORITY else 99, n))
        if only:
            order = [n for n in order if n in only]
        report = []
        for n in order:
            t0 = time.time()
            cl = klass(n)
            pads = nets[n]
            ok, info = self.route_net(n, cl, pads)
            report.append({"net": n, "class": cl, "pads": len(pads), "ok": ok, "sec": round(time.time() - t0, 1), **info})
            print(f"{'OK  ' if ok else 'FAIL'} {n:44s} {cl:14s} pads={len(pads):2d} {info}", flush=True)
        return report

    def pad_cells(self, p, tm, layers):
        x0, y0, x1, y1 = p["rect"]
        out = set()
        i0, j0 = self.cell(x0, y0)
        i1, j1 = self.cell(x1, y1)
        for L in layers:
            for j in range(max(0, j0), min(self.ny - 1, j1) + 1):
                for i in range(max(0, i0), min(self.nx - 1, i1) + 1):
                    x, y = self.xy(i, j)
                    if x0 - 1e-9 <= x <= x1 + 1e-9 and y0 - 1e-9 <= y <= y1 + 1e-9:
                        if "obj" in p and not p["obj"].HitTest(pcbnew.VECTOR2I(int(round(x * NM)), int(round(y * NM)))):
                            continue                  # inside the bounding box but outside the real pad shape (round / rounded corners)
                        out.add((L, i, j))
        if not out:                                  # tiny pad: nearest cell
            i, j = self.cell(p["x"], p["y"])
            for L in layers:
                out.add((L, i, j))
        return out

    def route_net(self, net, cl, pads):
        """strict via-to-pad gap first, then progressively smaller gaps, via-in-pad only as the last resort"""
        base = self.own_pad_via_gap
        ladder = [base] + ([g for g in (0.20, 0.16) if g < base] if self.use_ladder else [])
        for g in ladder:
            self.own_pad_via_gap = g
            self.relax_via_in_pad = False
            ok, info = self._route_net(net, cl, pads)
            if ok:
                self.own_pad_via_gap = base
                if g < base:
                    info["via_gap"] = g
                    self.tight_via_nets.add(net)
                return ok, info
        self.own_pad_via_gap = base
        if self.allow_vip_fallback and cl not in ("EMG_HIZ", "EMG_ELECTRODE", "ADC_CAP"):
            self.relax_via_in_pad = True
            ok, info2 = self._route_net(net, cl, pads)
            self.relax_via_in_pad = False
            if ok:
                info2["via_in_pad_fallback"] = True
                self.vip_nets.add(net)
                return ok, info2
        return False, info

    def _route_net(self, net, cl, pads):
        hiz = cl == "EMG_HIZ"
        no_via = cl in ("EMG_HIZ", "EMG_ELECTRODE", "ADC_CAP")
        outer_only = cl in ("EMG_HIZ", "EMG_ELECTRODE")
        zone_a_barred = cl in ("SPI_FAST", "CTRL_SLOW")
        widths = [CLASS_W[cl]] + ([0.25, 0.2] if CLASS_W[cl] > 0.25 else ([0.2] if CLASS_W[cl] > 0.2 else []))
        clr = CLASS_C[cl]
        info = {}
        # override for the narrow east channel of the XIAO (spec: 0.15/0.15)
        for w in widths + ([0.15] if cl in ("CTRL_SLOW", "SPI_FAST") else []):
            snap_t, snap_v = len(self.tracks), len(self.vias)
            snap_c = {L: len(self.copper[L]) for L in self.copper}
            layers_ok = [L_F, L_B] + ([L_I2] if (self.in2_region and not outer_only) else [])
            allow_vias = not no_via
            cache = {}

            def build(wc):
                if wc in cache:
                    return cache[wc]
                hw = wc / 2
                c_use = 0.15 if wc == 0.15 else clr
                tm, vm = self.masks(net, hw, c_use, hiz, VIA_D / 2, cl)
                if zone_a_barred and self.zone_a:
                    for L in (L_F, L_B, L_I2):
                        self.mark(tm[L], self.zone_a, hw)
                    self.mark(vm, self.zone_a, VIA_D / 2)
                if outer_only:
                    tm[L_B] = bytearray(b"\x01" * (self.nx * self.ny))
                    tm[L_I2] = bytearray(b"\x01" * (self.nx * self.ny))
                pcells = []
                for p in pads:
                    lay = p["layers"] if p["layers"] else [L_F]
                    cs = self.pad_cells(p, tm, lay)
                    # only cells that keep the clearance to foreign tracks/vias are valid landing cells (when any exists)
                    good = {(L, i, j) for (L, i, j) in cs if not self.tm_nopad[L][j * self.nx + i]}
                    if good:
                        cs = good
                    for (L, i, j) in cs:
                        tm[L][j * self.nx + i] = self.tm_nopad[L][j * self.nx + i]     # foreign pads never block the net's own pad
                    pcells.append(cs)
                cache[wc] = (tm, vm, pcells)
                return cache[wc]

            def width_for(pa, pb):
                # connections that touch an IC pin (0.65 mm pitch TSSOP) are necked to 0.2 mm so that the track leaves the
                # pad with >= 0.4 mm to the neighbouring hi-Z pin track
                if w > 0.2 and (pa["ref"] in self.narrow_refs or pb["ref"] in self.narrow_refs):
                    return 0.2
                return w
            attract = None
            if net in self.pair_partner and any(t[0] == self.pair_partner[net] for t in self.tracks):
                attract = {L: bytearray(self.nx * self.ny) for L in (L_F, L_B, L_I2)}
                for (x0, y0, x1, y1, n2, kind) in self.copper[L_F] + self.copper[L_B]:
                    pass
                for L in (L_F, L_B, L_I2):
                    for (x0, y0, x1, y1, n2, kind) in self.copper[L]:
                        if n2 == self.pair_partner[net] and kind == "track":
                            self.mark(attract[L], (x0, y0, x1, y1), self.pair_reach)
            tm0, vm0, pcells = build(w)
            tree = set(pcells[0])
            tree_pad_refs = [pads[0]]
            remaining = list(range(1, len(pads)))
            failed = None
            while remaining:
                best = min(remaining, key=lambda k: min(abs(pads[k]["x"] - self.xy(i, j)[0]) + abs(pads[k]["y"] - self.xy(i, j)[1]) for (_, i, j) in list(tree)[:400]))
                # nearest tree pad decides the width class of the connection (the tree seed or an earlier pad)
                near = min(tree_pad_refs, key=lambda q: abs(q["x"] - pads[best]["x"]) + abs(q["y"] - pads[best]["y"]))
                wc = width_for(near, pads[best])
                tm, vm, pc = build(wc)
                path = self.search(tree, pc[best], tm, vm, allow_vias, layers_ok, layer_pref=(L_B, 1), attract=attract)
                if path is None:
                    failed = pads[best]
                    break
                nv = len(self.vias)
                self.commit(net, path, wc)
                for (_, vx, vy) in self.vias[nv:]:
                    for (tmx, vmx, _pc) in cache.values():
                        self.mark(vmx, (vx - VIA_D / 2, vy - VIA_D / 2, vx + VIA_D / 2, vy + VIA_D / 2), VIA_D / 2 + 0.5)
                for (L, i, j) in path:
                    tree.add((L, i, j))
                    for (tmx, vmx, _pc) in cache.values():
                        tmx[L][j * self.nx + i] = 0
                tree |= pc[best]
                tree_pad_refs.append(pads[best])
                remaining.remove(best)
            if failed is None:
                info = {"w": w}
                self.finish_stubs(net, pads, w)
                return True, info
            del self.tracks[snap_t:]
            del self.vias[snap_v:]
            for L in self.copper:
                del self.copper[L][snap_c[L]:]
            info = {"failed_pad": f"{failed['ref']}.{failed['num']}", "tried_w": w}
        return False, info

    def finish_stubs(self, net, pads, w):
        """connect every pad centre to the nearest track end / via of this net with an orthogonal stub; stubs are registered
        as copper so later nets keep their distance"""
        tol = 0.15
        for p in pads:
            lays = p["layers"] or [L_F]
            r = p["rect"]
            best = None
            for (n2, L, xa, ya, xb, yb, w2) in self.tracks:
                if n2 != net or L not in lays:
                    continue
                for (x, y) in ((xa, ya), (xb, yb)):
                    if r[0] - tol <= x <= r[2] + tol and r[1] - tol <= y <= r[3] + tol:
                        d = abs(x - p["x"]) + abs(y - p["y"])
                        if best is None or d < best[0]:
                            best = (d, L, x, y, w2)
            if best is None:
                continue
            d, L, x, y, w2 = best
            if d > 1e-6:
                if abs(y - p["y"]) > 1e-6:
                    self.add_track(net, L, p["x"], p["y"], p["x"], y, w2)
                if abs(x - p["x"]) > 1e-6:
                    self.add_track(net, L, p["x"], y, x, y, w2)

    # ---------------------------------------------------------------- GND vias
    def gnd_vias(self, prefixes=None, skip_done=True):
        b = self.b
        pads = []
        for fp in b.GetFootprints():
            for p in fp.Pads():
                if p.GetNetname() == "GND":
                    if prefixes is not None and f"{fp.GetReference()}.{p.GetNumber()}" not in prefixes:
                        continue
                    if (fp.GetReference(), p.GetNumber()) in self.gnd_done:
                        continue
                    bb = p.GetBoundingBox()
                    pads.append({"obj": p, "ref": fp.GetReference(), "num": p.GetNumber(), "x": p.GetPosition().x / NM, "y": p.GetPosition().y / NM,
                                 "rect": (bb.GetLeft() / NM, bb.GetTop() / NM, bb.GetRight() / NM, bb.GetBottom() / NM),
                                 "layers": [L for lid, L in ((pcbnew.F_Cu, L_F), (pcbnew.B_Cu, L_B)) if p.IsOnLayer(lid)]})
        done = 0
        fail = []

        def attempt(p, radius_cells, allow_vias_in_path):
            for w in (0.3, 0.2, 0.15):
                hw = w / 2
                tm, vm = self.masks("GND", hw, 0.2 if w > 0.15 else 0.15, False, VIA_D / 2, "GND")
                lays = p["layers"] or [L_F]
                cs = self.pad_cells(p, tm, lays)
                for (L, i, j) in cs:
                    tm[L][j * self.nx + i] = 0
                ci, cj = self.cell(p["x"], p["y"])
                R = radius_cells
                targets = set()
                track_cells = set()
                via_legal = set()
                for j in range(max(0, cj - R), min(self.ny, cj + R + 1)):
                    for i in range(max(0, ci - R), min(self.nx, ci + R + 1)):
                        if not vm[j * self.nx + i] and not tm[L_F][j * self.nx + i] and not tm[L_B][j * self.nx + i]:
                            x, y = self.xy(i, j)
                            if any(r[0] - self.gnd_rect_margin <= x <= r[2] + self.gnd_rect_margin and r[1] - self.gnd_rect_margin <= y <= r[3] + self.gnd_rect_margin for r in self.gnd_rects):
                                continue
                            targets.add((lays[0], i, j))
                            via_legal.add((lays[0], i, j))
                for (n2, vx, vy) in self.vias:
                    if n2 == "GND":
                        vi, vj = self.cell(vx, vy)
                        if abs(vi - ci) <= R and abs(vj - cj) <= R:
                            targets.add((lays[0], vi, vj))
                            tm[lays[0]][vj * self.nx + vi] = 0
                if allow_vias_in_path:
                    # second chance: touch an existing, already plane-connected GND track on the pad's layer
                    for (n2, L2, xa, ya, xb, yb, w2) in self.tracks:
                        if n2 != "GND" or L2 != lays[0]:
                            continue
                        ai, aj = self.cell(xa, ya)
                        bi, bj = self.cell(xb, yb)
                        steps = max(abs(bi - ai), abs(bj - aj), 1)
                        for q in range(steps + 1):
                            ti, tj = ai + (bi - ai) * q // steps, aj + (bj - aj) * q // steps
                            if abs(ti - ci) <= R and abs(tj - cj) <= R and 0 <= ti < self.nx and 0 <= tj < self.ny:
                                targets.add((lays[0], ti, tj))
                                track_cells.add((lays[0], ti, tj))
                                tm[lays[0]][tj * self.nx + ti] = 0
                if not targets:
                    continue
                path = self.search(cs, targets, tm, vm, allow_vias_in_path, [L_F, L_B], max_exp=60000)
                if path is None:
                    continue
                L, i, j = path[-1]
                x, y = self.xy(i, j)
                self.commit("GND", path, w)
                on_track = (L, i, j) in track_cells and (L, i, j) not in via_legal
                if not on_track and not any(abs(v[1] - x) < 0.05 and abs(v[2] - y) < 0.05 for v in self.vias if v[0] == "GND"):
                    self.add_via("GND", x, y)
                self.finish_stubs("GND", [p], w)
                return True
            return False

        left = []
        for p in pads:
            self.relax_via_in_pad = False
            if attempt(p, 30, False):
                done += 1
                self.gnd_done.add((p["ref"], p["num"]))
            else:
                left.append(p)
        # second chance for the crowded pads: larger window, a via allowed inside the path (pad -> B.Cu -> via)
        for p in left:
            self.relax_via_in_pad = False
            ok_ = False
            base_gap = self.own_pad_via_gap
            for g in [base_gap] + ([x for x in (0.20, 0.16) if x < base_gap] if self.use_ladder else []):
                self.own_pad_via_gap = g
                ok_ = attempt(p, 60, True)
                if ok_:
                    break
            self.own_pad_via_gap = base_gap
            if not ok_ and self.allow_vip_fallback:
                self.relax_via_in_pad = True
                ok_ = attempt(p, 60, True)
                self.relax_via_in_pad = False
                if ok_:
                    self.vip_nets.add(f"GND:{p['ref']}.{p['num']}")
            if ok_:
                done += 1
                self.gnd_done.add((p["ref"], p["num"]))
            else:
                fail.append(f"{p['ref']}.{p['num']}")
        return done, fail

    def repair_gnd(self, nets_by_name=None, radius=3.0):
        """local rip-up for GND pads that found no via: remove the foreign nets near the pad, tie the pad first, re-route them"""
        pend = self.gnd_pending()
        for pnd in pend:
            snap = (list(self.tracks), list(self.vias), {L: list(v) for L, v in self.copper.items()}, set(self.gnd_done))
            pad = None
            for fp in self.b.GetFootprints():
                if fp.GetReference() == pnd["ref"]:
                    for q in fp.Pads():
                        if q.GetNumber() == pnd["num"] and q.GetNetname() == "GND":
                            pad = (q, fp)
            if pad is None:
                continue
            px, py = pad[0].GetPosition().x / NM, pad[0].GetPosition().y / NM
            near = set()
            for (net, L, xa, ya, xb, yb, w) in self.tracks:
                if net == "GND":
                    continue
                if min(math.hypot(xa - px, ya - py), math.hypot(xb - px, yb - py)) < radius:
                    near.add(net)
            for (net, vx, vy) in self.vias:
                if net != "GND" and math.hypot(vx - px, vy - py) < radius:
                    near.add(net)
            # never rip up hi-Z / electrode nets
            near = {n for n in near if klass(n) not in ("EMG_HIZ", "EMG_ELECTRODE")}
            self.tracks = [t for t in self.tracks if t[0] not in near]
            self.vias = [v for v in self.vias if v[0] not in near]
            for L in self.copper:
                self.copper[L] = [c for c in self.copper[L] if not (c[4] in near and c[5] in ("track", "via"))]
            # tie the pad first
            self.gnd_done.discard((pnd["ref"], pnd["num"]))
            ok = self.gnd_vias(prefixes={f"{pnd['ref']}.{pnd['num']}"})
            good = (pnd["ref"], pnd["num"]) in self.gnd_done
            order = sorted(near, key=lambda n: (PRIORITY.index(klass(n)) if klass(n) in PRIORITY else 99, n))
            if good:
                for n in order:
                    okn, _ = self.route_net(n, klass(n), self.nets_by_name[n])
                    if not okn:
                        good = False
                        break
            if not good:
                self.tracks, self.vias, self.copper, self.gnd_done = snap
                print("repair FAILED for", pnd, "nets", sorted(near), flush=True)
            else:
                print("repair OK for", pnd, "re-routed", sorted(near), flush=True)

    def gnd_pending(self):
        out = []
        for fp in self.b.GetFootprints():
            for p in fp.Pads():
                if p.GetNetname() == "GND" and (fp.GetReference(), p.GetNumber()) not in self.gnd_done:
                    out.append({"ref": fp.GetReference(), "num": p.GetNumber()})
        return out

    # ---------------------------------------------------------------- write back
    def write(self, out):
        b = self.b
        for (net, L, xa, ya, xb, yb, w) in self.tracks:
            if abs(xa - xb) < 1e-9 and abs(ya - yb) < 1e-9:
                continue
            t = pcbnew.PCB_TRACK(b)
            t.SetStart(pcbnew.VECTOR2I(int(round(xa * NM)), int(round(ya * NM))))
            t.SetEnd(pcbnew.VECTOR2I(int(round(xb * NM)), int(round(yb * NM))))
            t.SetWidth(int(round(w * NM)))
            t.SetLayer(LID[L])
            t.SetNet(b.FindNet(net))
            b.Add(t)
        for (net, x, y) in self.vias:
            v = pcbnew.PCB_VIA(b)
            v.SetPosition(pcbnew.VECTOR2I(int(round(x * NM)), int(round(y * NM))))
            v.SetWidth(int(round(VIA_D * NM)))
            v.SetDrill(int(round(VIA_DRILL * NM)))
            v.SetViaType(pcbnew.VIATYPE_THROUGH)
            v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
            v.SetNet(b.FindNet(net))
            b.Add(v)
        pcbnew.SaveBoard(str(out), b)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pcb", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--log", type=Path)
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--no-gnd", action="store_true")
    ap.add_argument("--gnd-front", action="store_true", help="reserve GND vias of previously failed pads before the signals")
    ap.add_argument("--slack", type=float, default=0.03)
    ap.add_argument("--clock-first", action="store_true", help="route X1_OUT / ADC_CLKIN before every other net")
    ap.add_argument("--strict-vias", action="store_true", help="never fall back to via-in-pad: a net that cannot be routed strictly fails")
    ap.add_argument("--via-ladder", action="store_true", help="after the strict via-to-pad gap try 0.20 and 0.16 mm before via-in-pad")
    ap.add_argument("--via-gap", type=float, default=0.25, help="min via-centre to pad-edge distance for own-net pads (mm)")
    ap.add_argument("--no-repair", action="store_true")
    a = ap.parse_args(argv)
    front = ["/ADC/X1_OUT", "/ADC/ADC_CLKIN"] if a.clock_first else []      # optionally route the 8.192 MHz clock before anything else
    gnd_front = []
    for it in range(8):
        b = pcbnew.LoadBoard(str(a.pcb))
        r = Router(b)
        r.slack = a.slack
        r.own_pad_via_gap = a.via_gap
        r.use_ladder = a.via_ladder
        r.allow_vip_fallback = not a.strict_vias
        # GND copper rects (used to keep GND vias out of pads)
        r.gnd_rects = [(x0, y0, x1, y1) for (x0, y0, x1, y1, n, k) in r.copper[L_F] if n == "GND" and k == "pad"]
        print("pass", it, "front", front, flush=True)
        # hemmed-in IC / transistor / oscillator ground pads get their vias first, before the signals use up the room
        r.hiz_nets, r.buf_nets, r.electrode_nets, r.net_clear = set(), set(), set(), {"GND": 0.2}
        if gnd_front and a.gnd_front:
            r.gnd_vias(prefixes=set(gnd_front))
        rep = r.route_all(only=set(a.only) if a.only else None, front=front)
        bad = [x["net"] for x in rep if not x["ok"]]
        # GND pads that could not be tied after all signals were routed are reserved first in the next pass
        if not a.no_gnd and not bad:
            r.gnd_vias()
        if not bad:
            break
        newfront = bad + [n for n in front if n not in bad]
        if newfront == front:
            break
        front = newfront
    res = {"nets": rep, "tracks": len(r.tracks), "vias": len(r.vias), "via_in_pad_fallback": sorted(r.vip_nets), "reduced_via_gap_nets": sorted(r.tight_via_nets)}
    if not a.no_gnd:
        r.gnd_vias()
    if not a.no_gnd and not a.no_repair:
        r.repair_gnd(nets_by_name=getattr(r, "nets_by_name", None))
    if not a.no_gnd:
        res["gnd_vias"] = len(r.gnd_done)
        res["gnd_fail"] = sorted(f"{x['ref']}.{x['num']}" for x in r.gnd_pending()) if hasattr(r, "gnd_pending") else []
        print("GND vias", len(r.gnd_done), "fail", res["gnd_fail"], flush=True)
    r.write(a.out)
    if a.log:
        a.log.write_text(json.dumps(res, indent=1))
    nfail = [x["net"] for x in rep if not x["ok"]]
    print("routed", sum(1 for x in rep if x["ok"]), "failed", nfail, "tracks", len(r.tracks), "vias", len(r.vias))
    return 0


if __name__ == "__main__":
    sys.exit(main())
