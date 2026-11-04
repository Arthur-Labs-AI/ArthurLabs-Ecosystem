#!/usr/bin/env python3
"""RB-04A: two-unit cost model from rb04a_selection (LCSC retail tiers, NOT a JLC quotation)."""
import json, sys
from pathlib import Path
base = Path(__file__).resolve().parent.parent
L = json.load(open(base / "evidence/rb04a/bom_selection.json"))
UNITS = 2
rows = []; a = b = 0.0; ext_conf = []; ext_unk = []; basic = []
for l in L:
    s = l["sel"]
    if not s: continue
    n = len(l["refs"]) * UNITS
    t = s["tiers"]
    if t:
        tier = max([x for x in t if x[0] <= n], key=lambda x: x[0], default=t[0])
        unit_a = tier[1]; qa = n
        qb = max(n, t[0][0]); tb = max([x for x in t if x[0] <= qb], key=lambda x: x[0]); unit_b = tb[1]
    else:
        unit_a = unit_b = None; qa = n; qb = n
    ca = n * unit_a if unit_a is not None else None
    cb = qb * unit_b if unit_b is not None else None
    rows.append(dict(refs=len(l["refs"]), lcsc=s["lcsc"], need=n, unit_need=unit_a, cost_need=ca, buy=qb, unit_buy=unit_b, cost_buy=cb, cls=s["cls"]))
    if ca is not None: a += ca
    if cb is not None: b += cb
    c = s["cls"].lower()
    (ext_conf if c.startswith("extended") else basic if c.startswith("basic") else ext_unk).append(s["lcsc"])
joints = 340
fees = dict(setup=8.18, stencil=1.53, smt=round(joints * UNITS * 0.0016, 2), confirm=0.45)
fee_fixed = sum(fees.values())
def feeder(n): return round(n * 3.07, 2)
out = dict(parts_need_qty=round(a, 2), parts_moq_qty=round(b, 2), fees=fees, ext_confirmed=ext_conf, unlabeled=ext_unk, basic=basic,
           feeder_best=feeder(len(ext_conf)), feeder_worst=feeder(len(ext_conf) + len(ext_unk)),
           rows=rows)
out["assembly_best"] = round(fee_fixed + out["feeder_best"], 2); out["assembly_worst"] = round(fee_fixed + out["feeder_worst"], 2)
out["ferrite_unpriced"] = True
json.dump(out, open(base / "evidence/rb04a/cost_model.json", "w"), indent=1)
print({k: v for k, v in out.items() if k != "rows"})
for r in rows: print(r)
