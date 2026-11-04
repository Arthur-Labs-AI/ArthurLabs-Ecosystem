# RB-04J — Independent BAT+ Pre-Production Audit

Date: 2026-10-13. Branch `hardware/emg-rev-b`. **Read-only audit**: canonical PCB (sha256 `7fda8d9c6fa568d7…`), footprint (`c8703292…`), schematic, BOM and the QUOTE-ONLY package were not modified; the design was not unfrozen; nothing was ordered, uploaded, sent, committed or pushed. No medical or human-contact safety statement is made.
Method: everything below was **recalculated from the files** with `tools/rb04j_audit.py` (PCB text, library footprint, the Gerber/drill zip in `quote-package/staging_R1b_QUOTE_ONLY/`, a fresh netlist, the Seeed module CAD fitted to U1) — not copied from RB-04D…RB-04I. Data: `rev-b-xiao/evidence/rb04j/audit.json`.
**Provenance of the manufacturer statements:** the JLCPCB and Seeed confirmations quoted in the brief are taken as *reported by the owner*; I did not receive the original messages and could not verify their wording. Where a conclusion depends on their exact wording it is marked.

---

## 0. Executive summary (one page)

**Question:** can five Rev B PCBs be ordered from JLCPCB now, before a physical XIAO is in hand?

**Recommendation: CONDITIONAL GO (B).** The frozen PCB and the R1b geometry need **no change**. The order can be placed once five achievable, non-engineering conditions are met:

