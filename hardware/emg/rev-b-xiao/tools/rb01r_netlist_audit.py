#!/usr/bin/env python3
"""RB-01R independent audit of a KiCad-exported XML netlist (Rev B).

Input : the output of  `kicad-cli sch export netlist --format kicadxml`  (never the schematic generator,
        never a file written by it).
Oracle: everything below is hand-authored from (a) the manufacturer pin tables / absolute-maximum tables
        listed in DATASHEET_* and (b) the frozen RB-00/RB-00.5/RB-00.6 requirement documents.  It imports no
        generator data.  The supplied external RB-01R checker (67 structural assertions) is kept as
        group `S*`, unchanged in intent; groups `D*`, `L*`, `P*`, `R*`, `B*` are new.

Exit status 0 only if every check passes.  Run with --json for machine output, --list for the check table.

Limitations (see README.md): connectivity and BOM metadata only.  No analog simulation, no ERC, no
footprint geometry, no patient-safety claim.  The author of the rules also read the netlist, so rules and
netlist may share a mistake; the datasheet pin tables and the mutation suite are the defence.
"""
import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from xml.etree import ElementTree as ET

# --------------------------------------------------------------------------- datasheet pin tables
# TI ADS131M04 SBAS890D Table 5-1, TSSOP (PW) column
DATASHEET_ADS131M04_PW = {
    1: "AVDD", 2: "AGND", 3: "AIN0P", 4: "AIN0N", 5: "AIN1N", 6: "AIN1P", 7: "AIN2P", 8: "AIN2N",
    9: "AIN3N", 10: "AIN3P", 11: "SYNC/RESET", 12: "CS", 13: "DRDY", 14: "SCLK", 15: "DOUT",
    16: "DIN", 17: "CLKIN", 18: "CAP", 19: "DGND", 20: "DVDD"}
# TI TLV9064 SBOS839N Table 5-5, SOIC/TSSOP column
DATASHEET_TLV9064_PW = {
    1: "OUT1", 2: "IN1-", 3: "IN1+", 4: "V+", 5: "IN2+", 6: "IN2-", 7: "OUT2", 8: "OUT3",
    9: "IN3-", 10: "IN3+", 11: "V-", 12: "IN4+", 13: "IN4-", 14: "OUT4"}
# TI TPS7A20 SBVS338H, SOT-23 (DBV) column
DATASHEET_TPS7A20_DBV = {1: "IN", 2: "GND", 3: "EN", 4: "NC", 5: "OUT"}
# Nexperia BAV199 (1 Apr 2023) Table 2; Nexperia 2N7002 SOT23: 1 G, 2 S, 3 D
DATASHEET_BAV199 = {1: "A1", 2: "K2", 3: "K1/A2"}
DATASHEET_2N7002 = {1: "G", 2: "S", 3: "D"}
# SCTF SX3M (3CM) family datasheet rev 05/12/2026, "Dimensions" page
DATASHEET_SCTF_3CM = {1: "OE", 2: "GND", 3: "OUT", 4: "VDD"}
# Seeed Studio XIAO ESP32S3 (wiki pinout + OPL_Kicad_Library symbol XIAO-ESP32-S3-SMD)
DATASHEET_XIAO = {1: "D0/GPIO1", 2: "D1/GPIO2", 3: "D2/GPIO3", 4: "D3/GPIO4", 5: "D4/GPIO5", 6: "D5/GPIO6",
                  7: "D6/GPIO43", 8: "D7/GPIO44", 9: "D8/GPIO7", 10: "D9/GPIO8", 11: "D10/GPIO9",
                  12: "3V3", 13: "GND", 14: "5V", 23: "BAT+"}

ADC_P = {1: 3, 2: 6, 3: 7, 4: 10}     # AINxP pin for EMG channel k (AIN0P=3, AIN1P=6, AIN2P=7, AIN3P=10)
ADC_N = {1: 4, 2: 5, 3: 8, 4: 9}      # AINxN
# follower pins (IN+, IN-, OUT) of the TLV9064 amplifier that buffers each leg
AMP = {("P", 1): ("U501", 3, 2, 1), ("N", 1): ("U501", 5, 6, 7), ("P", 2): ("U501", 10, 9, 8),
       ("N", 2): ("U501", 12, 13, 14), ("P", 3): ("U502", 3, 2, 1), ("N", 3): ("U502", 5, 6, 7),
       ("P", 4): ("U502", 10, 9, 8), ("N", 4): ("U502", 12, 13, 14)}

UNIT = {"p": 1e-12, "n": 1e-9, "u": 1e-6, "m": 1e-3, "k": 1e3, "M": 1e6, "R": 1.0}


def num(v):
    """'2.2uF' -> 2.2e-6, '1.0k' -> 1000, '4.7' -> 4.7, '10M' -> 1e7 (None if not numeric)."""
    m = re.fullmatch(r"\s*([0-9]*\.?[0-9]+)\s*([pnumkMR]?)\s*[FfΩ]?\s*", v or "")
    if not m:
        return None
    return float(m.group(1)) * UNIT.get(m.group(2), 1.0)


