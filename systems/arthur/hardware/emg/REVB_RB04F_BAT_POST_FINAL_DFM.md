# RB-04F — Final BAT+ Post DFM Qualification

Date: 2026-10-12. Branch `hardware/emg-rev-b`. **Nothing was installed:** canonical PCB, schematic, BOM and footprint unchanged (sha256 `111e1cd3d0c9fae1…`, project hashes verify). No order, upload, purchase, commit, push; JLC and Seeed were **not** contacted.
All experiments ran on scratch copies (`tools/rb04f_bat_post_geometry.py`, `tools/rb04f_variant_drc.py`; data `evidence/rb04f/`). No electrical-safety approval and no permission for human electrode use is implied.

## 1. Result

```
R1b MANUFACTURABILITY:            CONDITIONAL  (fabricable inside every published JLC limit; mask-vs-hole handling not documented → written confirmation)
HOLE AND MASK GEOMETRY:           CONDITIONAL  (mask film can overhang the hole by up to 0.165 mm in the worst corner; harmless for the post, but unconfirmed)
WORST-CASE ANNULAR RING:          nominal 0.20 mm; worst 0.035 mm (finished +0.13, drill wander 0.075, copper -0.025) — positive, no breakout
WORST-CASE BAT− SEPARATION:       exposed conductors (post, solder, exposed ring annulus) to GND0 pad: ≥ 0.235 mm
                                  covered ring copper (under mask) to GND0 pad: ≥ 0.085 mm in plan (nominal 0.247)
POST SOLDERING RELIABILITY:       CONDITIONAL  (inspected cone joint, loose bottom fillet; trial required)
BETTER MINIMAL ALTERNATIVE:       none proven; R1b geometry is kept. One variant (A3, bottom-fed 0.80 mm hole) is promising and unproven → trial coupon
REQUIRED PCB CHANGE (if installed): U1 pad 23: drill 1.40→1.90, copper 1.90→2.30, mask margin −0.225→−0.175 (opening 1.95; fallback −0.125 = 2.05)
PHYSICAL SAMPLE STILL REQUIRED:   YES
READY TO INSTALL THE CORRECTION:  YES (R1b, on your approval; the mask margin may still change to −0.125 after JLC's written answer)
READY TO ORDER:                   NO
```

## 2. Concern 1 — hole and solder-mask geometry

### 2.1 What JLC publishes (capabilities page, re-read 2026-10-12) and what it does not

| Item | Published value | Used |
|---|---|---|
| Plated hole finished size | +0.13 / −0.08 mm | 1.90 → **1.82 … 2.03** |
| Drill position | ±0.075 mm | ✓ |
| PTH annular ring, multilayer 1 oz | **recommended 0.20, absolute minimum 0.15** (2-layer 1 oz: 0.25 / 0.18) | R1b 0.20 = "recommended" |
| Soldermask expansion / bridge | 1:1; bridge 0.10 mm (between openings) | n/a (no free-standing mask strip here: the mask is continuous outside the opening) |
| Mask registration | **not published** | ±0.05 **assumed** |
| Mask opening smaller than a plated hole | **not published** | question to JLC |
| Acceptance class | default IPC Class 2 (JLC blog, via search summary — not on the capabilities page): ring breakout up to 90° allowed if the connection is intact | consistent with a 0.20 ring |

Plated slots (a way to widen the hole only along the pad) need length ≥ 2 × width and share the same tolerance → not applicable to a pad 1.016 mm high.

### 2.2 Worst-case numbers (assumptions above; `bat_post_geometry.json`)

| Candidate (drill / ring / mask) | Finished hole | Annulus nom / worst | Mask lip into hole typ / worst | Mask over ring nom / worst | Covered ring → GND0 nom / worst | **Exposed copper → GND0 worst** |
|---|---|---|---|---|---|---|
| Current 1.40 / 1.90 / 1.45 | 1.32–1.53 | 0.25 / 0.085 | 0 / 0.165 | 0.225 / 0.15 | 0.447 / 0.035 | 0.235 |
| R1 1.70 / 2.10 / 1.75 | 1.62–1.83 | 0.20 / 0.035 | 0 / 0.165 | 0.175 / 0.10 | 0.347 / 0.085 | 0.235 |
| **R1b 1.90 / 2.30 / 1.95** | 1.82–2.03 | 0.20 / 0.035 | 0 / 0.165 | 0.175 / 0.10 | 0.247 / 0.085 | **0.235** |
| R1c 1.90 / 2.30 / 2.05 | 1.82–2.03 | 0.20 / 0.035 | 0 / 0.115 | 0.125 / 0.05 | 0.247 / 0.085 | 0.185 |
| R1d 1.90 / 2.30 / 2.15 | 1.82–2.03 | 0.20 / 0.035 | 0 / 0.065 | 0.075 / 0.00 | 0.247 / 0.085 | 0.135 |

