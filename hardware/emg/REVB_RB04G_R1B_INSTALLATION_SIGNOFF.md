# RB-04G — R1b Installation and Freeze: Sign-off

Date: 2026-10-12. Branch `hardware/emg-rev-b`. R1b is **installed** in the canonical PCB and in the authoritative custom footprint, on your design approval. This is **not** a manufacturing release: nothing was purchased, uploaded, sent to JLC or Seeed, committed or pushed.
No electrical-safety approval and no permission for human electrode use is implied.

## 1. Final gate

```
R1b INSTALLED:                       YES
PCB GEOMETRY:                        PASS
DRC / ERC / UNCONNECTED:             0 errors, 1 accepted warning (lib_footprint_mismatch U1) / ERC 0 / 0 unconnected
SCHEMATIC PARITY:                    PASS (refs 135/135, values, footprints, 357 pad nets, 0 net mismatches)
                                     NOTE: 126 metadata-field warnings (see §5) — not errors, pre-existing since RB-04A
XIAO PIN ALIGNMENT:                  PASS (14/14 castellations 0.000 mm; BAT+ hole 0.000 mm from the BAT0 pad centre)
BAT+ POST GEOMETRY:                  CONDITIONAL (R1b worst-case margins per RB-04F; sample + JLC mask confirmation pending)
BOM/CPL UNCHANGED:                   YES (byte-identical to RB-05)
OLD MANUFACTURING PACKAGES INVALIDATED: YES
QUOTE-ONLY PACKAGE UPDATED:          YES (quote-package/staging_R1b_QUOTE_ONLY)
JLC CONFIRMATION:                    PENDING
SEEED CONFIRMATION:                  PENDING
PHYSICAL MODULE VERIFICATION:        PENDING
READY FOR PRELIMINARY QUOTE:         YES
READY TO ORDER:                      NO
```

## 2. What changed (exactly)

Reviewed before installation: the install script was run on a scratch copy and its text diff taken (`evidence/rb04g/exact_text_changes_pcb.diff`, `…_footprint.diff`): **3 changed lines in the PCB, 3 in the footprint**:

| | Before | After |
|---|---|---|
| U1 pad "23" thru-hole `size` | 1.9 × 1.9 | **2.3 × 2.3** |
| `drill` | 1.4 | **1.9** |
| `solder_mask_margin` | −0.225 (opening 1.45) | **−0.175 (opening 1.95)** |
| position (−4.445, −0.4075), net VBAT, layers, B.Cu Ø3.0 pad | — | **unchanged** |

