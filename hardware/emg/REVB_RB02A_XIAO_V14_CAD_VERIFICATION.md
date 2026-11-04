# A.R.T.H.U.R EMG Rev B — RB-02A: Official XIAO ESP32-S3 v1.4 CAD Verification

Date: 2026-10-10. Branch `hardware/emg-rev-b`, nothing committed. Scope: **digital mechanical verification only** — no purchase,
no test PCB, no Rev A change, no RB-01R/RB-00.6 file edited (discrepancies are *reported* with recommended corrections).
Numbers: [REVB_RB02A_GEOMETRY_COMPARISON.md](REVB_RB02A_GEOMETRY_COMPARISON.md); data: `rev-b-xiao/evidence/rb02a/`.

## 0. Result in one paragraph

Seeed's "plain v1.4 SCH & PCB" download **is not the plain v1.4 design**: it is byte-for-byte the *Sense v1.5* archive (PN 202003753).
The exact plain-v1.4 CAD therefore remains **unavailable**, and the Sense file is not silently substituted: it is used as the
best available manufacturer geometry and every conclusion is labelled accordingly. Against that geometry the RB-00.6 mounting
design is **geometrically sound**: all 14 castellations, BAT+/BAT−, USB-C and U.FL match to ≤ 0.03 mm and the post hole is
0.022 mm from the BAT+ pad centre. The review found 9 documentation discrepancies (none changes the architecture; D-3, D-5 are
the ones that matter) and three physical unknowns that CAD cannot close (PCB thickness, plain-vs-Sense revision equality,
manufacturing tolerances). **Decision: CONDITIONAL GO** for digital footprint authoring and placement; a single-module caliper check
moves to the manufacturing-release gate (before Gerbers), not before RB-02.

## 1. Source acquisition and identification

| Item | URL (all fetched 2026-10-10) | SHA-256 | Finding |
|---|---|---|---|
| "Plain v1.4 SCH&PCB" zip | `https://files.seeedstudio.com/wiki/SeeedStudio-XIAO-ESP32S3/new-res/202003751_XIAO%20ESP32S3_v1.4_SCH%26PCB_260226.zip` | `a8224772…2d5cdb` (836,170 B) | contains folder **`202003753_XIAO ESP32S3 Sense_v1.5_SCH&PCB_260226`**; zip **identical** to the Sense v1.5 zip below |
| Sense v1.5 SCH&PCB zip | `…/new-res/202003753_XIAO%20ESP32S3%20Sense_v1.5_SCH%26PCB_260226.zip` | `a8224772…2d5cdb` | same bytes |
| "Plain v1.4" SCH PDF | `…/new-res/202003751_XIAO%20ESP32S3_v1.4_SCH_260226.pdf.pdf` | `15993097…9f9923c` | byte-identical to the Sense v1.5 SCH PDF; title block "XIAO ESP32-S3-Sense" |
| PCB inside the archive | `XIAO ESP32S3_V1.5.kicad_pcb` | `d20724aa…e4af6c` | KiCad 9.0 file (`version 20241229`), 71 footprints, 4 copper layers, `thickness 1.6` default, edge-cuts outline 17.78 × 21.135 |
| Dimensioning DXF | `…/res/XIAO_ESP32S3_v1.1_Dimensioning.dxf` | `5fd32e3b…67903f23` | v1.1 *bottom-side artwork* (no dimension values); shows 14 castellations, bottom legends, 2 slots, corner relief |
| 3D model (plain) | `…/res/seeed-studio-xiao-esp32s3-3d_model.zip` | `0d552ed2…03d3650` | STEP 2023-05-27; internal product name "Seeed Studio XIAO-ESP32-S3 (Sense)"; render shows the B2B connector populated |
| Secondary PCB | `github.com/Seeed-Studio/OPL_Kicad_Library`, `Seeed Studio XIAO ESP32S3/ESP32S3.kicad_pcb`, commit `b0035c5` (2026-06-23) | — | KiCad 9.0 file, 2-layer variant, same outline/pads |
| Wiki | `https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/` | — | "Dimensions 21 × 17.8 mm"; lists the files above |

