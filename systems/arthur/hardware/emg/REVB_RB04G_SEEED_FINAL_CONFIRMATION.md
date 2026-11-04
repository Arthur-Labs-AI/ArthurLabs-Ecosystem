# RB-04G — Seeed Studio Confirmation Request: Plain Module Revision and Bottom-Pad Geometry (prepared, **NOT SENT**)

Date: 2026-10-12. **Seeed was not contacted.** Requires your explicit approval to send.

## Context

We will hand-solder **Seeed Studio XIAO ESP32-S3 (plain), PN 202003751 / SKU 113991114, unsoldered headers** on 14 castellations plus one Ø0.51 mm post through the BAT+ pad. Our host PCB is **already designed** around the module PCB geometry in Seeed's file `XIAO ESP32S3_V1.5.kicad_pcb` (SHA-256 `d20724aa7198a897871cc1ce87f1a322d0b9cf77521fd2fc4ccda61bc5e4af6c`),
which Seeed publishes in the archive named "XIAO ESP32S3 **v1.4** SCH & PCB" for PN 202003751 (SHA-256 `a82247725c8a8bcd8cac81a7acbd126396217e5b680f6dfe28958851e02d5cdb`, 836,170 bytes). That archive is byte-identical to the "Sense v1.5" archive for PN 202003753; the schematic title block reads "XIAO ESP32-S3-Sense", Rev V1.3 (2026-02-10).
The wiki gives a charge current of 50 mA for plain and 100 mA for Sense, while the supplied schematic sets 110 mA (R10 = 220 kΩ).

## The numbers our board depends on (module frame: u from the D0–D6 edge, v from the USB-C end; all from the file above)

| Feature | Value we use | Tolerance we assume (Seeed publishes none) |
|---|---|---|
| Outline | 17.780 × 21.135 mm, R1.905 corners | ±0.20 mm |
| Castellation pads | 14, pitch 2.540 mm, centres 2.921 … 18.161 mm from the USB end (D0 and 5V at 2.921 mm), copper 1.626 mm wide | position ±0.10 mm relative to the outline |
| BAT+ (BAT0) pad | 2.032 × 1.016 mm, centre u = 4.445, v = 10.160 | ±0.10 mm relative to the castellation copper |
| BAT− (GND0) pad | 2.032 × 1.016 mm, centre u = 4.445, v = 8.255 | ±0.05 mm |
| USB-C | 9.0 mm wide, centred (u = 8.89), overhang 1.508 mm | — |
| U.FL | centre u = 4.039, v = 19.406 | — |
| Bottom exposed copper | TP1–TP8 Ø1.143, pad-25 window, 4 GND shell ovals, 2 NPTH Ø0.58 | — |
| PCB thickness | **unknown** (file default 1.6 mm) | swept 0.8–1.6 mm |

## Questions (a written answer to each, please)

1. **Revision.** Which PCB / hardware revision is shipped today under PN 202003751 (marking, date-code position)? Which revisions are in the channel at the same time?
2. **Geometry identity ★.** Is the plain module's PCB — outline, castellation pads, BAT0/GND0 pads, USB-C, U.FL, bottom pads — **identical** to the file above? Please list every difference, however small.
3. **Bottom-pad geometry.** For BAT0 and GND0: nominal size and position, position tolerance relative to the castellation copper and to the outline, copper finish and thickness, whether the pad is NSMD (mask opening = pad) and the mask-to-pad clearance.
4. **Thickness.** Finished PCB thickness at the BAT pads ± tolerance; flatness/warpage limit; layer count.
5. **Outline and castellations.** Outline tolerance; distance from the outline to the castellation half-hole centres ± tolerance.
6. **Electrical differences.** Components that differ from the Sense v1.5 schematic in the main board (charger resistor R10 / charge current, regulator current limit, Q1/D2 path). Confirm that the 5V pad is VBUS before the Schottky D2 (0 V on battery power) and that the charger is enabled whenever VBUS is present with a cell on BAT+.
7. **Boot states.** Default pull/state of D0–D10 during reset and boot; any resistor on D2 (GPIO3), D6/D7 (GPIO43/44).
8. **Soldering.** Guidance for hand-soldering the castellations and a Ø0.5 mm post to BAT0 (finish, iron temperature, time limits).
9. **Documentation.** Will a plain-specific PCB/schematic/STEP be published?

## What each answer changes

| Answer | Effect on Rev B |
|---|---|
| Q2 identical | none (Option C: plain) |
| Q2 differs in BAT pad or castellation position > 0.1 mm | re-run the post stack (RB-04F); possible footprint change |
| Q4 thickness | fillet-height rule (≥ 50 % of thickness), enclosure stack |
| Q6 charge current | cell selection (0.5 C ≥ ~0.1–0.25 Ah) |
| Q7 | firmware / pull-up review of D2, D6, D7 |

## Which can be answered without Seeed

None of 1–5 can be settled from public documents (the plain files are Sense files). Q6/Q7 partially (wiki, schematic) but not for the plain BOM. A physical module answers 1–5 (caliper, micrometer, microscope, bench supply); Seeed's written answer is needed for revision traceability.