def close(a, b):
    return a is not None and b is not None and abs(a - b) <= 1e-9 + 1e-6 * abs(b)


# --------------------------------------------------------------------------- netlist model
class NL:
    def __init__(self, xml_bytes):
        root = ET.fromstring(xml_bytes)
        self.comp = {}
        for c in root.findall("./components/comp"):
            ref = c.get("ref")
            fields = {f.get("name", ""): (f.text or "") for f in c.findall("./fields/field")}
            props = {}
            for p in c.findall("property"):
                props[p.get("name", "")] = p.get("value")
            self.comp[ref] = dict(value=c.findtext("value", ""), footprint=c.findtext("footprint", ""),
                                  fields=fields, props=props,
                                  libsource=(c.find("libsource").get("part") if c.find("libsource") is not None else ""))
        self.pin = {}        # (ref, pin) -> net
        self.func = {}       # (ref, pin) -> symbol pin function (pinfunction attr)
        self.members = defaultdict(list)
        self.dup = []
        for net in root.findall("./nets/net"):
            nm = net.get("name", "")
            for n in net.findall("node"):
                k = (n.get("ref"), n.get("pin"))
                if k in self.pin:
                    self.dup.append(k)
                self.pin[k] = nm
                self.func[k] = n.get("pinfunction", "")
                self.members[nm].append(k)

    def net(self, ref, pin):
        return self.pin.get((ref, str(pin)))

    def same(self, *rp):
        ns = [self.net(r, p) for r, p in rp]
        return all(x is not None and x == ns[0] for x in ns)

    def nc(self, ref, pin):
        nm = self.net(ref, pin)
        return nm is not None and len(self.members[nm]) == 1

    def val(self, ref):
        return self.comp.get(ref, {}).get("value", "")

    def numval(self, ref):
        return num(self.val(ref))

    def other(self, ref, pin):
        """net on the opposite terminal of a 2-terminal part."""
        return self.net(ref, "2" if str(pin) == "1" else "1")

    def on_net(self, net, prefix=None):
        return [(r, p) for r, p in self.members.get(net, []) if prefix is None or r.startswith(prefix)]


# --------------------------------------------------------------------------- expected partition
def leg_refs(c, side):
    b = c * 100
    o = 0 if side == "P" else 1
    return dict(rs=f"R{b+1+o}", rb=f"R{b+5+o}", cac=f"C{b+1+o}", chz=f"C{b+3+o}", rdc=f"R{b+3+o}",
                rai=f"R{b+7+o}", cai=f"C{b+6+o}", dhz=f"D{b+1+o}", dai=f"D{b+3+o}", cdiff=f"C{b+5}",
                j=f"J{c}01")


