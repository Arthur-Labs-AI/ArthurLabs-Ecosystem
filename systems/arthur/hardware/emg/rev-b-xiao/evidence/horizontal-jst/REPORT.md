# Horizontal electrode JST ECO — implemented, NOT RELEASED

Date: 2026-10-19 (Europe/Sofia). Branch: `codex/revb-horizontal-jst`.
Starting commit: `98cc84e07fe4cf2791a56baba2cde3e9bb599724`.
No commits were created. Changes remain in the working tree for review.

The starting PCB and project already had uncommitted edits. The exact on-disk
PCB/project were copied to `baseline/` before this ECO. They, rather than an
older release or HEAD PCB, are the comparison baseline. Existing untracked
variants, history, GLB, backups, quote files, and software files were preserved.
The canonical `.kicad_pro` is byte-identical to its pre-task snapshot.

## Implemented scope

Actual canonical PCB: `../../kicad/ARTHUR_EMG_RevB/ARTHUR_EMG_RevB.kicad_pcb`.
Updated hierarchical schematic sheets: `emg_channel.kicad_sch` (shared by all
four channels) and `reference_vcm.kicad_sch`. Value, footprint, MPN, LCSC,
datasheet, description, and specification fields agree with the PCB. No symbol
pins or circuit connections changed. The existing vendored KiCad 10 horizontal
footprint was used; the unchanged J1 uses that same footprint.

All five connectors change from
`Connector_JST:JST_PH_B2B-PH-SM4-TB_1x02-1MP_P2.00mm_Vertical`
to
`Connector_JST:JST_PH_S2B-PH-SM4-TB_1x02-1MP_P2.00mm_Horizontal`.

| Connector | Old X,Y,rotation | New X,Y,rotation | Cable exit |
|---|---|---|---|
| J401 | 6.85, 3.75, 180° | 6.85, 5.15, 180° | north / decreasing Y |
| J301 | 16.25, 3.75, 180° | 16.25, 5.15, 180° | north / decreasing Y |
| J201 | 25.65, 3.75, 180° | 25.65, 5.15, 180° | north / decreasing Y |
| J101 | 35.05, 3.75, 180° | 35.05, 5.15, 180° | north / decreasing Y |
| J5001 | 44.45, 3.75, 180° | 44.45, 5.15, 180° | north / decreasing Y |

Coordinates in mm, PCB convention. North is the assumed wristband exit edge;
case CAD is absent, so the product owner must confirm that intended direction.

The horizontal parts cannot fit at the original Y position: retention copper
would extend past the edge. Moving them inward without modifying the resistor
placement produces nine courtyard overlaps. The minimal local placement change
used here is:

* R101/R102/R201/R202/R301/R302/R401/R402: same X, Y 10.10 → 11.10,
  rotation -90° → 180°. Values, pad nets, and all component fields unchanged.
* R5002: (44.45,10.30,-90°) → (44.45,12.20,90°), same value and pad nets.
* TP5's RLD_SAFE via: (45.00,13.90) → (46.50,13.90), same drill and net;
  its local approach/bottom segment was rerouted.

Electrode, local post-limiter Hi-Z, retention-pad, RLD_SAFE and VCM approaches
were rerouted. Other copper is structurally unchanged. The two MP pads of each
connector retain their isolated original MP net and connect to each other with
a short top-layer strap. They have no signal/GND connection. Ten redundant MP
vias were removed; no new signal vias were introduced. Total segments 1518 →
1455; vias 201 → 191. All zones were refilled by KiCad.

Each channel's connector-to-limiter trace lengths are P 4.000914 mm and
N 3.317462 mm (0.683452 mm mismatch); both run directly on F.Cu. This is shorter
than the baseline electrode approaches; it is not an analog-performance or EMC
qualification. Original downstream routing and reference/plane definitions
remain. `invariants.json` records full before/after net trace lengths.

## Pin mapping and invariants

| Ref | Pin 1 | Pin 2 |
|---|---|---|
| J101 | /CH1/ELEC_P | /CH1/ELEC_N |
| J201 | /CH2/ELEC_P | /CH2/ELEC_N |
| J301 | /CH3/ELEC_P | /CH3/ELEC_N |
| J401 | /CH4/ELEC_P | /CH4/ELEC_N |
| J5001 | unconnected-(J5001-Pad1), intentionally NC | /Reference_VCM/RLD_SAFE |

32 independent structural/net assertions PASS in `invariants.json`: unchanged
J1 in full, every pad-to-net assignment, component census, other components,
resistor properties/values, outline, stackup/setup, layers, zone definitions,
title warning, unrelated tracks/vias, and target connector identity/orientation.
The 51.30 × 64.95 mm board outline is unchanged.

