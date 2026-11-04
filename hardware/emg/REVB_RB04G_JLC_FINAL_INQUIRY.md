# RB-04G — Final JLCPCB Technical Inquiry (prepared, **NOT SENT**)

Date: 2026-10-12. **No manufacturer was contacted and no file was uploaded.** Sending requires your explicit approval, and attaching any Gerber/BOM/CPL needs a separate approval (they are not attached to this text).
Design: "ARTHUR_EMG_RevB", 4 layers, 51.30 × 64.95 mm, 1.6 mm (JLC04161H-7628), 1 oz outer / 0.5 oz inner, HASL, tented vias, top-side Economic PCBA, 2 assembled boards.
Reference files (local, not sent): `quote-package/staging_R1b_QUOTE_ONLY/` (Gerbers dated 2026-10-12, R1b), `evidence/rb04a/jlc_inquiry/` (overview.png, V01–V22.png, via_list.csv).

## How to answer

For each question please mark: **N** nominal capability · **C** what your CAM changes on this file · **P** confirmed production acceptability (you will build this exact geometry without a hold). ★ = a P-level written answer is needed.

## A. BAT+ post hole (U1 pad 23, one plated through hole, net VBAT, at x = 44.635 mm, y = 54.790 mm)

| Layer | Geometry |
|---|---|
| Drill file | **1 × Ø1.90 mm plated** (T2), 201 × Ø0.30 vias (T1); no NPTH |
| F.Cu land / In1 / In2 pad | **Ø2.30 mm** (annular ring 0.20 mm) |
| F.Mask (top) | **Ø1.95 mm** opening (0.025 mm per side larger than the nominal drill; the land is covered by mask outside the opening) |
| B.Cu | separate **Ø3.00 mm** pad, same net, no paste, with a Ø3.00 mm B.Mask opening (bare collar) |
| B.Mask over the hole | opening Ø1.95 mm, inside the Ø3.00 mm opening |

**A1 ★** Is a plated Ø1.90 mm hole (finished 1.82 … 2.03 mm with your +0.13 / −0.08 mm) with a **Ø1.95 mm** F.Mask opening accepted as drawn? The finished hole may be larger than the opening by up to 0.04 mm per side before drill wander (±0.075 mm) and mask registration. Will your CAM leave the opening, enlarge it (to what size), or shrink it? Is solder-mask film intruding into the hole acceptable on a hole that is not a component-lead hole (it lies under a hand-fitted module)?
**A2 ★** What is the **solder-mask registration tolerance** for 4-layer LPI on this stack-up (not stated in the capabilities pages)?
**A3 ★** Is a **0.20 mm annular ring** acceptable at this hole size for F.Cu and for the inner pads (we assume IPC-6012 Class 2 with up to 90° breakout allowed)? Is the inner pad (isolated from the plane by the plane clearance) kept, enlarged to your minimum, or removed?
**A4** Is the +0.13 / −0.08 mm finished-size tolerance valid for a Ø1.90 mm PTH in a 4-layer board with 1.6 mm thickness (aspect ratio 0.84 : 1)? Is the drill-file value treated as the finished size (do you compensate plating)?
**A5** Does the Ø3.00 mm bare B.Cu pad (no paste, HASL) with a Ø1.9 mm hole raise any concern (HASL solder plug, hole filling, solder fill of the hole)?
**A6 ★** HASL finish: does HASL (lead-free or leaded) reduce the finished hole by up to what amount for a Ø1.9 mm hole? We need ≥ 1.75 mm free diameter for a Ø0.51 mm post plus solder.

## B. Post solderability (information request, not a fabrication question)

**B1** Is the plated barrel (1.6 mm long, Ø1.8–2.0 mm) compatible with a hand-soldered Ø0.51 mm tinned copper post (SnPb or SAC, 330–360 °C, 3–5 s)? Any plating-thickness figure you can give (IPC Class 2: ≥ 20 µm average)?
**B2** What is the typical HASL thickness on a Ø2.3 mm land and on the barrel of a Ø1.9 mm hole (to size the module stand-off: our module rests on the mask, 0.03–0.08 mm above)?

## C. The 22 mask/via cases (unchanged by R1b)

Vias are 0.30 mm drill / 0.60 mm pad, tented on both sides (no via aperture in the mask Gerbers). 10 vias have their annulus overlapping a same-net pad opening by 0.009–0.049 mm (class 3), 12 have a mask dam of 0.00–0.087 mm between via annulus and opening (class 2). Distances were re-measured on the exported mask Gerber (V01–V22 below).

