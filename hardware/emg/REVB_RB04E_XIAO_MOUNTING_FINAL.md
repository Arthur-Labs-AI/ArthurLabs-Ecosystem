# RB-04E — BAT+ Mounting Correction and Final Compatibility Gate

Date: 2026-10-12. Branch `hardware/emg-rev-b`. **R1 was NOT installed.** The canonical PCB, schematic, BOM and footprint are unchanged (PCB sha256 `111e1cd3d0c9fae1…`; project hashes verify). Nothing purchased, uploaded, sent, committed, pushed or released; Seeed and JLC were not contacted.
No electrical-safety approval and no permission for human electrode use is implied. Evidence: `rev-b-xiao/evidence/rb04e/`; tools `tools/rb04e_post_stack.py`, `tools/rb04e_install_R1b.sh` (not run on the canonical project), `rb05_package.py` / `rb05_verify.py` (generalised, canonical result unchanged 16/16).

## 1. Result in one table

```
R1 INSTALLED:                     NO   (R1 as proposed 1.70 / 2.10 / 1.75 fails the stricter worst-case gate: 0.187 mm shift needed vs 0.150 allowed)
IMPROVED VARIANT R1b:             1.90 / 2.30 / 1.95 — verified on a scratch copy, NOT installed (needs your approval; one command)
FINISHED-HOLE FABRICATION:        CONDITIONAL (R1b: drill 1.90, finished 1.82–2.03, ring annulus 0.20 = JLC "recommended"; all JLC published limits met)
BAT+ POST GEOMETRY:               CONDITIONAL (R1b worst case passes with a Ø ≤ 1.0 mm cone; Ø1.1 only +0.013 mm)
WORST-CASE BAT− CLEARANCE:        R1b: +0.06 mm air gap (all tolerances adverse + 0.087 mm module shift); nominal 0.247 mm; Monte-Carlo P(gap < 0.10) < 5e-6
SOLDER-CONE / POSITIONING MARGIN: R1b Ø1.0: needed shift 0.087 vs allowed 0.150 (margin 0.063); Ø1.1: 0.137 (margin 0.013 → not robust)
CASTELLATION SOLDERABILITY:       PASS for R1b (toe ≥ 1.06 mm worst case, overlap ≥ 1.43 mm)
MECHANICAL COMPATIBILITY:         Plain: CAD-equivalent, UNVERIFIED retail  |  Sense: design file = PN, retail UNVERIFIED
DRC / ERC / UNCONNECTED (R1b):    0 errors (1 accepted warning) / 0 / 0; parity 135/135, 357 pad nets
ADDITIONAL JLC CONFIRMATION:      YES (items in §7)
PHYSICAL XIAO MEASUREMENT:        YES
READY FOR MANUFACTURING QUOTE:    YES (RB-05 package stays valid for a quote; it is stamped QUOTE ONLY; a quote does not need the hole change)
READY TO ORDER:                   NO
```

## 2. Tolerance model used (every term is an assumption unless "JLC"; Seeed publishes none)

| Term | Value | Source |
|---|---|---|
| Post on module pad (hand) | ±0.25 | install procedure |
| Module BAT pad ↔ castellation copper registration | ±0.10 | assumed (conservative; same copper layer, realistic 0.05) |
| Drilled-hole position | ±0.075 | JLC capabilities (re-read 2026-10-12) |
| Host copper ↔ drill registration | ±0.05 | assumed |
| Datum (hole centre vs pad centre) | 0.022 | RB-02A |
| Finished plated hole | +0.13 / −0.08 | JLC capabilities |
| Module edge position / host pad end | ±0.10 / ±0.05 | assumed |
| Solder-mask registration | ±0.05 | **not published by JLC**; assumed |
| GND0 pad position, ring copper size | ±0.05 each | assumed |

Per-axis linear error of the cone relative to the hole centre: **0.497 mm** (was 0.447 mm in RB-04D; the extra 0.05 is host copper-to-drill registration, which RB-04D omitted).
Allowed module shift: **u (toe direction) 0.150 mm** — toe ≥ 1.0 mm requires 1.30 − 1.0 − 0.10 − 0.05; RB-04D used 0.20 because it omitted the host-pad-end tolerance. **v (along the pad row, toward/away from BAT−) 0.513 mm** (copper overlap ≥ 1.0 mm).
Only the u-direction is tight; v-direction error is corrected by sliding the module along the row, at the price of reducing the BAT− gap when the module moves toward GND0.

## 3. Is R1 sufficient? — No, not under the stated criterion

