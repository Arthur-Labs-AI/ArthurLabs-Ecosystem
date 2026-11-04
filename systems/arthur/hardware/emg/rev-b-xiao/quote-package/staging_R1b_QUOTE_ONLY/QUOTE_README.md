# QUOTE_README — A.R.T.H.U.R EMG Rev B, JLCPCB quote / preliminary-DFM package, **R1b staging (RB-04G)**

> **QUOTE ONLY. NOT FOR PRODUCTION.** Staging package for a preliminary quotation; manufacturing release and purchasing are BLOCKED (see `NOT_FOR_PRODUCTION__QUOTE_ONLY.txt`).
> It supersedes the RB-05 package, which is invalidated (`../SUPERSEDED_pre_R1b__DO_NOT_USE/`).

Generated 2026-10-12 from the canonical project with R1b installed (PCB sha256 at export `75875df32d63d202…`; after the RB-04H metadata-only field sync the canonical PCB is `7fda8d9c6fa568d7…` — Gerber/drill/BOM/CPL re-exported from it are identical apart from timestamps; footprint sha256 `c8703292766625345…`).
Change vs RB-05: **only U1 pad 23** (BAT+ post): drill 1.40 → **1.90 mm**, F.Cu/inner copper 1.90 → **2.30 mm**, F.Mask opening 1.45 → **1.95 mm**; B.Cu Ø3.00 pad, position and net unchanged. BOM and CPL are byte-identical to RB-05.
Changed Gerber layers: F.Cu, B.Cu, In1, In2, F.Mask, B.Mask and the drill file (silkscreen, paste, Edge.Cuts: no semantic change).

## 1. Files

| File | Content |
|---|---|
| `ARTHUR_EMG_RevB_R1b_QUOTE-ONLY_Gerbers.zip` | 10 Gerber layers (RS-274X X2, metric) + one Excellon drill: 201 × Ø0.30, **1 × Ø1.90** (PTH, U1.23); flat zip, no job file. Zip name carries QUOTE-ONLY on purpose |
| `ARTHUR_EMG_RevB_R1b_QUOTE-ONLY_BOM.csv` | JLC format `Comment, Designator, Footprint, LCSC Part #`: 29 lines / 126 designators |
| `ARTHUR_EMG_RevB_R1b_QUOTE-ONLY_CPL.csv` | 126 rows, all Top; community rotation offsets (see §4) |
| `alternate/…_CPL_raw_KiCad_rotation.csv` | same positions, unmodified KiCad rotations |
| `MANIFEST.json`, `SHA256SUMS.txt` | file list, hashes, source hashes, status flags |
| `verification/` | `package_verification.json` (16 independent checks), `gerber_vs_kicad_report.json` (14 checks), `structural_diff_pre_vs_post_R1b.json` |

## 2. Suggested order-form values (verify each on JLC's page; I did not open the order form)

| Setting | Value |
|---|---|
| Layers / size / thickness | 4 / 51.30 × 64.95 mm / 1.6 mm (stack-up JLC04161H-7628, no impedance control) |
| Copper | 1 oz outer, 0.5 oz inner (design assumption) |
| Min via hole / diameter | 0.30 mm / 0.60 mm design → the default "0.3 mm / 0.4 mm" tier fits; do **not** pick a finer tier |
| Via covering | **Tented** (the mask Gerber has no via apertures). Do not choose plugged / epoxy-filled unless JLC advises |
| Surface finish | HASL (design file assumption; lead-free vs leaded and ENIG are your choice and change price) |
| Assembly | Economic PCBA, **Top side only**, 2 boards, "confirm parts placement" optional. No bottom side, no through-hole, XIAO **not** supplied |
| Board count | the PCB service has its own minimum quantity (often 5); the 2 assembled boards are a PCBA option, not the fabrication count |

## 3. What was verified (all from the shipped files, independent parser — `tools/rb05_verify.py`)

| Check | Result |
|---|---|
| Zip is flat, 10 layers + drill, no job file | PASS |
| Outline 51.30 × 64.95 mm, origin 0,0 (Gerber y ≤ 0) | PASS |
| 201 × 0.30 mm holes at exactly the 201 via positions; 1 × 1.90 mm PTH at U1.23 (R1b); 0 NPTH | PASS |
| Every F.Cu pad of the PCB (incl. pin 1 of all polarised parts) has a flash at its centre | PASS |
| F.Mask 355 openings, B.Mask 10; no via aperture on either mask | PASS |
| No via hole inside or touching a mask opening on either side (all hole-to-opening webs ≥ 0.10 mm) | PASS |
| Mask classes re-derived from the mask Gerber: 179 / 12 / 10, class and hole-edge distance of V01–V22 agree with `via_list.csv` within 0.03 mm | PASS |
| CPL: 126 rows = every non-DNP SMD footprint, all top, none of U1/TP1–TP8; coordinates = PCB origins (x, −y) to 0.0006 mm; raw rotation = KiCad | PASS |
| BOM: 126 unique designators = CPL set, 29 LCSC numbers, equal to the RB-04B selection | PASS |
| KiCad DRC `--schematic-parity --severity-all`: 0 errors, 1 accepted warning (`lib_footprint_mismatch` U1), 0 unconnected, 0 parity | PASS |
| ERC | 0 violations |
| Guard (netclasses, 10 custom DRC rules, via/mask severities, stack-up, finish, tenting) + canary + 15 negative controls | PASS |
| Project file hashes (`tools/baseline/canonical_files.sha256`) before and after the export; no `.history` / lock debris | PASS |
| Copper, positions, schematic, footprints modified | **none** (export from a scratch copy; canonical PCB hash identical) |