def expected_groups():
    """Return list of (label, set((ref,pin))) describing every electrical node of the design.
    Written from the datasheet roles and the RB-00..RB-00.6 documents; no generator data."""
    G = []

    def g(label, *pins):
        G.append((label, {(r, str(p)) for r, p in pins}))

    gnd, afe, vcm = [], [], []
    for c in range(1, 5):
        for side in ("P", "N"):
            L = leg_refs(c, side)
            u, ip, im, out = AMP[(side, c)]
            pin_j = 1 if side == "P" else 2
            adc = (ADC_P if side == "P" else ADC_N)[c]
            g(f"CH{c}{side}_ELEC", (L["j"], pin_j), (L["rs"], 1))
            g(f"CH{c}{side}_HIZ", (L["rs"], 2), (u, ip), (L["chz"], 1), (L["rb"], 2), (L["dhz"], 3))
            g(f"CH{c}{side}_BUF", (u, out), (u, im), (L["cac"], 1))
            g(f"CH{c}{side}_ACN", (L["cac"], 2), (L["rdc"], 1), (L["rai"], 1))
            diff_pin = (L["cdiff"], 1 if side == "P" else 2)
            g(f"CH{c}{side}_AIN", (L["rai"], 2), ("U6001", adc), (L["cai"], 1), (L["dai"], 3), diff_pin)
            gnd += [(L["chz"], 2), (L["cai"], 2), (L["rdc"], 2), (L["dhz"], 1), (L["dai"], 1)]
            afe += [(L["dhz"], 2)]
            vcm += [(L["rb"], 1)]
    # references / VCM
    vcm += [("R5002", 1), ("TP4", 1), ("U503", 1), ("U503", 2), ("U503", 5), ("U503", 10), ("U503", 12)]
    g("VCM", *vcm)
    g("VCM_DIV", ("C5001", 1), ("C5002", 1), ("R5003", 2), ("R5004", 1), ("R5005", 1))
    g("VCM_BUF_IN", ("R5005", 2), ("U503", 3))
    g("U503B", ("U503", 6), ("U503", 7))
    g("U503C", ("U503", 9), ("U503", 8))
    g("U503D", ("U503", 13), ("U503", 14))
    g("RLD_SAFE", ("J5001", 2), ("R5002", 2), ("TP5", 1))
    g("J5001_PIN1_NC", ("J5001", 1))
    # analog supply
    afe += [("U4002", 5), ("U6001", 1), ("U501", 4), ("U502", 4), ("U503", 4), ("C501", 1), ("C502", 1), ("C503", 1),
            ("C6007", 1), ("C4006", 1), ("R5003", 1), ("TP2", 1)]
    g("AFE_3V0", *afe)
    g("VBAT", ("J1", 1), ("R4001", 1), ("R7107", 1), ("TP1", 1), ("U1", 23))
    g("VBAT_AFE", ("R4001", 2), ("C4007", 1), ("C4005", 1), ("U4002", 1))
    g("AFE_EN", ("U4002", 3), ("Q3001", 3), ("R3007", 2), ("R3008", 1), ("TP6", 1))
    g("AFE_EN_REQ", ("R3007", 1), ("U1", 4))
    g("VBUS_GATE", ("Q3001", 1), ("R3004", 1), ("R3006", 2))
    g("XIAO_5V", ("U1", 14), ("R3006", 1), ("R3009", 1), ("R7105", 1))
    g("USB_PRESENT", ("U1", 7), ("R7105", 2), ("R7106", 1))
    g("VBAT_SENSE", ("U1", 1), ("R7107", 2), ("R7108", 1), ("C7103", 1))
    g("XIAO_3V3", ("U1", 12), ("FB1", 1))
    g("DVDD_F", ("FB1", 2), ("U6001", 20), ("X1", 1), ("X1", 4), ("C6008", 1), ("C6010", 1), ("C7101", 1),
      ("C7102", 1), ("R7103", 1), ("R7104", 1), ("TP3", 1))
    # ADC digital
    g("CLKIN", ("R6001", 2), ("U6001", 17))
    g("X1_OUT", ("R6001", 1), ("X1", 3))
    g("CAP", ("C6009", 1), ("U6001", 18))
    g("DOUT", ("U6001", 15), ("R6002", 1))
    g("MISO", ("R6002", 2), ("U1", 10))
    g("DRDY_ADC", ("U6001", 13), ("R6003", 1))
    g("DRDY_MCU", ("R6003", 2), ("U1", 2))
    g("SCLK_MCU", ("U1", 9), ("R7101", 1))
    g("SCLK", ("R7101", 2), ("U6001", 14))
    g("MOSI_MCU", ("U1", 11), ("R7102", 1))
    g("MOSI", ("R7102", 2), ("U6001", 16))
    g("CS", ("U1", 8), ("U6001", 12), ("R7103", 2))
    g("SYNC", ("U1", 3), ("U6001", 11), ("R7104", 2))
    # NC items (each a single-pin node)
    for k in range(1, 5):
        for o in (0, 1):
            g(f"D{k*100+3+o}_K2_NC", (f"D{k*100+3+o}", 2))
    g("U4002_NC", ("U4002", 4))
    g("XIAO_D4_NC", ("U1", 5))
    g("XIAO_D5_NC", ("U1", 6))
    for j in ("J1", "J101", "J201", "J301", "J401", "J5001"):
        g(f"{j}_MP_NC", (j, "MP"))
    # ground
    gnd += [("J1", 2), ("Q3001", 2), ("R3004", 2), ("R3008", 2), ("R3009", 2), ("R5004", 2), ("R7106", 2),
            ("R7108", 2), ("C4005", 2), ("C4006", 2), ("C4007", 2), ("C5001", 2), ("C5002", 2), ("C501", 2),
            ("C502", 2), ("C503", 2), ("C6007", 2), ("C6008", 2), ("C6009", 2), ("C6010", 2), ("C7101", 2),
            ("C7102", 2), ("C7103", 2), ("TP7", 1), ("TP8", 1), ("U1", 13), ("U4002", 2), ("U501", 11),
            ("U502", 11), ("U503", 11), ("U6001", 2), ("U6001", 19), ("X1", 2)]
    for c in range(1, 5):
        for o in (0, 1):
            pass
    # differential caps: pin 1 on the P AIN net, pin 2 on the N AIN net (already in AIN groups)
    g("GND", *gnd)
    return G


# --------------------------------------------------------------------------- checks
CHECKS = []


def check(cid, title):
    def deco(fn):
        CHECKS.append((cid, title, fn))
        return fn
    return deco


def norm_func(s):
    s = re.sub(r"_(\d+|MP)$", "", s or "")
    return s.replace("~{", "").replace("}", "")