| Variant (hole / ring / mask) | Cone Ø | Cone-fit margin centred | Shift needed (u) vs 0.150 | BAT− worst air gap | Annulus | Verdict (worst case) |
|---|---|---|---|---|---|---|
| Current 1.40 / 1.90 / 1.45 | 1.0 | 0.160 | 0.337 → **−0.187** | +0.010 | 0.25 | FAIL |
| Current | 1.1 | 0.110 | 0.387 → −0.237 | −0.040 | 0.25 | FAIL |
| **R1 1.70 / 2.10 / 1.75** | 1.0 | 0.310 | 0.187 → **−0.037** | +0.060 | 0.20 | **FAIL (by 0.037 mm)** |
| R1 | 1.1 | 0.260 | 0.237 → −0.087 | +0.010 | 0.20 | FAIL |
| 1.80 / 2.20 / 1.85 | 1.0 | 0.360 | 0.137 → +0.013 | +0.060 | 0.20 | marginal (0.013 mm: not robust) |
| **R1b 1.90 / 2.30 / 1.95** | **1.0** | **0.410** | **0.087 → +0.063** | **+0.060** | **0.20** | **PASS (margin 0.063 mm)** |
| R1b | 1.1 | 0.360 | 0.137 → +0.013 | +0.010 | 0.20 | marginal |
| 2.00 / 2.40 / 2.05 | 1.0 / 1.1 | 0.460 / 0.410 | 0.037 / 0.087 | +0.060 / +0.010 | 0.20 | PASS but nominal BAT− gap only 0.197 |

Monte Carlo (200,000 samples, uniform independent errors, assembler applies the *minimum* shift; `evidence/rb04e/post_stack_rb04e.json`): P(cone cannot be seated within the shift limits) = 1.3 % (current, Ø1.0), 4.6 % (current, Ø1.1), **≤ 0.02 %** for R1 (0.0002 at Ø1.1) and **< 5e-6** for R1b; P(BAT− air gap < 0.10 mm) < 5e-6 for R1 and R1b.
So R1 would work in almost every unit, but it fails the "no worst-case dependence on 0.01–0.04 mm of positioning" gate you set; R1b meets it with a 0.063 mm margin at Ø ≤ 1.0 mm.

**Smallest improvement chosen: R1b** — drill 1.90, ring 2.30 (annulus kept at 0.20), mask opening 1.95 (margin −0.175, same 0.025 mm/side web to the hole as the current design), BAT+ centre and B.Cu Ø3.0 pad unchanged. It is a footprint-pad change only: no copper routing, no component, no outline.
Requires one procedural tightening: **cone Ø ≤ 1.0 mm (was "≤ 1.1 max")**; the 1.016 mm pad height already caps a round cone at about Ø1.0, so this is natural; gauge it.

## 4. Fabrication and assembly checks of R1b

| Item | Finding |
|---|---|
| Finished hole | 1.90 drilled → 1.82 … 2.03 mm (JLC +0.13/−0.08); no minimum-size issue (min 0.15) |
| Annular ring | 0.20 mm nominal = JLC multilayer 1 oz "recommended 0.20 / absolute minimum 0.15"; at the largest finished hole and −0.075 position the ring is 0.06 mm (> 0, no breakout); V0 had 0.25 mm. Inner In1/In2 pads Ø2.3 are isolated from the planes by the plane clearance (no electrical role) |
| Hole position / hole-to-hole | KiCad `hole_clearance` (0.25 mm) and `hole_to_hole` (0.5 mm) rules: 0 violations |
| Plating / solder fill | barrel 1.6 mm long, Ø1.9 → 1.4 mm radial gap to the Ø0.51 post: the bottom joint is a **fillet from the post to the Ø3.0 B.Cu pad**, not a filled barrel; electrically adequate (≤ 0.35 A), mechanically it is a locating/connection post (loads go through the 14 castellations). Needs a trial; the post is no longer a locating pin (radial play ±0.7 mm) |
| Mask | opening 1.95 mm vs finished hole up to 2.03: a mask lip of ≤ 0.04 mm (+ registration ±0.05) may extend into the hole — harmless for the post (top side, under the module); ring stays covered (mask dam 0.175 mm nominal, ≥ 0.125 mm worst case) so the VBAT ring is insulated by mask **and** by the air gap to GND0 |
| JLC conventions | 1:1 mask expansion; the opening is not smaller than the drill; the hole is a standard round PTH (no slot). Slots were rejected: JLC plated slots need length ≥ 2 × width and +0.13/−0.08 |
| BAT− | ring edge → GND0 pad edge: nominal 0.247; at the worst allowed combination 0.06 mm air gap; mask is a second barrier, not the only one |
| Castellations (14) | worst-case toe 1.06–1.54 mm (≥ 1.0 ✓), copper overlap along the edge ≥ 1.43 mm, neighbour copper gap ≥ 0.74 mm |
| Module alignment by hand | needed shift ≤ 0.087 mm in the worst combination (typically 0): the cone drops into a hole with 0.41 mm radial margin; no precise hand positioning needed |