### BAT+ post geometry (XIAO U1 pad 23, VBAT) — R1b

Source: PTH at (44.635, 54.790) mm; **drill 1.90 mm** (finished 1.82–2.03 mm per JLC +0.13/−0.08); F.Cu pad and In1/In2 flash **Ø2.30 mm** (annulus 0.20 mm); F.Mask opening **Ø1.95 mm** (mask margin −0.175 mm); a separate
**B.Cu Ø3.00 mm pad (net VBAT) with a Ø3.00 mm B.Mask opening** — unchanged. Gerber: all flashes at Gerber (44.635, −54.790) with matching sizes; the drill file has the 1.90 mm hole at the same position (`package_verification.json`).
JLC will see a plated 1.9 mm hole whose front mask opening (1.95 mm) is 0.025 mm per side larger than the nominal drill, so a hole at the +0.13 limit (2.03 mm) can be larger than the opening (mask film may overhang up to 0.165 mm in the worst corner, see `REVB_RB04F_BAT_POST_FINAL_DFM.md`). This is item 5 below.

## 4. CPL rotations and positions — read before upload

The primary CPL applies the rotation offsets that KiCad-to-JLC converters commonly use (+180° for SOT-23*, +270° for TSSOP*/SOIC*, +180° for the S-type JST). They come from a public KiBot reference, **not from JLCPCB**.
The JLC component viewer is the only authority: check pin-1 markers of the parts below after upload. If a family is wrong, correct it in the viewer or switch that family to the raw value.
Positions are the footprint origins; every footprint's pad bounding box is centred on its origin (checked), so no body-centre correction is applied; this is also unconfirmed by JLC.

| Ref | Footprint | KiCad rot (raw file) | Primary CPL rot | Pin-1 pad centre (KiCad x, y mm) |
|---|---|---|---|---|
| D101 | SOT-23 | 180° | 0° | 38.337, 14.950 |
| D102 | SOT-23 | 180° | 0° | 33.638, 14.950 |
| D103 | SOT-23 | 0° | 180° | 8.162, 45.200 |
| D104 | SOT-23 | 0° | 180° | 4.263, 45.200 |
| D201 | SOT-23 | 180° | 0° | 28.938, 14.950 |
| D202 | SOT-23 | 180° | 0° | 24.238, 14.950 |
| D203 | SOT-23 | 0° | 180° | 4.263, 48.800 |
| D204 | SOT-23 | 0° | 180° | 8.162, 48.800 |
| D301 | SOT-23 | 180° | 0° | 19.538, 14.950 |
| D302 | SOT-23 | 180° | 0° | 14.838, 14.950 |
| D303 | SOT-23 | 0° | 180° | 8.162, 52.400 |
| D304 | SOT-23 | 0° | 180° | 4.263, 52.400 |
| D401 | SOT-23 | 180° | 0° | 10.137, 14.950 |
| D402 | SOT-23 | 180° | 0° | 5.438, 14.950 |
| D403 | SOT-23 | 0° | 180° | 4.263, 56.000 |
| D404 | SOT-23 | 0° | 180° | 8.162, 56.000 |
| FB1 | L_0603_1608Metric | 0° | 0° | 26.212, 56.950 |
| J1 | JST_PH_S2B-PH-SM4-TB_1x02-1MP_ | 90° | 270° | 41.550, 39.300 |
| J101 | JST_PH_B2B-PH-SM4-TB_1x02-1MP_ | 180° | 180° | 36.050, 3.250 |
| J201 | JST_PH_B2B-PH-SM4-TB_1x02-1MP_ | 180° | 180° | 26.650, 3.250 |
| J301 | JST_PH_B2B-PH-SM4-TB_1x02-1MP_ | 180° | 180° | 17.250, 3.250 |
| J401 | JST_PH_B2B-PH-SM4-TB_1x02-1MP_ | 180° | 180° | 7.850, 3.250 |
| J5001 | JST_PH_B2B-PH-SM4-TB_1x02-1MP_ | 180° | 180° | 45.450, 3.250 |
| Q3001 | SOT-23 | 0° | 180° | 27.863, 36.800 |
| U4002 | SOT-23-5 | 0° | 180° | 21.363, 36.600 |
| U501 | TSSOP-14_4.4x5mm_P0.65mm | 180° | 90° | 33.212, 24.550 |
| U502 | TSSOP-14_4.4x5mm_P0.65mm | 180° | 90° | 14.413, 24.550 |
| U503 | TSSOP-14_4.4x5mm_P0.65mm | 180° | 90° | 44.312, 24.550 |
| U6001 | TSSOP-20_4.4x6.5mm_P0.65mm | 0° | 270° | 15.438, 49.025 |
| X1 | OSC_SCTF_SX3M_SMD3225-4P | 180° | 180° | 25.300, 46.175 |

