# RB-04C — Final XIAO ESP32-S3 Compatibility Qualification

Date: 2026-10-12. Branch `hardware/emg-rev-b`. Canonical PCB sha256 `111e1cd3d0c9fae1…` (RB-04A TP2 repair, RB-04B BOM). **Nothing was modified, ordered, sent, uploaded, committed or pushed; Seeed was not contacted.**
No electrical-safety approval and no permission for human electrode use is implied. Companion documents: `REVB_RB04C_XIAO_MECHANICAL_OVERLAY.md`, `REVB_RB04C_XIAO_ELECTRICAL_MATRIX.md`, `REVB_RB04C_SEEED_MANUFACTURER_QUESTIONS.md`. Evidence: `rev-b-xiao/evidence/rb04c/`.

## 1. Exact product identification and the "plain v1.4 = Sense v1.5" discrepancy

| Question | Finding | Evidence |
|---|---|---|
| Intended module | Seeed Studio XIAO ESP32-S3 **plain**, PN 202003751, unsoldered headers | owner brief |
| Which hardware revision does the retail plain module have? | **Unknown.** Seeed labels the file "plain v1.4"; no document identifies the shipping revision of PN 202003751 | below |
| Seeed "plain v1.4 SCH&PCB" archive | **byte-identical** to the Sense v1.5 archive (sha256 `a8224772…2d5cdb`, 836,170 B), re-downloaded and re-hashed 2026-10-12 | `rb02a_fetch_seeed_sources.sh`, all 7 hashes verified |
| Seeed "plain v1.4 SCH" PDF | byte-identical to the Sense v1.5 PDF (`15993097…9f9923c`); title block "XIAO ESP32-S3-Sense", Rev V1.3, 2026-02-10 | `pdftotext`, page 1 render |
| PCB in the archive | `XIAO ESP32S3_V1.5.kicad_pcb`, KiCad 9.0, 71 footprints, outline 17.78 × 21.135; the **Sense** design (camera connector J3, mic, SD pads) | RB-02A + re-extraction |
| Files carrying the PN | "202003751" appears only in file names; no CAD file contains it | grep |
| Plain-vs-Sense electrical difference proven | wiki: plain charge current "50 mA fast / 3.8 mA trickle", Sense "100 mA / 0.9 mA"; the file's R10 = 220 kΩ gives 110 mA → **the files cannot be the plain BOM** | wiki 2026-10-12; schematic p.4 |
| Revision history in the file | v1.0 2023-01-04 … v1.3 2025-10-21 ("R5 0R → 24 nH"); nothing touches castellations, BAT or USB | schematic p.2 |
| 3D model "plain" | STEP product name "Seeed Studio XIAO-ESP32-S3 (Sense)" | STEP header |

**Conclusion:** the plain-module CAD that Seeed publishes is the Sense design. The Sense CAD is *probably* the same mechanical main board (same outline, same castellations, three independent files agree to 0.03 mm, Seeed sells plain and Sense as one PCB plus an add-on), but **no Seeed document guarantees that the retail plain module has this geometry**, and its thickness, tolerances and shipping revision are unknown.
I did **not** treat the Sense CAD as plain-module evidence; it is labelled "Sense v1.5 CAD (best available manufacturer geometry)" throughout. An inquiry to Seeed is prepared (`REVB_RB04C_SEEED_MANUFACTURER_QUESTIONS.md`), **not sent**.

## 2. Geometry versus the canonical board (summary of the overlay document)

* The module placement is **fitted** to the 14 castellations of U1 on the *canonical* routed board (not RB-02/RB-02A): x 31.30…49.08, y 43.82…64.95, USB end flush with the south edge.
* 14/14 castellation centres coincide with the host pads (0.000 mm residual along and normal); function names match pin numbers 1–14; BAT+ pad centre coincides with the post hole (0.000 mm), BAT− pad 1.905 mm away.
* Underside: no mask-open host copper under the module; nearest different-net copper to any exposed module pad ≥ 0.61 mm (mask-covered).
* Neighbours: nearest courtyard 1.04 mm (R7108); iron access unchanged from RB-03S (PASS at 45° and 60°, toes 12/13 short 0.13 mm at 30°).
* USB-C 9.0 mm centred, overhang 1.508 mm beyond the board edge; U.FL at (45.04, 45.54), 1.84 mm from J1.

## 3. BAT+ post gate — worst case, not nominal