Product/revision identifiers actually present in the files: schematic title block "XIAO ESP32-S3-Sense", `REV V1.3`, date 2026-02-10,
KiCad 9.0.6; internal revision log v1.0 (2023-01-04) … v1.3 (2025-10-21, "R5 changed from 0R to L5_24nH"); library
`XIAO ESP32S3_v1.2_230725`. The strings "202003751"/"202003753" appear **only** in the Seeed file names, not in any CAD file.
**Whether the archive corresponds to PN 202003751 cannot be established from Seeed's files**, and it demonstrably corresponds to
PN 202003753. This matches the gap already recorded in RB-00.5 (§2); RB-02A adds the byte-identity proof and the second PCB.

### What supports treating it as the plain module's mechanical geometry (and what does not)

| Evidence | Direction |
|---|---|
| Seeed distributes the same archive under both PNs; the plain and Sense boards are one main PCB (Sense = main board + camera/mic expansion) | supports |
| Seeed's plain 3D model is derived from the Sense STEP root and shows the identical bottom pad layout and a populated B2B connector | supports |
| A second, independent Seeed PCB (OPL, different build) has identical outline and **0.000 mm** pad-centre difference over 42 pads | supports (geometry stable across Seeed files) |
| The revision log lists only component/silk/shield-hole changes v1.0 → v1.3; none touches castellations, BAT or USB | supports |
| No Seeed file bearing PN 202003751 contains a PCB; nobody outside Seeed can show the plain v1.4 layout equals this one | **limit** |
| PCB thickness and manufacturing tolerances are not in the file | **limit** |

## 2. Extracted geometry and its provenance

| Feature | Value | Provenance |
|---|---|---|
| Outline | 17.780 × 21.135 mm, corner R1.905, 2 internal slots 0.41 × 1.25 | **actual PCB geometry** (Edge.Cuts) |
| Castellations | 14, pitch 2.540 (spread 0.000), D0 2.921 mm from the USB edge, 2.974 mm from the far edge; half-hole Ø0.70 (pad Ø1.27), header hole Ø0.95 / ring Ø1.40, SMD copper 1.626 along × 2.0–2.1 deep | PCB geometry |
| BAT+ | pad 2.032 × 1.016 at module (u = 4.445, v = 10.160), net VBAT; BAT−/GND0 2.032 × 1.016 at (4.445, 8.255), net GND, pitch 1.905 | PCB geometry |
| USB-C | 9.000 wide, centred on the module axis (u = 8.890), overhang 1.508 beyond the USB edge, body depth 7.35; 4 THT shell ovals (GND) + 2 NPTH Ø0.58 | PCB geometry (footprint silkscreen) |
| U.FL | centre u = 4.039, v = 19.406 (1.729 from the far edge), courtyard 2.8 × 4.06, name "…2.6X2.6X1.0MM" | PCB geometry / library name |
| Underside | TP1–TP8 Ø1.143 at u = 7.62/10.16; pad-25 mask window 2.75 × 2.5 (u 8.635…11.385, v 11.29…13.79); no components | PCB geometry |
| PCB thickness | 1.6 (KiCad default, no stackup stored) | **engineering default — UNRESOLVED** |
| Tolerances | none published; Seeed rounds to "21 × 17.8 mm" | **not available** |
| Module height / top parts | not extracted (3D model only, not authoritative) | assumption |

## 3. Comparison with RB-00.6 (summary)

157 rows compared (CSV/JSON): **80 MATCH, 4 MINOR, 52 INFO, 19 DISCREPANCY, 2 UNRESOLVED** (the 19 collapse to D-2, D-3 and D-4;
14 of them are the one castellation-width statement repeated per pin). The 180° transform was re-derived and validated
(comparison §1); it is correct, with a constant −0.021 mm y offset from the 21.02 vs 21.041 USB-edge reference.
Discrepancy register D-1 … D-9 with recommended corrections: comparison §8. The **frozen mounting geometry is not altered**.

