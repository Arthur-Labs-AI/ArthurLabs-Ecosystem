#!/usr/bin/env python3
"""RB-03R: copper voltage drop of the power nets from the routed-board audit (rb03_audit.py audit.json) with documented current
bounds.  Drop = I_total_bound x R_to_farthest_pad (an upper bound: the total load is assumed to sit at the farthest pad).
    python3 rb03r_power.py --audit audit.json --out power_drop.json"""
import argparse, json
from pathlib import Path

# (net, source label, bound in mA, basis)
BOUNDS = {
    "AFE_3V0": (4.0 + 12 * 0.8 + 0.2, "ADS131M04 IAVDD max 4.0 mA (high-resolution, SBAS890D rev D, 6.5 Electrical Characteristics) + 12 x TLV9064 IQ max 0.80 mA "
                "(-40..125 C, SBOS839, VS = 5.5 V; at 3.0 V it is lower) + 0.2 mA bias/divider/leakage allowance"),
    "DVDD_F": (10.0 + 0.5 + 0.5 + 0.4, "X1 SX3M8.192M20F30TNN Icc <= 10 mA (15 pF, vendor sheet) + ADS131M04 IDVDD max 0.5 mA (SPI idle) + 0.5 mA SPI activity "
               "+ 0.4 mA pull-ups (3.6 V / 10 k)"),
    "/XIAO_Brain_Interface/XIAO_3V3": (11.4 + 15.0 * 0.0, "DVDD_F bound (the 3V3 pin feeds FB1 only on this board)"),
    "/Analog_Power_Interlock/VBAT_AFE": (13.8 + 1.0, "AFE_3V0 bound + TPS7A2030 ground current (<= 1 mA allowance)"),
    "VBAT": (500.0, "system bound, not a datasheet value: XIAO ESP32-S3 radio TX peak ~355 mA + charger/board margin -> 0.5 A; measure"),
    "/XIAO_5V": (20.0, "USB-presence sense / inhibit network only on this board (the charge current is inside the module); 20 mA allowance"),
}
ap = argparse.ArgumentParser(); ap.add_argument("--audit", type=Path, required=True); ap.add_argument("--out", type=Path, required=True)
a = ap.parse_args()
d = json.load(open(a.audit))["power"]
out = {}
for net, (ma, basis) in BOUNDS.items():
    if net not in d:
        continue
    r = d[net]["max_mohm"]
    out[net] = {"source_pad": d[net]["source"], "bound_mA": round(ma, 2), "max_R_mohm": r, "drop_mV": round(ma * r / 1000.0, 3), "basis": basis}
a.out.write_text(json.dumps(out, indent=1))
for n, v in out.items():
    print(f"{n:42s} {v['bound_mA']:7.1f} mA  R {v['max_R_mohm']:6.1f} mOhm  drop {v['drop_mV']:7.3f} mV")
