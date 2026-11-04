# RB-04 — Open Risks and Decisions

Date: 2026-10-11. Nothing was ordered, uploaded, committed or pushed; no manufacturing release exists. No electrical-safety approval and no permission for
human electrode use is implied. Documents: `REVB_RB04_INDEPENDENT_ELECTRICAL_AUDIT.md`, `REVB_RB04_DFM_AUDIT.md`, `REVB_RB04_ECONOMIC_PCBA_AND_BOM.md`.

> **RB-04A update — decision status.** Superseded by RB-04A (2026-10-11): board is now `B / RB-04A`; the TP2 dependence is repaired (R1 closed), the BOM candidates are selected (R5 reduced to the 2.2 µF approval), the JLC inquiry is prepared and **not sent**. Details: `REVB_RB04A_*.md`.
>
> | ID | Status after RB-04A |
> |---|---|
> | D1 | **DONE** — TP2 repair installed and verified (R1 closed) |
> | D2 | **HOLD** — 0.30 / 0.60 mm vias kept; question Q6 prepared |
> | D3 | **PREPARED, NOT SENT** — `REVB_RB04A_JLC_QUESTIONS.md`; JLC ANSWER RECEIVED: NO |
> | D4 | **DONE except 2.2 µF line** — 118 / 126 qualified; 8 parts need approval of the 10 V X7R part |
> | D5 | **HOLD** — nothing uploaded; CPL rotations stay CONDITIONAL |
> | D6 | **OPEN, accept pending JLC Q1–Q2** — 12 class-2, 10 class-3 vias unchanged; no rework |
> | D7 | **OPEN (owner)** — skin-side bare pads TP1–TP8 incl. RLD_SAFE and AFE_3V0 (TP2) unchanged |
> | D8 | **DONE** — title blocks and `REVISION` = "B / RB-04A"; R18 closed |
> | D9 | **KEPT** — "no certification, no human use" statement is in every RB-04A document |


## 1. Risk register

| # | Risk | Severity | Basis | Mitigation / owner decision |
|---|---|---|---|---|
| R1 | AFE_3V0 trunk continuity depends on the copper of bare test pad TP2 | Medium | `conn.json` (own union-find); only this net | D1: add two B.Cu segments (candidate DRC-clean) |
| R2 | 10 vias (class 3) with annulus partly in a pad opening; hole web 0.101–0.141 mm, three within 0.01 mm of JLC's 0.10 mm figure | Medium | `mask.json`, JLC page | JLC inquiry Q1; D6 |
| R3 | 12 vias (class 2) with mask dam 0.00–0.087 mm (< 0.09 mm neighbour clearance) | Low-Med | same | JLC inquiry Q2 |
| R4 | Via annular ring 0.150 mm = JLC absolute minimum for PTH (recommended 0.20) | Medium | JLC page | Q3; option P2 (0.25 mm drill) — possible price/aspect-ratio issue |
| R5 | BOM not frozen: 128 parts generic, 5 IC lines without LCSC number; dielectric mismatches (X5R vs X7R), no C0G 10 nF found | **High for ordering** | BOM doc | D4 |
| R6 | CPL rotation convention for SOT-23, SOT-23-5, TSSOP, JST, SX3M unverified | Medium | no JLC viewer access | D5 after upload approval |
| R7 | Mask registration tolerance unpublished | Medium | JLC page | Q1 |
| R8 | "Tented by default" for the 4-layer order unconfirmed | Medium | JLC page lists plugged / filled options only | Q4 |
| R9 | 2.5 mm body-to-edge note and fixed 255 °C reflow vs JST connectors unresolved (carried from RB-02E) | Medium | RB-02E | Q6, Q7 |
| R10 | ADC-input runs 43–58 mm, 7–11 vias, P/N Δ up to 11.7 mm | Low | calculations (not measured) | accept; measure |
| R11 | CLKIN 0.35–0.45 mm from AFE_CAP / MOSI / DVDD_F; B.Cu section 26 % over no In2 pour | Low-Med | `electrical.json` | accept; EMC pre-compliance / scope check |
| R12 | SPI on In2 (3.6–4.4 mm, 1.065 mm from In1) and long B.Cu runs | Low | geometry | accept |
| R13 | Skin-side bare test pads include VBAT, AFE_3V0, DVDD_F, VCM, **RLD_SAFE (patient reference)** and AFE_EN | Medium (safety design, not certified) | netlist | enclosure partition / cover or remove pads: owner decision D7 |
| R14 | No mains, defibrillation, ESD or leakage-current protection; none claimed | Scope | schematic | out of scope; do not use on humans |
| R15 | C6009 estimates (0.25 nH, 11 MHz) unmeasured | Low | formulas | measure CAP-pin noise |
| R16 | 30° iron approach at toes 12–13: FB1/C7101 0.13 mm short | Low | model | accept |
| R17 | Project files are protected only by hash + read-only bits; pcbnew/GUI can still rewrite | Low-Med | `rb04_lock.sh` | keep the verify step in every run |
| R18 | Title block / REVISION variable stale ("B / RB-02", "B / RB-01") | Info | job file | D8 |
| R19 | Stack-up 1.606 mm computed vs Economic "≤ 1.6 mm" | Low | economic audit | confirm on order form |