Parts whose primary rotation differs from the raw one: 23 (all SOT-23, SOT-23-5, TSSOP-14/20 and J1). Non-polar 0603/0805 passives, FB1 and the SX3M oscillator are unchanged.

## 5. The 22 open mask-via cases as exported

`class 3` = via annulus overlaps a pad opening; `class 2` = annulus outside but dam < 0.09 mm. Values re-measured on the exported mask Gerber (hole edge → nearest opening; annulus edge → opening, negative = overlap):

| Via | Class | Hole edge → opening (mm) | Annulus edge → opening (mm) |
|---|---|---|---|
| V01 | class 3 | 0.125 | -0.025 |
| V02 | class 3 | 0.125 | -0.025 |
| V03 | class 3 | 0.110 | -0.040 |
| V04 | class 3 | 0.108 | -0.042 |
| V05 | class 3 | 0.125 | -0.025 |
| V06 | class 3 | 0.125 | -0.025 |
| V07 | class 3 | 0.141 | -0.009 |
| V08 | class 3 | 0.125 | -0.025 |
| V09 | class 3 | 0.125 | -0.025 |
| V10 | class 3 | 0.101 | -0.049 |
| V11 | class 2 | 0.228 | +0.078 |
| V12 | class 2 | 0.164 | +0.014 |
| V13 | class 2 | 0.164 | +0.014 |
| V14 | class 2 | 0.228 | +0.078 |
| V15 | class 2 | 0.233 | +0.083 |
| V16 | class 2 | 0.175 | +0.025 |
| V17 | class 2 | 0.200 | +0.050 |
| V18 | class 2 | 0.156 | +0.006 |
| V19 | class 2 | 0.175 | +0.025 |
| V20 | class 2 | 0.150 | +0.000 |
| V21 | class 2 | 0.179 | +0.029 |
| V22 | class 2 | 0.226 | +0.076 |

The Gerber contains **no via apertures** (all tented). Whether JLC's CAM keeps them tented, adjusts pad openings, or flags them is exactly what `REVB_RB04A_JLC_QUESTIONS.md` asks.

## 6. Remaining uncertainty (not proven by any local check)

1. **Mask**: registration tolerance and CAM behaviour for the 10 class-3 and 12 class-2 vias are unknown; the C6009 via (V04) has 0.04 mm annulus overlap and a 0.11 mm web. A passing automatic DFM does not settle them.
2. **Ring**: 0.15 mm via annular ring = JLC's published absolute minimum (recommended 0.20 mm).
3. **Rotations / pin 1** for SOT-23, SOT-23-5, TSSOP, JST S-type: community offsets only (§4). JST connectors, the SX3M oscillator and the TPS7A2030 are unchecked against the 255 ± 5 °C Economic reflow.
4. **Economic eligibility**: every selected part lists "Economic and Standard", but the 2.5 mm body-to-edge note and the board-size/quantity rules of the Economic service are not confirmed; the 16 BOM lines whose Basic/Extended class was not shown may add feeder fees.
5. **BAT+ post**: a Ø1.90 mm PTH (finished up to 2.03 mm) with a Ø1.95 mm front mask opening, a Ø2.30 mm land (0.20 mm annulus = JLC "recommended") and a Ø3.0 mm bare back pad. JLC's handling of a mask opening smaller than the finished hole and its mask registration tolerance are **not published**; CAM may enlarge the opening. Written confirmation requested (`REVB_RB04G_JLC_FINAL_INQUIRY.md`).
6. **Cost** is not in this package: JLC's quote will include fabrication, shipping and taxes; RB-04A/B estimates only cover parts + assembly (≈ $67–$132 for two units, not a quotation).
7. **Stock** of every LCSC line must be re-checked in JLC's BOM tool (C14663 has only 4,000 pcs; the 10 k, 10 M and 4.7 Ω lines use second-choice parts).
8. HASL finish and 1 oz / 0.5 oz copper are design assumptions, not stated in the PCB file.
9. Gerber export was validated by my own parser plus KiCad's DRC; it has **not** been loaded in a third-party CAM viewer (e.g. GerbView) or JLC's viewer.

## 7. Reproduce

```
python3 hardware/emg/rev-b-xiao/tools/rb05_package.py <scratch> <out>   # output names are the RB-05 names; the staging copy renames them with QUOTE-ONLY
python3 hardware/emg/rev-b-xiao/tools/rb05_verify.py <out> hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB/ARTHUR_EMG_RevB.kicad_pcb hardware/emg/rev-b-xiao/evidence/rb04a/jlc_inquiry/via_list.csv verify.json
```
