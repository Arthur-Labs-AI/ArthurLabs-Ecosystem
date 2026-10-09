# A.R.T.H.U.R EMG Rev B — XIAO ESP32-S3 Hand-Solderable Mounting Specification (RB-00.6)

Dimensional source of truth:
- Seeed official `XIAO-ESP32-S3-SMD` footprint (`New_XIAO_Series_Footprints.zip`)
- Seeed's module PCB (served as the Sense v1.5 KiCad project), cross-checked in RB-00.5 to within 0.03 mm

The official footprint is a *reflow* footprint: 0.54 mm toe, 0.54 mm pad gaps, paste and pads on all 25 bottom features. **It is not used as-is.** Rev B defines a new footprint, `ARTHUR:XIAO_ESP32S3_HANDSOLDER`, whose copper is specified below.

Coordinates:
- **Board frame** = the Rev B board (origin north-west, +x east, +y south, mm), with the XIAO rotated 180°.
- **Module frame** = Seeed footprint frame (origin at the module's far-end corner on the D0–D6 side, USB toward −y).
- Transform: board x = 72.78 − x_mod, board y = 32.00 − (21.02 − |y_mod|).

## 1. Module facts used

| Item | Value | Source |
|---|---|---|
| Module outline | 17.78 × 21.02 mm (PCB outline 21.14 incl. tolerance) | Seeed footprint courtyard / module Edge.Cuts |
| Castellation pitch / rows | 2.54 mm, 7 per long side | Official footprint |
| Castellation copper on module | Half-hole Ø≈1.0 at the edge + pad 1.626 × 1.325, from 0.2 mm outside to 1.43 mm inside the edge; plated header hole Ø1.4 ring centred 1.17 mm inside | Module PCB (U9 pads) |
| BAT+ pad (BAT0) | 2.032 × 1.016, module (4.445, −10.882) | Module PCB, net VBAT |
| BAT− pad (GND0) | 2.032 × 1.016, module (4.445, −12.787) | Module PCB, net GND |
| Other exposed bottom pads | 15–22 (Ø1.143 on module, Ø1.7 in the Seeed footprint): MTDI, MTDO, EN, GND, MTMS, MTCK, USB D−, USB D+; 25: 2.75 × 2.5 GND window | RB-00.5 table |
| USB-C | 9.0 wide, overhangs the module end by 1.51 | Module PCB |
| U.FL | Top side, module (4.07, −1.64) | Module PCB |
| XIAO PCB thickness | **To be measured** (checklist item M4). Seeed's KiCad file only carries the default 1.6 | — |

## 2. Castellation pads (14×)

| Parameter | Value | Rationale |
|---|---|---|
| Pad width (along the edge) | **1.50 mm** | Covers the 1.325 mm module pad with ±0.09 mm; leaves a 1.04 mm gap at 2.54 mm pitch (the official footprint leaves 0.54 mm, which bridges under an iron) |
| Pad length (normal to the edge) | **2.90 mm** | = toe + inner |
| Toe (exposed, outside the XIAO edge) | **1.30 mm nominal** | Iron and solder access. With module width ±0.10 and hand placement ±0.20, the **visible toe is 1.0–1.5 mm** |
| Inner length (under the XIAO) | **1.60 mm** | Covers the module castellation pad (to 1.43 mm) so the fillet wets underneath. Stays ≥ 1.5 mm from all bottom features (BAT pads start 3.2 mm in) |
| Corners | Rounded, r = 0.15 | — |
| Solder mask | NSMD, opening = pad + 0.05 mm/side (1.60 × 3.00). Mask web between pads 0.94 mm | JLC min web ≈ 0.1 mm |
| Paste | **None** (F.Paste removed). The XIAO is DNP; no stencil bumps under the module | Module must sit flat |
| Finish | HASL lead-free (pre-tinned pads help hand soldering); ENIG acceptable | — |
| Connection | Via a short trace from the pad's **toe or side**, never a via in the pad. Pin 13 GND: ≥ 3 tented vias ≥ 0.5 mm west of its toe end (natural thermal relief). 3V3/5V: same style, 2 vias | Zero via-in-pad rule; iron-friendly heat |
| Required fillet | Wets **≥ 1.0 mm** of toe, concave; climbs the castellation wall to **≥ 50 % of XIAO PCB thickness**; no bridge; no solder ball > 0.2 mm | IPC-A-610 class-2-style acceptance for castellated terminations |

Pad centres (board frame):
- **West side** (x 53.70–56.60; module edge x = 55.00): pins 8–14 = D7, D8, D9, D10, 3V3, GND, 5V, at y = 13.86, 16.40, 18.94, 21.48, 24.02, 26.56, 29.10.
- **East side** (x 71.18–74.08; module edge x = 72.78): pins 7–1 = D6, D5, D4, D3, D2, D1, D0, at the same y values.

**Module-body clearance and iron access:**

| Band (measured from the toe pad ends) | Allowed |
|---|---|
| West 0–1.5 mm (x 52.2–53.7) | No components (tented vias only) |
| West 1.5–4.0 mm (x 49.7–52.2) | Components ≤ 1.2 mm tall only (0402/0603 passives, SOT-23 2N7002 1.1 mm, 0603 10 µF ≤ 0.9 mm) |
| West beyond 4.0 mm | Anything |
| East | Board edge 0.92 mm beyond the toe ends. No components; copper-to-edge 0.92 mm ≥ 0.5 mm rule |
| North/south module ends | No castellations. ≥ 1.0 mm component clearance north; USB end flush with the board edge (0…+0.2 mm inside) |

- With these bands, a 1.6–2.4 mm chisel tip approaching at 30–45° clears every neighbour.
- A courtyard for the new footprint: module frame x −1.30…19.08 + 1.5 mm, y −22.53 (USB) … +1.0.

## 3. BAT+ connection: soldered post through a plated hole

This is an engineered *post*, not a flying wire. A post needs no route under the module, no bend, no insulation, and puts no load on the pad.

| Parameter | Value |
|---|---|
| Post material | **Solid tinned copper, AWG 24 (Ø0.51 mm)**. A 0.5–0.6 mm component lead is an acceptable substitute. **Never stranded wire** (it splays and wicks) |
| Insulation | **None.** Between the XIAO and the board the gap is ≤ 0.1 mm, so there is no exposed length. Inside the hole the barrel is the same net (VBAT) |
| Rating | Peak ≤ 0.35 A, average ≤ 0.15 A → < 1 % of the AWG 24 capacity. Loop resistance (post + joints) < 5 mΩ |
| Cut length before mounting | 6 mm; trimmed to ≈ 1.0 mm below the board after soldering |
| Joint on the XIAO BAT+ pad | Post perpendicular (±10°), centred on the pad. Solder cone **Ø ≤ 1.1 mm, height ≤ 0.5 mm**. Solder film elsewhere on the pad ≤ 0.05 mm. **No solder may reach GND0** (1.905 mm pitch, 0.89 mm pad-to-pad gap) |
| Board hole | **Plated through, drill Ø1.40** (finished ≈ Ø1.30) at board **(68.335, 21.862)**, exactly under the module BAT+ pad centre |
| Clearance / function | Radial slop ≈ 0.40 mm around the post. The post is the **locating pin** for the XIAO; castellations fine-align it |
| Top annular ring | Ø1.90, **covered by solder mask** except the hole (mask opening Ø1.45). Ring edge is 0.45 mm from the module GND0 pad edge; mask insulates it |
| Bottom pad ("large accessible VBAT pad") | **Ø3.00 on B.Cu**, exposed, thermal relief 4 × 0.5 mm spokes to a ≥ 1.0 mm VBAT trace/pour back to J_BAT+ (via In2/B.Cu). No B.Cu copper of other nets within 0.5 mm |
| Exit direction | Straight down through the board. **Minimum bend radius: n/a**; the post must never be bent at the pad joint (straighten before insertion) |
| Strain relief | Mechanical load goes into the 14 castellation fillets and the hole wall. The pad joint sees none. **Adhesive not required.** Optional after electrical verification: one small drop of neutral-cure (oxime-free, electronics-grade) silicone on the *underside* joint only; never under the module |
| Clearance from XIAO underside features | The XIAO bottom has no components, only pads. The post is 1.9 mm from GND0 (mask-insulated), ≥ 3.5 mm from pads 15–22 and pad 25, and nowhere near the U.FL (module top, north-east corner) |
| Via rule | This hole is the **only** plated hole inside the module outline apart from the tented via field |

**BAT−:** castellation **pin 13 (GND)** through the board plane. Justification is in the architecture doc §5. **No post on GND0**: a second hole at 1.905 mm pitch would leave < 0.5 mm copper spacing, and pin 13 is electrically sufficient.

## 4. Under-module copper rules

| Region (board frame) | Rule |
|---|---|
| XIAO exposed pads 15–22: x 61.27–66.51, y 21.14–31.46 | **F.Cu copper keep-out**, no vias. Mask over bare laminate (an EN or USB short to GND is impossible even if the mask is scratched) |
| Pad 25 window: x 61.40–64.15, y 18.23–20.73 (+0.5 margin) | F.Cu keep-out, no vias |
| GND0: x 67.32–69.35, y 23.26–24.28 (+0.5) | F.Cu keep-out |
| Via field: x 57.6–70.2, y 12.0–17.2 | Tented vias allowed (≥ 1.0 mm from any module exposed pad and host pad) |
| East channel: x 69.65–70.95, y 9.0–29.9 | F.Cu routing for D0–D3 (and D6 at the north end); 0.15/0.15 mm |
| Rest of the module footprint | F.Cu GND pour under solder mask allowed; In1 solid GND everywhere; In2 may route Zone-D signals |

## 5. Surrounding placements (fixed by this spec)

| Item | Placement |
|---|---|
| J_BAT (JST-PH 2p SMD, side entry, e.g. S2B-PH-SM4-TB) | North strip, envelope ≈ x 57.5–66.0, y 0.6–7.0, mating face on the north edge. **Final pads from the JST drawing in RB-02** |
| R_PRE, C_PRE, C_BAT 22 µF | North strip between J_BAT and U4002 |
| U4002 + inhibit cluster (Q3001, R_VG_S, R3004, R_EN_S, R_EN_PD) | North Zone B/C (y < 12.5), within 3 mm of the EN pin |
| R_VBUSLD 4.7 k | At pin 14 (x 49.7–52.2 band, y ≈ 29) |
| SPI 33 Ω (SCLK, MOSI), CS/SYNC pull-ups, FB1 + 10 µF (0603) + 100 nF | x 49.7–52.2 band beside pins 8–12 |
| X1 | Zone B east edge, ≤ 5 mm from U6001 pin 17 (1.2 mm tall → x ≤ 49.7) |
| Antenna cable | From the U.FL at (68.71, 12.62) → east over the board edge |

## 6. What this changes vs RB-00.5

| RB-00.5 | RB-00.6 |
|---|---|
| Official 25-pad footprint, all pads soldered (hot plate) | New 14-pad hand-solder footprint + 1 BAT+ post hole; bottom pads 15–25 and GND0 **not soldered** |
| Orientation −90° (USB east) | **180° (USB south, east end)** |
| Courtyard/anchor edits to the Seeed footprint | Superseded by the new footprint (origin at body centre, rotation 0° = USB toward −y in the module frame) |
