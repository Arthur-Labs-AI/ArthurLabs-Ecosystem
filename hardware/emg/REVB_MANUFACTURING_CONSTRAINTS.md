# A.R.T.H.U.R EMG Rev B — Manufacturing Constraints, Netclasses & Routing Rules (RB-00)

These rules are defined **from scratch**. None of the Rev A `.kicad_pro` netclasses or `.kicad_dru` rules are inherited. Rev A's rules reference ADS1294-era nets that no longer exist, and its analog rules match no live net (see Architecture §7).

## 1. Fabrication target

| Item | Rev B requirement |
|---|---|
| Fab / assembly | JLCPCB, **Economic PCBA** |
| Stackup | 4-layer, 1.6 mm FR-4 (JLC standard stackup, e.g. JLC04161H-7628, confirm at quote), 1 oz outer / 0.5 oz inner |
| Layers | L1 F.Cu signal + GND fill; **L2 In1 solid GND, no routing**; L3 In2 GND (Zones A/B) + power pours (Zones C/D); L4 B.Cu short signal escapes, GND fill, bare test pads |
| Vias | Standard through vias only: **0.3 mm drill / 0.6 mm pad** (0.45 mm pad minimum allowed only in Zone C/D fan-out). No blind/buried, no microvia, no HDI, **no via-in-pad, no POFV** |
| Track / space | 0.15 / 0.15 mm minimum anywhere. JLC 4L capability is 0.09/0.09 mm; we stay ≥ 1.6× above it |
| Copper to edge | ≥ 0.5 mm (≥ 0.3 mm allowed only for castellation-adjacent XIAO pads, per the Seeed footprint) |
| Finish | HASL lead-free acceptable. ENIG optional (flatter for TSSOP 0.65 mm; cost trade-off at quote) |
| Solder mask | Green (cheapest), LPI, mask web between 0.65 mm pads (JLC min web ≈ 0.1 mm OK) |
| Board thickness tolerance | Standard |
| Castellated holes on *our* board | **None**. The XIAO is the castellated part; our board has plain SMD pads |

## 2. Assembly target

| Item | Requirement |
|---|---|
| Sides | **Single-side (top) SMT only**. B.Cu carries only bare test pads (no components) |
| THT | **None** on the EMG board |
| Smallest package | 0603 passives, SOT-23, TSSOP-14/20 0.65 mm. **No 0402, no QFN, no BGA** |
| Parts library | Prefer JLC *Basic* parts for all passives. Target **≤ 7 extended lines**: ADS131M04, TLV9064, TPS7A2030P, X1 **C7425393**, BAV199 (now 16 pcs, still one line), JST-PH, [2N7002 if not basic]. The XIAO is not a JLC line (DNP) |
| Fiducials | 3 global fiducials (1 mm Cu, 2 mm mask opening) on F.Cu |
| Tooling | JLC adds rails if needed; keep ≥ 3 mm component-free along the long edges except the connectors, or accept JLC edge rails |
| USB | None on our board. **No manual USB connector process** |

### 2.1 XIAO mounting (RB-00.6, frozen)

**Hand-soldered after JLC PCBA.** The XIAO is DNP and excluded from the JLC BOM/CPL. Full geometry: [REVB_XIAO_MOUNTING_SPEC.md](REVB_XIAO_MOUNTING_SPEC.md). Procedure: [REVB_XIAO_ASSEMBLY_PROCEDURE.md](REVB_XIAO_ASSEMBLY_PROCEDURE.md).

- **Footprint:** `ARTHUR:XIAO_ESP32S3_HANDSOLDER`, 14 castellation pads.
  - 1.50 × 2.90 mm, of which 1.30 mm is toe outside the module edge and 1.60 mm is under it.
  - Pitch 2.54, 1.04 mm gaps.
  - NSMD mask +0.05 mm; **no paste**.
- **BAT+:** AWG 24 solid post soldered to the XIAO BAT+ pad before mounting, dropped into a **plated Ø1.40 hole** at board (68.335, 21.862), soldered to a Ø3.00 B.Cu pad from the underside.
- **BAT−:** castellation pin 13 → plane.
- **Not soldered:** the XIAO bottom pads 15–25 and GND0. **F.Cu keep-out and no vias** under them.
- **Hand-solder access bands:** no parts within 1.5 mm of the west toe ends; parts ≤ 1.2 mm tall within 1.5–4.0 mm; the east toes end 0.92 mm from the board edge.
- **The module USB end is flush with the south board edge** (0…+0.2 mm inside).
- **Tools:** iron, flux, 0.5 mm solder, wick, tweezers, multimeter. **No hot plate, no hot air, no reflow.**