(The "worst" columns stack finished-hole oversize, drill wander 0.075, mask registration 0.05, copper tolerances 0.025–0.05 and the module shift needed to seat the cone, 0.087 mm.)

**Answers.**
* *Can the finished hole exceed the mask opening?* Yes. For R1b the opening (Ø1.95) is only 0.025 mm/side larger than the nominal hole; a hole at the +0.13 limit (Ø2.03), displaced by wander and registration, lets the mask film overhang the void by up to **0.165 mm** at one edge (typical case: flush). The same happens in the **current** design (Ø1.45 vs ≤ 1.53). It is a property of the 0.05 mm nominal margin used since RB-00.6, not introduced by R1b.
* *Does it matter?* The overhang is over the top rim of a hole that the Ø0.51 post passes with ≥ 0.65 mm radial clearance; the hole is under the module and not a component-solder hole. Risks: loose mask flakes (debris) and an inspection finding. JLC CAM may also enlarge the opening automatically (unknown).
* *Annular ring.* Nominal 0.20 mm equals JLC's recommended value for multilayer 1 oz. At the worst corner the F.Cu land is 0.035 mm wide on one side — **positive, no breakout**; IPC Class 2 would anyway accept up to 90° breakout. Inner-layer pads (Ø2.3) have no electrical role (isolated from the planes), the barrel connects F.Cu ring ↔ B.Cu Ø3.0 pad. 0.25 mm of annulus would require ring Ø2.4 and costs 0.05 mm of BAT− gap — not needed.
* *Would changing the mask opening create BAT− problems?* Raising it toward the ring (R1c, R1d) removes the overhang but exposes more VBAT copper: exposed-copper gap to GND0 falls 0.235 → 0.185 → 0.135 and more HASL area appears under the module (solder flooding risk). A smaller opening is protective for BAT− and for solder containment. **Keep 1.95; use 2.05 only if JLC says it will otherwise flag/enlarge.**

DRC passing (0 errors on R1b, R1c, A1, A2, A3 scratch copies) says nothing about any of the above: KiCad has no rule for mask-lip-into-hole or finished-hole oversize.

## 3. Concern 2 — is a 0.06–0.085 mm BAT− gap sufficient?

### 3.1 The number was the wrong one to judge by

The 0.06 mm of RB-04E (0.085 mm here after re-weighting tolerances) is the plan-view distance between the **mask-covered** edge of the host VBAT ring and the GND0 pad edge. It is not a solder-bridge path: the ring copper is under 10–30 µm of mask, and solder does not wet mask. The conductors that can actually carry solder are:

| Conductor pair | Worst-case plan distance | Notes |
|---|---|---|
| Solder cone on module BAT0 pad ↔ GND0 pad | ≥ 0.889 mm (pad gap 0.889; the cone wets only the pad; module mask between) | cone Ø ≤ 1.0 × 0.4 mm, volume ≈ 0.19 mm³ |
| Post / bottom-pad fillet ↔ GND0 pad | ≥ 0.50 mm (post at the pad limit 0.253 toward GND0, radius 0.255, fillet confined to the hole) | the fillet sits in the Ø1.9 hole and on the B.Cu pad, 1.6 mm below |
| **Exposed host VBAT copper** (barrel rim + 0.025–0.075 mm ring annulus inside the mask opening) ↔ GND0 pad | **≥ 0.235 mm** (R1b) | the only host copper that is open |
| Covered ring edge ↔ GND0 pad | ≥ 0.085 mm in plan, separated by mask (≥ 0.025) **and** the module standoff | no conductive path unless mask is breached **and** conductive material lies in the gap |

### 3.2 Three-dimensional stack (assumed thicknesses; not measured)

| Layer, bottom → top | Thickness |
|---|---|
| Host F.Cu | 0.035 mm |
| Host solder mask over copper / over laminate | 0.01–0.03 / 0.02–0.04 mm |
| HASL on host castellation pads (domed) | 0.001–0.04 mm — the module rests on these 28 domes |
| Air gap under module | 0.03–0.08 mm |
| Module mask and exposed pad finish (BAT0 / GND0) | pad ≈ flush to +0.04 mm |

Consequences: (i) a solder **ball** (≥ 0.2 mm) cannot sit under the seated module; only films/smears can, and they cannot wet mask, so lateral transport over 0.235 mm is not credible; (ii) the cone is inside the hole (depth 1.6 mm), so it does not raise the module — if it does not enter, the module is lifted 0.4 mm and the rock test (procedure step 2) catches it; (iii) the BAT− pad is raised ≤ 0.04 mm above the module face and faces the covered ring with 0.03–0.08 mm of air plus mask.

