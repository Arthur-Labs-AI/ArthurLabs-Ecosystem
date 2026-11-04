#!/usr/bin/env python3
"""RB-02: prove that each custom DRC rule in ARTHUR_EMG_RevB.kicad_dru fires.  For every rule a scratch copy of the board gets a
deliberate violation (a via/segment on named nets in free space); `kicad-cli pcb drc` must report it.  The real board is untouched.

    python3 rb02_seed_drc_rules.py --project-dir <ARTHUR_EMG_RevB dir>
"""
import argparse, json, shutil, subprocess, sys, tempfile, uuid
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--project-dir", type=Path, default=Path(__file__).resolve().parents[1] / "kicad/ARTHUR_EMG_RevB")
a = ap.parse_args()
u = lambda: str(uuid.uuid4())


def seg(x0, y0, x1, y1, layer, net, w=0.2):
    return f'\t(segment (start {x0} {y0}) (end {x1} {y1}) (width {w}) (layer "{layer}") (net "{net}") (uuid "{u()}"))\n'


def via(x, y, net, d=0.6, dr=0.3):
    return f'\t(via (at {x} {y}) (size {d}) (drill {dr}) (layers "F.Cu" "B.Cu") (net "{net}") (uuid "{u()}"))\n'


sys.path.insert(0, str(Path(__file__).resolve().parent))
import rb02_check_placement as CP   # noqa: E402

fps, edge, zones, _ = CP.load(a.project_dir / "ARTHUR_EMG_RevB.kicad_pcb")
blocked = [o.crt for o in fps.values() if o.crt and o.layer == "F.Cu"]


def free_rect(w, h, x_lo=0.0, x_hi=1e9, step=0.5):
    """first w x h rectangle (+0.6 margin) not touching any courtyard, scanning west->east, north->south"""
    y = edge[1] + 0.8
    while y + h < edge[3] - 0.8:
        x = max(edge[0] + 0.8, x_lo)
        while x + w < min(edge[2] - 0.8, x_hi):
            r = (x - 0.6, y - 0.6, x + w + 0.6, y + h + 0.6)
            if not any(CP.ov(r, c) for c in blocked):
                return x, y
            x += step
        y += step
    raise SystemExit(f"no free {w}x{h} area")


# Zone A free area (digital nets are forbidden there) and a free area elsewhere
ax, ay = free_rect(6, 1.8, 0.0, 39.0 + 22.0)
bx, by = free_rect(6, 1.8, 0.0, 200.0)
pad = fps["R6001"].pads[0]
CASES = {
    "hiz_no_vias": via(bx + 2, by + 1, "/CH1/HIZ_P"),
    "hiz_outer_only_in1": seg(bx, by + 1, bx + 5, by + 1, "In1.Cu", "/CH1/HIZ_P"),
    "hiz_outer_only_in2": seg(bx, by + 1, bx + 5, by + 1, "In2.Cu", "/CH2/ELEC_P"),
    "hiz_leakage": seg(bx, by, bx + 5, by, "F.Cu", "/CH1/HIZ_P") + seg(bx, by + 0.5, bx + 5, by + 0.5, "F.Cu", "AFE_3V0"),
    "spi_to_hiz": seg(bx, by, bx + 5, by, "F.Cu", "/CH1/HIZ_P") + seg(bx, by + 1.6, bx + 5, by + 1.6, "F.Cu", "/SCLK"),
    "spi_to_buf": seg(bx, by, bx + 5, by, "F.Cu", "/CH1/BUF_P") + seg(bx, by + 0.7, bx + 5, by + 0.7, "F.Cu", "/MOSI"),
    "zone_a_no_digital": seg(ax, ay + 1, ax + 5, ay + 1, "F.Cu", "/CS_N"),
    "no_via_in_smd_pad": via(round(pad["x"] - pad["w"] / 2 - 0.26, 3), round(pad["y"], 3), "GND", 0.5, 0.3),
}
EXPECT = {k: k for k in CASES}
ok = True
for case, extra in CASES.items():
    d = Path(tempfile.mkdtemp())
    for f in a.project_dir.iterdir():
        if f.is_file():
            shutil.copy(f, d)
        elif f.is_dir():
            shutil.copytree(f, d / f.name)
    p = d / "ARTHUR_EMG_RevB.kicad_pcb"
    s = p.read_text().rstrip()
    p.write_text(s[:-1] + extra + ")\n")
    out = d / "drc.json"
    subprocess.run(["kicad-cli", "pcb", "drc", "--severity-all", "--format", "json", "-o", str(out), str(p)], capture_output=True)
    j = json.loads(out.read_text())
    hit = [v for v in j["violations"] if EXPECT[case] in json.dumps(v)]
    print(f"{case:22s} {'FIRES' if hit else 'DID NOT FIRE'}  ({len(hit)} markers)")
    ok &= bool(hit)
    shutil.rmtree(d)
print("ALL RULES FIRE" if ok else "SOME RULES INERT")
sys.exit(0 if ok else 1)