## 2. Decisions required

| ID | Decision | Recommendation | Consequence if deferred |
|---|---|---|---|
| **D1** | Apply the TP2 bridge (2 B.Cu segments, 0.3 mm wide, +1.05 mm copper; `archive/rb04_candidates/cand_P1_tp2_bridge.kicad_pcb`): DRC 0 errors, 0 unconnected, guard PASS | **Yes** — trivial, removes the only continuity dependence on a test pad | board keeps an AFE rail linked through a probe point |
| **D2** | Via drill 0.30 → 0.25 mm (ring 0.175 mm, hole web +0.025 mm; DRC clean in scratch; needs rule change `min_through_hole_diameter` 0.30 → 0.25 + baseline update) | **Not yet** — ask JLC first (price, aspect ratio, ring figure) | ring stays at the absolute minimum |
| **D3** | Send the inquiry in §3 (text + images + CSV, no Gerbers) | **Yes** | R2, R3, R4, R7, R8 stay open |
| **D4** | BOM freeze: pick LCSC numbers for 21 generic lines and the 5 IC/diode lines; decide X5R vs X7R (1 µF, 2.2 µF), 10 nF C0G alternatives (X7R, 2 × 4.7 nF C0G, Extended) | owner selection; candidate list in the BOM doc | no quote, no order possible |
| **D5** | Upload Gerbers/BOM/CPL to JLC's DFM viewer (not done) to check rotations and DFM | after D3, with explicit approval | R6 open |
| **D6** | Hand-placement rework of the 22 non-class-1 vias (moving neighbouring 0603 parts 0.05–0.20 mm), or accept after JLC's answer | accept pending Q1–Q2; rework only if JLC objects | possible re-run of RB-03R-style repair |
| **D7** | Skin-side test pads (TP1–TP8, incl. RLD_SAFE): keep bare behind an enclosure partition, cover with mask, or remove | owner / enclosure design | safety-design question stays open |
| **D8** | Update title block / REVISION text at release preparation | yes | cosmetic |
| **D9** | Keep the "no certification, no human use" scope statement in every release document | yes | — |

## 3. JLCPCB technical inquiry (draft; send only on D3)

# JLCPCB technical inquiry — design "ARTHUR_EMG_RevB" (4-layer, 51.30 × 64.95 mm, 1.6 mm, HASL), draft for approval

Please answer for a 4-layer 1.6 mm JLC04161H-7628 board, 1 oz outer / 0.5 oz inner, 0.30 mm drilled / 0.60 mm pad through vias, default tenting.
Attachments: overview.png (numbered), V01–V22.png (4 × 4 mm crops, F.Cu + F.Mask, the via circled), via_list.csv (coordinates and measured distances).
Gerber / drill / BOM / CPL files are NOT attached to this draft.

**Q1 (10 vias V01–V10).** The via annulus (0.60 mm) overlaps the solder-mask opening of a same-net SMD pad by 0.009–0.049 mm; the via hole edge is
0.101–0.141 mm from the opening. The Gerber mask layer contains no aperture for the via (tented both sides). (a) Will your CAM keep the via covered
(not open or merge it with the pad opening)? (b) Is a 0.10 mm mask web between a pad opening and a tented via hole acceptable, and with what
registration tolerance (the capabilities page gives none)? (c) Do you modify the pad aperture in these cases?

