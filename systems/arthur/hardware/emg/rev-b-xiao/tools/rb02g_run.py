#!/usr/bin/env python3
"""RB-02G: build, check, render and summarise all compact-layout variants on scratch copies.

    python3 rb02g_run.py --out <dir> [--variants V1 V2 ...]

For each variant: variant.kicad_pcb (scratch what-if board), chk.json (RB-02 placement checks in the module frame),
edge_clearance.json / economic_audit.json (RB-02E audit), drc.json (kicad-cli --schematic-parity in a scratch project copy),
metrics.json, img.png/.svg.  Also summary.json with one row per variant plus the current RB-02 board as baseline.
The project PCB is never written.
"""
import argparse
import collections
import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
K = HERE.parent / "kicad/ARTHUR_EMG_RevB"
sys.path.insert(0, str(HERE))
import rb02g_build as B  # noqa: E402


def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def one(name, net, out, pcb=None, variants_file=None):
    d = out / name
    d.mkdir(parents=True, exist_ok=True)
    if pcb is None:
        cmd = [sys.executable, str(HERE / "rb02g_build.py"), "--netlist", str(net), "--variant", name, "--out", str(d)]
        if variants_file:
            cmd += ["--variants-file", str(variants_file)]
        r = sh(cmd)
        if r.returncode:
            raise SystemExit(r.stderr)
        pcb = d / "variant.kicad_pcb"
    chk = d / "chk.json"
    sh([sys.executable, str(HERE / "rb02g_check.py"), "--pcb", str(pcb), "--netlist", str(net), "--json", str(chk)])
    sh([sys.executable, str(HERE / "rb02e_economic_audit.py"), "--pcb", str(pcb), "--netlist", str(net), "--out", str(d)])
    sh([sys.executable, str(HERE / "rb02g_metrics.py"), "--pcb", str(pcb), "--json", str(d / "metrics.json")])
    prj = d / "_prj"
    shutil.rmtree(prj, ignore_errors=True)
    shutil.copytree(K, prj)
    shutil.copy(pcb, prj / "ARTHUR_EMG_RevB.kicad_pcb")
    sh(["kicad-cli", "pcb", "drc", "--schematic-parity", "--severity-all", "--format", "json", "-o", str(d / "drc.json"),
        str(prj / "ARTHUR_EMG_RevB.kicad_pcb")], cwd=prj)
    shutil.rmtree(prj, ignore_errors=True)
    sh([sys.executable, str(HERE / "rb02g_render.py"), "--pcb", str(pcb), "--title", name, "--out", str(d / "img")])
    c = json.loads(chk.read_text())
    st = {r["id"]: r["status"] for r in c}
    e = json.loads((d / "edge_clearance.json").read_text())
    top = [r for r in e if r["side"] == "top" and r["ref"] != "U1"]
    drc = json.loads((d / "drc.json").read_text())
    cnt = collections.Counter(v["type"] for v in drc["violations"] if v["severity"] == "error")
    m = json.loads((d / "metrics.json").read_text())
    audit = json.loads((d / "economic_audit.json").read_text())
    return {"name": name, "W": m["W"], "H": m["H"], "area": m["area"], "aspect": m["aspect"], "util": m["courtyard_utilisation"],
            "placed": next(r for r in c if r["id"] == "C01")["detail"].split(" ")[0],
            "checks": st, "check_fail": sorted(k for k, v in st.items() if v == "FAIL" and k != "C06"),
            "drc_errors": dict(cnt), "drc_error_total": sum(cnt.values()),
            "drc_warnings": dict(collections.Counter(v["type"] for v in drc["violations"] if v["severity"] == "warning")),
            "unconnected": len(drc["unconnected_items"]), "parity": len(drc["schematic_parity"]),
            "body_lt_2p5": sum(1 for r in top if r["body_to_edge"] < 2.5 - 1e-9),
            "copper_lt_0p3": sum(1 for r in top if r["envelope_to_edge"] < 0.3),
            "min_copper_edge": min(r["envelope_to_edge"] for r in top), "jlc_bottom": audit["assembly"]["jlc_assembled_bottom"],
            "cpl_has_u1": audit["assembly"]["cpl_contains_U1"], "hpwl": m["hpwl_total"], "hpwl_buf": m["hpwl_by_class"].get("EMG_BUF"),
            "ac_run_max": m["ac_run_max"], "ac_run_min": m["ac_run_min"], "hiz_to_module": m["hiz_to_module_mm"], "hiz_nearest": m["hiz_nearest_part"], "pn_mismatch": m["ac_pn_mismatch_max"],
            "electrode_edges": sorted(set(m["electrode_connector_edges"].values())), "battery_edge": m["battery_connector_edge"], "battery_plug_exit": m["battery_plug_exit"]}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--variants", nargs="*")
    ap.add_argument("--variants-file", type=Path)
    a = ap.parse_args(argv)
    a.out.mkdir(parents=True, exist_ok=True)
    net = a.out / "revb.xml"
    r = sh(["kicad-cli", "sch", "export", "netlist", "--format", "kicadxml", "-o", str(net), "ARTHUR_EMG_RevB.kicad_sch"], cwd=K)
    names = a.variants or list(B.load_variants(a.variants_file or HERE / "rb02g_variants.py"))
    rows = [one("RB02_current", net, a.out, pcb=K / "ARTHUR_EMG_RevB.kicad_pcb")]
    for n in names:
        rows.append(one(n, net, a.out, variants_file=a.variants_file))
    (a.out / "summary.json").write_text(json.dumps(rows, indent=1))
    for r in rows:
        print(f"{r['name']:13s} {r['W']:5.1f} x {r['H']:5.1f}  area {r['area']:5d}  util {r['util']:.2f}  DRCerr {r['drc_error_total']:3d}  "
              f"<2.5 {r['body_lt_2p5']:2d}  <0.3 {r['copper_lt_0p3']:2d}  HPWL {r['hpwl']:5d}  ACrun {r['ac_run_max']:5.1f}  chkfail {r['check_fail']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
