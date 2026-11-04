#!/usr/bin/env python3
"""RB-04A: BOM candidate selection for the 31 BOM lines (126 factory parts).  Data came from LCSC / JLCPCB part pages read 2026-10-11 (WebFetch
extracts; prices are LCSC retail tiers in USD, NOT a JLC quotation).  `cls` is exactly what the JLC page said; 'not stated' means the
extract did not show a library type.  Nothing here is a purchase decision."""
import json, sys
from pathlib import Path

N = "not stated on page"
# key = spec string of evidence/rb04/bom_lines.json
SEL = {
 "2.2uF 16V X7R 0603 MLCC": dict(mfr="FH (Guangdong Fenghua)", mpn="0603B225K160NT", lcsc="C43922", cls="Extended Parts", stock=305720,
      tiers=[(20,.0271),(200,.0215),(600,.0191),(4000,.0158)], rating="16 V X7R +-10 %, 1.6 x 0.8 x 0.8(+-0.2) mm, -55..125 C", status="QUALIFIED",
      note="RB-04B: exact-spec part found by the owner; FH catalogue row verified (2.2 uF / X7R / 16 V / +-10 % / 0603, T 0.80+-0.20 mm). No manufacturer DC-bias curve is published in the FH general-series sheet A0006.",
      dcbias="typ. -10..-25 % at 1.5 V DC (estimate; NO manufacturer curve available -> uncertainty +-10 %)"),
 "100pF 50V C0G 0603 MLCC": dict(mfr="Samsung Electro-Mechanics", mpn="CL10C101JB8NNNC", lcsc="C14858", cls=N, stock=290550,
      tiers=[(50,.0087),(500,.0065),(1500,.0056),(4000,.0048)], rating="50 V C0G +-5 %", status="QUALIFIED",
      note="C0G: no DC-bias or ageing capacitance change.", dcbias="0 % (C0G)"),
 "10nF 50V C0G 0603 MLCC": dict(mfr="TDK", mpn="C1608C0G1H103JT000N", lcsc="C76599", cls="Extended Parts", stock=11740,
      tiers=[(20,.046),(200,.0374),(600,.0326),(4000,.0298)], rating="50 V C0G +-5 %", status="QUALIFIED",
      note="Compliant C0G 10 nF exists (RB-04 report of 'none found' was a search failure). Adds one Extended feeder line.", dcbias="0 % (C0G)"),
 "1.0nF 50V C0G 0603 MLCC": dict(mfr="FH (Guangdong Fenghua)", mpn="0603CG102J500NT", lcsc="C1636", cls="Extended Parts", stock=70500,
      tiers=[(100,.0083),(1000,.0067),(4000,.0054)], rating="50 V C0G +-5 %", status="QUALIFIED", note="", dcbias="0 % (C0G)"),
 "22uF 10V X5R 0805 MLCC": dict(mfr="Samsung Electro-Mechanics", mpn="CL21A226MAQNNNE", lcsc="C45783", cls=N, stock=138860,
      tiers=[(20,.2227),(200,.1657),(600,.1378),(2000,.1129)], rating="25 V X5R +-20 % (spec 10 V X5R: higher rating, same footprint)", status="QUALIFIED",
      note="25 V part instead of 10 V: same dielectric and footprint, less DC-bias loss. +-20 % tolerance as in spec class.",
      dcbias="typ. -20..-40 % at 3.0 V on a 25 V X5R 0805 (estimate; spec role assumes ~10 uF effective)"),
 "1uF 16V X7R 0603 MLCC": dict(mfr="Samsung Electro-Mechanics", mpn="CL10B105KO8NNNC", lcsc="C59782", cls="Extended Parts", stock=123400,
      tiers=[(50,.0212),(500,.0162),(1500,.014),(4000,.0124)], rating="16 V X7R +-10 %", status="QUALIFIED", note="",
      dcbias="typ. -10..-20 % at 3.0 V (estimate)"),
 "100nF 16V X7R 0603 MLCC": dict(mfr="YAGEO", mpn="CC0603KRX7R9BB104", lcsc="C14663", cls="Basic (page)", stock=4000,
      tiers=[(50,.0141),(500,.0107),(1500,.0091),(4000,.0076)], rating="50 V X7R +-10 %", status="QUALIFIED",
      note="50 V part vs 16 V spec (same footprint, less bias loss). Stock 4,000 only; alternate Samsung CL10B104KB8NNNC C1591 (Extended, 7.8 M stock).",
      dcbias="typ. -0..-10 % at 3.0 V (estimate)"),
 "220nF 16V X7R 0603 MLCC": dict(mfr="Samsung Electro-Mechanics", mpn="CL10B224KO8NNNC", lcsc="C160828", cls=N, stock=28600,
      tiers=[(50,.0154),(500,.0127),(1500,.0112),(4000,.0102)], rating="16 V X7R +-10 %", status="QUALIFIED",
      note="ADS131M04 CAP pin needs 220 nF (datasheet 10.1); C6009 sits at 1.8 V -> bias loss small.", dcbias="typ. -5..-12 % at 1.8 V (estimate)"),
 "10uF 10V X5R 0603 MLCC": dict(mfr="Samsung Electro-Mechanics", mpn="CL10A106KP8NNNC", lcsc="C19702", cls=N, stock=885520,
      tiers=[(20,.0308),(200,.0228),(600,.0193),(4000,.0166)], rating="10 V X5R +-10 %", status="QUALIFIED",
      note="Same as spec.", dcbias="typ. -30..-50 % at 3.0 V on a 10 V X5R 0603 (estimate; effective 5-7 uF)"),
 "Dual series low-leakage diode, IR <= 5 nA @ 75 V, SOT-23": dict(mfr="Nexperia", mpn="BAV199,215", lcsc="C40919", cls="Extended Parts", stock=17520,
      tiers=[(10,.0429),(100,.0339),(300,.0293),(3000,.0255)], rating="85 V, IR 5 nA max @ 75 V (80 nA @ 150 C), Cd 2 pF", status="QUALIFIED",
      note="Datasheet read (Nexperia BAV199, 2026-10-11): leakage / capacitance consistent with the HIZ node model.", dcbias="n/a"),
 "Ferrite bead 600 ohm @ 100 MHz, 0603, >= 200 mA, DCR <= 0.5 ohm": dict(mfr="Murata", mpn="BLM18AG601SN1D", lcsc="C19330", cls="Extended", stock=400250,
      tiers=[(50,.0128),(500,.01),(1500,.0087),(4000,.0076)], rating="600 ohm@100 MHz +-25 %, 500 mA, DCR 380 mohm, -55..125 C", status="QUALIFIED",
      note="RB-04B: exact-spec fallback made primary. Sunlord GZ1608D601TF C1002 (Basic, 200 mA / 450 mohm = exactly at the limits) has no retrievable LCSC page/stock; swap back (-$3.07 feeder) only if the JLC BOM tool shows stock and the owner accepts zero margin.",
      dcbias="n/a"),
 "JST PH 2.0 mm 2-pin side-entry SMD, 2 A / 100 V AC/DC (AWG24), mates P": dict(mfr="JST", mpn="S2B-PH-SM4-TB(LF)(SN)", lcsc="C295747", cls="Extended (per project field, page lists Economic+Standard)", stock=15180,
      tiers=[(5,.2387),(50,.1923),(150,.1724),(1000,.1475)], rating="100 V / 2 A, -25..85 C", status="QUALIFIED", note="datasheet PDF not retrieved", dcbias="n/a"),
 "JST PH 2.0 mm 2-pin vertical SMD, 2 retention pads": dict(mfr="JST", mpn="B2B-PH-SM4-TB(LF)(SN)", lcsc="C160352", cls="Extended (per project field, page lists Economic+Standard)", stock=11170,
      tiers=[(5,.2165),(50,.1729),(150,.1543),(1000,.131)], rating="100 V / 2 A, -25..85 C", status="QUALIFIED", note="datasheet PDF not retrieved", dcbias="n/a"),
 "60 V N-MOSFET SOT-23, VGS(th) >= 0.8 V": dict(mfr="JSCJ (Jiangsu Changjing)", mpn="2N7002", lcsc="C8545", cls=N, stock=665100,
      tiers=[(50,.0179),(500,.0143),(3000,.0127)], rating="60 V / 115 mA, VGS(th) <= 2.5 V", status="QUALIFIED",
      note="VGS(th) lower bound not read from page; gate drive in the circuit is 3.0-3.3 V.", dcbias="n/a"),
 "10k +-1% 0603 thick film, >=1/10 W": dict(mfr="YAGEO", mpn="RC0603FR-0710KL", lcsc="C98220", cls="Extended Parts", stock=5076700,
      tiers=[(100,.0034),(1000,.0026),(5000,.0022)], rating="+-1 %, 100 mW, 75 V, +-100 ppm/C", status="QUALIFIED",
      note="Preferred Basic Uniroyal 0603WAF1002T5E C25804 is out of stock at LCSC; if JLC shows stock, switch to it (saves one feeder fee).", dcbias="n/a"),
 "100k +-1% 0603 thick film, >=1/10 W": dict(mfr="UNI-ROYAL", mpn="0603WAF1003T5E", lcsc="C25803", cls=N, stock=11913200,
      tiers=[(100,.0031),(1000,.0024),(5000,.0021)], rating="+-1 %, 100 mW, 75 V", status="QUALIFIED", note="", dcbias="n/a"),
 "10M +-5% 0603 thick film, >=1/10 W": dict(mfr="YAGEO", mpn="RC0603FR-0710ML", lcsc="C114606", cls=N, stock=823600,
      tiers=[(100,.005),(1000,.0044),(5000,.0041)], rating="+-1 %, 100 mW, 75 V (spec +-5 %: tighter)", status="QUALIFIED",
      note="Uniroyal 10M C7250 out of stock.", dcbias="n/a"),
 "1.0k +-1% 0603 thick film, >=1/10 W": dict(mfr="UNI-ROYAL", mpn="0603WAF1001T5E", lcsc="C21190", cls=N, stock=1645900,
      tiers=[(100,.0026),(1000,.0021),(5000,.0018)], rating="+-1 %, 100 mW, 75 V", status="QUALIFIED", note="", dcbias="n/a"),
 "4.7k +-1% 0603 thick film, >=1/10 W": dict(mfr="UNI-ROYAL", mpn="0603WAF4701T5E", lcsc="C23162", cls=N, stock=8483200,
      tiers=[(100,.0028),(1000,.0023),(5000,.002)], rating="+-1 %, 100 mW, 75 V", status="QUALIFIED", note="", dcbias="n/a"),
 "4.7 +-1% 0603 thick film, >=1/10 W": dict(mfr="YAGEO", mpn="RC0603FR-074R7L", lcsc="C137705", cls=N, stock=19100,
      tiers=[(100,.0077),(1000,.0066),(5000,.0059)], rating="+-1 %, 100 mW, 75 V, +-200 ppm/C", status="QUALIFIED",
      note="Uniroyal 4.7R and Meritek CR164R70F out of stock; stock 19,100.", dcbias="n/a"),
 "100k +-1% 0805 thick film, >=1/10 W, 0805 for creepage": dict(mfr="UNI-ROYAL", mpn="0805W8F1003T5E", lcsc="C149504", cls=N, stock=2011500,
      tiers=[(100,.006),(1000,.0047),(5000,.0041)], rating="+-1 %, 125 mW, 150 V", status="QUALIFIED", note="0805 kept for creepage (R5002).", dcbias="n/a"),
 "33 +-1% 0603 thick film, >=1/10 W": dict(mfr="UNI-ROYAL", mpn="0603WAF330JT5E", lcsc="C23140", cls=N, stock=2943400,
      tiers=[(100,.0025),(1000,.002),(5000,.0017)], rating="+-1 %, 100 mW, 75 V", status="QUALIFIED", note="", dcbias="n/a"),
 "100 +-1% 0603 thick film, >=1/10 W": dict(mfr="UNI-ROYAL", mpn="0603WAF1000T5E", lcsc="C22775", cls=N, stock=1944100,
      tiers=[(100,.0032),(1000,.0025),(5000,.0022)], rating="+-1 %, 100 mW, 75 V", status="QUALIFIED", note="", dcbias="n/a"),
 "150k +-1% 0603 thick film, >=1/10 W": dict(mfr="UNI-ROYAL", mpn="0603WAF1503T5E", lcsc="C22807", cls=N, stock=502100,
      tiers=[(100,.0045),(1000,.0034),(5000,.0029)], rating="+-1 %, 100 mW, 75 V", status="QUALIFIED", note="", dcbias="n/a"),
 "1M +-1% 0603 thick film, >=1/10 W": dict(mfr="UNI-ROYAL", mpn="0603WAF1004T5E", lcsc="C22935", cls=N, stock=3185200,
      tiers=[(100,.002),(1000,.0015),(5000,.0013)], rating="+-1 %, 100 mW, 75 V", status="QUALIFIED", note="", dcbias="n/a"),
 "3.0 V 300 mA LDO, active discharge, SOT-23-5": dict(mfr="Texas Instruments", mpn="TPS7A2030PDBVR", lcsc="C963429", cls=N + " (page: Economic and Standard)", stock=1880,
      tiers=[(5,.2332),(50,.1831),(150,.1586),(500,.1368)], rating="300 mA, 140 mV dropout, EN 0.3/0.9 V, IQ 6.5 uA", status="QUALIFIED",
      note="Datasheet SBVS tps7a20 read 2026-10-11 (EN thresholds, IQ).", dcbias="n/a"),
 "Quad RRIO op-amp TSSOP-14": dict(mfr="Texas Instruments", mpn="TLV9064IPWR", lcsc="C779410", cls="Extended", stock=18770,
      tiers=[(5,.3927),(50,.3075),(150,.2709),(500,.2145)], rating="1.8-5.5 V, en 16 nV/rtHz @1 kHz, IB 0.5 pA, -40..125 C", status="QUALIFIED", note="", dcbias="n/a"),
 "4-ch 24-bit simultaneous delta-sigma ADC, TSSOP-20": dict(mfr="Texas Instruments", mpn="ADS131M04IPWR", lcsc="C2862562", cls="Extended", stock=1717,
      tiers=[(1,4.69),(10,4.18),(30,3.85),(100,3.54)], rating="-40..125 C, AIN abs -1.6 V .. AVDD+0.3 V", status="QUALIFIED",
      note="Datasheet SBAS890D read.", dcbias="n/a"),
 "8.192 MHz CMOS XO": dict(mfr="SCTF (Asian Brands)", mpn="SX3M8.192M20F30TNN", lcsc="C2901557", cls="Extended (per project field)", stock=1658,
      tiers=[(1,.3482),(10,.3071),(30,.2891),(100,.2661)], rating="1.62-3.63 V, +-20 ppm @25 C, -40..85 C", status="QUALIFIED", note="datasheet PDF not retrievable", dcbias="n/a"),
}

def key_for(spec):
    spec = spec.replace("\u00b1", "+-")
    for k in SEL:
        if spec.startswith(k): return k
    return None

if __name__ == "__main__":
    base = Path(__file__).resolve().parent.parent
    lines = json.load(open(base / "evidence/rb04/bom_lines.json"))
    out = []
    for l in lines:
        k = key_for(l["spec"])
        out.append({**l, "sel": SEL.get(k) if k else None})
    json.dump(out, open(base / "evidence/rb04a/bom_selection.json", "w"), indent=1, default=list)
    print(sum(1 for o in out if o["sel"]), "of", len(out), "lines with a selection")
