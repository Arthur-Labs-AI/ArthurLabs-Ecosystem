# Gerber check after corrected JST preview — NOT RELEASED

2026-10-22, Europe/Sofia. Branch `hardware/revb-horizontal-jst`, source HEAD `69b3f7410b88d11a77dddeeee453310e0d5b39b9`.

**No Gerber modification is required for this placement-rotation correction.** Current fabrication geometry already matches the PCB's north-facing five-header layout and east-facing J1 layout. CPL rotations describe how the factory places parts onto those existing lands; changing component placement angles in CPL does not require rotating copper, paste, mask, drill or outline geometry.

## Executed gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Authoritative PCB, schematics and libraries | PASS: all 27 recorded source hashes unchanged | `RESULT.json`, matched against RC2 manifest inherited from audited RC1. |
| Current fabrication archive vs RC1 | PASS: byte-for-byte identical ZIP, SHA256 `2dba5ebe1220329af378240519455e628f2672eb88e753b587c8c0f893d82dfd` | Candidate archive and frozen RC1 both read and compared. |
| Fresh native Gerber/drill export vs current archive | PASS: all 11 members identical after removing generation timestamp metadata only | `rb05_package.py` executed in fresh `/tmp/arthur-gerber-check-20261022-zq99g1cm`; all geometry, aperture, layer and manufacturing commands retained in comparison. |
| All six JST pad registration | PASS: all 24 pad centers exactly match current source evidence in F.Cu, F.Mask and F.Paste; copper pin numbers and net names also match | Gerber X2 attributes and D03 flashes parsed directly; every signal and MP land compared in `verify.py`. |
| Drill and outline | PASS: 192 drill hits; Ø0.30 via and Ø1.90 BAT-PTH definitions; fresh outline member identical | 51.30 × 64.95 mm previously measured outline unchanged. |
| Corrected CPL scope | PASS: 126 refs; only six rotation cells differ from RC1; all coordinates, sides and other 120 rotations unchanged | Five north JSTs 180°, J1 90° in the separately named J1-90 alternative. |
| New rendered opening directions | Visually corroborated by user screenshot and user confirmation | `user-corrected-preview.png`; user confirms using the supplied file. The image corresponds to the latest linked J1-90 alternative by that confirmation; selected reference/row values are not shown in the image itself. |
| Exact final 2D numbered-terminal/net overlay and factory CAM/production-file review | UNVERIFIED | A rendered body opening alone does not certify pin polarity or factory placement setup. |
| Production and body-contact safety approval | UNVERIFIED / not granted | No order, payment, upload, assembly confirmation or production authorization performed here. |

The new picture is retained verbatim; its hash and the user's Bulgarian confirmation are recorded in `RESULT.json`. Earlier RC1/RC2 evidence and bundles are not rewritten.

## Files to keep paired

- Gerbers: `../placement-orientation-2026-10-20/NOT_RELEASED_PENDING_PREVIEW_VERIFICATION/ARTHUR_Neuron_RevB_HJ_JLC_RC2_NOT_RELEASED_Gerbers.zip` — unchanged.
- CPL matching the latest test: `../placement-orientation-2026-10-20/ALTERNATE_J1_TEST_ONLY/ARTHUR_Neuron_RevB_HJ_JLC_RC2_J1_90_TEST_ONLY_NOT_RELEASED_CPL.csv` — five north headers 180°, J1 90°.
- BOM remains 28 groups / 126 factory refs and does not change for this rotation-only correction.

**Do not accidentally replace the latest tested CPL with the main RC2 CPL:** that historical candidate preserves J1 at 270°. The default exporter likewise still retains J1's legacy angle pending full pin/preview qualification. This check does not silently promote either file or change exporter policy.

For final review, confirm north-header signal tails are on the south lands (Y=8.00 mm), pin 1 east/pin 2 west; MP lands north (Y=2.25 mm). J1 signal tails must be west, pin 1 on VBAT at board (41.55,39.30), pin 2 on GND at (41.55,37.30), MP lands east. If a physical-terminal overlay fails despite a correct-looking body, investigate the model/origin and CPL mapping before authorizing assembly. No PCB/Gerber change is justified by the present evidence.

## Reproduction

Generate a fresh export in a new scratch/output directory with the existing `tools/rb05_package.py`, then run:

```sh
python3 hardware/emg/rev-b-xiao/evidence/gerber-orientation-check-2026-10-22/verify.py <fresh-export-directory>
```

The verifier is read-only and prints the machine-readable gate result. Its Gerber comparison excludes only generation timestamps, not coordinate or geometry differences. No PCB, schematic, manufacturing archive, BOM/CPL or DRC constraint was edited during this pass. Only this evidence and the current-package navigation note are added/updated; no commit or push was performed.