### 3.3 Failure scenarios

| Scenario | Needs | Assessment |
|---|---|---|
| Solder smear from the bottom fill climbs the hole, floods the exposed annulus | over-fed solder at step 7 | confined to ≤ 0.075 mm annulus (R1b 0.025) inside the opening; cannot cross 0.235 mm of mask-covered ring to GND0 |
| Cone overflows the BAT0 pad toward GND0 | solder volume ≫ 0.3 mm³ | caught by the step-1 inspection (before assembly); 0.889 mm gap |
| Mask pinhole over ring + conductive debris bridging 0.085 mm | two independent defects | leakage-type (flux residue ~10⁸ Ω → tens of nA at 4.2 V), not a hard short; not credible as a repeatable failure |
| Module shifted toward GND0 by hand | shift > 0.09 mm toward BAT− in the worst tolerance corner | shift is only needed in that corner; monitoring: gap stays > 0 with every tolerance adverse |
| Mechanical loading: USB insertion (≤ 35 N class value) / pressing the module | — | in-plane load goes through the 14 castellation fillets (≈ 1/15 share to a rigid post, ≈ 2–3 N — estimate, not measured); no strain on the pad before step 7; **after** step 7 the 1 mm stub and the post-to-pad joint carry a small share — hence the trial |

### 3.4 Verdict on the gap

* **Not** counting solder mask: the minimum separation between *exposed* VBAT metal/solder and the BAT− pad is **0.235 mm** (R1b), 0.50 mm for the post/fillet and 0.889 mm for the cone. That is the number that matters for a manually assembled joint and it is **sufficient** against mask-defect-independent bridging (typical hand-soldering residue < 0.1 mm films, standoff 0.03–0.08 mm).
* The 0.085 mm covered-ring gap is a dielectric-through-mask distance; it is acceptable only in addition to the above and should **not** be quoted as the safety margin.
* The residual risk is process (cone size, over-fed bottom solder), controlled by the Ø ≤ 1.0 mm gauge and the visual/continuity checks, not by this geometry.

## 4. Alternatives (all scratch; DRC 0/0/0 for each)

| Option | Process | PCB change | Hole / ring / mask | Exposed → GND0 worst | Cone/post fit | Main weakness | Assessment |
|---|---|---|---|---|---|---|---|
| Current | T0 cone first | none | 1.40 / 1.90 / 1.45 | 0.235 | needs 0.337 mm shift vs 0.150 allowed → **fails** | — | rejected (RB-04E) |
| R1 | T0 | drill, ring, mask | 1.70 / 2.10 / 1.75 | 0.235 | 0.187 vs 0.150 → **fails by 0.037** | — | rejected |
| **R1b** | T0 | drill, ring, mask, In1 refill | 1.90 / 2.30 / 1.95 | **0.235** | 0.087 vs 0.150 (**+0.063**) with Ø ≤ 1.0 cone | loose bottom fillet (gap 0.65), mask-vs-hole confirmation | **preferred** |
| R1c | T0 | as R1b, mask 2.05 | 1.90 / 2.30 / 2.05 | 0.185 | same | more exposed copper | fallback if JLC objects to the lip |
| A1 | T1 bottom-fed | **mask only** (−0.125) | 1.40 / 1.90 / 1.65 | 0.472 | post floats ±0.65 in the hole → only ~16 % of its area on the pad (worst) | unpredictable post location | rejected |
| A2 | T1 | drill, ring, mask | 1.10 / 1.50 / 1.35 | 0.622 | post off-centre ≤ 0.50 → ~52 % on pad | loose fit, capillary gap 0.26–0.36 | not preferred |
| **A3** | T1 | drill, ring, mask | 0.80 / 1.20 / 1.00 | 0.797 | post within 0.35 of pad centre → ~86 % on pad; radial gap 0.11–0.21 = normal through-hole fit | **blind joint**: solder must rise 1.6 mm to a pad that can only be inspected electrically; heat sink of the module pad | **promising, unproven** — trial coupon |
| AWG22 post (Ø0.64) with R1b | T0 | none beyond R1b | — | — | stronger stub; fillet radial 0.18 only | cone gauge still Ø ≤ 1.0 | process option for the trial |

Rejected without a trial: oval/slotted PTH (JLC length ≥ 2 × width), a flying wire (no mechanical locator), pad-less F.Cu hole (JLC behaviour for a land-less hole unknown), a carrier board (excluded by the brief), ring annulus 0.15 (breakout margin lost).