| Check | Nominal | Worst case (assumed tolerances, see overlay doc §4) | Result |
|---|---|---|---|
| Hole vs BAT+ pad centre | 0.000 mm | post axis error ≤ 0.447 mm (RSS 0.28) | geometry sound; **needs module hand-shift ≤ 0.29 mm** for a Ø1.0 cone (0.34 mm for Ø1.1) |
| Finished hole Ø | 1.40 | 1.32 … 1.53 mm (JLC +0.13/−0.08) | cone Ø1.0 → 0.16 mm margin centred; Ø1.2 → 0.06 |
| Post / cone to BAT− pad | 1.397 mm pad edge from BAT+ centre | ≥ 0.59 mm (cone Ø1.1, post at pad limit) | **PASS** |
| Host VBAT ring to GND0 | 0.447 mm | −0.003 mm at a 0.45 mm shift: GND0 over mask-covered ring; mask opening 0.22 mm away | **CONDITIONAL** (mask only) |
| Under-module insulation | solder mask | no host mask-open copper; mask-only insulation under GND0 (worst case) and under the ring | **CONDITIONAL** |
| Module sits flat | cone enters hole; stand-off = mask + HASL (≈ 0.05) | fails if the cone is ≥ Ø1.2 or the hole finishes small and the module cannot be shifted | **CONDITIONAL** |
| Strain on the BAT+ pad | post is a locating pin until the underside barrel is soldered | afterwards the post shares in-plane load from USB-C insertion (≤ ~35 N spec value) with the 14 castellations; estimate ≈ 1/15 of the load (≈ 2–3 N) — **not measured** | **CONDITIONAL**, pull/insertion test on the sample |
| Short during installation | — | cone/solder bridging to GND0 (0.59 mm margin), flux/solder under module on exposed pads | operator process; inspection steps exist |
| Repeatable by hand | Ø ≤ 1.0 × h ≤ 0.4 mm cone on a 1.016-mm-high pad | a 0.19 mm³ solder volume controlled by eye | **not guaranteed**; needs a go/no-go gauge and 3–5 trial units |

**Gate result: CONDITIONAL.** The design is geometrically sound and the worst case is *assemblable* (module shifted ≤ 0.29 mm, toe ≥ 0.91 mm), but it is not guaranteed by tolerances alone and depends on assembler discipline and on module thickness/tolerances that are unmeasured.

## 4. Electrical compatibility

See the matrix. Summary: 14/14 pin mapping PASS; levels PASS; no 5 V backfeed path; 3V3 supply (700 mA, load 11 mA) PASS; USB inhibit PASS by analysis (the 5V pad is raw VBUS); power architecture CONDITIONAL (plain-module charger variant unconfirmed; charging a cell with no cell protection or reverse-polarity protection on Rev B; D2/GPIO3 strapping and UART0 boot activity to be bench-confirmed).

## 5. Assembly and enclosure

| Item | Result |
|---|---|
| All 14 castellation toes accessible after RB-03S | **PASS** (iron-body model 45°/60°, no blocked toe; 30° toes 12/13 short 0.13 mm — flat tip approach only) |
| BAT+ bottom joint accessible | **PASS**: Ø3.0 B.Cu pad, no B.Cu parts nearby, post trimmed to ≈ 1 mm |
| USB-C insertion forces | **CONDITIONAL**: receptacle is supported by the module PCB and its 14 castellations only; enclosure must support the module end/receptacle rim (E1 in the mechanical checklist) |
| U.FL / antenna cable | **PASS (geometry)**: 1.84 mm to J1; cable leaves east, J1 plug opens east at y ≈ 38; bend radius and plug height unverified |
| Enclosure accommodates module | **CONDITIONAL**: footprint 17.78 × 21.14 mm + 1.5 mm USB overhang; module top ≈ 3 mm above the board (STEP, not authoritative) vs tallest host part J101… 6.6 mm; the 17 mm target (RB-02H: 11–17 mm) is set by the electrode connectors, not the XIAO |
| 17 mm maximum thickness | **remains feasible** (CONDITIONAL as in RB-02H; wall and battery assumptions) |
| Skin-side exposed conductors | **CONDITIONAL / open decision D7**: TP1–TP8 on B.Cu (VBAT, AFE_3V0, DVDD_F, VCM, RLD_SAFE, AFE_EN, GND, GND) **plus** the Ø3.0 B.Cu BAT+ pad and a 1 mm post stub (VBAT). Needs an enclosure floor/partition or an insulating cover; the top side has no exposed power pad except the module's own USB shell and castellation joints |
| Program/debug before final assembly | **PASS**: the retail module has USB-C and BOOT/RESET buttons on top and can be flashed stand-alone; on the board the USB-C is at the south edge; USB presence inhibits the AFE (debug with the AFE live must use battery + wireless/serial on another pin set — D6/D7 are not free) |

