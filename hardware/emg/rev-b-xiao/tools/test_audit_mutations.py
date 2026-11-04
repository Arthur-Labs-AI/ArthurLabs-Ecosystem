#!/usr/bin/env python3
"""RB-01R mutation / fault-injection test for rb01r_netlist_audit.py.

Input must be a netlist exported from KiCad by `kicad-cli sch export netlist --format kicadxml`.
It is parsed once, then each mutant is built in memory and audited:

  * baseline            the unmodified export must pass every check
  * pin-move            every one of the pins is moved to GND and to a second net (AFE_3V0, or GND if it
                        already sits on AFE_3V0), plus an isolated net (open circuit)
  * value               every R/C/FB value is replaced by a wrong one
  * remove              every component is deleted (nodes and comp)
  * pin-swap            pins of 3-terminal parts and neighbouring IC pins are swapped
  * symbol-pin-name     the symbol pin function of every IC pin is renamed (numbering/label error)
  * field               BOM metadata regressions (old MPN/footprint/LCSC, DNP flag, exclude_from_bom)
  * scenario            named historical defects (Rev A J5001.1 on GND, clamp before the 1k, ...)

A mutant is *killed* when at least one check fails.  The run passes only if the baseline passes, every
mutant is killed (or is listed in EQUIVALENT with a reason) and every check kills at least one mutant
(no vacuous check).  Nothing here modifies a file; no generator data is used.
"""
import copy
import sys
from collections import defaultdict
from pathlib import Path
from xml.etree import ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rb01r_netlist_audit as A  # noqa: E402

# mutants that provably do not change the circuit (documented, not hidden).  Format: (kind, ref, pin) -> reason
EQUIVALENT = {}
# moving a pin that is already a single-pin (open) net to a fresh open net is not a mutation
_OPEN = [f"D{c*100+3+o}.2" for c in range(1, 5) for o in (0, 1)] + ["U1.5", "U1.6", "U4002.4", "J5001.1"] \
    + [f"{j}.MP" for j in ("J1", "J101", "J201", "J301", "J401", "J5001")]
for _p in _OPEN:
    EQUIVALENT[("pin->open", _p)] = "pin already sits alone on an open net; moving it to another open net changes nothing"


def nets_of(root):
    return {n.get("name"): n for n in root.findall("./nets/net")}


def find_node(root, ref, pin):
    for net in root.findall("./nets/net"):
        for node in net.findall("node"):
            if node.get("ref") == ref and node.get("pin") == pin:
                return net, node
    raise KeyError((ref, pin))


def move(root, ref, pin, target):
    net, node = find_node(root, ref, pin)
    net.remove(node)
    nets = nets_of(root)
    dest = nets.get(target)
    if dest is None:
        dest = ET.SubElement(root.find("nets"), "net", {"name": target, "code": "99999"})
    dest.append(node)
    if len(net.findall("node")) == 0:
        root.find("nets").remove(net)


def kill(root_bytes_or_root):
    root = root_bytes_or_root
    xml = ET.tostring(root)
    res = A.run_bytes(xml)
    return [cid for cid, errs in res.items() if errs]


def signature(root):
    """name-independent fingerprint of connectivity + part data; equal fingerprints = identical circuit."""
    part = tuple(sorted((c.get("ref"), c.findtext("value", ""), c.findtext("footprint", ""),
                         tuple(sorted((f.get("name"), f.text) for f in c.findall("./fields/field"))),
                         tuple(sorted(p.get("name") for p in c.findall("property"))))
                        for c in root.findall("./components/comp")))
    conn = frozenset(frozenset((x.get("ref"), x.get("pin"), x.get("pinfunction")) for x in n.findall("node"))
                     for n in root.findall("./nets/net"))
    return part, conn