## 4. BAT+ post engineering verification

Tool: `rb02a_post_sensitivity.py` (all unknown tolerances are swept, none invented). CAD facts: pad 2.032 × 1.016; GND0 pad edge
1.397 mm from the BAT+ centre; hole 0.022 mm from the pad centre toward GND0.

| # | Question | Evidence | Verdict |
|---|---|---|---|
| 1 | Hole aligned with the BAT+ pad? | hole − pad centre = (0.000, +0.022) mm; the hole centre lies inside the pad with 0.486 mm to its nearest edge | **PASS** (nominal). Physical error stack unknown (see §6) |
| 2 | Post fits without displacing the module? | Ø0.511–0.54 post in a finished hole of Ø1.25–1.35 → 0.36–0.42 mm radial play | **PASS** |
| 3 | Post or fillet could touch BAT−? | cone-edge to GND0-pad-edge ≥ 0.50 mm worst case (cone r 0.65, post 0.253 mm toward GND0, the maximum before the post leaves the 1.016-high pad); 0.59 mm for r 0.55. Independent of the host hole. Pad-to-pad gap 0.889 mm | **PASS** (needs: post centred on the pad within ±0.25 mm in y) |
| 4 | Top annular ring (Ø1.90) could contact underside exposed copper? | under BAT0 = same net. Nearest different-net copper: GND0 pad edge 0.425 mm (plan view), shrinking by the module offset toward GND0 (0 mm at 0.45 mm offset); TP7 1.71 mm from the ring edge; shell ovals 8.7 mm. Ring is mask-covered (annulus 0.225 mm), so plan overlap ≠ contact | **CONDITIONAL** (no metal contact expected; keep the module within ±0.3 mm of nominal) |
| 5 | Mask coverage sufficient and manufacturable? | opening Ø1.45 over ring Ø1.90 → 0.225 mm dam each side; ring annulus 0.25 mm; RB-00.6 §2 assumes a JLC minimum web ≈ 0.1 mm | **PASS** |
| 6 | Solder-cone Ø ≤ 1.1 / h ≤ 0.5 realistic? | the pad is only 1.016 high, so a round cone cannot exceed the pad in y; a Ø1.0 × 0.4 mm cap is 0.19 mm³ ≈ 1 mm of Ø0.5 solder wire, a Ø1.1 × 0.5 cap ≈ 1.5 mm | **PASS** as a limit; hard to control by hand |
| 7 | Module sits flat after the post is installed? | the cone must enter the hole: radial margin (finished Ø − cone Ø)/2 = **+0.075 … +0.125 mm** for Ø1.25–1.35 and Ø1.1; ≤ 0 for a Ø1.3 cone; host ring + mask bump ≈ 0.05 mm | **CONDITIONAL** — fails if the cone is Ø1.2 or more or the hole finishes small |
| 8 | Bottom joint accessible with a normal iron? | host B.Cu Ø3.00 pad, no B.Cu components (RB-00.6), post protrudes 1.0 mm | **PASS** |
| 9 | Post introduces stress into the BAT+ pad? | post is a locating pin; estimate: plug force 5–20 N shared over 15 joints ≈ 0.3–1.3 N each vs ≈ 15 N solder-pad shear and ≈ 30 N Ø0.51 Cu shear. The post must not be the load path | **PASS** with enclosure support (checklist E1) |
| 10 | Thermal expansion / positional variation? | differential growth over 21.1 mm: 1–13 µm for Δα 2–10 ppm/K, ΔT 25–60 K — negligible against 0.4 mm play. Positional variation is the real term: castellation overlap stays ≥ 1.06 mm for module shifts ≤ 0.5 mm (module copper 1.626 vs host 1.50) | **PASS** |

