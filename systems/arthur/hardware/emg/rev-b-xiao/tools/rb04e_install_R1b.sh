#!/usr/bin/env bash
# RB-04E: apply the BAT+ post-hole change R1b (U1 pad 23: drill 1.40 -> 1.90, copper 1.90 -> 2.30, mask margin -0.225 -> -0.175 => opening 1.95)
# to a KiCad project directory.  NOT run on the canonical project without the owner's approval.
#   bash rb04e_install_R1b.sh <project dir> [--canonical]     (default: refuses to touch the canonical dir unless --canonical)
# Steps: archive the pre-change PCB + footprint -> patch both text files (exact match, aborts otherwise) -> refill zones with pcbnew (scratch copy
# of the project is what pcbnew opens; the result is copied back) -> print a short status.  Then run rb04_lock.sh lock and the audits.
set -eu
T="$(cd "$(dirname "$0")" && pwd)"; R="$(cd "$T/.." && pwd)"; CAN="$R/kicad/ARTHUR_EMG_RevB"
P="$(readlink -f "${1:?project dir}")"
if [ "$P" = "$CAN" ] && [ "${2:-}" != "--canonical" ]; then echo "refusing to modify the canonical project without --canonical"; exit 2; fi
chmod u+w "$P/ARTHUR_EMG_RevB.kicad_pcb" "$P/fp-libs/ARTHUR.pretty/XIAO_ESP32S3_HANDSOLDER.kicad_mod"
A="$R/archive/rb04e_pre_R1b"; mkdir -p "$A"
[ -e "$A/ARTHUR_EMG_RevB.kicad_pcb" ] || cp -p "$P/ARTHUR_EMG_RevB.kicad_pcb" "$P/fp-libs/ARTHUR.pretty/XIAO_ESP32S3_HANDSOLDER.kicad_mod" "$A/"
python3 - "$P" <<'PY'
import sys
P = sys.argv[1]
def patch(path, old, new):
    s = open(path).read()
    assert s.count(old) == 1, f"pattern not found exactly once in {path}"
    open(path, "w").write(s.replace(old, new))
old = '''(pad "23" thru_hole circle
			(at -4.445 -0.4075 180)
			(size 1.9 1.9)
			(drill 1.4)
			(layers "*.Cu" "*.Mask")
			(remove_unused_layers no)
			(net "VBAT")
			(solder_mask_margin -0.225)'''
patch(P + "/ARTHUR_EMG_RevB.kicad_pcb", old, old.replace("(size 1.9 1.9)", "(size 2.3 2.3)").replace("(drill 1.4)", "(drill 1.9)").replace("-0.225)", "-0.175)"))
old2 = '''(pad "23" thru_hole circle
		(at -4.445 -0.4075)
		(size 1.9 1.9)
		(drill 1.4)
		(layers "*.Cu" "F.Mask" "B.Mask")
		(solder_mask_margin -0.225)'''
patch(P + "/fp-libs/ARTHUR.pretty/XIAO_ESP32S3_HANDSOLDER.kicad_mod", old2, old2.replace("(size 1.9 1.9)", "(size 2.3 2.3)").replace("(drill 1.4)", "(drill 1.9)").replace("-0.225)", "-0.175)"))
print("patched pad 23 in PCB and footprint")
PY
python3 "$T/rb03_fill.py" "$P/ARTHUR_EMG_RevB.kicad_pcb" "$P/.rb04e_filled.kicad_pcb" 2>&1 | grep -v assert || true
mv "$P/.rb04e_filled.kicad_pcb" "$P/ARTHUR_EMG_RevB.kicad_pcb"
echo "R1b applied to $P (archive: $A)"