**Rejected:** JLC placement (C9900124959: 0 stock, MOQ 445, consign-only); the reflowed official 25-pad footprint (needs a hot plate).

## 3. Netclasses (new)

| Netclass | Nets | Width | Clearance | Via | Layer rule |
|---|---|---|---|---|---|
| `EMG_ELECTRODE` | J1x1.1/.2 … J4x1 → series 10 k | 0.25 | 0.30 | **none allowed** | F.Cu only |
| `EMG_HIZ` | hi-Z nodes: 10 k/BAV199/100 pF/10 M/follower +IN (`Net-(Dx0x-COM)`) | 0.20 | **0.40** to non-GND | **none allowed** | F.Cu only, GND guard pour both sides, ≥ 2 mm from `SPI_*`/`CLK` on any layer |
| `EMG_BUF` | follower out → 2.2 µF → 100 k → 1 k → `CHx_P/N` | 0.20 | 0.20 | ≤ 1 per net, outside pads | F.Cu preferred. P/N legs length-matched ±0.5 mm. Symmetric placement |
| `ANALOG_REF` | VCM, VCM_DIV (U503 +IN), RLD_SAFE | 0.20 | 0.25 | allowed, outside pads | L1/L4 only |
| `ADC_CAP` | AFE_CAP (pin 18) | 0.25 | 0.20 | **none** | F.Cu, ≤ 2 mm |
| `PWR_AFE` | AFE_3V0 | 0.30 | 0.20 | ≥ 2 per transition | any |
| `PWR_VBAT` | VBAT, VBAT_AFE | 0.50 (VBAT), 0.30 (VBAT_AFE) | 0.20 | ≥ 2 per transition | Zones C/D only |
| `PWR_DVDD` | 3V3 (XIAO), DVDD_F | 0.30 | 0.20 | ≥ 2 | Zones B/C/D |
| `SPI_FAST` | SCLK, MOSI, MISO, CLKIN | 0.20 | 0.20 | ≤ 2 per net | Over solid In1 GND; **≥ 2.0 mm from `EMG_HIZ`, ≥ 1.0 mm from `EMG_BUF`**; length ≤ 25 mm; CLKIN ≤ 6 mm |
| `CTRL_SLOW` | CS_N, DRDY_N, SYNC/RESET_N, AFE_EN_REQ, AFE_EN, USB_PRESENT, VBAT_SENSE, VBUS_GATE, SDA, SCL | 0.20 | 0.20 | allowed | Zones B/C/D only |
| `VBUS_SENSE` | XIAO 5V pin net | 0.25 | **0.30** | allowed | Zone C/D only (5 V present) |
| `GND` | GND | 0.30 min; pours | 0.20 | stitching ≤ 3 mm pitch at boundaries | — |
| `Default` | — | 0.20 | 0.20 | — | **Must be empty at RB-03 DRC**. Every net is explicitly classed; no net may fall back to Default |

### 3.1 Custom rules (to author in the Rev B `.kicad_dru` at RB-02)

```
(version 1)
(rule "hiz_outer_only"      (constraint track (layer outer))           (condition "A.NetClass == 'EMG_HIZ' || A.NetClass == 'EMG_ELECTRODE'"))
(rule "hiz_no_vias"         (constraint via_count (max 0))            (condition "A.NetClass == 'EMG_HIZ' || A.NetClass == 'EMG_ELECTRODE' || A.NetClass == 'ADC_CAP'"))
(rule "spi_to_hiz"          (constraint clearance (min 2.0mm))        (condition "A.NetClass == 'SPI_FAST' && B.NetClass == 'EMG_HIZ'"))
(rule "spi_to_buf"          (constraint clearance (min 1.0mm))        (condition "A.NetClass == 'SPI_FAST' && B.NetClass == 'EMG_BUF'"))
(rule "hiz_leakage"         (constraint clearance (min 0.4mm))        (condition "A.NetClass == 'EMG_HIZ' && B.NetClass != 'GND' && B.NetClass != 'EMG_HIZ'"))
(rule "no_via_in_pad"       (constraint hole_clearance (min 0.15mm))  (condition "A.Type == 'Via' && B.Type == 'Pad' && B.Pad_Type == 'SMD'"))
(rule "zone_a_no_digital"   (constraint disallow track via)           (condition "(A.NetClass == 'SPI_FAST' || A.NetClass == 'CTRL_SLOW') && A.intersectsArea('ZONE_A')"))
```