@check("D01", "Netlist partition equals the hand-authored datasheet/role partition (name independent)")
def d01(n):
    exp = expected_groups()
    seen = set()
    err = []
    for label, s in exp:
        if seen & s:
            err.append(f"internal: overlapping expected group {label}")
        seen |= s
    exp_sets = {frozenset(s): label for label, s in exp}
    got = {}
    for nm, mem in n.members.items():
        got[frozenset(mem)] = nm
    for s, label in exp_sets.items():
        if s not in got:
            # report which pins landed elsewhere
            nets = sorted({str(n.pin.get(p)) for p in s})
            err.append(f"expected node {label} {sorted(s)[:6]} not found as one net (pins sit on {nets[:4]})")
    for s, nm in got.items():
        if s not in exp_sets:
            err.append(f"unexpected net {nm}: {sorted(s)[:8]}")
    allpins = set(n.pin)
    if allpins != seen:
        err.append(f"pins only in netlist: {sorted(allpins - seen)[:5]}; only in expectation: {sorted(seen - allpins)[:5]}")
    if n.dup:
        err.append(f"pins assigned to two nets: {n.dup[:3]}")
    return err


@check("D02", "Symbol pin names equal the manufacturer pin tables (ADS131M04, TPS7A20, BAV199, 2N7002, SCTF, XIAO)")
def d02(n):
    err = []

    def cmp(ref, table, strip=lambda s: s):
        pins = {int(p): f for (r, p), f in n.func.items() if r == ref and p.isdigit()}
        for p, name in table.items():
            got = strip(norm_func(pins.get(p, "")))
            if got != name:
                err.append(f"{ref}.{p}: symbol says '{got}', datasheet says '{name}'")
        extra = set(pins) - set(table)
        if extra:
            err.append(f"{ref}: pins not in the datasheet table: {sorted(extra)}")
    cmp("U6001", DATASHEET_ADS131M04_PW, lambda s: s.replace("~SYNC/~RESET", "SYNC/RESET").replace("~CS", "CS").replace("~DRDY", "DRDY"))
    cmp("U4002", DATASHEET_TPS7A20_DBV)
    for d in [f"D{c}0{k}" for c in range(1, 5) for k in (1, 2, 3, 4)]:
        cmp(d, DATASHEET_BAV199)
    cmp("Q3001", DATASHEET_2N7002)
    cmp("X1", DATASHEET_SCTF_3CM)

    def xi(s):
        return s.replace("5V(VBUS)", "5V").replace("BAT+_(bottom_pad_->_POST)", "BAT+")
    pins = {int(p): xi(norm_func(f)) for (r, p), f in n.func.items() if r == "U1" and p.isdigit()}
    for p, name in DATASHEET_XIAO.items():
        g = pins.get(p, "")
        if not (g == name or g.startswith(name) or (name.split("/")[0] == g.split("/")[0])):
            err.append(f"U1.{p}: symbol '{g}' vs Seeed '{name}'")
    # op-amp symbol pin directions vs datasheet function
    for u in ("U501", "U502", "U503"):
        for p, name in DATASHEET_TLV9064_PW.items():
            f = norm_func(n.func.get((u, str(p)), ""))
            want = {"OUT": "~", "IN": None}
            if name.startswith("OUT") and f != "~":
                err.append(f"{u}.{p}: expected an output pin")
            if name.startswith("IN") and f not in ("+", "-"):
                err.append(f"{u}.{p}: expected + / - input")
            if name.startswith("IN") and f != name[-1].replace("+", "+").replace("-", "-"):
                err.append(f"{u}.{p}: symbol polarity '{f}' vs datasheet '{name}'")
            if name == "V+" and f != "V+":
                err.append(f"{u}.{p}: expected V+")
            if name == "V-" and f != "V-":
                err.append(f"{u}.{p}: expected V-")
    return err


@check("D03", "Every IC pin is on a net with another pin, except the datasheet-NC list")
def d03(n):
    allowed_nc = {("U4002", "4"), ("U1", "5"), ("U1", "6")}
    err = []
    for (r, p), nm in n.pin.items():
        if r[0] == "U" or r == "X1" or r == "Q3001":
            if len(n.members[nm]) == 1 and (r, p) not in allowed_nc and not (r in ("U503",) and False):
                err.append(f"{r}.{p} floats (net {nm})")
    return err


@check("D04", "Single-pin nets are exactly the 18 documented NC items")
def d04(n):
    singles = sorted(f"{r}.{p}" for nm, m in n.members.items() if len(m) == 1 for r, p in m)
    want = sorted([f"D{k*100+3+o}.2" for k in range(1, 5) for o in (0, 1)] + ["U4002.4", "U1.5", "U1.6", "J5001.1"]
                  + [f"{j}.MP" for j in ("J1", "J101", "J201", "J301", "J401", "J5001")])
    return [] if singles == want else [f"single-pin nets {sorted(set(singles) ^ set(want))}"]