**Overall: POST ASSEMBLY FEASIBILITY = CONDITIONAL.** A nominal match is not a PASS for assembly; the open term is the
cone-in-hole margin. Recommendations (not applied to the frozen design): (a) specify the cone target Ø ≤ 1.0 mm and h ≤ 0.4 mm
in the assembly procedure, verified on the first unit; or (b) at RB-02 consider drill Ø1.5 with ring Ø2.0 (annulus unchanged, ring-to-GND0 gap
0.425 → 0.375 mm, still ≥ 0.3); decide with the measured finished hole of the first article.

## 5. Castellations, footprint, USB-C, antenna, enclosure

**Castellations (14/14).** Numbering, functions, edge positions, 2.540 pitch: PASS. Host pad 1.50 × 2.90 (toe 1.30 / inner 1.60) overlaps the
module copper by ≥ 1.0 mm for shifts up to 0.6 mm; gaps host 1.04 mm, module copper 0.914 mm → bridging risk low. The module copper
is 1.626 wide along the edge (RB-00.6 assumed 1.325): host pad is 0.063 mm/side narrower — harmless, rationale text wrong (D-2).
The module's open Ø0.95 header hole sits over the host pad: expect solder wicking to the top; not a defect. Hand-soldering access
(1.6–2.4 mm chisel) is a host-layout property that cannot be tested on the module; on the module there is nothing on the underside
and the nearest top-side parts are the tact switches K1/K2 (bodies ≈ 1.7 mm inboard of the D0/D6 corner pads), above the host pad. **Verdict: hand-solder
footprint CONDITIONAL** (spec geometry verified; the footprint file does not exist yet; D-2 and D-3 to be reflected).

**USB-C.** 9.0 mm wide, centred (board x = 63.89), overhang 1.508 beyond the south board edge at y = 32.00 → receptacle face at
y = 33.51; mated plug overmold (≈ 12.4 × 6.5, checklist E2) lies wholly beyond y = 33.51, so no board collision. **PASS.**
Enclosure facts vs assumptions: *fact* — receptacle position/size; *assumption* — the wall cutout and a wall that supports the
receptacle rim (E1); *not yet known* — enclosure CAD, plug-strain relief.

**U.FL.** At board (68.74, 12.59): north-east corner, 4.04 mm from the east module edge and 1.73 mm from the north edge; the cable
may leave east or north (plug rotates). The cable passes 0.5 mm from the D6 toe pad (x 71.18–74.08, y 13.11–14.61): solder the toes
before the cable is fitted. **PASS** (geometry); antenna element placement stays an enclosure task.

**Underside keep-outs.** CAD underside = TP1–TP8, pad-25 window, BAT0, GND0 **and four USB shell ovals (GND)** that RB-00.6 §4 does not
list. Spec boxes for pads 15–22, 25 and GND0 are correct (spec 0.28 mm larger = conservative). **Verdict: FAIL as written (D-3)**;
correction is trivial (add four 1.78 × 0.89 GND pads or confirm GND-only copper beneath), no electrical consequence expected.

## 6. Tolerance analysis (what is unknown is swept, not guessed)

| Unknown | Range swept | Where it bites | Outcome |
|---|---|---|---|
| Finished post-hole Ø | 1.25 … 1.45 (drill 1.40 ± 0.05, plating) | cone-in-hole margin | −0.025 … +0.325 mm (table in `post_sensitivity.txt`) → the only sensitive term |
| Post position on the BAT+ pad | 0 … 0.253 mm (limit set by the 1.016 pad) | cone/post-to-GND0 | ≥ 0.495 mm clearance |
| Host hole position / module placement | 0 … 0.6 mm shift | castellation overlap, ring-to-GND0 | overlap ≥ 0.96 mm; ring gap 0.425 → 0 at 0.45 mm (mask-covered) |
| Module outline/pad tolerance | unknown (Seeed: nominal CAD) | all of the above | not quantified; assumed ≤ ±0.15 mm like checklist M1–M8 |
| Module PCB thickness | 0.8 … 1.6 (assumed range) | fillet height on the castellation wall (≥ 50 % of T) | 0.4 … 0.8 mm: attainable by hand; post length (6 mm cut) is independent of T |
| CTE mismatch | Δα 2–10 ppm/K | module length | ≤ 13 µm |

