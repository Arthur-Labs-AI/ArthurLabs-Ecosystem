# RB-04H — Final Schematic/PCB Metadata Synchronization: Sign-off

Date: 2026-10-12. Branch `hardware/emg-rev-b`. The metadata-only synchronisation was performed on a scratch copy, verified, then installed into the canonical PCB (on your approval) and the hash lock updated.
Nothing was purchased, uploaded, sent to JLC or Seeed, committed or pushed. No manufacturing release. No electrical-safety approval and no permission for human electrode use is implied.

## 1. Result

```
ORIGINAL FIELD WARNINGS:             126 (footprint_symbol_field_mismatch, severity warning; one per factory-placed footprint)
REMAINING FIELD WARNINGS:            0
EXACT FIELDS CHANGED:                709 property edits in 126 footprints (table §3); no other change
PCB GEOMETRY PRESERVED:              YES
SCHEMATIC PARITY:                    PASS (refs 135/135, values, footprints, 357 pad nets, 0 field mismatches)
DRC / ERC / UNCONNECTED:             0 errors, 1 accepted warning (lib_footprint_mismatch U1) / 0 / 0
BOM / CPL UNCHANGED:                 YES (byte-identical)
R1b GEOMETRY PRESERVED:              YES (drill 1.90, F.Cu 2.30, mask 1.95, B.Cu 3.00, same position and net)
GERBER / DRILL EQUIVALENT:           YES (all 11 files identical apart from timestamp lines)
GUARD / CANARY:                      PASS / PASS
QUOTE-ONLY PACKAGE:                  VALID (staging_R1b_QUOTE_ONLY; manifest updated; still NOT FOR PRODUCTION)
JLC CONFIRMATION:                    PENDING      SEEED CONFIRMATION: PENDING      PHYSICAL MODULE: PENDING
READY TO ORDER:                      NO
```

## 2. Investigation of the 126 warnings (before any change)

| Question | Finding |
|---|---|
| What are they? | KiCad's schematic-parity check compares the *fields* of each schematic symbol with the *properties* of the PCB footprint. Since RB-04A/RB-04B the schematic carries the qualified MPN / Manufacturer / LCSC / JLC_Class / BOM_Status / LCSC datasheet; the PCB footprints still carried the RB-01/RB-02 generic text |
| Severity | **warning** only. No electrical, geometric or netlist content; they do not appear in the fabrication outputs |
| Why did DRC show "1 accepted warning" and 126 field mismatches? | The DRC JSON has two separate arrays: `violations` (1 item: `lib_footprint_mismatch` U1) and `schematic_parity` (the 126 field warnings). My summary line printed the violations by type and only the *length* of the parity array ("parity 126"), and earlier reports described it as "0 parity" in the sense of reference/value/footprint/net parity. The 126 were therefore always present since RB-04A; RB-04G disclosed them, RB-04H removes them |
| Which field does each warning name? | KiCad reports only the **first** differing field per footprint (113 × MPN, 2 × Manufacturer, 5 × missing LCSC, 6 × missing BOM_Status). The full inventory (`evidence/rb04h/inventory_before.csv`) lists every differing field: 126 footprints × up to 6 fields |
| Authoritative source | the schematic fields as exported in the netlist; verified against the RB-04B selection (`rb04a_selection.py`): **126/126 refs, 0 mismatches** in MPN, Manufacturer, LCSC, JLC_Class, BOM_Status |
| The one remaining "accepted warning" | `lib_footprint_mismatch` for **U1**: the board's U1 is a flattened instance of `ARTHUR:XIAO_ESP32S3_HANDSOLDER` (geometry stored rotated, fields/Reference properties, no embedded keep-out zone) and differs from the library copy in graphics, zone and text, not in the 14 castellation pads, the BAT+ post or the R1b geometry. It predates this work (accepted since RB-02), cannot be resolved by a metadata edit and is outside the scope you approved; it has no fabrication impact |

## 3. Exact fields changed (`evidence/rb04h/sync_changes.json`)