@check("D05", "Component values equal the design values per role")
def d05(n):
    err = []

    def v(ref, want):
        got = n.numval(ref)
        if not close(got, want):
            err.append(f"{ref}: value '{n.val(ref)}' != {want:g}")
    for c in range(1, 5):
        for side in ("P", "N"):
            L = leg_refs(c, side)
            v(L["rs"], 10e3); v(L["rb"], 10e6); v(L["cac"], 2.2e-6); v(L["chz"], 100e-12)
            v(L["rdc"], 100e3); v(L["rai"], 1e3); v(L["cai"], 1e-9)
        v(leg_refs(c, "P")["cdiff"], 10e-9)
    for r, x in dict(R5002=100e3, R5003=100e3, R5004=100e3, R5005=10e3, C5001=1e-6, C5002=100e-9, R4001=4.7,
                     C4007=22e-6, C4005=1e-6, C4006=1e-6, C501=100e-9, C502=100e-9, C503=100e-9, C6007=1e-6,
                     C6008=1e-6, C6009=220e-9, C6010=100e-9, C7101=10e-6, C7102=100e-9, C7103=100e-9,
                     R3004=100e3, R3006=10e3, R3007=10e3, R3008=100e3, R3009=4.7e3, R6001=33, R6002=33,
                     R6003=100, R7101=33, R7102=33, R7103=100e3, R7104=10e3, R7105=100e3, R7106=150e3,
                     R7107=1e6, R7108=1e6).items():
        v(r, x)
    if n.val("FB1") != "600R@100MHz":
        err.append(f"FB1 value '{n.val('FB1')}'")
    return err


@check("D06", "Part identities: ICs/diodes/MOSFET/connectors/oscillator MPN, value and footprint")
def d06(n):
    err = []

    def f(ref, key):
        return n.comp.get(ref, {}).get("fields", {}).get(key, "")

    def want(ref, mpn, fp, lcsc=None, mfr=None):
        if ref not in n.comp:
            err.append(f"{ref} missing")
            return
        if f(ref, "MPN") != mpn:
            err.append(f"{ref} MPN '{f(ref,'MPN')}' != '{mpn}'")
        if n.comp[ref]["footprint"] != fp:
            err.append(f"{ref} footprint '{n.comp[ref]['footprint']}' != '{fp}'")
        if lcsc is not None and f(ref, "LCSC") != lcsc:
            err.append(f"{ref} LCSC '{f(ref,'LCSC')}' != '{lcsc}'")
        if mfr is not None and not f(ref, "Manufacturer").startswith(mfr):
            err.append(f"{ref} manufacturer '{f(ref,'Manufacturer')}'")
    want("U6001", "ADS131M04IPWR", "Package_SO:TSSOP-20_4.4x6.5mm_P0.65mm")
    for u in ("U501", "U502", "U503"):
        want(u, "TLV9064IPWR", "Package_SO:TSSOP-14_4.4x5mm_P0.65mm")
    want("U4002", "TPS7A2030PDBVR", "Package_TO_SOT_SMD:SOT-23-5")
    want("Q3001", "2N7002", "Package_TO_SOT_SMD:SOT-23")
    for c in range(1, 5):
        for k in (1, 2, 3, 4):
            want(f"D{c}0{k}", "BAV199", "Package_TO_SOT_SMD:SOT-23", mfr="Nexperia")
    for j in ("J101", "J201", "J301", "J401", "J5001"):
        # Horizontal JST ECO (2026-10-19); pin/net oracle is unchanged.
        want(j, "S2B-PH-SM4-TB(LF)(SN)", "Connector_JST:JST_PH_S2B-PH-SM4-TB_1x02-1MP_P2.00mm_Horizontal", "C295747", "JST")
    want("J1", "S2B-PH-SM4-TB(LF)(SN)", "Connector_JST:JST_PH_S2B-PH-SM4-TB_1x02-1MP_P2.00mm_Horizontal", "C295747", "JST")
    want("X1", "SX3M8.192M20F30TNN", "ARTHUR:OSC_SCTF_SX3M_SMD3225-4P", "C2901557", "SCTF")
    if n.val("X1") != "SX3M8.192M20F30TNN":
        err.append(f"X1 value '{n.val('X1')}'")
    if n.val("J1") != "S2B-PH-SM4-TB":
        err.append(f"J1 value '{n.val('J1')}'")
    if n.comp["U1"]["footprint"] != "ARTHUR:XIAO_ESP32S3_HANDSOLDER":
        err.append("U1 footprint")
    if "dnp" not in n.comp["U1"]["props"]:
        err.append("U1 is not marked DNP")
    for ref, c in n.comp.items():
        if ref != "U1" and "dnp" in c["props"]:
            err.append(f"{ref} unexpectedly DNP")
        if ref.startswith("TP") != ("exclude_from_bom" in c["props"]):
            err.append(f"{ref}: exclude_from_bom mismatch (only test pads are excluded)")
    return err


@check("D07", "Footprints of passives match the package class of the BOM value")
def d07(n):
    err = []
    for ref, c in n.comp.items():
        if ref[0] == "R":
            ok = c["footprint"] == ("Resistor_SMD:R_0805_2012Metric" if ref == "R5002" else "Resistor_SMD:R_0603_1608Metric")
        elif ref[0] == "C":
            ok = c["footprint"] == ("Capacitor_SMD:C_0805_2012Metric" if ref == "C4007" else "Capacitor_SMD:C_0603_1608Metric")
        elif ref == "FB1":
            ok = c["footprint"] == "Inductor_SMD:L_0603_1608Metric"
        elif ref.startswith("TP"):
            ok = c["footprint"] == "TestPoint:TestPoint_Pad_D1.5mm"
        else:
            continue
        if not ok:
            err.append(f"{ref}: footprint {c['footprint']}")
    return err


