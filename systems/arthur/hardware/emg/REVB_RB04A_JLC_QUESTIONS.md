# RB-04A / RB-04B — JLCPCB Manufacturer Clarification Package (D3) — FINAL, READY, NOT SENT

Date: 2026-10-11. **Nothing was sent and JLCPCB was not contacted.** Sending needs your explicit approval (and, for the attachments, a separate approval: Gerbers / BOM / CPL are never attached to this package).
Package: this text + `evidence/rb04a/jlc_inquiry/` (`overview.png`, `V01–V22.png` 4 × 4 mm crops, `via_list.csv` with coordinates and measured distances, `inquiry_text.md`).
The via list and images are unchanged by RB-04A: the TP2 repair adds no via and no mask aperture (201 vias, classes 179 / 12 / 10 / 0).
Board: 4 layers, 51.30 × 64.95 mm, 1.6 mm, JLC04161H-7628, 1 oz outer / 0.5 oz inner, 0.30 mm drill / 0.60 mm pad vias, tented (no via mask apertures in the Gerber), HASL, top-side Economic PCBA.

## 1. What we ask — and how the answer should be written

For **every** numbered question please state which of the three categories each statement belongs to:

* **N — nominal capability** (what the published process can produce in general);
* **C — CAM adjustment** (what your engineers change automatically or manually on this file: mask openings shrunk, pads merged, via openings added or closed);
* **P — confirmed production acceptability** (you will build this exact geometry without a hold, with the stated tolerance, on the Economic service).

"Standard process" or "we will review after upload" is not enough for the open items marked ★.

## 2. Questions

**Q1 — class-3 vias, 10 pieces (V01–V10; coordinates in `via_list.csv`).** The 0.60 mm via annulus overlaps the solder-mask opening of a same-net SMD pad by 0.009–0.049 mm;
the hole edge is 0.101–0.141 mm from the opening (three are within 0.01 mm of your published 0.10 mm mask bridge). The mask Gerber has no aperture for these vias.
(a) ★ Will the via stay fully tented on both sides, or does CAM open/merge it with the pad? (b) ★ What registration tolerance applies to the mask layer? The capabilities page gives none (a secondary source says ±0.05 mm). With that tolerance
is a 0.10 mm web guaranteed? (c) Do you edit the pad aperture in these cases (C), and is the result acceptable (P)?

**Q2 — class-2 vias, 12 pieces (V11–V22).** The annulus is outside the opening but 0.000–0.087 mm from it (mask dam below your "0.09 mm between mask openings and neighbouring traces"). (a) Does that figure apply to via annuli? (b) What does CAM do if it is not met: shrink the opening (by how much), keep the dam, or hold the order? (c) ★ Is the geometry acceptable as drawn (P)?

**Q3 — solder wicking / joint risk.** For the 10 + 12 vias above and the case where the via annulus is exposed through the pad opening (class 3): the via hole is open (tented, not plugged). (a) ★ Do you see a solder-wicking or starved-joint risk through the hole on the reflow (255 ± 5 °C Economic profile)?
(b) Is "tented" a solder-mask cap that holds during reflow for a 0.30 mm hole, and on which side is the cap thinner? (c) What minimum distance from a pad opening do you require for a non-plugged via, and what for a plugged one (your page: ≥ 0.35 mm, ≤ 0.5 mm plug)?

**Q4 — annular ring.** Vias are 0.30 / 0.60 mm: ring 0.150 mm = the "absolute minimum" in your PTH row (recommended 0.20 mm for multilayer 1 oz). ★ Is 0.15 mm acceptable for **vias** on this stack-up without a surcharge, a yield penalty or a CAM change? Is the figure drill-wander-compensated (what registration is assumed)?

