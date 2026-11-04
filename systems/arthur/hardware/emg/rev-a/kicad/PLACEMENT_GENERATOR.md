# ARTHUR EMG Rev A — Placement Generator (portable, deterministic)

No routing. No copper pours. No Gerbers/BOM/CPL. Placement only.

## 1. Canonical placement source

| Role | File |
| --- | --- |
| Coordinates + rotation (main 92) | `pl_rows_a.py` (`ROWS_A`), `pl_rows_b.py` (`ROWS_B`) |
| DNP/companion placement (14) | `pl_place.py` `EXTRA_ORDER` (bench coordinates, matches current PCB) |
| Values (main) | `pl_core_c.py` (`VALS`); test points default to `TP_SMD` |
| Values + footprints (DNP) | `pl_core_d.py` (`EXTRA_VAL`, `EXTRA_FP`, `EXTRA_NETS` — nets informational) |
| Geometry + netlist (pads, silk/fab/courtyard, net declarations) | Reference `.kicad_pcb` itself (default: the committed `ARTHUR_EMG_RevA/ARTHUR_EMG_RevA.kicad_pcb`) |
| Deterministic emitter | `pl_place.py` |

`pl_rows_*.py` tuple shape (6-tuple, enforced):
`(ref, footprint, x_mm, y_mm, rot_deg, flag)`.

The `*_DNP-BOTTOM` / `COMPANION` rows in `pl_rows_b.py` carry stale
schematic-zone coordinates; their canonical placement is `EXTRA_ORDER`
in `pl_place.py`. Do not read placement for those refs from `pl_rows_b.py`.

There is exactly one emitter of PCB coordinates: `pl_place.py`.
Never hand-edit footprint `(at ...)` positions in the `.kicad_pcb`.

## 2. Dependency map ( prior `pl_genv3d.py` chain — superseded )

| Dependency | Old location | Status now |
| --- | --- | --- |
| `D:\A.R.T.H.U.R\...` source root (`sys.path`) | every `pl_gen*.py`, `pl_core_a.py` | replaced by `ROOT = Path(__file__).resolve().parent` in `pl_place.py` |
| `C:\Users\nikol\...\dsh-217e9p\pcbdata.json` (nets, name2code, comp_pins) | `pl_genv2.py`, `pl_core_a.py`, `pl_gen.py`, `pl_build.py`, `pl_emit*.py` | obsolete session artifact; net data now read from the reference PCB header + per-pad `(net N "NAME")` tags. Producer was `pl_genpcb.py` ← `tp3.net` (KiCad netlist export), neither committed |
| `padlib.json` (per-footprint pad blocks) | produced by `pl_padlib.py` from KiCad stock `.pretty` + local `ARTHUR.pretty` | obsolete; pad geometry now extracted verbatim from the reference PCB footprint instances |
| `gfx.json` (silk/fab/courtyard items) | produced by `pl_gfx.py` from the same libraries | obsolete; graphics now extracted verbatim from the reference PCB |
| `head2.txt` / `headv2.txt` (title/layers/setup/nets header) | produced by `pl_genv2b.py`, consumed by `pl_genv2d.py` / `pl_genv3d.py` | obsolete; header preserved verbatim from the reference PCB |
| KiCad stock footprint libraries (`C:\Program Files\KiCad\10.0\...`, `${KICAD10_FOOTPRINT_DIR}`) | `pl_padlib.py`, `pl_gfx.py` | **not required** for regeneration: all 17 used footprints' pad/silk geometry is embedded in the PCB. Needed only to validate/author *new* footprints |
| Local `ARTHUR.pretty` (DSK, DQA, TP_SMD_1x1mm) | `ARTHUR_EMG_RevA/ARTHUR.pretty/` | committed; still the source for new-footprint work, not for regen |
| `pl_genv2.py` `EXTRA` / `pl_genv3d.py` `SKIP` + bottom-layer list + `U7001 rot=-90` | generation chain | ported into `pl_place.py` (`EXTRA_ORDER`, `SKIP_MAIN`, `BOTTOM_REFS`, U7001 override) |
| `pl_close*.py`, `pl_tup.py`, `pl_pos*.py` | one-shot Windows-session diagnostics | **deleted** in this pass |

The remaining `pl_gen*.py` / `pl_emit*.py` / `pl_core_*.py` (except
`pl_core_c.py`, `pl_core_d.py`, consumed by `pl_place.py`) are legacy and
not part of the deterministic workflow. Left untouched; see §7.

## 3. Generator invocation

Work from the kicad dir (`hardware/emg/rev-a/kicad/`). No environment
variables, no config files, no network. Python 3 only (stdlib).

```
# Regenerate in place (default ref = out = project PCB):
python3 pl_place.py

# Verify without writing:
python3 pl_place.py --check        # exit 0 + "placement identical", else diff + exit 2

# Explicit paths (geometry ref vs output may differ):
python3 pl_place.py --ref PATH/to/reference.kicad_pcb --out PATH/to/out.kicad_pcb
```