@check("D08", "Every component carries MPN, Manufacturer, Spec, JLC_Class, Datasheet and Description")
def d08(n):
    err = []
    for ref, c in n.comp.items():
        for k in ("MPN", "Manufacturer", "Spec", "JLC_Class", "Datasheet", "Description"):
            if not c["fields"].get(k, "").strip():
                err.append(f"{ref} lacks {k}")
    return err


@check("D09", "Component census equals the RB-01 BOM (135 refs: 126 assembled, 1 DNP (U1), 8 test pads)")
def d09(n):
    pref = defaultdict(int)
    for r in n.comp:
        pref[re.match(r"[A-Z]+", r).group(0)] += 1
    want = dict(R=53, C=43, D=16, J=6, U=6, X=1, Q=1, FB=1, TP=8)
    err = [f"{k}: {pref.get(k,0)} != {v}" for k, v in want.items() if pref.get(k, 0) != v]
    if sum(want.values()) != len(n.comp):
        err.append(f"total {len(n.comp)} != {sum(want.values())}")
    return err


@check("D10", "Removed Rev A / optional parts are absent (R_OPT0, U_ID, R_SDA, R_SCL, Q3002, R3005, U7001 ...)")
def d10(n):
    gone = ["R_OPT0", "U_ID", "R_SDA", "R_SCL", "Q3002", "R3005", "U7001", "U2001", "U4001", "J3001", "J8001",
            "R3003", "J2001", "L4001"]
    return [f"{r} present" for r in gone if r in n.comp]


# ---- electrical rules computed from connectivity (not from the partition above)
@check("P01", "No patient/electrode connector pin has a resistive path < 10 kohm to GND, to any supply or to XIAO 3V3/5V")
def p01(n):
    gnd = n.net("U6001", 2)
    res = defaultdict(list)           # net -> [(other_net, ohms)]
    for ref, c in n.comp.items():
        if ref[0] == "R" and n.numval(ref) is not None:
            a, b = n.net(ref, 1), n.net(ref, 2)
            res[a].append((b, n.numval(ref)))
            res[b].append((a, n.numval(ref)))
    err = []
    sinks = {gnd: "GND", n.net("U6001", 1): "AFE_3V0", n.net("J1", 1): "VBAT", n.net("U1", 12): "3V3",
             n.net("U1", 14): "5V", n.net("U6001", 20): "DVDD_F"}
    for j in ("J101", "J201", "J301", "J401", "J5001"):
        for pin in ("1", "2"):
            start = n.net(j, pin)
            if start is None or n.nc(j, pin):
                continue
            # Dijkstra on resistances
            dist = {start: 0.0}
            todo = [start]
            while todo:
                todo.sort(key=lambda x: dist[x])
                u = todo.pop(0)
                for v, w in res.get(u, []):
                    if dist[u] + w < dist.get(v, 1e30):
                        dist[v] = dist[u] + w
                        todo.append(v)
            for s, name in sinks.items():
                if s in dist and dist[s] < 10e3 and s != start:
                    err.append(f"{j}.{pin} -> {name}: {dist[s]:.0f} ohm")
    return err


@check("P02", "ADC input clamps: pin 1 = GND, pin 3 = AIN behind the 1k series resistor, pin 2 NC; hi-Z clamps to GND/AFE rail")
def p02(n):
    err = []
    gnd, afe = n.net("U6001", 2), n.net("U6001", 1)
    for c in range(1, 5):
        for side in ("P", "N"):
            L = leg_refs(c, side)
            if not (n.net(L["dai"], 1) == gnd and n.nc(L["dai"], 2)):
                err.append(f"{L['dai']}: ADC clamp pin 1/2 wrong")
            ain = n.net(L["dai"], 3)
            if ain != n.net("U6001", (ADC_P if side == "P" else ADC_N)[c]):
                err.append(f"{L['dai']}.3 not on the ADC pin")
            if n.net(L["rai"], 2) != ain or n.net(L["rai"], 1) == ain:
                err.append(f"{L['dai']} is before the series 1k")
            if not (n.net(L["dhz"], 1) == gnd and n.net(L["dhz"], 2) == afe and n.net(L["dhz"], 3) == n.net(L["rs"], 2)):
                err.append(f"{L['dhz']}: hi-Z clamp wiring")
    return err


@check("P03", "VCM: U503A follower, B/C/D followers on VCM, U503 +IN behind 10k, no loop through patient pins")
def p03(n):
    err = []
    if not n.same(("U503", 1), ("U503", 2)):
        err.append("U503A not a follower")
    for inp, im, out in ((5, 6, 7), (10, 9, 8), (12, 13, 14)):
        if not n.same(("U503", out), ("U503", im)) or not n.same(("U503", inp), ("U503", 1)):
            err.append(f"U503 amp +IN{inp} not a VCM follower")
    if n.same(("U503", 3), ("U503", 1)) or not n.same(("U503", 3), ("R5005", 2)):
        err.append("U503A +IN not behind R5005")
    return err