Every rule must be **proven to fire** in RB-02 by seeding a deliberate violation on a scratch copy. Rev A's `analog_L1_only` was inert because no net matched its condition.

**KiCad `hole_clearance` may not flag same-net via/pad overlap.** The `no_via_in_pad` gate is therefore also enforced by the **scripted via-vs-SMD-pad overlap check** (the same geometry test used in RB-00 to count Rev A's 72 overlaps). It is mandatory at every routing checkpoint and must report **0**.

## 4. Via-in-pad policy

**VIA-IN-PAD ALLOWED: NO.** Every SMD pad connects to its via through a dog-bone trace (≥ 0.25 mm from pad edge to via annulus). This applies to every pad, including thermal/GND pads.

Rev A evidence, reproduced in RB-00 by script on the frozen PCB:
- 72 vias overlap SMD pads.
- 10 of them are on U4001/C4001–C4004, which are removed in Rev B.
- **62 are in the analog/ADC area**, including 5 on U6001 pins, 3 on U502, and 2 each on C6007, C107, C207, C307, C406 and C407.

Rev B removes these **structurally**:
- It re-places and re-routes the analog block on a new outline.
- The `EMG_HIZ`/`EMG_ELECTRODE`/`ADC_CAP` classes forbid vias entirely.
- Decoupling-cap GND returns use a separate via beside the pad.

## 5. Placement constraints

1. Zone order (west → east): A analog | B ADC | C boundary | D XIAO. No stacking.
2. All five electrode connectors on the Zone A board edge. Their mating direction and cable exit are away from the XIAO and antenna.
3. U6001: analog pins facing Zone A, digital pins facing Zone C. AVDD/DVDD/CAP caps ≤ 1.5 mm from the pins, on F.Cu, with no via between cap and pin.
4. X1 ≤ 5 mm from U6001 pin 17, on the Zone C side of U6001, never between U6001 and U501/U502.
5. U4002 + C4005/C4006 in the north of Zone B/C, with the inhibit cluster (Q3001, R_VG_S, R3004, R_EN_S, R_EN_PD) within 3 mm of its EN pin. R_PRE/C_PRE sit between J_BAT and U4002 in the north strip. Short AFE_3V0 path into Zone A.
6. J_BAT in the Zone D north strip (≈ x 57.5–66, y 0.6–7). VBAT splits at its + pad (burst branch → BAT+ post; AFE branch → R_PRE). Pin 13 GND gets ≥ 3 vias beside its toe pad.
7. XIAO toe copper ≥ 5 mm from any Zone B part (5.7 mm by design) and ≥ 14 mm from Zone A. Height bands west of the toes per 2.1.
8. The U.FL (module north-east corner) antenna cable leaves the board toward the **east**. Never route it over Zones A–C.
9. No component taller than the XIAO within 3 mm of the USB-C mouth (cable plug clearance).
10. Keep the TLV9064 input pins (3/5/10/12) facing the channel networks so that the `EMG_HIZ` routes are ≤ 8 mm each and symmetric per channel.
11. ADC-input BAV199 clamps (RB-00.5): each within 2 mm of its ADS131M04 AIN pin on F.Cu, on the `CHx_y` net (class `EMG_BUF`), P/N clamps placed symmetrically. The pin-1 GND via goes beside the pad (dog-bone).
12. X1 (3225) on the Zone C side of U6001, ≤ 5 mm from pin 17. The 100 nF sits at pin 4, and pin 1 (OE) is tied to DVDD_F at the part.

## 6. Required RB checkpoints (manufacturing gates)

| Gate | Pass criterion |
|---|---|
| ERC | 0 errors, every warning justified |
| DRC (KiCad, `--all-track-errors`, zone refill) | 0 errors, 0 unconnected |
| Scripted via-in-SMD-pad check | **0** |
| Netclass audit | `Default` class has 0 nets. Every `EMG_HIZ` net is F.Cu only with 0 vias |
| JLC DFM (upload Gerber/BOM/CPL) | No hole/pad/mask errors; Economic PCBA eligible; no POFV/HDI upcharge |
| BOM/CPL | Rotation check for the TSSOP/SOT/XO/JST parts in the JLC preview; XIAO orientation |