Installation procedure: unlock → install script on the canonical project (`--canonical`) → zone refill by pcbnew in a scratch copy (the script's save wrote a stray `.rb04e_filled.kicad_pro` into the project folder; it was removed, and the project hashes verify unchanged) → structural diff → re-lock.

| Artefact | Pre-R1b (archived `archive/rb04e_pre_R1b/`) | Installed |
|---|---|---|
| `ARTHUR_EMG_RevB.kicad_pcb` | `111e1cd3d0c9fae12b53f5f8…` | `75875df32d63d202dda0c06e…` |
| `XIAO_ESP32S3_HANDSOLDER.kicad_mod` | `510594ced920387443fb03c3…` | `c8703292766625345f78a221…` |

## 3. Verification

| Check | Result |
|---|---|
| Segments | 1518 old / 1518 new, identical (uuid-agnostic) |
| Vias | 201 / 201 identical |
| Footprints | 135 / 135; **positions, rotations, layers identical**; 134 footprints byte-equivalent; U1 differs only in pad 23 (through-hole part) |
| Outline | 0 … 51.30 × 0 … 64.95 mm, 4 lines + 4 arcs identical |
| Nets, setup, layers, title block, zone definitions | identical |
| Plane fill | In1 3057.11 → 3055.41 mm² (−1.70, antipad of the larger hole); In2 unchanged |
| KiCad DRC `--schematic-parity --severity-all` | 0 errors; 1 warning (`lib_footprint_mismatch` U1, accepted since RB-02); 0 unconnected |
| ERC | 0 violations |
| Netlist pad nets | **357**, 0 unconnected nets; same two `{slash}` escape notes for unconnected U1 pins |
| RB-04 audits (`evidence/rb04g/suite/`) | connectivity (TP excluded), power, electrical, iron-access, CPL check, guard self-test (15/15), guard check + canary: **identical or PASS**; geometry differs only by `pad_drills` 1.4 → 1.9 and In1 area; mask JSON only the PTH entry; Gerber report 14/14 PASS after correcting the hard-coded 1.40 mm constant in `rb04_gerber.py` (see §5) |
| Dimensions from Gerber/drill | F.Cu / In1 / In2 / B.Cu land Ø2.30; F.Mask and B.Mask hole opening Ø1.95; B.Cu Ø3.00 with Ø3.00 mask; drill T2 = **Ø1.90 plated** at (44.635, −54.790); `rb05_verify` 16/16 PASS |
| BOM / CPL | byte-identical to the RB-05 files (126 placements, top only, 29 BOM lines) |
| Project integrity | `rb04_lock.sh verify` PASS; the freeze list now also covers the PCB and the authoritative footprint (11 files); the first 9 project-file hashes are unchanged; no `.history` / lock debris |

## 4. Manufacturing preparation

| Item | Status |
|---|---|
| Old Gerber/drill package (RB-05) | **Invalidated**: moved to `quote-package/SUPERSEDED_pre_R1b__DO_NOT_USE/` with an `INVALIDATED__DO_NOT_USE.txt`, the Gerber zip renamed `…PRE_R1b_SUPERSEDED_INVALID_Gerbers.zip`; same in `~/ARTHUR_EMG_RevB_JLC_UPLOAD/` (plus a top-level marker) |
| New staging package | `quote-package/staging_R1b_QUOTE_ONLY/` and `~/ARTHUR_EMG_RevB_JLC_QUOTE_R1b_QUOTE-ONLY/`: Gerbers zip (renamed with QUOTE-ONLY), BOM, CPL, raw CPL, README, `NOT_FOR_PRODUCTION__QUOTE_ONLY.txt`, `MANIFEST.json` (source hashes, change, flags), `SHA256SUMS.txt` (all verified) |
| Changed layers | F.Cu, B.Cu, In1, In2, F.Mask, B.Mask, drill; unchanged: silkscreen, paste, Edge.Cuts |
| Uploaded | **NO** |
| Inquiries prepared (NOT sent) | `REVB_RB04G_JLC_FINAL_INQUIRY.md`, `REVB_RB04G_SEEED_FINAL_CONFIRMATION.md` |

## 5. Findings to disclose

1. **126 PCB-vs-schematic field warnings (`footprint_symbol_field_mismatch`, severity warning).** Since RB-04A wrote MPN / Manufacturer / LCSC / JLC_Class / BOM_Status / Datasheet into the **schematic** symbols, every placed PCB footprint still carries the old generic field text (113 × MPN, 2 × Manufacturer, 5 × missing LCSC, 6 × missing BOM_Status). DRC reports these as `schematic_parity` warnings, which the audit line printed as "parity 126" and which my earlier reports (RB-04A … RB-04F) summarised as "0 parity" — that statement was true for **reference/value/footprint/net parity** but I missed the 126 field warnings. They do not affect nets, geometry, BOM (generated from the schematic netlist) or CPL (positions). Per your instruction to preserve every other footprint, **I did not touch them**. Decision for you: sync the 126 footprint fields from the schematic (metadata only, one scripted pass, re-lock) or accept the warnings.
2. **`rb04_gerber.py` had a hard-coded 1.40 mm PTH drill** in its source-vs-Gerber check; with R1b it reported FAIL 0 ≠ 1. Fixed to read the drill from the PCB; the re-run is 14/14 PASS. (`rb05_verify.py` was generalised the same way in RB-04E.)
3. **`rb04e_install_R1b.sh` / pcbnew side-effect:** saving the filled board wrote a project file next to the board in the canonical folder; removed, hashes verified. If the script is reused, run it on a scratch copy and copy the board back.
4. Mask-lip-into-hole (up to 0.165 mm in the worst corner), mask registration and ring acceptance remain **JLC confirmations** (inquiry items A1–A3); fallback is mask margin −0.125 (opening 2.05 mm), mask Gerbers only.

## 6. Remaining items before any order

JLC written answers (mask opening vs hole, registration, ring, 22 vias, rotations, reflow); Seeed written answer and one real module (thickness, BAT pad position, revision); post-cone/bottom-fill trial (coupon or first article); decision on the 126 field warnings; skin-side pad decision D7; manufacturing release approval.
