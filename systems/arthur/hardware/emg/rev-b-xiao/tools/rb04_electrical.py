#!/usr/bin/env python3
"""RB-04: independent first-order electrical quantities from the routed PCB + the frozen schematic values.
Everything printed is a CALCULATION with the stated model; nothing here is a measurement.

    python3 rb04_electrical.py --pcb board.kicad_pcb --netlist revb.xml --out electrical.json

Layout-derived:  coupling capacitance between nets (coplanar-strip upper bound, parallel axis-aligned runs only), In2-routed
                 length of fast nets (return reference across the 1.065 mm core), nearest ground via to every signal via, hi-Z node
                 capacitance, distance of hi-Z copper to the XIAO module.
Circuit-derived: input impedance and common-mode-to-differential conversion, thermal / amplifier noise, clamp currents,
                 AFE shutdown logic thresholds, start-up / shutdown input excursions, supply filter corners.
"""
import argparse, collections, json, math, sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rb02_sexpr import first, kids, parse

EPS0 = 8.854e-12


def ellipk(k):
    a, b = 1.0, math.sqrt(1 - k * k)
    for _ in range(30):
        a, b = (a + b) / 2, math.sqrt(a * b)
    return math.pi / (2 * a)


def cps_cprime(w, s, er=4.4):
    """coplanar-strip capacitance per length (F/m) between two strips of width w (m) separated by s (m); ignores copper thickness and the nearby plane
    (-> upper bound for strips 0.2 mm above In1)"""
    k = s / (s + 2 * w)
    kp = math.sqrt(1 - k * k)
    return EPS0 * (er + 1) / 2 * ellipk(kp) / ellipk(k)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pcb", type=Path, required=True); ap.add_argument("--netlist", type=Path, required=True); ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    root = parse(a.pcb.read_text())
    segs = []
    for s in kids(root, "segment"):
        st, en = first(s, "start"), first(s, "end")
        segs.append({"net": str(first(s, "net")[1]), "layer": str(first(s, "layer")[1]), "x0": float(st[1]), "y0": float(st[2]), "x1": float(en[1]), "y1": float(en[2]),
                     "w": float(first(s, "width")[1])})
    vias = [(float(first(v, "at")[1]), float(first(v, "at")[2]), str(first(v, "net")[1])) for v in kids(root, "via")]
    out = {}
    # --- coupling (parallel axis-aligned overlaps on the same layer)
    def run(sg):
        return (min(sg["x0"], sg["x1"]), max(sg["x0"], sg["x1"]), min(sg["y0"], sg["y1"]), max(sg["y0"], sg["y1"]))
    pair = collections.defaultdict(float)
    for i, p in enumerate(segs):
        for q in segs[i + 1:]:
            if p["layer"] != q["layer"] or p["net"] == q["net"] or "GND" in (p["net"], q["net"]):
                continue
            ax, bx, ay, by = run(p); cx, dx, cy, dy = run(q)
            horiz_p = ay == by; horiz_q = cy == dy
            vert_p = ax == bx; vert_q = cx == dx
            if horiz_p and horiz_q:
                L = min(bx, dx) - max(ax, cx); gap = abs(ay - cy)
            elif vert_p and vert_q:
                L = min(by, dy) - max(ay, cy); gap = abs(ax - cx)
            else:
                continue
            s = gap - (p["w"] + q["w"]) / 2
            if L <= 0 or s <= 0 or s > 2.0:
                continue
            c = cps_cprime((p["w"] + q["w"]) / 2 * 1e-3, s * 1e-3) * L * 1e-3        # F
            pair[tuple(sorted((p["net"], q["net"])))] += c
    def top(sel, n=10):
        rows = sorted(((c * 1e15, a_, b_) for (a_, b_), c in pair.items() if sel(a_, b_)), reverse=True)[:n]
        return [(round(c, 2), a_, b_) for c, a_, b_ in rows]
    is_hz = lambda n: "/HIZ_" in n
    is_spi = lambda n: n in ("/SCLK", "/MOSI", "/MISO", "/ADC/ADC_CLKIN", "/ADC/X1_OUT", "/ADC/ADC_DOUT", "/XIAO_Brain_Interface/SCLK_MCU", "/XIAO_Brain_Interface/MOSI_MCU")
    is_adcin = lambda n: n.startswith("/CH") and n[-2:] in ("_P", "_N") and "/" not in n[1:]
    out["coupling_fF_upper_bound"] = {
        "hiz_to_anything": top(lambda a_, b_: is_hz(a_) or is_hz(b_)),
        "adc_input_to_spi_clock": top(lambda a_, b_: (is_adcin(a_) and is_spi(b_)) or (is_adcin(b_) and is_spi(a_))),
        "AFE_CAP_to_anything": top(lambda a_, b_: "/ADC/AFE_CAP" in (a_, b_)),
        "ADC_CLKIN_to_anything": top(lambda a_, b_: "/ADC/ADC_CLKIN" in (a_, b_)),
        "X1_OUT_to_anything": top(lambda a_, b_: "/ADC/X1_OUT" in (a_, b_))}
    # --- fast nets on In2 (reference: In1 across the 1.065 mm core; B.Cu is not a plane)
    fast = collections.defaultdict(lambda: collections.defaultdict(float))
    for s in segs:
        if is_spi(s["net"]) or s["net"].startswith("/CH") or "ELEC" in s["net"]:
            fast[s["net"]][s["layer"]] += math.hypot(s["x1"] - s["x0"], s["y1"] - s["y0"])
    out["length_by_layer_mm"] = {n: {k: round(v, 1) for k, v in d.items()} for n, d in fast.items() if is_spi(n)}
    out["in2_length_mm"] = {n: round(d.get("In2.Cu", 0), 1) for n, d in fast.items() if d.get("In2.Cu")}
    out["bcu_length_mm"] = {n: round(d.get("B.Cu", 0), 1) for n, d in fast.items() if d.get("B.Cu") and is_spi(n)}
    # --- return via proximity for signal vias on fast nets
    gv = [(x, y) for x, y, n in vias if n == "GND"]
    rv = []
    for x, y, n in vias:
        if is_spi(n):
            d = min(math.hypot(x - gx, y - gy) for gx, gy in gv)
            rv.append((n, round(x, 2), round(y, 2), round(d, 2)))
    out["fast_signal_vias_nearest_gnd_via_mm"] = sorted(rv, key=lambda r: -r[3])
    # --- hi-Z lengths and node capacitance (0.088 pF/mm for 0.2 mm over In1: RB-03R microstrip estimate) + parts
    r = ET.parse(a.netlist).getroot()
    hz_len = collections.defaultdict(float)
    for s in segs:
        if is_hz(s["net"]):
            hz_len[s["net"]] += math.hypot(s["x1"] - s["x0"], s["y1"] - s["y0"])
    out["hiz_length_mm"] = {n: round(l, 1) for n, l in sorted(hz_len.items())}
    cnode = {}
    for n, l in hz_len.items():
        cnode[n] = round(100.0 + 0.088 * l + 2 * 2.0 + 4.0 + 2.0, 1)    # 100 pF C0G + track + 2 BAV199 halves (2 pF each, datasheet order) + TLV9064 CIC 4 pF + CID 2 pF
    out["hiz_node_capacitance_pF"] = cnode
    # --- distance of hi-Z copper to the XIAO module outline (U1 pads bbox) and to the board edge handled elsewhere
    u1 = [(float(first(f, "at")[1]), float(first(f, "at")[2])) for f in kids(root, "footprint") if any(str(p[2]) == "U1" for p in kids(f, "property") if str(p[1]) == "Reference")]
    ux, uy = u1[0]
    out["hiz_to_xiao_centre_min_mm"] = round(min(math.hypot(((s["x0"] + s["x1"]) / 2) - ux, ((s["y0"] + s["y1"]) / 2) - uy) for s in segs if is_hz(s["net"])), 1)
    # --- circuit calculations
    c = {}
    R_S, R_BIAS = 10e3, 10e6
    for f in (50.0,):
        cn = min(cnode.values()) * 1e-12
        zc = 1 / (2 * math.pi * f * cn)
        zin = abs(1 / (1 / R_BIAS + 1j * 2 * math.pi * f * cn)) + R_S
        c["Zin_single_ended_50Hz_Mohm"] = round(zin / 1e6, 2)
        c["hiz_node_C_pF_min"] = round(cn * 1e12, 1)
        for dz in (1e3, 10e3, 50e3, 100e3):
            c[f"CM_to_DM_at_50Hz_dB_for_electrode_imbalance_{int(dz/1e3)}k"] = round(20 * math.log10(dz / zin), 1)
        c["CM_to_DM_from_1pct_bias_resistor_mismatch_dB_for_Zs50k"] = round(20 * math.log10(50e3 * 0.01 * R_BIAS / R_BIAS ** 2), 1)
    k = 1.380649e-23 * 300
    th = math.sqrt(4 * k * R_S)
    en = 16e-9
    c["noise_nV_rtHz_per_leg_10k_thermal"] = round(th * 1e9, 1)
    for zs in (0.0, 10e3, 50e3, 100e3):
        tot = math.sqrt(2 * (th ** 2 + en ** 2 + 4 * k * zs))
        c[f"input_noise_diff_nV_rtHz_electrode_{int(zs/1e3)}k_at_1kHz"] = round(tot * 1e9, 1)
        c[f"input_noise_uVrms_20_500Hz_electrode_{int(zs/1e3)}k"] = round(tot * math.sqrt(480) * 1e6, 2)
    c["TLV9064_0.1-10Hz_noise_uVpp_datasheet"] = 4.77
    # clamp current from a fault source through the 10 k limiter (BAV199 clamp to AFE_3V0 / GND), static
    for v in (5.0, 12.0, 50.0):
        c[f"clamp_current_mA_electrode_{int(v)}V"] = round((v - 3.7) / R_S * 1e3, 2) if v > 3.7 else 0
    c["limiter_resistor_power_W_at_230Vrms"] = round(230 ** 2 / R_S, 2)
    # USB inhibit
    vbus_max, vbus_min = 5.25, 4.5
    c["Vgate_min_V"] = round(4.75 * 100 / 110, 2); c["Vgate_max_V"] = round(vbus_max * 100 / 110, 2)
    c["USB_PRESENT_V_at_4.5V_5.25V"] = [round(vbus_min * 150 / 250, 2), round(vbus_max * 150 / 250, 2)]
    c["AFE_EN_V_when_USB_absent_and_request_high"] = round(3.3 * 100 / 110, 2)
    c["AFE_EN_V_when_inhibited_Rdson_7.5ohm"] = round(3.3 * 7.5 / (10e3 + 7.5) * 1e3, 1)
    # shutdown excursion: coupling caps hold VCM (1.5 V) when the rail collapses
    c["shutdown_C101_tau_s"] = round(100e3 * 2.2e-6, 2)
    c["AFE_cutoff_RC_Hz_R4_7_Ceff10uF"] = round(1 / (2 * math.pi * 4.7 * 10e-6), 0)
    c["VCM_divider_tau_ms"] = round(50e3 * 1.1e-6 * 1e3, 0)
    c["HPF_corner_Hz"] = round(1 / (2 * math.pi * 100e3 * 2.2e-6), 2)
    c["ADS131M04_Zin_diff_kohm_gain1"] = 300
    c["gain_error_pct_from_R107_R108_into_300k"] = round(2 * 1e3 / 300e3 * 100, 2)
    out["circuit"] = c
    a.out.write_text(json.dumps(out, indent=1, default=list))
    print(json.dumps({k: out[k] for k in ("coupling_fF_upper_bound", "in2_length_mm", "bcu_length_mm", "hiz_to_xiao_centre_min_mm")}, indent=0, default=list)[:2600])
    print(json.dumps(out["circuit"], indent=0)[:1800])
    print("far signal vias from a GND via:", out["fast_signal_vias_nearest_gnd_via_mm"][:6])
    print("hi-Z node C:", out["hiz_node_capacitance_pF"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
