# RB-04C — XIAO Mechanical Overlay and Coordinate Comparison

Date: 2026-10-12. Branch `hardware/emg-rev-b`. Canonical PCB `ARTHUR_EMG_RevB.kicad_pcb` (sha256 `111e1cd3d0c9fae1…`, RB-04A TP2 repair, RB-04B BOM; **not** the RB-02/RB-02A placement). Nothing modified, ordered, sent, committed or pushed.
Tools: `tools/rb04c_xiao.py`, `rb04c_overlay.py`, `rb04c_post_stack.py`; data `evidence/rb04c/` (`xiao_geometry.json`, `castellation_comparison.csv`, `post_stack.json`, overlays).

## 0. Basis and its limits (read first)

* **Module geometry is from Seeed's Sense v1.5 KiCad PCB** (`XIAO ESP32S3_V1.5.kicad_pcb`, sha256 `d20724aa…e4af6c`), the file Seeed serves under the *plain v1.4* name. It is a **Sense** design (schematic title "XIAO ESP32-S3-Sense", Rev V1.3, 2026-02-10); it is **not** verified plain-module data. Where this document says "module" it means that CAD.
* Cross-checks that agree: Seeed's DXF (outline 17.785 × 21.14 mm vs PCB 17.780 × 21.135; USB locating holes within 0.03 mm), the secondary OPL PCB (0.000 mm over 42 pads, RB-02A).
* **PCB thickness is unknown** (the KiCad file has only the 1.6 mm default; the wiki gives none; the STEP model is not interpretable). All thickness-dependent items below are ranges.
* The module→board transform is **fitted**, not typed: rotation 180° (USB south), translation by least squares over the 14 castellation pad centres (spread of the fit in y: 0.0000 mm). The host footprint was authored from the same CAD, so zero residuals confirm that the *canonical board still carries the RB-02A geometry*; they do not independently prove the real module.

## 1. Module placement on the board (fitted)

| Item | Board coordinates (mm) |
|---|---|
| Module outline bounding box | x 31.300 … 49.080, y 43.815 … 64.950 (17.780 × 21.135) |
| Board outline | 0 … 51.30, 0 … 64.95 |
| USB end edge | y = 64.950 → **flush with the board's south edge** (inset 0.000; receptacle overhangs 1.508 mm beyond it) |
| East gap module edge → board edge | 2.22 mm (host toe pads end 0.92 mm from the edge) |
| U.FL centre | (45.04, 45.54) |
| BAT+ pad / post hole | (44.635, 54.790) / (44.635, 54.790); offset -0.000, -0.000 |
| BAT− (GND0) pad | (44.635, 56.695); BAT+↔BAT− pitch 1.905, pad gap 0.889 |

## 2. Castellations — coordinate by coordinate

Module (u, v) = from the D0–D6 edge and the USB end edge. Residuals: along the edge (host pad centre − module pad centre) and normal to the edge (vs the designed 0.15 mm inset). Toe = host copper outside the module edge; under = host copper under the module.