## Mechanical qualification and limits

Primary source: [JST PH datasheet](https://www.jst.com/wp-content/uploads/2025/06/ePH.pdf),
archived as `JST_PH_datasheet.pdf`; pages 2–4 contain the SMT land pattern,
PHR-2 housing, side-entry header and circuit-1 marking. The target is
S2B-PH-SM4-TB(LF)(SN), 2 mm pitch, nominal header width 7.9 mm, height 5.5 mm.
PHR-2 housing and compatible SPH-002T-P0.5S contacts are the mating family.

The vendored footprint's two signal pads are 1.0 × 3.5 mm, pitch 2.0 mm;
MP pads 1.5 × 3.4 mm at X ±3.35, Y +2.90. Signal centres are X ±1.00,
Y -2.85, pin 1 at negative local X. Signal pad width meets the datasheet's
1 mm minimum and length 3.5 is at its 3.4 ±0.1 mm upper limit; MP nominal
sizes agree with the SMT land drawing. Local +Y is the entry face; 180° maps
this to north. The misplaced old vertical retention routing was removed.

Nominal checks on the resulting geometry:

* 9.40 mm connector spacing, 1.50 mm nominal header body gap.
* 0.20 mm minimum adjacent connector courtyard gap.
* 0.55 mm retention-pad copper-to-north-edge clearance (existing rule: 0.50).
* 0.75 mm entry-face setback from the north edge.
* 0.15 mm nominal channel-resistor courtyard gap from connector rear;
  reference-resistor courtyard gap 0.10 mm. No courtyard conflicts in DRC.
* 5.80 mm PHR-2 envelope width gives 3.60 mm between adjacent plugs.
* A conservative full 6.85 mm unmated PHR-2 envelope is drawn outside each
  face (insertion overlap deliberately ignored); 8 mm of straight leads and
  an assumed 8 mm wide, 10 mm long service corridor are illustrated.
  These last service dimensions are design assumptions, not JST guarantees.

Actual KiCad 2D output was inspected in `layout.svg` / `layout.png`.
`mechanical-plan.svg` / `.png` show the exit direction and nominal envelopes.
`3d-envelopes.png` is an actual KiCad render of a PREVIEW COPY with conservative
box models, **not manufacturer CAD**. Ivory is a 7.9 × 8.6 × 5.5 mm bound
covering header body/tail extent, blue is a full PHR-2 envelope, red is a
straight cable indication. Preview models never enter the canonical PCB or
fabrication exports. Other component 3D models are also unavailable locally.
`horizontal_jst_preview.py` regenerates the preview copy and VRML.

The canonical footprints retain their standard library STEP reference. That
STEP is not installed; attempts to fetch the exact model from the official
KiCad GitHub/GitLab library paths returned 404. The JST product page returned
403. Consequently detailed plastic/latch/tolerance and mated-assembly 3D fit
are UNVERIFIED. No enclosure, strap, strain-relief or cable-bend specification
was supplied. Finger/tool removal access and confirmation of the north-facing
case opening remain blockers. A 0.20 mm nominal courtyard gap is not proof of
comfortable finger access or tolerance compliance.

## DRC, ERC, independent checks

KiCad CLI 10.0.6, full project libraries and unchanged project rules.

| Gate | Before | After | Status / evidence |
|---|---:|---:|---|
| DRC errors | 0 | 0 | PASS, before-drc.json / after-drc.json |
| DRC warnings | 1 | 1 | Same pre-existing U1 library mismatch |
| Unconnected items | 0 | 0 | PASS |
| Native schematic parity issues | 0 | 0 | PASS |
| Final schematic ERC | — | 0 | PASS, after-erc.json |
| Structural/net invariants | — | 32/32 | PASS, invariants.json |
| Raw CPL positions/membership | — | 126 parts, no issues | PASS, cpl-check.json |
| Export/source checks | — | PASS | fabrication-check.json |
| Legacy electrical audit | 22/23 | 22/23 | FAIL: identical existing D06 diode MPN discrepancies |
| Qualified manufacturer 3D / case fit / removal access | — | — | UNVERIFIED |
| Factory feeder/rotation, stencil/DFM approval | — | — | UNVERIFIED |
| Separate body-contact electrical safety review | — | — | UNVERIFIED; required before release/use |

The sole DRC warning is U1 `XIAO_ESP32S3_HANDSOLDER` differing from its vendored
library copy, with the same UUID/location before and after. It was not waived
or changed. No new exclusions or relaxed constraints were added. No DRC
issues were added or removed. The earlier scratch-only missing-library
warnings disappeared when the project's vendored libraries were included.

`parity.json` is the older textual checker: it reports the same two pre-existing
U1 NC names with `/` versus KiCad's `{slash}` spelling in `before-parity.json`;
it also reports PCB U1 DNP against its simplistic schematic DNP detection.
The native KiCad checker reports no parity issues. All five modified connectors
match in both tools; these unchanged U1 details are documented, not rewritten.

The legacy netlist audit's connector oracle was explicitly changed to the new
part/footprint/LCSC required by this ECO. Its remaining D06 failure is identical
before/after: sixteen `BAV199,215` MPN fields compared with its older `BAV199`
expectation. `before-net-audit.json` and `after-net-audit.json` are identical.
No diode expectation or electrical/safety check was weakened to get a pass.

## Manufacturing exports

`NOT_RELEASED_fabrication/` was regenerated from canonical schematic and PCB
using the existing `rb05_package.py` process, not hand-edited CSVs. It contains
10 Gerber layers + one Excellon drill file in the ZIP, a schematic-derived BOM,
factory-corrected CPL and raw KiCad-rotation CPL. The old release is untouched.

BOM: 126 refs before/after; only five refs change C160352 → C295747 and vertical
→ horizontal identity. They group with unchanged J1: six parts on the C295747
row; BOM groups 29 → 28. No other ref's BOM data changes.

CPL: 126 refs before/after, exactly 14 changed rows: the five connectors and nine
resistors listed above. Connector KiCad rotation remains 180°; the existing
factory correction adds 180° for JST_PH_S packages, giving 0°. J1 stays factory
270° at 44.4000,-38.3000 mm. Raw coordinates use KiCad's exported negative Y.
Factory visual confirmation is still required. Full per-ref changes are in
`export-diff.json`.

`fabrication-check.json` confirms all 191 via drill coordinates against source,
all 60 connector pad-centre flashes across F.Cu/F.Mask/F.Paste, and matching BOM
and CPL reference sets. This does not qualify aperture dimensions, stencil
process, fabrication tolerances, or assembly orientation acceptance.

## Reproduction

Run tools from the repository root. Avoid opening the canonical PCB through
pcbnew Python: older project tooling documents its `.kicad_pro` rewrite side
effects. Work on a full scratch project, including vendored libraries, symbol
library and library tables, then install only the intended PCB.

```bash
python3 hardware/emg/rev-b-xiao/tools/horizontal_jst_eco.py \
  hardware/emg/rev-b-xiao/evidence/horizontal-jst/baseline/ARTHUR_EMG_RevB.kicad_pcb \
  /tmp/full-project/ARTHUR_EMG_RevB.kicad_pcb \
  hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB/fp-libs/Connector_JST.pretty/JST_PH_S2B-PH-SM4-TB_1x02-1MP_P2.00mm_Horizontal.kicad_mod
kicad-cli pcb drc --refill-zones --save-board --severity-all --schematic-parity \
  --format json -o /tmp/drc.json /tmp/full-project/ARTHUR_EMG_RevB.kicad_pcb
python3 hardware/emg/rev-b-xiao/tools/horizontal_jst_verify.py \
  hardware/emg/rev-b-xiao/evidence/horizontal-jst/baseline/ARTHUR_EMG_RevB.kicad_pcb \
  hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB/ARTHUR_EMG_RevB.kicad_pcb /tmp/invariants.json
python3 hardware/emg/rev-b-xiao/tools/rb05_package.py /tmp/fresh-export /tmp/NOT_RELEASED
python3 hardware/emg/rev-b-xiao/tools/horizontal_jst_export_verify.py
```

The schematic field changes in this ECO must accompany the PCB; do not rerun
historical placement/build scripts as an update workflow because those scripts
reconstruct their earlier phase's placement. Use the updated schematic as source.

## Acceptance decision and blockers

Electrical/layout implementation, routing/refill, field synchronization and
fresh exports are complete and verified within the stated checks. Full
acceptance is **not satisfied**: qualified detailed 3D/mated fit, enclosure exit
confirmation, removal access, cable bend/strain relief, factory DFM/rotation
approval, and the separate safety review remain open. Keep the original
`NOT RELEASED: manufacturing blocked, no safety certification` warning.

No manufacturing readiness, certification, safe-to-wear or human-use claim is
made. Existing project operating constraint remains: no electrodes on the body
while USB is connected; no isolation is claimed. The required separate review
must assess isolation/protective design and charging-versus-wearing constraints.
