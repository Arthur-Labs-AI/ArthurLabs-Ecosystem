#!/usr/bin/env python3
"""RB-04: evaluate single-part shifts proposed by rb04_mask.py (scratch only).  For each (part, dx, dy): rb03s_repair.py, KiCad DRC
(rb03r_verify.sh), rb04_mask.py class counts.  Prints a table; writes JSON.   python3 rb04_try_shifts.py --pcb b --work dir REF:dx:dy ..."""
import argparse, json, subprocess, sys
from pathlib import Path
T = Path(__file__).resolve().parent
ap = argparse.ArgumentParser(); ap.add_argument("--pcb", type=Path, required=True); ap.add_argument("--work", type=Path, required=True); ap.add_argument("--out", type=Path, required=True)
ap.add_argument("moves", nargs="+")
a = ap.parse_args(); a.work.mkdir(parents=True, exist_ok=True)
base = json.loads(subprocess.run([sys.executable, str(T / "rb04_mask.py"), "--pcb", str(a.pcb), "--out", str(a.work / "base.json")], capture_output=True, text=True) and (a.work / "base.json").read_text())
bc = base["class_counts"]; rows = [{"move": "baseline", "classes": bc}]
for m in a.moves:
    ref = m.split(":")[0]; out = a.work / f"{ref}.kicad_pcb"
    p = subprocess.run([sys.executable, str(T / "rb03s_repair.py"), "--pcb", str(a.pcb), "--out", str(out), "--move", m, "--in2-margin", "-0.02", "--gnd-rect-margin", "0.25"], capture_output=True, text=True)
    if p.returncode != 0 or not out.exists():
        rows.append({"move": m, "result": "repair failed", "detail": [l for l in p.stdout.splitlines() if "conflict" in l or "False" in l][:2]}); print(rows[-1], flush=True); continue
    ev = a.work / f"ev_{ref}"
    subprocess.run(["bash", str(T / "rb03r_verify.sh"), str(out), str(ev), "--fill"], capture_output=True, text=True)
    d = json.load(open(ev / "drc.json"))
    errs = [v["type"] for v in d["violations"] if v["severity"] == "error"]
    subprocess.run([sys.executable, str(T / "rb04_mask.py"), "--pcb", str(ev / "prj" / "ARTHUR_EMG_RevB.kicad_pcb"), "--out", str(ev / "mask.json")], capture_output=True)
    mc = json.load(open(ev / "mask.json"))["class_counts"]
    rows.append({"move": m, "drc_errors": errs, "unconnected": len(d["unconnected_items"]), "classes": mc})
    print(rows[-1], flush=True)
a.out.write_text(json.dumps(rows, indent=1))