**Q5 — C6009 ground via (V04, 25.20 / 49.10 mm).** This is the case with the least slack: GND via 0.262 mm from its own pad copper (C6009.2, 0603 220 nF decoupling of the ADC's CAP pin), annulus overlapping the pad opening by 0.040 mm, hole edge 0.110 mm from the opening, same net, **no via-in-pad**.
It was chosen over a via in the pad (which would need filled-and-capped vias) because of Economic cost and the 1.2 nH estimated penalty of a long tie. (a) ★ Is it manufacturable and soldered reliably as is? (b) Do you require us to move or plug it?

**Q6 — drill size.** Would a **0.25 mm** drill (0.25 / 0.60 mm, ring 0.175 mm, hole web +0.025 mm) improve actual manufacturability for the 22 near-opening vias, and does it change **price, lead time, yield or Economic eligibility**
(aspect ratio 1.6 : 0.25 = 6.4 : 1)? We are *not* proposing to change the whole via population; the answer decides whether a change of only those 22 vias is worth asking for.

**Q7 — default via treatment.** For a 4-layer order whose mask Gerber has no via apertures: is "tented both sides" the default and free? Which order-form option must be set (and is there a surcharge)?

**Q8 — test pads.** Eight bare 1.5 mm B.Cu pads (HASL, no paste, no part); two have a tented via 0.08 mm from their opening (V11, V14). Any concern?

**Q9 — assembly (Economic).** (a) Please confirm the rotation / pin-1 convention of your library for SOT-23 (BAV199 ×16, 2N7002), SOT-23-5 (TPS7A2030), TSSOP-14/-20 (TLV9064, ADS131M04), JST B2B-PH-SM4-TB (vertical, ×5), JST S2B-PH-SM4-TB (side entry), SX3M 3225-4P oscillator.
Community rotation tables for KiCad-to-JLC exports use +180° for SOT-23, +270° for TSSOP/SOIC and +180° for the S-type JST; is that what your viewer needs? (b) Is the 255 ± 5 °C reflow compatible with the JST connectors, the SX3M oscillator and the TPS7A2030?
(c) Which of the 29 BOM lines are Basic / Preferred Extended / Extended in your library today (list in `REVB_RB04A_FINAL_BOM_CANDIDATES.md`; 16 lines did not show a class on their pages), and is there a minimum purchase / attrition quantity for two boards?
(d) *(RB-04B)* Please confirm that C43922 (FH 0603B225K160NT, 2.2 µF 16 V X7R) and C19330 (Murata BLM18AG601SN1D) are in stock for 16 and 2 pcs, and whether C1002 (Sunlord GZ1608D601TF, Basic) and C25804 (Uniroyal 10 k, Basic) are currently stocked.

**Q10 — outline.** Edge.Cuts is a 0.1 mm line: the file shows 51.4 × 65.05 mm; the centre line is 51.30 × 64.95 mm. Which dimension do you price and use for the 2.5 mm body-to-edge note (pads of J101–J501 are 0.5 mm from the edge)?

## 3. Answer sheet (to be filled from JLC's reply)

| Q | N nominal | C CAM adjustment | P production acceptability | Written by / date |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |
| 6 | | | | |
| 7 | | | | |
| 8 | | | | |
| 9 | | | | |
| 10 | | | | |

**JLC ANSWER RECEIVED: NO.**

## 4. What is *already* known from public pages (read 2026-10-11)

Min via hole 0.15 mm / diameter 0.25 mm; multilayer 1 oz PTH ring recommended 0.20 mm, absolute 0.15 mm; mask bridge 0.10 mm; mask expansion 1:1 with ≥ 0.09 mm opening-to-trace; plugged vias ≥ 0.35 mm from other openings and ≤ 0.5 mm; via-in-pad = epoxy-filled and capped;
no published mask registration figure. This design meets the published numbers; the open items are exactly those the pages do not state (registration, tenting default, behaviour of CAM, reflow suitability).

## 5. The 22 unresolved solder-mask via cases (from `via_list.csv`)

| ID | x, y (mm) | Net | Class | Nearest pad | Hole edge → opening (mm) | Annulus → opening (mm, − = overlap) |
|---|---|---|---|---|---|---|
| V01 | 11.1, 53.2 | /CH3_P | 3 | C306.1 | 0.125 | -0.025 |
| V02 | 23.0, 56.4 | DVDD_F | 3 | R7104.1 | 0.125 | -0.025 |
| V03 | 24.1, 54.5 | /DRDY_N | 3 | R6003.2 | 0.1096 | -0.0404 |
| V04 | 25.2, 49.1 | GND | 3 | C6009.2 | 0.1099 | -0.0401 |
| V05 | 26.3, 59.3 | DVDD_F | 3 | C7102.1 | 0.125 | -0.025 |
| V06 | 28.5, 56.7 | DVDD_F | 3 | FB1.2 | 0.125 | -0.025 |
| V07 | 30.3, 55.5 | IAO_Brain_Interface/MOSI_MCU | 3 | U1.11 | 0.1409 | -0.0091 |
| V08 | 31.7, 16.5 | /VCM | 3 | R106.1 | 0.125 | -0.025 |
| V09 | 36.4, 16.5 | /VCM | 3 | R105.1 | 0.125 | -0.025 |
| V10 | 49.4, 58.0 | /SYNC_RESET_N | 3 | U1.3 | 0.1009 | -0.0491 |
| V11 | 7.2, 36.7 | GND | 2 | TP8.1 | 0.2312 | 0.0812 |
| V12 | 11.1, 48.4 | /CH1_N | 2 | C107.1 | 0.1635 | 0.0135 |
| V13 | 11.1, 49.9 | /CH2_N | 2 | C207.1 | 0.1635 | 0.0135 |
| V14 | 13.4, 36.7 | GND | 2 | TP7.1 | 0.2312 | 0.0812 |
| V15 | 14.2, 57.5 | GND | 2 | C406.2 | 0.2373 | 0.0873 |
| V16 | 14.3, 18.7 | GND | 2 | C304.2 | 0.175 | 0.025 |
| V17 | 14.6, 20.1 | /CH3/BUF_N | 2 | U502.7 | 0.2 | 0.05 |
| V18 | 22.4, 60.7 | _Brain_Interface/USB_PRESENT | 2 | R7106.1 | 0.1565 | 0.0065 |
| V19 | 26.8, 54.6 | IAO_Brain_Interface/MOSI_MCU | 2 | R7102.1 | 0.175 | 0.025 |
| V20 | 28.7, 37.8 | nalog_Power_Interlock/AFE_EN | 2 | Q3001.3 | 0.15 | 0.0 |
| V21 | 30.3, 48.2 | IAO_Brain_Interface/SCLK_MCU | 2 | U1.9 | 0.1791 | 0.0291 |
| V22 | 34.5, 39.7 | GND | 2 | R7108.2 | 0.2258 | 0.0758 |

Class 3 = annulus overlaps the pad opening (V01–V10); class 2 = annulus outside the opening but the dam is below 0.09 mm (V11–V22). Images V01–V22.png and overview.png are in `evidence/rb04a/jlc_inquiry/`. RB-04B changed no via, pad, mask or copper.