| Pin | Module function | Module (u, v) | Module→board (x, y) | Host pad centre (x, y) | Δ along | Δ normal | Toe / under (mm) | Host net |
|---|---|---|---|---|---|---|---|---|
| 1 | D0/A0 | 0.000, 2.921 | 49.080, 62.029 | 48.930, 62.029 | +0.000 | -0.000 | 1.30 / 1.60 | VBAT_SENSE |
| 2 | D1/A1 | 0.000, 5.461 | 49.080, 59.489 | 48.930, 59.489 | +0.000 | -0.000 | 1.30 / 1.60 | DRDY_N |
| 3 | D2/A2 | 0.000, 8.001 | 49.080, 56.949 | 48.930, 56.949 | +0.000 | -0.000 | 1.30 / 1.60 | SYNC_RESET_N |
| 4 | D3/A3 | 0.000, 10.541 | 49.080, 54.409 | 48.930, 54.409 | +0.000 | -0.000 | 1.30 / 1.60 | AFE_EN_REQ |
| 5 | D4/I2C_SDA | 0.000, 13.081 | 49.080, 51.869 | 48.930, 51.869 | +0.000 | -0.000 | 1.30 / 1.60 | unconnected-(U1-D4{slash}GPIO5 |
| 6 | D5/I2C_SCL | 0.000, 15.621 | 49.080, 49.329 | 48.930, 49.329 | +0.000 | -0.000 | 1.30 / 1.60 | unconnected-(U1-D5{slash}GPIO6 |
| 7 | D6/TX | 0.000, 18.161 | 49.080, 46.789 | 48.930, 46.789 | +0.000 | -0.000 | 1.30 / 1.60 | USB_PRESENT |
| 8 | D7/RX | 17.780, 18.161 | 31.300, 46.789 | 31.450, 46.789 | +0.000 | -0.000 | 1.30 / 1.60 | CS_N |
| 9 | D8/A8/SCK | 17.780, 15.621 | 31.300, 49.329 | 31.450, 49.329 | +0.000 | -0.000 | 1.30 / 1.60 | SCLK_MCU |
| 10 | D9/A9/MISO | 17.780, 13.081 | 31.300, 51.869 | 31.450, 51.869 | +0.000 | -0.000 | 1.30 / 1.60 | MISO |
| 11 | D10/A10/MOSI | 17.780, 10.541 | 31.300, 54.409 | 31.450, 54.409 | +0.000 | -0.000 | 1.30 / 1.60 | MOSI_MCU |
| 12 | VCC_3V3 | 17.780, 8.001 | 31.300, 56.949 | 31.450, 56.949 | +0.000 | -0.000 | 1.30 / 1.60 | XIAO_3V3 |
| 13 | GND | 17.780, 5.461 | 31.300, 59.489 | 31.450, 59.489 | +0.000 | -0.000 | 1.30 / 1.60 | GND |
| 14 | VBUS | 17.780, 2.921 | 31.300, 62.029 | 31.450, 62.029 | +0.000 | -0.000 | 1.30 / 1.60 | XIAO_5V |

Result: 14/14 castellations present, 2.540 mm pitch, numbering D0…D6 (pins 1–7, east side) and D7, D8, D9, D10, 3V3, GND, 5V (pins 8–14, west side) match the module function of each pad; host pad 1.50 × 2.90 vs module copper 1.626 wide: copper overlap ≥ 1.56 mm nominal.
Neighbour gaps: host copper 1.04 mm, module copper 0.914 mm.

## 3. Underside: exposed module copper vs host F.Cu

The module's bottom face (toward the host) carries only pads (no components). Distance from each exposed pad to the nearest host F.Cu object of the canonical board (all such host copper is under solder mask; **no mask-open host pad lies under the module**):

| Module feature | Function | Board (x, y) | Size (mm) | Nearest host F.Cu |
|---|---|---|---|---|
| USB_NPTH | hole | 37.31, 60.21 | 0.58×0.58 | none within 2 mm |
| USB_NPTH | hole | 43.06, 60.21 | 0.58×0.58 | none within 2 mm |
| USB_S1 | GND(shell) | 35.87, 63.87 | 1.778×0.889 | none within 2 mm |
| USB_S2 | GND(shell) | 44.51, 63.87 | 1.778×0.889 | none within 2 mm |
| USB_S3 | GND(shell) | 35.87, 59.68 | 1.778×0.889 | 0.61 mm (USB_PRESENT, mask-covered) |
| USB_S4 | GND(shell) | 44.51, 59.68 | 1.778×0.889 | 1.10 mm (VBAT_SENSE, mask-covered) |
| TP4 | MTDO/IO40/CAM_SDA | 38.92, 63.05 | 1.143×1.143 | none within 2 mm |
| GND0 | GND | 44.64, 56.70 | 2.032×1.016 | 0.85 mm (VBAT_SENSE, mask-covered) |
| TP3 | MTDI/IO41/PDM_DATA | 41.46, 63.05 | 1.143×1.143 | none within 2 mm |
| TP5 | MTCK/IO39/CAM_SCL | 38.92, 57.97 | 1.143×1.143 | none within 2 mm |
| TP1 | GND | 38.92, 60.51 | 1.143×1.143 | none within 2 mm |
| TP8 | ESP_USB_D+ | 38.92, 55.43 | 1.143×1.143 | none within 2 mm |
| BAT0 | VBAT | 44.64, 54.79 | 2.032×1.016 | 0.00 mm (VBAT, mask-covered) |
| TP6 | EN | 41.46, 60.51 | 1.143×1.143 | none within 2 mm |
| TP7 | ESP_USB_D- | 41.46, 55.43 | 1.143×1.143 | 1.00 mm (VBAT, mask-covered) |
| TP2 | MTMS/IO42/PDM_CLK | 41.46, 57.97 | 1.143×1.143 | none within 2 mm |
| PAD25_window | GND(pour) | 39.07, 52.41 | 2.75×2.5 | none within 2 mm |

* TP1–TP8, the pad-25 window and the USB shell/NPTH features have **no** host copper within 2 mm; BAT0 sits over its own VBAT track (same net), GND0 0.85 mm from the VBAT_SENSE track.
* The USB shell ovals S3/S4 (GND, through-plated) are 0.61 mm / 1.10 mm from USB_PRESENT / VBAT_SENSE tracks: mask-covered; RB-00.6 §4 required "no tracks, no vias" under the ovals — the canonical routing keeps **0.61 mm**, i.e. the rule is met at ≥ 0.5 mm margin.
* Exposed module copper touches the host only through the 20–50 µm solder mask; a mask defect is the only short path (see BAT− in the audit).

## 4. BAT+ post — worst-case stack

Assumed tolerances (Seeed publishes **none**; JLC figures for the host): finished hole 1.40 +0.13 / −0.08 → **1.32 … 1.53 mm**, hole position ±0.075, module pad registration ±0.10 (assumption), post on pad ±0.25 (procedure), datum 0.022, AWG24 post 0.511.

| Cone Ø (mm) | Radial margin when centred (R_hole,min − r_cone) | Centring shift needed, linear worst case | RSS |
|---|---|---|---|
| 0.8 | 0.260 | 0.187 | 0.020 |
| **1.0 (procedure target)** | 0.160 | **0.287** | 0.120 |
| 1.1 (procedure limit) | 0.110 | 0.337 | 0.170 |
| 1.2 | 0.060 | 0.387 | 0.220 |

Total post-axis-to-hole-centre error, linear worst case **0.447 mm** (RSS 0.280). With a Ø1.0 cone the module must be hand-shifted up to **0.29 mm** so the cone enters the hole.
Available shift before the castellation rules break: along the edge ≤ 0.51 mm (copper overlap ≥ 1.0), normal to the edge ≤ **0.20 mm for the specified ≥ 1.0 mm toe**, ≤ 0.45 mm if a 0.75 mm toe is accepted.
→ **A nominal PASS is not a guarantee**: at worst case the cone fits only if the assembler accepts a toe of 0.91 mm on one side and 1.69 mm on the other (feasible, outside the 1.0 mm rule). Ø1.1 needs 0.34 mm (toe 0.86), Ø1.2 needs 0.39 mm (0.81).

BAT−: cone edge to the GND0 pad edge ≥ 0.59 mm (cone Ø1.1, post at the pad's limit toward GND0). Host VBAT ring (Ø1.90, mask-covered, opening Ø1.45) to the GND0 pad edge: 0.447 mm nominal, **−0.003 mm at a 0.45 mm module shift**
(GND0 would sit over the mask-covered ring; mask opening still 0.22 mm away) → insulated by solder mask only in the worst case.

Castellations at module shifts of 0 / 0.2 / 0.45 / 0.6 mm: copper overlap along the edge 1.56 / 1.36 / 1.11 / 0.96 mm; toe 1.2–1.4 / 1.0–1.6 / 0.75–1.85 / 0.6–2.0 mm; neighbour copper gap 0.98 / 0.78 / 0.53 / 0.38 mm.
USB end position relative to the board edge: ±0.3 mm (assumed placement ±0.2, outline ±0.1 per side).

## 5. Neighbours, USB-C, U.FL, iron access

* Host courtyards within 4 mm of the module outline: R7108 1.04 mm (north-west corner), R3006 2.62, C7101/C7102/FB1/R3009/R7101 2.82, R7107 2.84, R7102 2.92 (north or north-west of the module, beyond the 1.5 mm toe band). No part overlaps the module outline.
* Iron access (RB-03S model, re-run on RB-04B board, unchanged): 45° and 60°: all 14 toes clear (worst margin +0.57 mm); 30°: toes 12 and 13 short by 0.13 mm (FB1 / C7101 at 1.52 mm). The ferrite changed to a Murata BLM18AG601SN1D (0603, 0.95 mm in the model) — same height class.
* **USB-C:** 9.0 mm receptacle centred on the module axis (x = 40.19), face at y = 66.46, i.e. 1.51 mm beyond the board edge; the enclosure cutout must absorb the ±0.3 mm placement range.
* **U.FL:** (45.04, 45.54), 1.84 mm south of the nearest host part (J1, pads at y 34.95–41.65), 4.8 mm from the east board edge. J1's plug opens toward +x at y ≈ 38; the U.FL cable also leaves east → corridors are parallel, ~7 mm apart. The antenna cable bend radius and the plug height (≈ 2 mm) are not CAD-verified.

## 6. Overlays

* Bottom (module underside over host F.Cu): [overlay_bottom.png](rev-b-xiao/evidence/rb04c/overlay_bottom.png) (SVG alongside).
* Top (module top parts, USB-C, U.FL, host courtyards): [overlay_top.png](rev-b-xiao/evidence/rb04c/overlay_top.png).
Colours: blue = module outline / host U1 pads, cyan = module castellation copper, orange = module exposed pads, red = host F.Cu, green = module top-side courtyards, grey dashed = host courtyards.

## 7. What cannot be established from CAD

PCB thickness; module outline / pad tolerances; real hole-position tolerance of JLC on this order; solder-cone size actually achieved; that the retail plain module has this geometry. See `REVB_RB04C_XIAO_COMPATIBILITY_AUDIT.md` §7 for the single-module measurement list.