1. **Pre-payment CAM check.** Upload the (re-issued, release-named) Gerber set to JLC and inspect its online viewer / DFM result for U1 pad 23: the Ø1.90 hole must show as an open plated component hole (not "via tented/plugged"), mask openings visible on both sides. Answer any engineering question about it in writing before paying.
2. **Order remark:** "Single plated Ø1.90 mm hole at X 44.635 / Y 54.790 (-54.790 in Gerber frame) is a COMPONENT hole: keep open — do not tent, plug or fill. Mask openings and pad sizes as per Gerber."
3. **Finish:** order ENIG (JLC's recommendation; the PCB file says HASL-with-lead). It is an order option, not a Gerber change; it avoids HASL hole reduction/domes under the module.
4. **Assembly controls** (§6): solder cone made from a 1.0 mm slug of Ø0.5 mm solder wire, go/no-go gauge Ø1.0 mm, rock test, three continuity tests before the battery.
5. **Incoming inspection of the bare boards:** Ø1.7 mm pin passes the hole from both sides; mask visible; continuity J1.1 ↔ B.Cu land.

**Why this is acceptable without a sample:** nominal fit has 0.41 mm radial margin around a Ø1.0 mm cone; worst-case (every tolerance adverse) needs 0.087 mm of module shift against 0.150 mm allowed; exposed-conductor separation to the BAT− pad is ≥ 0.235 mm at the host and ≥ 0.74 mm for post and cone; JLC's reported statements are consistent with the geometry.

**What can still go wrong (and what it would cost):**

| Risk | Needs a new PCB revision? | Likelihood basis |
|---|---|---|
| JLC CAM tents/plugs the Ø1.90 hole | possibly (re-export of the **mask layers only** with a larger opening; copper/drill unchanged) | unknown until the viewer is seen; JLC's published tent/plug limits are ≤ 0.5–0.6 mm; opening ≥ file hole by 0.05 mm |
| Retail module pad > 0.45 mm off the file position, or not the same geometry | yes | contradicted by three agreeing Seeed sources and by Seeed's reported "essentially the same dimensions"; tolerances unpublished |
| Cone too large / module not seated / solder bridge / cold joint | **no** — assembly | detected by gauge, rock test, continuity, first power-up |
| Joint fatigue under handling | no — enclosure/strain relief | see §7 |

**Unresolved but not blocking:** retail plain-module bottom-pad tolerances, module PCB thickness, charge current (kept separate from the mechanical decision).

---

## 1. Source-of-truth verification

| Item | PCB (installed) | Library footprint | Gerber / drill (QUOTE-ONLY zip) | Result |
|---|---|---|---|---|
| U1 pad 23 PTH drill | 1.90 | 1.90 | T2 Ø1.900, 1 hole at (44.635, −54.790), tagged `Plated,PTH,ComponentDrill` | MATCH |
| F.Cu land | Ø2.30 | Ø2.30 | F.Cu flash Ø2.30 `ComponentPad`; In1/In2 Ø2.30 `ComponentPad` | MATCH |
| F.Mask opening | 2.30 − 2×0.175 = **Ø1.95** | Ø1.95 | F.Mask flash Ø1.95 | MATCH |
| B.Cu land / B.Mask | Ø3.00 `SMDPad,CuDef`; margin 0 → Ø3.00 | Ø3.00 | B.Cu Ø3.00; B.Mask flashes Ø1.95 **and** Ø3.00 (union Ø3.00) | MATCH |
| Exposed soldering area at the bottom | — | — | B.Cu annulus between Ø1.90 hole and Ø3.00 land = **4.23 mm²** (0.55 mm radial) | usable |
| Exposed host copper at the top | — | — | annulus between the hole (Ø1.90) and the opening (Ø1.95): 0.025 mm radial (barrel rim) | minimal by design |
| Net of both pad-23 entries | VBAT | (library has no nets) | — | MATCH |
| VBAT network (netlist) | J1.1, R4001.1, R7107.1, TP1, **U1.23** only; pad 23 appears in no other net | | | CORRECT |
| VBAT copper on the land | 0.5 mm F.Cu tracks (44.635, 54.790)→(44.635, 54.2)→(43.9, 54.2)… to J1 | | | CONNECTED |
| Module BAT− (GND0) | module pad 2.032 × 1.016 mm at board (44.635, 56.695): 1.905 mm from BAT0; **no host copper is connected to it** (keep-out `XIAO GND0 (BAT-) pad`) | | | as designed |
| 14 castellations | U1 pads 1–14, 2.9 × 1.5 mm, toe 1.30 / inner 1.60 mm; 0.000 mm residual to the Seeed CAD | identical | F.Cu flashes at every pad centre (RB-05 check) | PASS |
| Keep-outs | 11 board-level rule areas = the 11 library zones (0.000 mm delta, RB-04I); 0 tracks/vias/pours inside | | | PASS |
| Nearest foreign copper to the BAT+ land | F.Cu: VBAT_SENSE track **0.715 mm** from the Ø2.30 land edge; AFE_EN_REQ ≥ 1.41 mm; In2: DRDY_N 1.06 mm; **no B.Cu copper within 4 mm of the Ø3.00 land** | | | OK |
| Planes | In1/In2 GND planes clear of the land by the 0.30 mm zone clearance (In1 area −1.7 mm² = the larger antipad) | | | DRC clean |
| Stackup / thickness | F.Cu 35 µm, prepreg 0.2104, In1 15 µm, core 1.065, In2 15 µm, prepreg 0.2104, B.Cu 35 µm, mask 10 µm; **1.586 mm + masks ≈ 1.606 mm** (1.6 mm ordered); finish in the job file: HASL with lead | | | JLC04161H-7628 |
| Schematic ↔ PCB ↔ footprint | refs 135/135, 357 pad nets, 0 field warnings, DRC 0 errors, ERC 0 (RB-04H) | | | PASS |

Residual disagreement: none between the sources. The only difference is metadata presentation (RB-04I).

## 2. Manufacturer evidence (as reported) and what it does and does not establish

| Reported statement | Effect on this audit |
|---|---|
| **JLC:** hole, pad and mask dimensions generally acceptable under the standard four-layer service | supports GO; "generally" is not a CAM-run acceptance of this file |
| **JLC:** production compensation applied to reach the specified finished hole | the drill *tool* is larger than the file's 1.90 mm by an unknown amount (plating ≈ 0.05; typical practice 0.05–0.15) — see §5 |
| **JLC:** a mask opening smaller than a drilled hole may be treated as a tented/plugged via | decisive for R1b: the opening (1.95) is **0.05 mm larger than the file hole (1.90)** but only 0.00 … −0.10 mm vs a compensated tool (table below) |
| **JLC:** component-PTH recommended annulus ≥ 0.20 mm per side | R1b: exactly 0.20 mm nominal (met at the recommended value; worst case 0.035 mm, no breakout) |
| **JLC:** green mask with ≥ 0.10 mm spacing generally acceptable | BAT+ interface: no mask web between openings; the 12 class-2 via dams (< 0.10 mm) are a separate, unchanged item |
| **JLC:** ENIG recommended | adopted as condition 3 |
| **Seeed:** plain and Sense main modules essentially the same mechanical dimensions | removes the geometry-identity doubt to the extent of "essentially" |
| **Seeed:** official mechanical production tolerances unavailable; BAT+ post method not officially validated | the ±0.10 mm module-pad assumption stays an assumption; the post method is the design's own risk |
| **Seeed:** 5V pin unpowered on battery | matches the schematic and wiki |

**Not established by any statement:** actual JLC CAM result for this file; mask registration tolerance; retail plain bottom-pad tolerances; module thickness.

## 3. Independent 3-D mechanical fit

### 3.1 Sequence and tolerance model (all values assumptions unless marked JLC; Seeed publishes none)

| Term | ± mm | Source |
|---|---|---|
| post placed on the module pad (hand) | 0.25 | procedure |
| module BAT pad vs castellation copper | 0.10 | assumed (conservative) |
| drilled-hole position | 0.075 | JLC |
| host copper-to-drill registration | 0.05 | assumed |
| datum | 0.022 | CAD |
| finished hole Ø1.90 | +0.13 / −0.08 | JLC |
| solder-mask registration | 0.05 | assumed (not published) |

Linear worst-case error cone↔hole centre **0.497 mm per axis** (RSS 0.29). Smallest finished hole radius 0.91 mm.

### 3.2 Results (`audit.json → stack`)

| Quantity | Nominal | Worst case (linear) | Statistical (RB-04E Monte-Carlo, uniform errors) |
|---|---|---|---|
| Cone Ø1.0 radial margin in the hole when centred | 0.45 mm | **0.41 mm** | — |
| Module shift needed to seat the cone | 0 | **0.087 mm** (Ø1.1: 0.137; Ø1.2: 0.187) | P(cannot seat) < 5·10⁻⁶ for Ø1.0 |
| Shift allowed along the toe direction (toe ≥ 1.0 mm) | — | **0.150 mm** | |
| Shift allowed along the pad row (overlap ≥ 1.0 mm) | — | **0.513 mm** | |
| Margin | — | **0.063 mm** at Ø1.0; 0.013 at Ø1.1; −0.037 at Ø1.2 | |
| Post shaft clearance | 0.65 mm radial (Ø0.511 in Ø1.82–2.03) | 0.65 | |
| Post tilt | — | 10° (procedure limit) over 1.6 mm board = 0.28 mm at the bottom; bow ≤ 0.2 mm → inside 0.65 | |
| Thermal deformation of the post | — | 6 mm Cu, ΔT 300 K: +0.03 mm length, negligible bend | |
| Module-to-host vertical separation | 0.03–0.08 mm (mask 0.01–0.03 + pad domes; ENIG lower than HASL) | — | |
| Castellation toes (worst allowed shift) | 1.30 | ≥ 1.06 mm toe, ≥ 1.43 mm overlap, ≥ 0.74 mm neighbour copper gap | |
| Strain on the module BAT+ pad | no load at nominal; the post cannot act as a locator (0.65 mm clearance) | the stub (≈ 1 mm) + fillet couple module and host after step 6; differential thermal movement ≈ 1 µm over 8 mm | |

**Cone control realistic with ordinary tools?** The pad is 1.016 mm high, so a round cone cannot exceed ≈ Ø1.0 in that direction; its volume is set by the solder fed. A 1.0 mm slug of Ø0.5 mm solder wire is **0.196 mm³** = a Ø1.0 × 0.4 mm cap (0.191 mm³); a 1.5 mm slug gives Ø1.1 × 0.5 mm (0.30 mm³). Measurement with a loupe/caliper is ± 0.1 mm — the go/no-go Ø1.0 gauge (a drill-shank or a card hole) is sufficient; an undetected Ø1.1 cone is still seated in the worst-case corner (margin 0.013 mm), an undetected Ø1.2 would need a 0.19 mm shift (only in the corner, statistically negligible).

**Classification.**
* Nominal fit: **PASS** (0.45 mm margin).
* Worst-case dimensional fit: **PASS with 0.063 mm margin at Ø1.0** — thin enough that it should not be called robust at Ø ≥ 1.1 mm.
* Statistical fit: **PASS**, justified only because the terms are independent and bounded; the dominant term (post on pad ±0.25) is under the assembler's control.
* Real-world fit: **requires a sample** for the module-pad registration, thickness and flatness; the design has margin for ±0.45 mm without it.

## 4. BAT+ / BAT− short-circuit analysis (exposed metal only)

`audit.json → separation_matrix`; module pads from the Seeed CAD fitted to the 14 castellations (0.000 mm).

| Exposed-conductor pair | Worst-case separation | Notes |
|---|---|---|
| Module BAT0 pad edge ↔ GND0 pad edge | **0.889 mm** | module design, both pads bare |
| Post (at the pad limit toward GND0) ↔ GND0 pad edge | **0.84 mm** | post Ø0.511 is on the BAT0 pad |
| Solder cone (wets the pad only; +0.10 mm meniscus allowance) ↔ GND0 | **0.74 mm** | cone Ø ≤ 1.0 mm |
| **Exposed host BAT+ metal** (barrel rim + opening edge ± mask registration) ↔ GND0 | **0.235 mm** (0.322 mm without module shift) | the only host metal that can see GND0 |
| Bottom fillet / B.Cu Ø3.0 land ↔ GND0 | ≥ **1.6 mm** in 3-D (through FR4 and the In1/In2 planes); plan-view overlap is not a clearance | |
| Nearest other exposed underside pad to BAT0 (centre) | GND0 1.91 mm; TP7 (USB D−) 3.24 mm; TP2 4.49 mm | |
| *Mask-covered* ring edge ↔ GND0 (plan) | 0.085 mm | **not an exposed-metal clearance**; listed only to avoid confusion; never counted as a barrier |

Solder mask is not relied on as the safety barrier: every pair above is bare metal to bare metal.

### Credible failure modes and detection before a battery is connected

| # | Failure mode | Why credible | Detection (battery disconnected, USB disconnected) |
|---|---|---|---|
| 1 | Solder bridge BAT0 ↔ GND0 on the module (step 1) | 0.889 mm gap, over-fed cone | module upside down: continuity BAT0 pad ↔ castellation 13 must be open; loupe |
| 2 | Cone bigger than Ø1.0 → does not enter / lifts the module | cone volume | go/no-go gauge before insertion; rock test + gap check after seating |
| 3 | Excess solder at the bottom climbs the hole, floods the 0.025 mm top annulus, reaches GND0 | 0.235 mm gap, standoff only 0.03–0.08 mm so a *ball* cannot sit there; a smear stays on the annulus | continuity J_BAT+ ↔ GND (must be ≥ 1 MΩ-class, procedure step 9); inspect the bottom fillet height (fillet only, not a column to the rim) |
| 4 | Solder ball trapped under the module | would have to lift the module > its diameter | rock test; gap under the USB end and sides; continuity as in 3 |
| 5 | Post bent / touches the barrel | clearance 0.65 mm; barrel is VBAT | harmless electrically; visual |
| 6 | Post touches nothing else | planes are 1.45 mm away behind FR4 | — |
| 7 | Open / cold post joint | thermal mass of the module pad | first power-up on a current-limited 3.8 V supply: 0 mA = open (procedure step 10); optionally 4-wire mΩ between B.Cu land and the module's VBAT |
| 8 | Reverse battery polarity | JST-PH is not polarity-standard | polarity check against the silkscreen and a meter before the first connection |
| 9 | Accidental contact under mechanical stress (USB plug force, battery cable) | stub + fillet | enclosure support (§7); re-check continuity after the mechanical test |

## 5. Hole fabrication and solderability

**Can R1b's output be read as a tented or plugged hole?**

* The hole is a **component pad**, not a via, in every machine-readable cue: drill tool attribute `ComponentDrill`; copper flashes `ComponentPad` on F.Cu/In1/In2/B.Cu; mask openings on **both** faces (Ø1.95 top and bottom, Ø3.00 at the bottom). A CAM that sorts vias by "has mask opening" will not classify it as a via.
* Where it can still go wrong is a CAM that compares the opening with the **compensated drill tool** (the file's 1.90 mm + compensation):

| Assumed compensation | Tool Ø | Ø1.95 opening minus tool | Ø2.05 | Ø2.10 | Ø2.15 |
|---|---|---|---|---|---|
| +0.00 | 1.90 | **+0.05** | +0.15 | +0.20 | +0.25 |
| +0.05 (plating allowance) | 1.95 | **0.00** | +0.10 | +0.15 | +0.20 |
| +0.10 | 2.00 | **−0.05** | +0.05 | +0.10 | +0.15 |
| +0.15 | 2.05 | **−0.10** | 0.00 | +0.05 | +0.10 |

R1b's opening is larger than the file hole but would be "smaller than the drilled hole" under a tool-based comparison with ≥ 0.05 mm compensation. JLC's wording (as reported) does not say which diameter its rule uses. **Therefore the claim "R1b cannot be tented" is not supportable from documents; it is checkable in minutes from JLC's viewer/DFM output (condition 1).**
* The physical outcome if it were applied: JLC's published tenting and plugging capabilities are for vias of ≤ 0.5–0.6 mm; a Ø1.9 mm hole is outside them, so the likelier result is an engineering question or a rejection of the instruction, not a silently plugged hole — but this is an assumption about CAM behaviour and is not asserted as acceptance.

| Property | Assessment |
|---|---|
| Open plated barrel | yes by design; barrel Ø1.82–2.03 mm; the ENIG finish does not reduce the hole (HASL can) |
| Usable annular ring | 0.20 mm nominal (JLC recommended), worst 0.035 mm — no breakout; the F.Cu land is mask-covered and not a solder land |
| Correct mask exposure | top: 0.025 mm annulus only (deliberate: contains solder, keeps the ring insulated); bottom: Ø3.0 land with 0.55 mm radial exposed |
| Bottom soldering land | 4.23 mm² bare, no neighbouring B.Cu copper within 4 mm |
| Insertion clearance | 0.65 mm radial for the post, 0.41 mm for a Ø1.0 cone |
| Inspectable fillet | bottom fillet fully visible; module-side cone inspected before assembly (step 2) |

**If JLC changes the mask opening.** A CAM *enlargement* (e.g. to 2.05–2.15) is harmless to function: exposed host metal grows, the BAT− exposed separation falls from 0.235 mm to 0.185 / 0.16 / 0.135 mm (opening 2.05 / 2.10 / 2.15, still bare-metal separations of > 0.1 mm), solder can wet slightly more of the top rim. A CAM *tenting* is the only harmful outcome (hole must be reopened or the board reworked).
**Minimal enlarged alternative, only if the viewer shows a problem:** F.Mask/B.Mask opening **Ø2.10 mm** (mask margin −0.10): 0.10 mm over a +0.10 compensation, mask covers the rest of the 0.20 mm ring; mask layers only — drill and copper Gerbers unchanged. It is **not** recommended pre-emptively: without CAM evidence it trades 0.075 mm of BAT− exposed margin for protection against a rule whose threshold is unknown.

## 6. Assembly reliability and instructions (no PCB change)

| Topic | Assessment |
|---|---|
| Handling, vibration, shock | module mass ≈ 3 g on 14 castellation joints + 1 stub: inertial loads are negligible compared with the USB-plug and cable loads |
| USB insertion (≈ 20–35 N class value) | in-plane load goes to the castellations; the post carries an estimated 1/15 (≈ 2–3 N, **estimate**); shear strength of a Ø0.51 post joint of ~0.6 mm² ≈ 15–20 N (order of magnitude) → acceptable, but the USB end needs enclosure support |
| Thermal cycling / fatigue | FR4 on FR4: differential growth ≈ 1 µm over 8 mm for ΔT 60 K; fillet fatigue negligible; the 1 mm stub is the soft element |
| Repair / inspection | bottom fillet accessible with an iron; cone joint not directly accessible after seating (reheat via the post) — repairable |
| Is the post a structural/alignment pin? | **No** — with 0.65 mm radial play it cannot align the module; the 14 castellations locate and carry it; after soldering it is a weak rigid link only |
| Battery cable strain | JST-PH connector J1 on the north edge, cable strain relief is an enclosure feature (RB-02H) |

**Handling and assembly instructions that lower risk without changing the PCB:**
1. Cut a 1.0 mm slug from Ø0.5 mm solder; tin the BAT0 pad centre only; hold the post vertical; gauge the cone Ø ≤ 1.0 mm / ≤ 0.4 mm high; continuity BAT0 ↔ castellation 13 open.
2. Lower the module with the post in the hole; rock test; USB end flush ± 0.2 mm; toes visible on both sides.
3. Solder castellations (pins 14 and 7 first); then the bottom fillet with the **smallest** solder amount that forms a concave fillet on the Ø3.0 land; do not fill the hole.
4. Tests: J_BAT+ ↔ GND not 0 Ω; pin 14 ↔ GND ≈ 4.4 kΩ; first power-up on a 3.8 V / 150 mA-limited supply before any cell.
5. Support the USB-C end and the module top in the enclosure; do not use the post as a mechanical stop.

## 7. Independent electrical review

| Check | Result |
|---|---|
| BAT+ only on VBAT | U1.23 appears only in net VBAT; VBAT = J1.1, R4001.1, R7107.1, TP1, U1.23 |
| BAT− / GND return | the module GND reaches the host ground through castellation 13 (and the plane); GND0 is not tied to host copper by design; return current of the module (≤ 0.5 A bursts) passes one 1.5 mm castellation joint — adequate current-wise; ground-bounce on the module side only |
| Backfeed | 5V pad only to resistors to GND (R3006/R3009/R7105); 3V3 pad only to FB1/DVDD_F; no VBAT → 5V/3V3 path outside the module; module power path per Seeed schematic (Q1/D2) |
| Special PTH short/open | DRC 0 errors, 0 unconnected; barrel is VBAT; planes cleared 0.30 mm; B.Cu land connected through the barrel (1.6 mm, ≥ 20 µm plating Class 2) |
| Battery protection / polarity | none on Rev B: PCM-protected 4.2 V cell mandatory; no reverse-polarity protection; JST-PH polarity not standardised — documented in the procedure |
| Charging current | uncertain (50 mA plain per wiki vs 110 mA in the Sense file): independent of the mechanical decision; must be measured on the module |

## 8. Manufacturing readiness

### 8.1 Risk by category if five PCBs are ordered before a module is available

| Category | Risk | Basis |
|---|---|---|
| **Bare-PCB fabrication** | low; one open item (hole/mask CAM interpretation) | all values inside JLC's published ranges; the item is verifiable before payment |
| **XIAO mechanical mounting** | low–moderate | radial margin 0.41 mm vs error budget 0.50 mm per axis resolved by ≤ 0.09 mm shift; unknowns: module pad registration, thickness, flatness |
| **Manual soldering** | moderate (skill-dependent) | cone size, bottom fillet quantity, seating; mitigated by slug/gauge/tests |
| **Electrical connection** | low | single net, inspected joint, three pre-battery tests |
| **Discard / rework of the five PCBs** | low | revision-requiring causes are limited to (a) a CAM that plugs/tents the hole irrecoverably, (b) a module whose BAT pad is > 0.45 mm off; everything else is fixable at assembly |

No numeric probabilities are given: none can be supported by the evidence.

### 8.2 Risks by remedy

| Could require another PCB revision | Addressable at assembly |
|---|---|
| hole plugged/tented by JLC (mask-layer change at most, if only the opening needs to grow) | cone size, bridging, bottom-fill amount |
| module BAT pad position or geometry outside the 0.45 mm envelope | module seating shift, toe symmetry |
| — | cold joint, polarity, USB strain (enclosure) |

### 8.3 Decision

**B — CONDITIONAL GO.** Not A, because the CAM interpretation of one Ø1.90 hole cannot be confirmed from documents; not C, because no specific credible *defect* in the design was found: the geometry is consistent across PCB, footprint and Gerber/drill, the exposed-metal separations are ≥ 0.235 mm, and the assembly margins are positive at worst case.

**Strictly necessary PCB changes: none.**
**Existing frozen PCB and QUOTE-ONLY package:** the PCB is used **unchanged**. The Gerber/drill/BOM/CPL contents are usable unchanged (RB-04H: equivalent to a re-export), but the package is stamped NOT FOR PRODUCTION and its zip carries "QUOTE-ONLY" in the name; to order, a release-named copy must be issued from the same frozen files after your explicit manufacturing-release approval (not done here).

## 9. Physical-sample-dependent unknowns (do not block the PCB order)

Module BAT0/GND0 pad position and size relative to the castellations; module thickness and flatness; real castellation-to-edge distance; charger resistor/current; boot behaviour of D2/D6/D7; achieved cone/fillet quality; USB-plug strain on the joint.

## 10. Manufacturer clarifications still required

* **JLC (written, before or with the order):** is the Ø1.90 hole with Ø1.95 openings kept open (component hole)? what is the CAM comparison diameter (file or compensated tool)? mask registration tolerance? ring acceptance at 0.20 mm? (items A1–A3 of `REVB_RB04G_JLC_FINAL_INQUIRY.md`). The statements already received (as reported) should be placed on file with their exact text.
* **Seeed:** retail plain pad position tolerance, thickness, revision (`REVB_RB04G_SEEED_FINAL_CONFIRMATION.md`); reported answers leave these open.

## 11. Final recommendation

```
FROZEN PCB CHANGES REQUIRED:       NONE
R1b GEOMETRY CONSISTENT (3 SOURCES): YES
WORST-CASE EXPOSED BAT+ ↔ BAT− GAP: 0.235 mm (host metal); 0.74–0.89 mm (post/cone/pad)
WORST-CASE SEATING MARGIN (Ø1.0 cone): 0.063 mm
HOLE-OPEN GUARANTEE FROM JLC CAM:  NOT DEMONSTRATED (check in viewer; order remark)
DECISION:                          B — CONDITIONAL GO for a five-board prototype order
CONDITIONS:                        1 viewer/DFM check, 2 order remark, 3 ENIG, 4 assembly controls, 5 incoming inspection
READY TO ORDER (per this audit):   CONDITIONAL — requires your manufacturing-release approval and the conditions above
```
