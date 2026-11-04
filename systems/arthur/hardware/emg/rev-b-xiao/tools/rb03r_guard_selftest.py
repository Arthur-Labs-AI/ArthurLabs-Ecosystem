#!/usr/bin/env python3
"""RB-03R: negative controls for rb03r_guard.py.  Each mutation is applied to a scratch copy of the canonical project and the guard
must exit != 0; the unmutated copy must exit 0.   python3 rb03r_guard_selftest.py --out report.json"""
import argparse, json, re, shutil, subprocess, sys, tempfile
from pathlib import Path
T = Path(__file__).resolve().parent
K = T.parent / "kicad" / "ARTHUR_EMG_RevB"
G = T / "rb03r_guard.py"
ap = argparse.ArgumentParser(); ap.add_argument("--out", type=Path, required=True); ap.add_argument("--netlist", type=Path)
a = ap.parse_args()
tmp = Path(tempfile.mkdtemp(prefix="guard_selftest_"))


def fresh(name):
    d = tmp / name
    shutil.copytree(K, d, ignore=shutil.ignore_patterns(".history", "~*", "*.lck"))
    subprocess.run(["chmod", "-R", "u+w", str(d)])
    return d


def run(d):
    cmd = [sys.executable, str(G), "check", "--project", str(d), "--pcb", str(d / "ARTHUR_EMG_RevB.kicad_pcb")] + (["--netlist", str(a.netlist)] if a.netlist else [])
    p = subprocess.run(cmd, capture_output=True, text=True)
    return p.returncode, (p.stdout + p.stderr).strip().splitlines()[-1:] 


def pro(d, fn):
    p = d / "ARTHUR_EMG_RevB.kicad_pro"; j = json.loads(p.read_text()); fn(j); p.write_text(json.dumps(j, indent=2))


def dru(d, fn):
    p = d / "ARTHUR_EMG_RevB.kicad_dru"; p.write_text(fn(p.read_text()))


def m_netclasses_gone(d):
    pro(d, lambda j: j["net_settings"].__setitem__("classes", [c for c in j["net_settings"]["classes"] if c["name"] == "Default"]))


def m_patterns_gone(d):
    pro(d, lambda j: j["net_settings"].__setitem__("netclass_patterns", []))


def m_pattern_changed(d):
    def f(j):
        for p in j["net_settings"]["netclass_patterns"]:
            if "CH1" in p["pattern"]:
                p["netclass"] = "Default"; return
        j["net_settings"]["netclass_patterns"][0]["netclass"] = "Default"
    pro(d, f)


def m_rule_removed(d):
    dru(d, lambda s: re.sub(r'\(rule "hiz_leakage".*?\n\t\(condition[^\n]*\n', "", s, flags=re.S))


def m_rule_disabled(d):
    dru(d, lambda s: s.replace('(rule "no_via_in_smd_pad"', '(rule "no_via_in_smd_pad"\n\t(disabled)', 1))


def m_severity_ignore(d):
    pro(d, lambda j: j["board"]["design_settings"].__setitem__("rule_severities", {**j["board"]["design_settings"].get("rule_severities", {}), "clearance": "ignore"}))


def m_dru_edited(d):
    dru(d, lambda s: s + "\n(rule \"x\" (constraint clearance (min 0.01mm)) (condition \"A.Type == 'Track'\"))\n")


def m_missing_dru(d):
    (d / "ARTHUR_EMG_RevB.kicad_dru").unlink()


def m_pcbnew_clobber(d):
    code = ("import pcbnew,sys;b=pcbnew.LoadBoard(sys.argv[1]);pcbnew.SaveBoard(sys.argv[1],b)")
    subprocess.run([sys.executable, "-c", code, str(d / "ARTHUR_EMG_RevB.kicad_pcb")], capture_output=True)
    # pcbnew rewrites the project when the board is saved in place
    return


def m_mask_bridge_off(d):
    pro(d, lambda j: j["board"]["design_settings"].__setitem__("rule_severities", {**j["board"]["design_settings"].get("rule_severities", {}), "solder_mask_bridge": "ignore"}))


def m_courtyard_warn(d):
    pro(d, lambda j: j["board"]["design_settings"].__setitem__("rule_severities", {**j["board"]["design_settings"].get("rule_severities", {}), "courtyards_overlap": "warning"}))


def m_annular_lowered(d):
    pro(d, lambda j: j["board"]["design_settings"]["rules"].__setitem__("min_via_annular_width", 0.05))


def m_hole_clearance_lowered(d):
    pro(d, lambda j: j["board"]["design_settings"]["rules"].__setitem__("min_hole_clearance", 0.05))


def _pcb(d, fn):
    p = d / "ARTHUR_EMG_RevB.kicad_pcb"
    p.write_text(fn(p.read_text()))


def m_untent(d):
    _pcb(d, lambda s: s.replace("(front yes)", "(front no)", 1))


def m_stackup(d):
    _pcb(d, lambda s: s.replace("(thickness 0.2104)", "(thickness 0.1)", 1))


cases = [("baseline (no mutation)", None, 0), ("netclasses removed", m_netclasses_gone, 1), ("netclass patterns removed", m_patterns_gone, 1),
         ("one pattern re-assigned to Default", m_pattern_changed, 1), ("hiz_leakage rule deleted", m_rule_removed, 1),
         ("no_via_in_smd_pad disabled", m_rule_disabled, 1), ("clearance severity set to ignore", m_severity_ignore, 1),
         ("dru edited (extra rule)", m_dru_edited, 1), ("dru missing", m_missing_dru, 1),
         ("solder_mask_bridge severity ignored", m_mask_bridge_off, 1), ("courtyards_overlap lowered to warning", m_courtyard_warn, 1),
         ("min_via_annular_width lowered to 0.05", m_annular_lowered, 1), ("min_hole_clearance lowered to 0.05", m_hole_clearance_lowered, 1),
         ("front via tenting switched off in the board", m_untent, 1), ("stack-up prepreg thickness changed", m_stackup, 1)]
rows = []
for i, (name, fn, want_fail) in enumerate(cases):
    d = fresh(f"c{i}")
    if fn:
        fn(d)
    rc, tail = run(d)
    ok = (rc != 0) if want_fail else (rc == 0)
    rows.append({"case": name, "guard_exit": rc, "expected": "FAIL" if want_fail else "PASS", "result": "OK" if ok else "NOT DETECTED", "last_line": tail})
    print(f"{'OK ' if ok else 'BAD'} {name:45s} exit {rc}")
a.out.write_text(json.dumps(rows, indent=1))
shutil.rmtree(tmp, ignore_errors=True)
sys.exit(0 if all(r["result"] == "OK" for r in rows) else 1)