**Tolerance verdict: CONDITIONAL** — nominal geometry has margin everywhere except the cone/hole fit; the tolerances themselves are
unknown and must be bounded by the first physical sample.

## 7. Tooling (reproducible, no purchase)

| File (`hardware/emg/rev-b-xiao/tools/`) | Purpose |
|---|---|
| `rb02a_fetch_seeed_sources.sh` | downloads the Seeed files, **verifies SHA-256**, proves the v1.4 and v1.5 archives are identical |
| `rb02a_xiao_cad_extract.py` | KiCad-PCB parser: outline, footprints, pads (absolute coordinates, custom-pad primitives), zones, vias → JSON |
| `rb02a_compare_rb006.py` | applies the 180° transform and compares with the RB-00.6 numbers; writes `comparison.csv/json`; exit 1 on DISCREPANCY |
| `rb02a_post_sensitivity.py` | BAT+ post sweep (items 1–10 of §4) |
| `rb02a_make_1to1.py` | generates `hardware/emg/XIAO_RB02A_CAD_1TO1.pdf`: 1:1 drawing from the CAD geometry with 150 mm ruler, 50 × 50 mm square, "print at 100 %" |
| `run_rb02a_checks.sh` | one command for all of the above |

```bash
bash hardware/emg/rev-b-xiao/tools/run_rb02a_checks.sh /tmp/rb02a            # downloads, verifies, extracts, compares
SECONDARY="/path/to/OPL_Kicad_Library/Seeed Studio XIAO ESP32S3/ESP32S3.kicad_pcb" bash …/run_rb02a_checks.sh /tmp/rb02a   # + cross-check
```

Expected: `rows: 157 {'MATCH': 80, 'MINOR': 4, 'INFO': 52, 'DISCREPANCY': 19, 'UNRESOLVED': 2}` (exit 1 is correct; the register is the
output). The A4 page size of the PDF is not evidence of scale: the printed ruler and square must be measured (P2, P3). The previous
`XIAO_MOUNTING_1TO1.pdf` is unchanged; it uses hand-typed constants that differ by ≤ 0.1 mm (D-1, D-7).

## 8. Can the physical measurement be deferred?

**Yes — to the manufacturing-release gate, and it needs one module, not two, and no purchase decision now.** The XIAO has to be
bought anyway for firmware bring-up; its calipers check costs nothing extra. What a physical sample resolves that CAD cannot:

| # | Measurement | Why CAD cannot answer | Consequence if different |
|---|---|---|---|
| 1 | PCB thickness (M4) | file stores the 1.6 default | fillet height rule; post/ring unaffected |
| 2 | Outline 17.78 × 21.135, castellation pitch, BAT+/GND0 position (M1, M2, M5–M7) | plain-v1.4 board unverified; no tolerances | hole/pad alignment margin, toe length |
| 3 | USB overhang 1.51 and U.FL position (M3, M8) | same | enclosure |
| 4 | B2B connector present, the 4 underside shell ovals exposed, castellation copper 1.626 wide (visual) | confirms that this layout is the plain board | keep-out list, D-2/D-3 |
| 5 | Finished cone/hole fit on the first unit (assembly trial with a scrap post and the *first* PCB) | process, not geometry | cone Ø/drill decision |

**Does not require hardware now:** library authoring, courtyard/keep-out definition, placement, routing, DRC rules. **Must
precede** the Gerber order: items 1–4. Item 5 is an acceptance test of the first assembled board.

## 9. Final acceptance gate