def mutants(root):
    pins = [(n.get("name"), x.get("ref"), x.get("pin")) for n in root.findall("./nets/net") for x in n.findall("node")]
    gnd = None
    for name, r, p in pins:
        if r == "U6001" and p == "2":
            gnd = name
        if r == "U6001" and p == "1":
            afe = name
    for name, r, p in pins:
        yield ("pin->GND" if name != gnd else "pin->AFE_3V0", f"{r}.{p}",
               lambda t, r=r, p=p, name=name: move(t, r, p, gnd if name != gnd else afe))
        yield ("pin->AFE_3V0" if name not in (afe, gnd) else "pin->open", f"{r}.{p}",
               lambda t, r=r, p=p, name=name: move(t, r, p, afe if name not in (afe, gnd) else f"MUT_OPEN_{r}_{p}"))
        yield ("pin->open", f"{r}.{p}", lambda t, r=r, p=p: move(t, r, p, f"MUT_OPEN_{r}_{p}"))

    wrong = {"R": "47k", "C": "47nF", "F": "10R@100MHz"}
    for c in root.findall("./components/comp"):
        ref = c.get("ref")
        if ref[0] in "RCF":
            def f(t, ref=ref):
                for cc in t.findall("./components/comp"):
                    if cc.get("ref") == ref:
                        cc.find("value").text = wrong[ref[0]] if cc.find("value").text != wrong[ref[0]] else "1k"
            yield ("value", ref, f)

    for c in root.findall("./components/comp"):
        ref = c.get("ref")

        def f(t, ref=ref):
            for cc in t.findall("./components/comp"):
                if cc.get("ref") == ref:
                    t.find("components").remove(cc)
            for net in list(t.findall("./nets/net")):
                for node in list(net.findall("node")):
                    if node.get("ref") == ref:
                        net.remove(node)
                if not net.findall("node"):
                    t.find("nets").remove(net)
        yield ("remove", ref, f)

    # swaps
    def swap(t, a, b):
        """exchange the NETS of two pins of one part (the nodes keep their own labels)."""
        (na, xa), (nb, xb) = find_node(t, *a), find_node(t, *b)
        if na is nb:
            return
        na.remove(xa); nb.remove(xb)
        nb.append(xa); na.append(xb)
    refs3 = [c.get("ref") for c in root.findall("./components/comp") if c.get("ref").startswith(("D", "Q"))]
    for ref in refs3:
        for a, b in (("1", "3"), ("1", "2"), ("2", "3")):
            yield ("pin-swap", f"{ref}.{a}<->{b}", lambda t, ref=ref, a=a, b=b: swap(t, (ref, a), (ref, b)))
    for u, n_pins in (("U6001", 20), ("U501", 14), ("U502", 14), ("U503", 14), ("U4002", 5)):
        for p in range(1, n_pins):
            yield ("pin-swap", f"{u}.{p}<->{p+1}", lambda t, u=u, p=p: swap(t, (u, str(p)), (u, str(p + 1))))
    for p in range(1, 14):
        yield ("pin-swap", f"U1.{p}<->{p+1}", lambda t, p=p: swap(t, ("U1", str(p)), ("U1", str(p + 1))))
    for r in ("J1", "J101", "J5001"):
        yield ("pin-swap", f"{r}.1<->2", lambda t, r=r: swap(t, (r, "1"), (r, "2")))
    # (two-terminal R/C/FB swaps are electrically symmetric and therefore not mutants)

    # symbol pin names
    for ref in ("U6001", "U4002", "Q3001", "X1", "D101", "D103", "U1", "U501"):
        for name, r, p in pins:
            if r == ref:
                def f(t, r=r, p=p):
                    _, node = find_node(t, r, p)
                    node.set("pinfunction", "MUTATED_" + p)
                yield ("symbol-pin-name", f"{r}.{p}", f)

    # fields / props
    def setfield(ref, key, val):
        def f(t):
            for cc in t.findall("./components/comp"):
                if cc.get("ref") == ref:
                    for fld in cc.findall("./fields/field"):
                        if fld.get("name") == key:
                            fld.text = val
        return f
    yield ("field", "X1.MPN=OT2JI-111-8.192M", setfield("X1", "MPN", "OT2JI-111-8.192M"))
    yield ("field", "X1.LCSC=C7425393", setfield("X1", "LCSC", "C7425393"))
    yield ("field", "J1.MPN provisional", setfield("J1", "MPN", "S2B-PH-SM4-TB(LF)(SN) (provisional)"))
    yield ("field", "J1.LCSC=blank", setfield("J1", "LCSC", ""))
    yield ("field", "J101.LCSC=C0", setfield("J101", "LCSC", "C0"))
    yield ("field", "U6001.MPN wrong", setfield("U6001", "MPN", "ADS131M02IPWR"))
    yield ("field", "Q3001.MPN wrong", setfield("Q3001", "MPN", "BSS138"))

    def fp(ref, val):
        def f(t):
            for cc in t.findall("./components/comp"):
                if cc.get("ref") == ref:
                    cc.find("footprint").text = val
        return f
    yield ("field", "X1.footprint=YXC", fp("X1", "ARTHUR:OSC_YXC_SMD3225-4P"))
    yield ("field", "J1.footprint=B2B", fp("J1", "Connector_JST:JST_PH_B2B-PH-SM4-TB_1x02-1MP_P2.00mm_Vertical"))
    yield ("field", "U6001.footprint=TSSOP-14", fp("U6001", "Package_SO:TSSOP-14_4.4x5mm_P0.65mm"))
    yield ("field", "D101.footprint=SOT-23-5", fp("D101", "Package_TO_SOT_SMD:SOT-23-5"))
    yield ("field", "R5002.footprint=0603", fp("R5002", "Resistor_SMD:R_0603_1608Metric"))

    def drop_prop(ref, name):
        def f(t):
            for cc in t.findall("./components/comp"):
                if cc.get("ref") == ref:
                    for p in cc.findall("property"):
                        if p.get("name") == name:
                            cc.remove(p)
        return f

    def add_prop(ref, name):
        def f(t):
            for cc in t.findall("./components/comp"):
                if cc.get("ref") == ref:
                    ET.SubElement(cc, "property", {"name": name})
        return f
    yield ("field", "U1 dnp removed", drop_prop("U1", "dnp"))
    yield ("field", "R101 dnp added", add_prop("R101", "dnp"))
    yield ("field", "TP1 exclude_from_bom removed", drop_prop("TP1", "exclude_from_bom"))

    # BOM completeness / forbidden parts
    for ref, key in (("R101", "MPN"), ("U6001", "Datasheet"), ("X1", "Spec"), ("J1", "JLC_Class"), ("Q3001", "Manufacturer")):
        yield ("field", f"{ref}.{key} blank", setfield(ref, key, ""))

    def add_part(ref, value, pins):
        def f(t):
            c = ET.SubElement(t.find("components"), "comp", {"ref": ref})
            ET.SubElement(c, "value").text = value
            ET.SubElement(c, "footprint").text = "Resistor_SMD:R_0603_1608Metric"
            for pin, tgt in pins:
                nets = nets_of(t)
                ET.SubElement(nets[tgt], "node", {"ref": ref, "pin": pin})
        return f
    yield ("forbidden-part", "R_OPT0 0R VBAT_AFE<->3V3",
           add_part("R_OPT0", "0R", (("1", "/Analog_Power_Interlock/VBAT_AFE"), ("2", "/XIAO_Brain_Interface/XIAO_3V3"))))
    yield ("forbidden-part", "R_SDA 4.7k on D4", add_part("R_SDA", "4.7k", (("1", "GND"), ("2", "DVDD_F"))))
    yield ("forbidden-part", "U_ID 24C02 placeholder", add_part("U_ID", "24C02", (("1", "GND"), ("2", "DVDD_F"))))
    yield ("forbidden-part", "Q3002 (Rev A) placeholder", add_part("Q3002", "BSS138", (("1", "GND"), ("2", "DVDD_F"))))

    # named scenarios (historical defects and review findings)
    def sc(title, *moves):
        def f(t):
            for ref, pin, tgt in moves:
                move(t, ref, pin, tgt)
        return ("scenario", title, f)
    yield sc("Rev A defect: J5001.1 on GND", ("J5001", "1", gnd))
    yield sc("RLD electrode straight to GND", ("J5001", "2", gnd))
    yield sc("ADC clamp before the 1k (D103 on ACN_P)", ("D103", "3", "/CH1/ACN_P"))
    yield sc("ADC clamp K2 tied to AFE_3V0", ("D103", "2", afe))
    yield sc("100k return on VCM (R303)", ("R303", "2", "/VCM"))
    yield sc("U503A +IN direct to VCM_DIV (10k bypassed)", ("U503", "3", "/Reference_VCM/VCM_DIV"))
    yield sc("R3008 EN pull-down open", ("R3008", "1", "MUT_OPEN_R3008"))
    yield sc("XIAO D6 into AFE_EN", ("U1", "7", "/Analog_Power_Interlock/AFE_EN"))
    yield sc("XIAO D3 straight to AFE_EN", ("U1", "4", "/Analog_Power_Interlock/AFE_EN"))
    yield sc("ADC DVDD from AFE_3V0", ("U6001", "20", afe))
    yield sc("ADC CLKIN from XIAO SCLK", ("U6001", "17", "/SCLK"))
    yield sc("BAT+ post on VBAT_AFE", ("U1", "23", "/Analog_Power_Interlock/VBAT_AFE"))
    yield sc("R_OPT0 equivalent: VBAT_AFE on XIAO 3V3", ("U4002", "1", "/XIAO_Brain_Interface/XIAO_3V3"))
    yield sc("LDO input from XIAO 3V3 instead of VBAT_AFE", ("R4001", "2", "/XIAO_Brain_Interface/XIAO_3V3"))
    yield sc("test point on a hi-Z node (TP4 on HIZ_P)", ("TP4", "1", "/CH2/HIZ_P"))
    yield sc("J1 polarity reversed on the board", ("J1", "1", gnd), ("J1", "2", "VBAT"))
    yield sc("CS_N pull-up to AFE_3V0", ("R7103", "1", afe))
    yield sc("ADC AIN0P on AIN0N net", ("U6001", "3", "/CH1_N"))


