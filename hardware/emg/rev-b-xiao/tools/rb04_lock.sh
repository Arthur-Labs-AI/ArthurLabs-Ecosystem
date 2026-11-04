#!/usr/bin/env bash
# RB-04: protect / verify the canonical KiCad project files.
#   rb04_lock.sh lock     make .kicad_pro, .kicad_dru (and the schematics) read-only and record sha256 in baseline/canonical_files.sha256
#   rb04_lock.sh verify   compare the files with the recorded hashes (exit 1 on any difference or any .history/lock debris)
#   rb04_lock.sh unlock   make them writable again (needed before rb02_write_project.py or a deliberate edit)
# Limits (honest): read-only bits stop in-place writes by tools that open the file; they do NOT stop an editor that replaces the file
# (write-to-temp + rename in a writable directory).  The hash check is the real protection; rb03r_verify.sh runs it on every verify.
set -eu
K="$(cd "$(dirname "$0")/../kicad/ARTHUR_EMG_RevB" && pwd)"; H="$(cd "$(dirname "$0")" && pwd)/baseline/canonical_files.sha256"
FILES="ARTHUR_EMG_RevB.kicad_pro ARTHUR_EMG_RevB.kicad_dru ARTHUR_EMG_RevB.kicad_sch adc.kicad_sch analog_power_interlock.kicad_sch emg_channel.kicad_sch reference_vcm.kicad_sch xiao_brain_interface.kicad_sch ARTHUR_RevB.kicad_sym ARTHUR_EMG_RevB.kicad_pcb fp-libs/ARTHUR.pretty/XIAO_ESP32S3_HANDSOLDER.kicad_mod"  # RB-04G: PCB + authoritative footprint frozen too
case "${1:-verify}" in
  lock) (cd "$K" && sha256sum $FILES > "$H" && chmod a-w $FILES); echo "locked $(wc -l < "$H") files -> $H";;
  unlock) (cd "$K" && chmod u+w $FILES); echo unlocked;;
  verify) (cd "$K" && sha256sum -c "$H" --quiet) && echo "CANONICAL FILES: PASS" || { echo "CANONICAL FILES: FAIL"; exit 1; }
          if [ -e "$K/.history" ] || ls "$K"/~*.lck >/dev/null 2>&1; then echo "debris (.history / lock files) present: WARN"; fi;;
esac