@check("P04", "Power-down inhibit: EN pulled low (R3008), USB 5V drives Q3001 (gate), D3 only through 10k, D6 sense only")
def p04(n):
    err = []
    en = n.net("U4002", 3)
    gnd = n.net("U6001", 2)
    if not n.same(("Q3001", 3), ("U4002", 3)) or n.net("Q3001", 2) != gnd:
        err.append("Q3001 drain/source")
    if n.net("R3008", 2) != gnd or n.net("R3008", 1) != en:
        err.append("EN pull-down")
    d3 = n.net("U1", 4)
    if d3 == en or not (n.same(("R3007", 1), ("U1", 4)) and n.net("R3007", 2) == en):
        err.append("D3 not isolated by R3007")
    if n.same(("U1", 14), ("Q3001", 1)):
        err.append("5V directly on the gate")
    if not (n.same(("U1", 14), ("R3006", 1)) and n.same(("R3006", 2), ("Q3001", 1))):
        err.append("5V -> R3006 -> gate")
    for p in (7,):
        if n.net("U1", p) in (en, n.net("Q3001", 1)):
            err.append("D6 (USB_PRESENT) is part of the control path")
    return err


@check("P05", "Rail separation: DVDD_F only from XIAO 3V3 via FB1; AFE_3V0 only from U4002; VBAT never on AFE_3V0/DVDD_F")
def p05(n):
    err = []
    afe, dv, vb, v3 = n.net("U6001", 1), n.net("U6001", 20), n.net("J1", 1), n.net("U1", 12)
    if len({afe, dv, vb, v3, n.net("U4002", 1), n.net("U6001", 2)}) != 6:
        err.append("two supply nets are shorted together")
    if n.net("FB1", 1) != v3 or n.net("FB1", 2) != dv:
        err.append("FB1 position")
    if n.net("R4001", 1) != vb or n.net("R4001", 2) != n.net("U4002", 1):
        err.append("R4001 position")
    drivers = [p for p in n.members[afe] if p[0] in ("U4002",) ]
    if drivers != [("U4002", "5")]:
        err.append(f"AFE_3V0 drivers {drivers}")
    return err


@check("P06", "The XIAO castellation map matches the interface spec (CS=D7, SYNC=D2, DRDY=D1, SCK=D8, MISO=D9, MOSI=D10)")
def p06(n):
    err = []
    exp = {8: ("R7103", "U6001", 12), 3: ("R7104", "U6001", 11)}
    if not n.same(("U1", 8), ("U6001", 12)):
        err.append("CS (D7) not on ADC CS")
    if not n.same(("U1", 3), ("U6001", 11)):
        err.append("SYNC (D2) not on ADC SYNC/RESET")
    if not n.same(("U1", 2), ("R6003", 2)):
        err.append("DRDY (D1) via R6003")
    if not n.same(("U1", 9), ("R7101", 1)) or not n.same(("U1", 11), ("R7102", 1)) or not n.same(("U1", 10), ("R6002", 2)):
        err.append("SPI SCK/MOSI/MISO")
    return err


@check("S01", "Supplied RB-01R checks: patient pin 1 NC, MP pads NC, RLD 100k to VCM")
def s01(n):
    e = []
    if not n.nc("J5001", "1"):
        e.append("A01")
    if not n.nc("J5001", "MP"):
        e.append("A03")
    if not (n.numval("R5002") == 100e3 and n.same(("J5001", 2), ("R5002", 2)) and n.same(("R5002", 1), ("U503", 1))):
        e.append("A02")
    return e


@check("S02", "Supplied RB-01R checks: per-channel electrode/clamp/bias/diff-cap wiring (64 assertions)")
def s02(n):
    e = []
    gnd, afe = n.net("U6001", 2), n.net("U6001", 1)
    for c in range(1, 5):
        for side, suf, ain in (("P", 1, ADC_P[c]), ("N", 2, ADC_N[c])):
            L = leg_refs(c, side)
            q = c * 100
            if not (n.numval(f"R{q+suf}") == 10e3 and n.same((f"J{q+1}", suf), (f"R{q+suf}", 1))):
                e.append(f"C{c}{side} electrode series")
            if not n.same((f"R{q+suf}", 2), (f"D{q+suf}", 3)) or n.net(f"D{q+suf}", 1) != gnd or n.net(f"D{q+suf}", 2) != afe:
                e.append(f"C{c}{side} input clamp")
            if not (close(n.numval(f"R{q+6+suf}"), 1e3) and n.same((f"R{q+6+suf}", 2), (f"D{q+2+suf}", 3), ("U6001", ain))
                    and n.net(f"D{q+2+suf}", 1) == gnd and n.nc(f"D{q+2+suf}", 2)):
                e.append(f"C{c}{side} adc clamp")
            if not (n.numval(f"R{q+2+suf}") == 100e3 and n.net(f"R{q+2+suf}", 2) == gnd):
                e.append(f"C{c}{side} AC bias return")
        if not (close(n.numval(f"C{c*100+5}"), 10e-9) and n.same((f"C{c*100+5}", 1), ("U6001", ADC_P[c])) and n.same((f"C{c*100+5}", 2), ("U6001", ADC_N[c]))):
            e.append(f"CH{c} differential cap")
    return e