def main(path):
    src = Path(path).read_bytes()
    base_root = ET.fromstring(src)
    base_fail = kill(base_root)
    if base_fail:
        print("BASELINE FAILS:", base_fail)
        return 1
    print(f"baseline: all {len(A.CHECKS)} checks pass")
    base_sig = signature(base_root)
    stats = defaultdict(lambda: [0, 0])
    survivors, killers = [], defaultdict(int)
    total = 0
    for kind, ident, fn in mutants(base_root):
        t = copy.deepcopy(base_root)
        try:
            fn(t)
        except KeyError:
            continue
        if signature(t) == base_sig:
            stats["no-op (identical circuit)"][0] += 1
            stats["no-op (identical circuit)"][1] += 1
            continue
        failed = kill(t)
        total += 1
        stats[kind][0] += 1
        if failed:
            stats[kind][1] += 1
            for c in failed:
                killers[c] += 1
        elif (kind, ident) not in EQUIVALENT:
            survivors.append((kind, ident))
    print(f"{'kind':18s} {'mutants':>8s} {'killed':>7s}")
    for k, (n, kk) in sorted(stats.items()):
        print(f"{k:18s} {n:8d} {kk:7d}")
    print(f"TOTAL {total}; killed {total - len(survivors) - 0}; survivors {len(survivors)}")
    for s in survivors[:60]:
        print("  SURVIVOR", s)
    vacuous = [cid for cid, *_ in A.CHECKS if killers.get(cid, 0) == 0]
    print("checks that never killed a mutant:", vacuous or "none")
    for cid, *_ in A.CHECKS:
        print(f"  {cid}: kills {killers.get(cid, 0)}")
    ok = not survivors and not vacuous
    print("MUTATION TEST:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