## 5. R1b verification on a scratch copy (canonical untouched)

| Check | Result |
|---|---|
| Change set | text diff vs canonical: only U1 pad 23 (+ footprint file) and the In1 plane fill (3057.1 → 3055.4 mm², −1.7 mm²); **segments (1518), vias (201), outline, nets, 134 other footprints identical** |
| KiCad DRC `--schematic-parity --severity-all` | 0 errors, 1 accepted warning (`lib_footprint_mismatch` U1), **0 unconnected**, 0 parity |
| ERC | 0 |
| Independent parity | 135/135 refs, **357 pad nets**, same two `{slash}` notes |
| RB-04 audits | connectivity (TP excluded) PASS; power paths identical; electrical/iron-access JSON identical; mask classes 179 / 12 / 10 and V01–V22 unchanged; guard + canary PASS; geometry diff = pad drill 1.4 → 1.9 and In1 area only |
| Manufacturing outputs (scratch) | 10 layers + drill: 1 × 0.30 mm ×201 and 1 × **1.90 mm** at (44.635, −54.790); F.Cu/B.Cu/In1/In2 flash Ø2.3 at the post; F.Mask/B.Mask Ø1.95; B.Cu Ø3.0 pad and mask Ø3.0 unchanged; `rb05_verify` 16/16 PASS; BOM and CPL byte-identical to RB-05 |

## 6. Manufacturing preparation — what to regenerate after R1b is installed

| RB-05 / earlier artefact | Status after R1b |
|---|---|
| `ARTHUR_EMG_RevB_Gerbers.zip` — F.Cu, B.Cu, In1.Cu, In2.Cu, F.Mask, B.Mask Gerbers and the `.drl` | **must be regenerated** (pad aperture, In1 fill, drill table). Silkscreen, paste and Edge.Cuts have no semantic change (timestamps only) |
| BOM CSV, CPL CSV | unchanged (byte-identical) |
| `verification/package_verification.json`, `gerber_vs_kicad_report.json` | regenerate |
| RB-04 audit evidence (`rb04b_suite`, mask/geometry JSON), via/mask inquiry package | re-run (geometry/mask hole entry changes; via list V01–V22 unchanged) |
| JLC inquiry (`REVB_RB04A_JLC_QUESTIONS.md`) | add: PTH Ø1.90 with 0.20 ring; 1.95 mask opening vs ≤ 2.03 finished hole; mask registration figure |
| Quote obtained from the old package | price for fabrication is unaffected in principle (one drill size), but must be re-confirmed on the new files |

**Accidental-use protection (done):** `quote-package/NOT_FOR_PRODUCTION__QUOTE_ONLY.txt` and a banner at the top of `QUOTE_README.md` (also `~/ARTHUR_EMG_RevB_JLC_UPLOAD/NOT_FOR_PRODUCTION__QUOTE_ONLY.txt`); checksum lists refreshed; the Gerber/BOM/CPL files themselves are untouched (same SHA-256). Once R1b is installed the old package should be moved to `archive/` and replaced by a regenerated package — the install script archives the pre-change PCB and footprint to `archive/rb04e_pre_R1b/`.

## 7. Open items

1. **JLC confirmation:** mask registration tolerance; whether CAM keeps a 1.95 mask opening around a 1.90 hole (finished up to 2.03); behaviour of 0.20 mm ring on a 1.9 PTH (inner pads); plus the existing RB-04A mask-via questions.
2. **Physical XIAO:** thickness, BAT0/GND0 pad position relative to the castellations (this sets the ±0.10 term), castellation-to-edge distance, charger resistor, boot states; real post-cone trial (Ø ≤ 1.0 mm gauge, bottom fillet quality) on 3–5 board/module pairs.
3. **Module decision (unchanged from RB-04D):** the BAT pad geometry is shared, so R1b serves **Plain (preferred, $7.49) and Sense (fallback, $13.90, expansion board removed)**; no schematic, routing or enclosure change for either. Verified: CAD compatibility with the Sense v1.5 design file; **unverified**: every retail-module tolerance, thickness and revision for both. Seeed inquiry items 1–13 are in `REVB_RB04C_SEEED_MANUFACTURER_QUESTIONS.md` (**not sent**).

## 8. To install R1b (needs your explicit approval)

```bash
bash hardware/emg/rev-b-xiao/tools/rb04_lock.sh unlock
bash hardware/emg/rev-b-xiao/tools/rb04e_install_R1b.sh hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB --canonical
bash hardware/emg/rev-b-xiao/tools/rb04_lock.sh lock
bash hardware/emg/rev-b-xiao/tools/rb04_run_all.sh /tmp/rb04e_final hardware/emg/rev-b-xiao/evidence/rb04e/installed_suite
```
The script was run only on a scratch copy; it aborts if the pad text does not match exactly.