```text
OFFICIAL XIAO V1.4 CAD:
NOT FOUND  (the v1.4 "plain" URLs serve the Sense v1.5 design, byte-identical archive and PDF)

EXACT PLAIN MODULE VERIFIED:
NO

SEEED PRODUCT REVISION:
Files are "XIAO ESP32-S3-Sense", PN 202003753, file V1.5, title-block REV V1.3 (KiCad 9.0.6);
none of the CAD files contains PN 202003751
SEEED SOURCE SHA-256:
a82247725c8a8bcd8cac81a7acbd126396217e5b680f6dfe28958851e02d5cdb  (zip)
d20724aa7198a897871cc1ce87f1a322d0b9cf77521fd2fc4ccda61bc5e4af6c  (XIAO ESP32S3_V1.5.kicad_pcb)

MODULE OUTLINE:
PASS  (17.78 exact; 21.135 vs 21.02 stated, +0.115 minor, D-1)

14 CASTELLATIONS:
PASS

PAD NUMBERING:
PASS

CASTELLATION PITCH:
PASS  (2.540, spread 0.000)

HAND-SOLDER FOOTPRINT:
CONDITIONAL  (geometry verified; module copper is 1.626 not 1.325 wide, D-2; footprint file not yet authored)

BAT+ POSITION:
PASS

BAT- POSITION:
PASS

BAT+ POST ALIGNMENT:
PASS  (0.022 mm nominal)

BAT+ TO BAT- CLEARANCE:
PASS  (>= 0.495 mm swept worst case; requires the post to stay on the pad)

POST ASSEMBLY FEASIBILITY:
CONDITIONAL  (cone-in-hole margin 0.075–0.125 mm; D-5)

USB-C GEOMETRY:
PASS

U.FL POSITION:
PASS

UNDERSIDE KEEP-OUTS:
FAIL  as written in RB-00.6 §4 (4 GND USB-shell ovals missing, D-3); trivial correction

MODULE PCB THICKNESS:
UNRESOLVED

TOLERANCE ANALYSIS:
CONDITIONAL

RB-00.6 DISCREPANCIES:
D-1 length 21.02 vs 21.135; D-2 castellation copper width/depth; D-3 USB shell ovals not in keep-out inventory;
D-4 post-to-pad distance 3.23 not >= 3.5; D-5 cone/hole margin; D-6 checklist M10 B2B is populated;
D-7 checklist datums 0.094 mm; D-8 thickness; D-9 undocumented slots/NPTH holes

PHYSICAL MEASUREMENT STILL REQUIRED:
YES  (one module; before manufacturing release, not before digital design)

IF YES, WHICH SPECIFIC MEASUREMENTS:
thickness (M4); outline/pitch (M1, M2, M5); BAT+/GND0 position (M6, M7); USB overhang and U.FL (M3, M8);
visual: B2B present, 4 underside shell ovals, castellation copper width; later: cone/hole fit on the first unit

DIGITAL DESIGN MAY CONTINUE:
YES

MANUFACTURING RELEASE APPROVED:
NO

RB-02A DECISION:
CONDITIONAL GO

BLOCKERS:
none for digital work. For manufacturing release: items 1–4 of §8, RB-00.6 corrections D-3/D-5 accepted by the owner,
authored ARTHUR:XIAO_ESP32S3_HANDSOLDER and ARTHUR:OSC_SCTF_SX3M_SMD3225-4P footprints (RB-02 tasks)
```

A virtual check is **not** equivalent to a successful physical assembly. This report removes the need to *buy* anything to
start RB-02; it does not remove the need for one caliper measurement and a first-article assembly before release.

## 10. Recommended corrections to RB-00.6 (not applied)

1. MOUNTING_SPEC §1/§2/§3, DIRECT_XIAO §4, 1:1 script, checklist M2/M6–M8/M10: apply D-1, D-2, D-4, D-6, D-7 values from comparison §7–§8.
2. MOUNTING_SPEC §4 and checklist G4: add the four shell ovals to the F.Cu keep-out/DRC rule.
3. MOUNTING_SPEC §3 / assembly step 1: cone target Ø ≤ 1.0 / h ≤ 0.4; revisit drill Ø1.40 vs Ø1.5 at RB-02 (D-5).
4. Checklist: replace "two modules" by "one module, before Gerber release"; keep the paper-fit check P1–P4/F1–F7 using
   `XIAO_RB02A_CAD_1TO1.pdf`.