## 6. Compatibility decision (five separate classifications)

| Dimension | Decision | Why |
|---|---|---|
| **CAD compatibility** | **COMPATIBLE with the Seeed Sense v1.5 CAD; NOT proven for plain PN 202003751** | geometry matches to 0.000 mm on the canonical board; three Seeed sources agree; the plain CAD does not exist |
| **Electrical compatibility** | **COMPATIBLE by analysis** (CONDITIONAL on the plain charger variant and bench tests) | pin map, levels, power path, inhibit, backfeed all consistent with the Sense schematic |
| **Assembly compatibility** | **CONDITIONAL** | hand soldering works nominally; post cone/hole stack needs module shift and process control; no reflow needed |
| **Retail-revision certainty** | **NO** | Seeed publishes no revision statement for PN 202003751; the plain files are Sense files |
| **Physical validation** | **REQUIRED** | see §7 |

Physical compatibility is **not** declared proven.

## 7. What one real module must show (before PCB manufacturing authorisation)

1. Board marking / revision and the PN on the packaging; photo of both faces.
2. Outline 17.78 × 21.14 mm ±, corner radii; castellation pitch 2.54 and 14 pad widths (caliper/microscope); USB overhang 1.51.
3. **PCB thickness** (micrometer, 4 points) — drives fillet height and flatness.
4. BAT+ and BAT− pad position and size from the USB edge (10.16 mm / 8.26 mm; 2.032 × 1.016); distance between them; GND0 continuity to castellation 13.
5. U.FL and USB-C position; underside: only the 8 TPs, pad 25, 4 shell ovals, 2 NPTH.
6. Dry-fit on a **bare Rev B PCB** (or a print of the 1:1 drawing `XIAO_RB02A_CAD_1TO1.pdf`): castellations on host pads, BAT+ pad over the hole; measure the post/cone fit with a Ø1.0 and a Ø1.1 trial cone on 3–5 module-and-board combinations.
7. Charger resistor/current and the bench list in the electrical matrix §5.

## 8. Final gate

```
EXACT XIAO MODEL:               Seeed Studio XIAO ESP32-S3 (plain; not Sense/Plus), unsoldered headers
EXACT SEEED PN:                 202003751
HARDWARE REVISION:              expected v1.4 per Seeed file label — UNVERIFIED; all geometry/electrical data come from the
                                Sense v1.5 design files (PN 202003753 schematic, Rev V1.3)

RETAIL REVISION VERIFIED:       NO

14 CASTELLATIONS:               PASS   (on Sense v1.5 CAD; 0.000 mm residual on the canonical board)
PIN NUMBERING:                  PASS
BAT+ POST ALIGNMENT:            CONDITIONAL   (nominal 0.000 mm; worst-case 0.447 mm needs a ≤ 0.29 mm module shift)
BAT− CLEARANCE:                 CONDITIONAL   (≥ 0.59 mm cone-to-pad; mask-only insulation at the worst-case shift)
UNDERSIDE KEEP-OUTS:            PASS
USB-C FIT:                      PASS   (flush, ±0.3 mm placement; enclosure cutout/support open)
U.FL FIT:                       PASS   (geometry; cable bend radius unverified)
HAND-SOLDER ASSEMBLY:           CONDITIONAL
ELECTRICAL PIN MAPPING:         PASS
POWER ARCHITECTURE:             CONDITIONAL
USB INHIBIT:                    PASS   (analysis; bench test mandatory)
ENCLOSURE COMPATIBILITY:        CONDITIONAL

PHYSICAL SAMPLE STILL REQUIRED: YES
DESIGN CHANGES REQUIRED:        NO     (none mandatory; the post-hole option "drill 1.5 / ring 2.0" is deferred to the sample result)
READY FOR PCB MANUFACTURING:    NO

BLOCKERS:
 1. Retail PN 202003751 revision/geometry not verified (Seeed publishes Sense CAD only) — one real module and/or Seeed's written answer.
 2. Module PCB thickness and outline/pad tolerances unmeasured.
 3. BAT+ cone-in-hole fit not demonstrated on real parts (worst-case stack needs a ≤ 0.29 mm module shift).
 4. Plain-module charger variant and boot-time behaviour not bench-confirmed; skin-side exposed conductors (D7) undecided.
```

Not blockers for requesting a JLC quotation (RB-05), but they must be closed before an order is authorised.