**Q2 (12 vias V11–V22).** The via annulus is outside the opening but 0.000–0.087 mm from it. Your page says "keep at least 0.09 mm clearance between
soldermask openings and neighboring traces". Does this apply to via annuli? What does CAM do when it is not met (shrink the opening, leave it, reject)?

**Q3.** Via 0.30 / 0.60 mm: annular ring 0.15 mm. The PTH row of the capabilities page gives "multilayer 1 oz: recommended 0.20 mm, absolute minimum 0.15 mm".
Is 0.15 mm acceptable for vias on this stack-up, and is there any surcharge or yield reduction? Would 0.25 / 0.60 mm (ring 0.175 mm) change price or lead time
(aspect ratio 1.6 : 0.25)?

**Q4.** For a 4-layer order, what is the default via treatment on the order form when the mask Gerber has no via apertures — tented both sides, and is that
free? Is "plugged" possible for vias that are 0.1–0.3 mm from pad openings (your page requires ≥ 0.35 mm)?

**Q5.** Eight bare 1.5 mm test pads on B.Cu (HASL, no paste) with a tented via 0.08 mm from the opening of two of them (V11, V14): any concern?

**Q6 (assembly, Economic).** Please confirm the rotation convention of your library for: SOT-23 (BAV199, 2N7002), SOT-23-5 (TPS7A2030), TSSOP-14/20,
JST B2B-PH-SM4 / S2B-PH-SM4, SX3M 3225 oscillator; and that the 255 ± 5 °C Economic profile is compatible with those JST connectors.

**Q7.** Board outline: Edge.Cuts line width 0.1 mm gives 51.4 × 65.05 mm in the job file; the centre-line size is 51.30 × 64.95 mm. Which dimension do you use for pricing and for the
2.5 mm body-to-edge note?

Coordinates are KiCad board coordinates in mm (origin top-left, y down).


## 4. What is explicitly not proven

Factory acceptance (no JLC response), analog performance (no measurement), safety, EMC, solder-mask behaviour of the 22 near-opening vias, CPL rotations, Basic/Extended status
of the generic lines, prices of the parts except three, and the 255 °C reflow compatibility of the JST connectors.

## 5. Final gate

```
RB-04 ELECTRICAL REVIEW:            CONDITIONAL
SCHEMATIC AND PCB PARITY:           PASS
DRC ERRORS:                         0
ERC ERRORS:                         0
UNCONNECTED NETS:                   0
GROUND / POWER INTEGRITY:           CONDITIONAL   (plane / return path PASS; AFE_3V0 trunk depends on TP2 — D1)
EMG ANALOG ROUTING:                 CONDITIONAL   (hi-Z legs clean; ADC-input runs long; nothing measured)
ADC CAP DECOUPLING:                 CONDITIONAL   (0.3 mm tie, est. 0.25 nH; via annulus 0.040 mm into the opening; unmeasured)
CRITICAL CLOCK ROUTING:             CONDITIONAL   (X1_OUT 4.3 mm, CLKIN 9.8 mm; 0.35-0.45 mm spacing to AFE_CAP/MOSI/DVDD_F)
VIA-IN-PAD:                         0
CLASS-2 MASK RISKS:                 12 vias (RB-03S method: 11)
CLASS-3 MASK RISKS:                 10 vias
JLC FABRICATION LIMITS:             CONDITIONAL   (all published limits met; ring at the absolute minimum; mask registration unpublished)
PROJECT CONFIGURATION:              PASS
JLC ECONOMIC ASSEMBLY:              CONDITIONAL
BOM AND CPL:                        CONDITIONAL   (CPL consistent; BOM not frozen)
COST ESTIMATE:                      OPEN          (assembly fees $32.74 documented; part prices incomplete)
READY FOR MANUFACTURING PREPARATION: YES          (no critical safety or manufacturability defect found; D1-D5 pending)
READY TO ORDER:                     NO
OPEN BLOCKERS:                      D4 (BOM freeze), D3/D5 (JLC answers incl. rotations), R2-R4 (via/mask questions), D1 (TP2 bridge, recommended)
REQUIRED USER DECISIONS:            D1, D2, D3, D4, D5, D6, D7, D8
```
