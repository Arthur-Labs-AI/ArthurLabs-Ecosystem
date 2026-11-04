#!/usr/bin/env python3
"""compact view of a rb03r_verify.sh evidence dir: via audit FAIL records, DRC errors/warnings, unconnected"""
import json, sys
d = sys.argv[1]
v = json.load(open(d + "/via_audit.json")); print(v["summary"])
for r in v["records"]:
    if r["class"].startswith("FAIL"):
        print("  VIA", r["via"], r["via_net"], r["pad"], r["class"][:34], r["centre_to_pad_copper_mm"])
x = json.load(open(d + "/drc.json"))
for e in x["violations"]:
    print("  DRC", e["severity"], e["type"], e["description"][:70], [i["description"][:42] for i in e["items"]], e["items"][0]["pos"])
print("  unconnected", len(x["unconnected_items"]), "parity", len(x["schematic_parity"]))