@check("R01", "The VBAT -> 4.7 ohm -> single 22 uF C_PRE -> LDO path exists once; no second 22 uF part")
def r01(n):
    err = []
    big = [r for r in n.comp if r[0] == "C" and n.numval(r) is not None and n.numval(r) >= 20e-6]
    if big != ["C4007"]:
        err.append(f"22 uF-class capacitors: {big}")
    if not (n.same(("R4001", 2), ("C4007", 1), ("U4002", 1)) and n.net("C4007", 2) == n.net("U6001", 2)):
        err.append("C_PRE not at the LDO input")
    return err


@check("R02", "R_OPT0-style path: no component bridges VBAT_AFE and XIAO 3V3 (or VBAT and 3V3)")
def r02(n):
    err = []
    a, b, c = n.net("U4002", 1), n.net("U1", 12), n.net("J1", 1)
    for ref in n.comp:
        if ref[0] in "RLFC" and ref != "FB1":
            nets = {n.net(ref, 1), n.net(ref, 2)}
            if (a in nets or c in nets) and b in nets:
                err.append(f"{ref} bridges {a if a in nets else c} and 3V3")
    return err


@check("B01", "X1: SCTF pins OE/VDD on DVDD_F, GND on GND, OUT behind the 33 ohm, 100 nF at the oscillator")
def b01(n):
    err = []
    if not n.same(("X1", 1), ("X1", 4), ("U6001", 20), ("C6010", 1)):
        err.append("OE/VDD/DVDD_F/C6010")
    if n.net("X1", 2) != n.net("U6001", 2) or n.net("C6010", 2) != n.net("U6001", 2):
        err.append("X1 GND")
    if not (n.same(("X1", 3), ("R6001", 1)) and n.same(("R6001", 2), ("U6001", 17))):
        err.append("OUT -> 33 ohm -> CLKIN")
    if len(n.members[n.net("X1", 3)]) != 2:
        err.append("X1 OUT has extra loads")
    return err


@check("B02", "J1: pin 1 = VBAT star (XIAO BAT+ post, R4001, VBAT divider), pin 2 = GND; no other connector on VBAT")
def b02(n):
    err = []
    if not n.same(("J1", 1), ("U1", 23), ("R4001", 1), ("R7107", 1)):
        err.append("J1.1 star")
    if n.net("J1", 2) != n.net("U6001", 2) or n.net("J1", 2) != n.net("U1", 13):
        err.append("J1.2 not GND")
    for j in ("J101", "J201", "J301", "J401", "J5001"):
        if n.net(j, 1) == n.net("J1", 1) or n.net(j, 2) == n.net("J1", 1):
            err.append(f"{j} on VBAT")
    return err


@check("B03", "Test pads: exactly TP1..TP8 on VBAT, AFE_3V0, DVDD_F, VCM, RLD_SAFE, AFE_EN, GND, GND; none on hi-Z/AIN/SPI/CLKIN")
def b03(n):
    want = {"TP1": n.net("J1", 1), "TP2": n.net("U6001", 1), "TP3": n.net("U6001", 20), "TP4": n.net("U503", 1),
            "TP5": n.net("J5001", 2), "TP6": n.net("U4002", 3), "TP7": n.net("U6001", 2), "TP8": n.net("U6001", 2)}
    return [f"{t}: net {n.net(t, 1)} != {w}" for t, w in want.items() if n.net(t, 1) != w]


def run(path):
    n = NL(Path(path).read_bytes())
    out = []
    for cid, title, fn in CHECKS:
        try:
            errs = fn(n)
        except Exception as ex:      # a crashing check is a failure, never a pass
            errs = [f"check crashed: {type(ex).__name__}: {ex}"]
        out.append((cid, title, errs))
    return out


def run_bytes(xml_bytes):
    n = NL(xml_bytes)
    res = {}
    for cid, title, fn in CHECKS:
        try:
            res[cid] = fn(n)
        except Exception as ex:
            res[cid] = [f"check crashed: {type(ex).__name__}: {ex}"]
    return res


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("netlist", nargs="?", type=Path)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args(argv)
    if a.list or not a.netlist:
        for cid, title, _ in CHECKS:
            print(f"{cid}  {title}")
        return 0
    res = run(a.netlist)
    bad = [r for r in res if r[2]]
    if a.json:
        print(json.dumps({"checks": len(res), "failed": [r[0] for r in bad],
                          "detail": {r[0]: r[2] for r in bad}}, indent=2))
    else:
        for cid, title, errs in res:
            print(("PASS " if not errs else "FAIL ") + f"{cid} {title}")
            for e in errs[:8]:
                print("      - " + e)
        print(f"{len(res)-len(bad)}/{len(res)} checks passed")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