**Why not A3 now.** It is the cleanest through-hole geometry and gives the largest BAT− margin (0.80 mm) but it moves the BAT+ joint from an open, inspectable joint (cone, step 1) to a blind one. A repeatable-assembly argument for a battery connection prefers the inspectable joint. R1b keeps the existing process and fixes the worst-case geometry; A3 should be tried on a coupon before any change of concept.

**Trial coupon (cheap, not yet ordered):** a 2-layer 1.6 mm board, 20 × 30 mm, with one BAT-pad-like land per variant (hole 0.8 / 1.1 / 1.4 / 1.7 / 1.9, top ring + mask as in the table, B.Cu Ø3.0 pad) plus a real XIAO (or a dummy with a 2.0 × 1.0 mm copper pad on 1.0 mm FR4). Measures: cone fit, bottom-fill height, pull/shear of the stub, and whether JLC's mask matches the opening. This requires your order approval.

## 5. Questions

### 5.1 JLCPCB (not sent)

| # | Question | Documentation | Written answer | Sample |
|---|---|---|---|---|
| J1 | Is a plated hole Ø1.90 with a mask opening Ø1.95 accepted as is, or does CAM enlarge/shrink the opening? What is the mask registration tolerance? | No — not published | **Yes (required)** | coupon confirms |
| J2 | Is a 0.20 mm F.Cu annulus at a Ø1.9 PTH (finished 1.82–2.03) accepted under IPC Class 2 breakout rules; does CAM add or change the ring? | partly (0.20 recommended / 0.15 min) | Yes | — |
| J3 | Is the +0.13/−0.08 tolerance on the *finished* diameter for Ø1.9 PTH on a 4-layer board? Does JLC drill oversize to compensate plating (so the file value is the finished target)? | partly | Yes | measure on coupon |
| J4 | Are inner-layer Ø2.3 pads isolated by the plane clearance acceptable (breakout/clearance)? | partly | optional | — |
| J5 | Does a Ø3.0 bare B.Cu pad with a Ø3.0 mask opening and no solder paste raise any concern? | — | optional | — |
| J6 | The 22 mask-via cases and the other items in `REVB_RB04A_JLC_QUESTIONS.md` | partly | Yes | — |

### 5.2 Seeed (not sent; extends `REVB_RB04C_SEEED_MANUFACTURER_QUESTIONS.md`)

| # | Question | Documentation | Written answer | Sample |
|---|---|---|---|---|
| S1 | PCB revision and geometry of PN 202003751 (identical to the Sense v1.5 CAD?) | **no** (files are Sense) | **Yes** | **Yes** |
| S2 | BAT0/GND0 pad size, position tolerance relative to the castellations, finish, thickness | no | Yes | **Yes** (measure) |
| S3 | PCB thickness and tolerance; flatness | no | Yes | **Yes** (micrometer) |
| S4 | Castellation edge distance tolerance | no | Yes | Yes |
| S5 | Charger resistor / charge current of the plain module | wiki only (50 mA) | Yes | bench |
| S6 | Boot-time states of D2/D3/D6/D7 | datasheet-level only | optional | bench |

## 6. Exact required PCB changes (only after your approval)

| # | Object | Change |
|---|---|---|
| R1b | U1 pad "23" thru-hole (PCB and `XIAO_ESP32S3_HANDSOLDER.kicad_mod`) | drill **1.40 → 1.90 mm**, copper **1.90 → 2.30 mm**, solder-mask margin **−0.225 → −0.175 mm** (opening 1.95 mm). BAT+ net, position (44.635, 54.790) and the B.Cu Ø3.0 pad unchanged |
| — | In1 plane fill | re-fill (−1.7 mm²) |
| — | Everything else | none (routing, vias, components, outline, schematic, BOM, CPL) |
| Optional | mask margin −0.175 → −0.125 (R1c) | only if JLC J1 requires it; mask Gerbers only |
Install with `tools/rb04e_install_R1b.sh` (archives the pre-change PCB; tested on a scratch copy), then re-run the RB-04 suite and regenerate the RB-05 package (F.Cu, B.Cu, In1, In2, F.Mask, B.Mask, drill). The RB-05 package is stamped QUOTE ONLY and stays valid for a quotation.
Process changes accompanying R1b: cone Ø ≤ 1.0 mm gauge (replaces "≤ 1.1"), post AWG24 solid (AWG22 as trial variable), step 7 solder volume limited to a fillet on the B.Cu pad.

## 7. What a physical sample must still show

Module thickness and BAT/castellation positions (they set the ±0.10 registration term); cone fit and the bottom-fillet quality on a real Ø1.9 hole; stub shear/pull; JLC's actual mask opening; whether the plain module equals the Sense CAD. Until then R1b is the best-supported geometry, not a proven assembly.