| Property | Action | Footprints | Example |
|---|---|---|---|
| MPN | value replaced | 113 | `GENERIC (spec-defined; …)` → `0603B225K160NT` |
| Manufacturer | value replaced | 99 | `Any (JLC Basic)` → `FH (Guangdong Fenghua)` |
| LCSC | **added** (hidden) | 119 | → `C43922` (7 footprints already had it) |
| JLC_Class | value replaced | 126 | `Basic (expected)` → `Extended Parts` |
| BOM_Status | **added** (hidden) | 126 | → `QUALIFIED` |
| Datasheet | value replaced | 126 | generic note → `https://www.lcsc.com/datasheet/C43922.pdf` |

Total **709** edits. U1 and TP1–TP8 (9 footprints) already matched. Added properties are clones of the footprint's own hidden JLC_Class property: layer `F.Fab`, `(hide yes)`, size 0.6; **no visible property was added or edited** (Reference and Value properties untouched; F.Fab is not exported to the Gerbers).
Method: `tools/rb04h_sync_fields.py` text edit on a scratch copy — not KiCad "Update PCB from Schematic" and not pcbnew (no footprint regeneration from the library, no reordering, no re-save). Fields not named in the six above (Spec, Role, Description, Status, Reference, Value) were already equal or untouched.

## 4. Verification (scratch candidate first, then canonical)

| Check | Result |
|---|---|
| Non-footprint content (outline, segments, vias, zones, setup, layers, title block, nets) | identical |
| Footprints | 135/135; **positions, rotations, layers identical**; pads, graphics, text, attributes identical (only hidden custom properties differ); U1 pad 23 = 2.3 / 1.9 / −0.175 as installed |
| Segments / vias | 1518 / 201 identical |
| Fill area | In1 3055.41, In2 2313.58 mm² unchanged (fills untouched) |
| Outline | 0 … 51.30 × 0 … 64.95 mm |
| Netlist pad nets | 357, 0 unconnected nets (identical parity JSON) |
| KiCad DRC (`--schematic-parity --severity-all`) | 0 errors; 1 warning (`lib_footprint_mismatch` U1); **0 schematic_parity**; 0 unconnected |
| ERC | 0 violations |
| Field inventory after | **0 refs with a mismatch** (`inventory_after.json`, `inventory_canonical_final.json`) |
| RB-04 audits (geometry, mask, power, conn, electrical, iron access, CPL check, guard self-test 15/15) | **byte-identical** to the RB-04G results; guard check and canary PASS |
| Gerber / drill | 10 layers + drill equivalent to the staging package (timestamps only); drill T2 = Ø1.90 at the post; `rb05_verify` 16/16, `rb04_gerber` 14/14 |
| BOM / CPL / raw CPL | byte-identical to the staging files |
| Canonical install | pre-sync PCB archived (`archive/rb04h_pre_metadata_sync/`, sha256 `75875df3…`); installed PCB sha256 `7fda8d9c6fa568d7…`; lock baseline now lists the new PCB hash, the other ten hashes unchanged; no `.history`/lock debris |

## 5. Quote-only package

`quote-package/staging_R1b_QUOTE_ONLY/` (and `~/ARTHUR_EMG_RevB_JLC_QUOTE_R1b_QUOTE-ONLY/`) remain valid: Gerber, drill, BOM and CPL files are unchanged (the re-export is identical apart from timestamps). The manifest and README now record both the PCB hash at export (`75875df3…`) and the current one. The package is still stamped NOT FOR PRODUCTION; the superseded RB-05 package stays invalidated.

## 6. Remaining confirmations (unchanged by this work)

* **JLC (inquiry prepared, not sent):** mask opening 1.95 mm vs finished hole up to 2.03 mm, mask registration, 0.20 mm ring acceptance, HASL hole reduction, the 22 class-2/class-3 mask-via cases, CPL rotations, reflow suitability of the JST/oscillator/LDO, BOM library classes — `REVB_RB04G_JLC_FINAL_INQUIRY.md`.
* **Seeed (not sent):** revision and geometry of PN 202003751, BAT pad position/finish, thickness, charger variant, boot states — `REVB_RB04G_SEEED_FINAL_CONFIRMATION.md`.
* **Physical:** one real XIAO module (thickness, pad positions) and the post-cone/bottom-fill trial.
* **Design decisions still yours:** skin-side pad treatment (D7), the 22 via cases (D6), the U1 `lib_footprint_mismatch` (leave, or regenerate the instance from the library as a separate, geometry-affecting task).