| ID | x, y (mm) | Class | Nearest pad | Hole edge → opening (mm) | Annulus edge → opening (mm; − = overlap) |
|---|---|---|---|---|---|
| V01 | 11.1, 53.2 | 3 | C306.1 | 0.125 | -0.025 |
| V02 | 23.0, 56.4 | 3 | R7104.1 | 0.125 | -0.025 |
| V03 | 24.1, 54.5 | 3 | R6003.2 | 0.1096 | -0.0404 |
| V04 | 25.2, 49.1 | 3 | C6009.2 | 0.1099 | -0.0401 |
| V05 | 26.3, 59.3 | 3 | C7102.1 | 0.125 | -0.025 |
| V06 | 28.5, 56.7 | 3 | FB1.2 | 0.125 | -0.025 |
| V07 | 30.3, 55.5 | 3 | U1.11 | 0.1409 | -0.0091 |
| V08 | 31.7, 16.5 | 3 | R106.1 | 0.125 | -0.025 |
| V09 | 36.4, 16.5 | 3 | R105.1 | 0.125 | -0.025 |
| V10 | 49.4, 58.0 | 3 | U1.3 | 0.1009 | -0.0491 |
| V11 | 7.2, 36.7 | 2 | TP8.1 | 0.2312 | 0.0812 |
| V12 | 11.1, 48.4 | 2 | C107.1 | 0.1635 | 0.0135 |
| V13 | 11.1, 49.9 | 2 | C207.1 | 0.1635 | 0.0135 |
| V14 | 13.4, 36.7 | 2 | TP7.1 | 0.2312 | 0.0812 |
| V15 | 14.2, 57.5 | 2 | C406.2 | 0.2373 | 0.0873 |
| V16 | 14.3, 18.7 | 2 | C304.2 | 0.175 | 0.025 |
| V17 | 14.6, 20.1 | 2 | U502.7 | 0.2 | 0.05 |
| V18 | 22.4, 60.7 | 2 | R7106.1 | 0.1565 | 0.0065 |
| V19 | 26.8, 54.6 | 2 | R7102.1 | 0.175 | 0.025 |
| V20 | 28.7, 37.8 | 2 | Q3001.3 | 0.15 | 0.0 |
| V21 | 30.3, 48.2 | 2 | U1.9 | 0.1791 | 0.0291 |
| V22 | 34.5, 39.7 | 2 | R7108.2 | 0.2258 | 0.0758 |

**C1 ★** Will CAM keep every via tented on both sides, or open/merge any of them with the pad opening? **C2 ★** With your registration tolerance, is a 0.10 mm mask web between hole edge and opening guaranteed for class 3? **C3 ★** What does CAM do with the 12 class-2 cases (dam < 0.09 mm: shrink the opening, leave, hold)? **C4** Is the 0.15 mm via annular ring (0.30/0.60 mm) acceptable without surcharge? **C5 ★** Is the C6009 ground via (V04: annulus overlaps the pad opening by 0.04 mm, hole edge 0.11 mm from the opening) acceptable for soldering without wicking/starved-joint risk at 255 ± 5 °C? **C6** Would a 0.25 mm drill change price, lead time, yield or Economic eligibility? (We are not requesting a change of the via population.)

## D. Assembly (Economic, top side)

**D1** Rotation/pin-1 convention of your library for SOT-23, SOT-23-5, TSSOP-14/20, JST B2B-PH-SM4-TB, JST S2B-PH-SM4-TB and the SX3M 3225-4P oscillator (we supply KiCad rotations plus community offsets: +180° SOT-23*, +270° TSSOP*, +180° S-type JST). **D2** Is the 255 ± 5 °C Economic reflow compatible with the JST connectors, SX3M oscillator and TPS7A2030? **D3** Basic/Extended class and stock of the 29 BOM lines (16 did not show a class); any minimum purchase or attrition for 2 boards. **D4** The 2.5 mm body-to-edge note and the board size/quantity rules for Economic. **D5** Outline: Edge.Cuts is a 0.1 mm line (file shows 51.40 × 65.05 mm; centre line 51.30 × 64.95 mm) — which dimension do you price?

## E. What each answer decides

| Answer | Consequence |
|---|---|
| A1 = "opening may be enlarged by CAM" | no change |
| A1 = "opening must be ≥ hole + 0.1 mm or will be rejected" | mask margin −0.175 → −0.125 (opening 2.05 mm), mask Gerber only |
| A3 = ring below your acceptance | ring 2.30 → 2.40 mm costs 0.05 mm of BAT− gap; re-run RB-04F geometry |
| C1–C5 | decides D6 (22 vias) rework or acceptance |
| D1/D2 | CPL rotation corrections / part substitution |

## F. Answer sheet (to be filled from JLC's reply)

| Q | N | C | P | Written by / date |
|---|---|---|---|---|
| A1 | | | | |
| A2 | | | | |
| A3 | | | | |
| A4–A6 | | | | |
| B1–B2 | | | | |
| C1–C6 | | | | |
| D1–D5 | | | | |

**JLC ANSWER RECEIVED: NO.**

## G. Which items can be settled from documentation

Published (re-read 2026-10-12): finished PTH tolerance +0.13/−0.08; drill position ±0.075; PTH annular ring multilayer 1 oz recommended 0.20 / absolute 0.15; mask expansion 1:1; mask bridge 0.10; plated slots need L ≥ 2W. **Not published:** mask registration; behaviour for a mask opening smaller than a finished hole; ring breakout acceptance (IPC Class 2 is JLC's default per its blog); rotation convention. Those need the written answers above (★).