Windows invocation: identical (`py pl_place.py [--check]`). No source
edits between platforms — all paths derive from `__file__`.

Expected output: `wrote <path> (<bytes> bytes)`; current board writes
279591 bytes / 106 footprints.

## 4. What the generator does (deterministically)

1. Parse reference PCB: verbatim header (title/layers/setup/netclasses/net
   declarations) + per-ref footprint blocks.
2. Build the ordered plan: rows order (minus `SKIP_MAIN`) then `EXTRA_ORDER`.
   Bottom layer iff ref ∈ `BOTTOM_REFS`; `U7001` rotation forced to −90.
3. For each ref: re-emit the KiCad header lines (version/generator/layer/
   deterministic `tstamp = md5("fp"+ref)` / `(at x y [rot])` / descr /
   Reference+Value+Footprint properties) and splice the reference body's
   `(attr ...)` + graphics + `(pad ... (net N "NAME"))` lines **verbatim**.
4. Append Edge.Cuts rect `(0,0)-(45,30)`, the six `gr_text` annotations,
   the battery-region rect, and the closing paren.

No timestamps, no randomness, no dict-ordering hazards: insertion order =
rows order. `tstamp` values are `md5`-derived, matching the values already
in the committed PCB.

## 5. Determinism verification (this pass, Linux, KiCad 10.0.6 tooling)

```
cp ARTHUR_EMG_RevA/ARTHUR_EMG_RevA.kicad_pcb /tmp/reference.pcb
python3 pl_place.py --out /tmp/regen1.pcb
cmp /tmp/reference.pcb /tmp/regen1.pcb   # identical (0 diff bytes)
python3 pl_place.py --out /tmp/regen2.pcb
cmp /tmp/regen1.pcb /tmp/regen2.pcb       # identical
python3 pl_place.py --check               # "placement identical", exit 0
git diff --exit-code -- ARTHUR_EMG_RevA/ARTHUR_EMG_RevA.kicad_pcb  # clean vs reference
```

Regeneration is byte-identical to the reference: there are no unavoidable
metadata differences. (One blank-line hazard at the header/footprint
boundary was fixed during this pass; the committed output has none.)

## 6. Verification results (this pass — placement unchanged)

- Footprints: **106** (92 rows + 14 EXTRA), order = rows order + EXTRA tail.
- Board size: **45 × 30 mm** (`gr_rect (start 0 0) (end 45 30)`, `Edge.Cuts`).
- Stack: 4-layer `F.Cu / In1.Cu / In2.Cu / B.Cu` (+ silk/mask/paste/courtyard/fab).
- 8 R_SER coordinates: R101 (3.5,22.6), R102 (5.5,22.6), R201 (11.5,22.6),
  R202 (13.5,22.6), R301 (19.5,22.6), R302 (21.5,22.6), R401 (27.5,22.6),
  R402 (29.5,22.6) — all rot 90, match `pl_rows_a.py` and PCB.
- Ref→footprint mapping spot-checked (R101→0603, U6001→TQFP-64,
  U7001→MDBT50Q @−90 on F.Cu, J8001→1.27mm header on B.Cu, TP115→TP_SMD on
  B.Cu, U4001→DSK, U3001→DQA).
- Routes: **0** (`(segment` 0, `(track` 0). Vias: **0**. Copper zones: **0**.
- DRC (`kicad-cli pcb drc --format json --severity-all`): **776** violations,
  exact-match (per-violation type+description+positions) with the pre-pass
  repaired state — reproduced, not altered. (Breakdown: silk_over_copper 199,
  silk_overlap 187, courtyards_overlap 101, lib_footprint_issues 82 — missing
  stock libs on this Linux box, environment noise — solder_mask_bridge 50,
  shorting_items 48, nonmirrored_text_on_back_layer 32, clearance 27,
  silk_edge_clearance 21, copper_edge_clearance 16, lib_footprint_mismatch 11,
  pth_inside_courtyard 2; unconnected items 263.)
- Render: `kicad-cli pcb render --side top/bottom` both succeed; top view
  byte-identical to the pre-pass render (same sha256), placement untouched.

## 7. Known limitations

- Netlist changes (new nets, renames, added components) require a new
  reference PCB carrying the updated `(net ...)` declarations and pad
  assignments — the generator preserves, never invents, nets.
- New footprint *types* require their geometry in the reference PCB (or a
  re-introduction of a library-driven step with dynamically located stock
  libs + clear failure when absent). No silent substitution is implemented
  or wanted.
- Legacy `pl_gen*.py` / `pl_emit*.py` / `pl_final_*.py` / `pl_v*.py` scripts
  remain in-tree but are **not** part of this workflow; a follow-up may
  archive them. `pl_core_c.py` / `pl_core_d.py` are live inputs.
- `ARTHUR_EMG_RevA/*.lck`, `session.jsonl` are untracked session artifacts,
  out of scope for this pass.
