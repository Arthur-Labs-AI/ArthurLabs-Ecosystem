# RB-04C — Seeed Studio Manufacturer Inquiry (prepared, NOT SENT)

Date: 2026-10-12. **Seeed was not contacted and nothing was sent.** Sending requires your explicit approval. Attach nothing confidential: the inquiry refers only to Seeed's own public files and one footprint dimension.

## Context to state

We intend to buy retail **Seeed Studio XIAO ESP32-S3 (plain), PN 202003751, headers unsoldered**, and hand-solder it on its 14 castellations plus one post through the BAT+ pad onto our own PCB.
The files Seeed publishes as "XIAO ESP32S3 v1.4 SCH & PCB" for PN 202003751 are byte-identical (SHA-256 `a82247725c8a8bcd8cac81a7acbd126396217e5b680f6dfe28958851e02d5cdb`, 836,170 bytes) to the "XIAO ESP32S3 Sense v1.5 SCH & PCB" archive for PN 202003753; the schematic title block reads "XIAO ESP32-S3-Sense", Rev V1.3 (2026-02-10).
The wiki lists a different charge current for plain (50 mA) and Sense (100 mA), while the file's charger resistor R10 = 220 kΩ gives 110 mA.

## Questions (a written answer to each is requested)

1. **Revision.** Which PCB / hardware revision is shipped today under PN 202003751 (marking on the board, date-code position), and since when? Is "v1.4" the plain-module PCB revision?
2. **Geometry identity.** Is the plain module's PCB geometry — outline 17.78 × 21.135 mm, 14 castellation pads (2.54 pitch, 1.626 mm copper width), the BAT0 and GND0 bottom pads (2.032 × 1.016 mm at 4.445 mm from the D0–D6 edge, 10.160 / 8.255 mm from the USB end), USB-C and U.FL positions, the eight bottom test pads, the pad-25 window and the USB shell ovals — **identical** to the Sense v1.5 file? Which of those differ, if any?
3. **Thickness.** Finished PCB thickness and tolerance, number of copper layers and surface finish of the plain module.
4. **Tolerances.** Outline tolerance, castellation / bottom-pad position tolerance relative to the outline, and drill/castellation tolerances; is there a manufacturing drawing (not the DXF "dimensioning" artwork) for PN 202003751?
5. **Plain-module BOM differences.** Please list components that differ from the Sense v1.5 schematic in the main-board power section: charger resistor R10 (charge current), U3 regulator output current limit, Q1/D2 power-path parts.
6. **Power behaviour.** (a) Is the 5V pad connected to VBUS before the Schottky (D2), so that it is 0 V on battery and never sourced by the module? (b) Maximum current from the 3V3 pad; (c) charge termination voltage and whether the charger is enabled whenever VBUS is present with a cell on BAT+.
7. **Boot states.** Default state/pull of D0–D10 during reset and boot; any series resistors or pulls on D2 (GPIO3), D6/D7 (GPIO43/44).
8. **Solderability.** Any guidance or restriction for hand-soldering castellations and for soldering a Ø0.5 mm post to the BAT0 pad (pad finish: ENIG/HASL? maximum iron temperature/time).
9. **Documentation.** Will Seeed publish the PN 202003751 PCB/schematic separately from the Sense archive? A STEP model that is the plain module (the current "plain" STEP is named "Seeed Studio XIAO-ESP32-S3 (Sense)").

## Our assumptions that the answers should confirm or correct

| Quantity | Value used (Sense v1.5 CAD) |
|---|---|
| PCB thickness | unknown (swept 0.8–1.6 mm) |
| BAT+ pad | 2.032 × 1.016 mm, finish unknown |
| Outline / pad tolerance | assumed ±0.20 / ±0.10 mm (no published value) |
| Charger | SGM40567-4.2, IREF 220 kΩ → 110 mA (Sense) |
| 5V pad | VBUS before the Schottky |

## RB-04E addendum (2026-10-12) — items that decide the BAT+ post tolerance stack (still NOT SENT)

10. **BAT0 / GND0 bottom pads:** position tolerance relative to the castellation copper (same copper layer; ± mm), pad size tolerance, copper finish and thickness, and whether the solder-mask opening equals the pad (NSMD).
11. **Castellation copper:** nominal and tolerance of the outline-to-half-hole distance (our toe budget is 1.30 mm − module outline − host pad tolerance).
12. **Board thickness** of PN 202003751 at the BAT pads (single value ± tolerance) and coplanarity/warpage limit (a 1.7–1.9 mm host hole is planned; the module must sit flat on the host mask).
13. **Revision / lot:** which of v1.0 … v1.5 PCB revisions are currently in the retail channel for PN 202003751 and how to identify them without opening the package (silk marking, date code position).
