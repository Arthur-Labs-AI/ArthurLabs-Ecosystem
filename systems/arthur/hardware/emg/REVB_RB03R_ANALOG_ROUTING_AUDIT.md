# RB-03R — Analog Routing Audit

> **Superseded in part by RB-03S (2026-10-11).** The board installed by RB-03R had a 14.3 mm ground wire on C6009 and an R7101 iron-access
> conflict; RB-03S replaced it (C6009 −0.18 mm, R7101 back, 0.3 mm ground tie, 0 via-in-pad, 0 DRC errors). See
> `REVB_RB03S_CAP_DECOUPLING_REPAIR.md` and `REVB_RB03S_VIA_MASK_AUDIT.md`. Numbers below describe the RB-03R board (archived in
> `rev-b-xiao/archive/rb03r_installed/`).


Date: 2026-10-10. Board: Rev B V1C (51.30 × 64.95 mm) as installed after RB-03R. "Before" = RB-03 run 14 (archived,
`rev-b-xiao/archive/rb03_run14/`). Tools: `rb03r_analog_audit.py`, `rb03r_gnd_ties.py`, `rb03r_escape_purity.py`, `rb03_audit.py`,
`rb03r_power.py`. Evidence: `rev-b-xiao/evidence/rb03r/`.

**Nothing in this document is an experimental result.** Lengths, parasitic capacitances and distances are measured on the layout file;
capacitances are a microstrip estimate (0.2104 mm 7628 prepreg to the solid In1 plane, εr 4.4, 35 µm copper → 0.088 pF/mm for a 0.2 mm
track). Analog signal integrity, CMRR, noise and leakage are **not** proven until a physical board is measured.

## 1. What was changed for analog quality

| Change | Where | Effect |
|---|---|---|
| ACN P/N pair attraction in the router (`pair_partner`: the N track of a clamp→1 nF run prefers cells within 0.8 mm of the P track) | `rb03_router.py` | clamp → 1 nF runs are now P = N to 0.01 mm on all four channels (was Δ 0.0-3.6 mm) |
| Class-priority re-route of hi-Z, buffer and AFE rail of CH3 in one pass | `rb03r_routenet.py` | buffer output CH3 P/N Δ 3.9 → 0.1 mm |
| Via-vs-hi-Z-pad mask (vias keep 0.40 mm from every hi-Z pad, TLV9064 pins included) | router masks | 0 vias inside the 0.40 mm band of a hi-Z pad (3 violations in the first narrowed-rule run) |
| Strict via placement (no via-in-pad, centre ≥ 0.25 mm from pad copper) | RB-03R | 228 → 200 vias; vias on buffered nets 60 → 42 |
| Hi-Z exemption narrowed (see the rule validation document) | `.kicad_dru` | track-to-track exemption only inside a rectangle per TLV9064; pads of other parts: full 0.40 mm |

No differential-pair length matching was applied, deliberately: the nets are not high-speed differential pairs; the aim was
equal parasitics and clean returns.

## 2. Hi-Z and electrode legs (before → after)

| Channel | Max distance of the hi-Z copper to a GND via (mm) | Min distance to SPI/clock copper (mm) | ΔC between P and N hi-Z node, estimate (pF) |
|---|---|---|---|
| CH1 | 4.88 → 4.74 | 22.82 → 25.12 | 0.226 |
| CH2 | 4.71 → 4.74 | 22.27 → 24.76 | 0.37 |
| CH3 | 4.71 → 4.74 | 23.28 → 25.79 | 0.17 |
| CH4 | 4.71 → 4.74 | 25.19 → 28.5 | 0.37 |

Electrode legs: P/N 7.4 / 7.4 mm on all channels (Δ ≤ 0.01 mm), F.Cu only, no vias, unchanged. Hi-Z legs: F.Cu only, **0 vias, 0
layer changes**, all over In1 copper (100 % of 438 sampled points). The residual hi-Z P/N length difference (Δ 1.9-4.2 mm, ≤ 0.37 pF)
comes from the placement of the 10 MΩ / 100 pF cells (R305/R306 vs C304 ...), not from routing; a first-order common-mode-to-
differential conversion of ΔC / C_cell = 0.37 pF / 100 pF ≈ 0.4 % (≈ −49 dB) is the worst-case bound for the hi-Z node alone; the
amplifier and the 10 MΩ bias network dominate real CMRR. Not measured.

## 3. Per-leg lengths, before → after (P / N, mm; vias per leg)

| Channel | Segment | Before P / N | After P / N | Vias |
|---|---|---|---|---|
| CH1 | electrode | 7.4 / 7.4 (Δ 0.0) | 7.4 / 7.4 (Δ 0.0) | 0 → 0 |
| CH1 | hi-Z (R_s → +IN) | 18.1 / 15.5 (Δ 2.6) | 18.3 / 15.7 (Δ 2.6) | 0 → 0 |
| CH1 | buffer out → clamp | 9.7 / 14.2 (Δ 4.5) | 10.2 / 14.2 (Δ 3.9) | 4 → 2 |
| CH1 | clamp → 1 nF | 7.8 / 4.5 (Δ 3.3) | 6.8 / 6.8 (Δ 0.0) | 2 → 0 |
| CH1 | buffer → ADC AIN | 55.1 / 56.5 (Δ 1.4) | 56.5 / 55.5 (Δ 1.0) | 4 → 7 |
| CH2 | electrode | 7.4 / 7.4 (Δ 0.0) | 7.4 / 7.4 (Δ 0.0) | 0 → 0 |
| CH2 | hi-Z (R_s → +IN) | 15.7 / 19.6 (Δ 4.0) | 15.7 / 19.9 (Δ 4.2) | 0 → 0 |
| CH2 | buffer out → clamp | 9.2 / 7.1 (Δ 2.1) | 9.4 / 7.1 (Δ 2.3) | 2 → 0 |
| CH2 | clamp → 1 nF | 11.0 / 7.4 (Δ 3.6) | 6.8 / 6.8 (Δ 0.0) | 4 → 0 |
| CH2 | buffer → ADC AIN | 61.9 / 47.7 (Δ 14.2) | 53.4 / 42.8 (Δ 10.6) | 12 → 10 |
| CH3 | electrode | 7.4 / 7.4 (Δ 0.0) | 7.4 / 7.4 (Δ 0.0) | 0 → 0 |
| CH3 | hi-Z (R_s → +IN) | 18.1 / 15.5 (Δ 2.6) | 18.4 / 16.5 (Δ 1.9) | 0 → 0 |
| CH3 | buffer out → clamp | 10.3 / 14.2 (Δ 3.9) | 10.2 / 10.2 (Δ 0.1) | 2 → 2 |
| CH3 | clamp → 1 nF | 7.4 / 7.4 (Δ 0.0) | 6.8 / 6.8 (Δ 0.0) | 4 → 0 |
| CH3 | buffer → ADC AIN | 42.2 / 48.6 (Δ 6.3) | 53.6 / 51.4 (Δ 2.3) | 11 → 11 |
| CH4 | electrode | 7.4 / 7.4 (Δ 0.0) | 7.4 / 7.4 (Δ 0.0) | 0 → 0 |
| CH4 | hi-Z (R_s → +IN) | 15.7 / 19.6 (Δ 4.0) | 15.7 / 19.9 (Δ 4.2) | 0 → 0 |
| CH4 | buffer out → clamp | 9.4 / 7.1 (Δ 2.3) | 9.4 / 7.1 (Δ 2.3) | 0 → 0 |
| CH4 | clamp → 1 nF | 4.5 / 7.4 (Δ 2.9) | 6.8 / 6.8 (Δ 0.0) | 4 → 0 |
| CH4 | buffer → ADC AIN | 47.5 / 47.5 (Δ 0.1) | 52.0 / 55.0 (Δ 3.0) | 11 → 10 |

Reading the table:

* **Clamp → 1 nF (ACN)**: exactly symmetric, no vias, on the same layer; before: up to 3.6 mm difference and 4 vias.
* **Buffer output → clamp (BUF)**: CH3 P = N. CH1 (3.9 mm) and CH2/CH4 (2.3 mm) differ; these runs are low-impedance (TLV9064 output),
  so a few millimetres of mismatch is a small effect (0.09 pF/mm); not equalised on purpose.
* **Buffer → ADC AIN (ADCIN)**: long (43-57 mm) because the AFE block is at the north and the ADC at the south of the board
  with the band row between them; these nets are low-impedance buffer outputs, so length is not a hi-Z leakage risk but is a
  pickup path. Via count per leg 7-11. CH2 differs by 10.6 mm (was 14.2 mm) and CH4 by 3.0 mm (was 0.1 mm). That is an open
  weakness: **P/N ADC input runs are not tightly coupled** (mean separation 1.4-1.9 mm, only 22-53 % of the P run within 1 mm of N).

### 3.1 ADC input runs: pick-up exposure (before → after)

| Channel | Mean P-N separation (mm) | Share of P within 1 mm of N | Min distance to SPI/clock (mm) | Min distance to CTRL (mm) |
|---|---|---|---|---|
| CH1 | 4.01 → 1.57 | 0.1 → 0.36 | 1.5 → 2.91 | 0.6 → 1.07 |
| CH2 | 1.98 → 1.4 | 0.32 → 0.53 | 1.5 → 2.12 | 2.22 → 3.59 |
| CH3 | 3.35 → 1.91 | 0.3 → 0.3 | 2.2 → 3.01 | 2.2 → 4.28 |
| CH4 | 2.21 → 1.94 | 0.29 → 0.22 | 2.77 → 3.52 | 3.1 → 4.46 |

Separation and SPI spacing improved on every channel; the share within 1 mm worsened on CH1/CH3-CH4 only slightly or is unchanged.
The routes cross the SPI group at 2.1-3.5 mm minimum distance; the rules require ≥ 2.0 mm to hi-Z and ≥ 1.0 mm to buffered nets.

## 4. SPI, clock and analog supply

| Net | Before (mm) | After (mm) |
|---|---|---|
| `/ADC/ADC_CLKIN` | 9.56 | 9.76 |
| `/ADC/ADC_DOUT` | 2.29 | 2.29 |
| `/ADC/X1_OUT` | 4.65 | 4.65 |
| `/MISO` | 7.56 | 8.96 |
| `/MOSI` | 12.36 | 11.91 |
| `/SCLK` | 17.36 | 12.91 |
| `/XIAO_Brain_Interface/MOSI_MCU` | 7.02 | 7.52 |
| `/XIAO_Brain_Interface/SCLK_MCU` | 7.3 | 12.1 |

* **Clock (X1_OUT → ADC_CLKIN)**: X1_OUT 4.65 mm (≤ 5 mm requirement), ADC_CLKIN 9.56 → 9.76 mm through the 33 Ω series resistor R6001;
  no vias on either; closest hi-Z/buffer copper 5.3 → 5.4 mm. The clock is routed over In1 copper for 100 % of its length.
* **SCLK_MCU** grew from 7.3 to 12.1 mm: the single via at U1.9 had to move 2.2 mm to leave the 0.25 mm hole-to-opening rule (XIAO
  openings carry +0.05 mm). It is the SPI clock after the 33 Ω series resistor R7101; the extra stub is over In1 and on the same
  layers as before.
* **Analog supply (AFE_3V0)**: RB-02 check C23 PASS on the final board: C6007 2.1 mm (AVDD pin 1), C6008 1.5 mm (DVDD pin 20), C6009
  2.2 mm (CAP pin 18), C501-C503 2.5 mm from the TLV9064 V+ pins, C6010 3.3 mm from X1 VDD. AFE_3V0 was re-routed after the hi-Z
  rules were narrowed; its copper is 145.8 mm long, 0.2-0.3 mm wide, 22 vias.

## 5. Ground-plane integrity and return currents

| Check | Result |
|---|---|
| In1.Cu | one solid GND plane, 3057 mm² single outline, 0 holes, 91.7 % copper fraction of the board |
| In2.Cu | GND zones A/B tied through the plane, 2313 mm² single filled outline |
| Return-path coverage (samples over In1 copper) | hi-Z 438/438, electrode 168/168, buffer 1220/1220, ADC cap 14/14, ANALOG_REF 236/236, SPI 139/139, CTRL 520/520, PWR_AFE 249/249, PWR_DVDD 97/97, PWR_VBAT 96 % (5 samples over the BAT+ post keep-out, expected) |
| Slots / splits under signals | none (In1 unbroken) |
| SMD GND pads | 71; nearest GND via: median 0.91 mm, max 4.2 mm; > 2.0 mm: 12 (RB-03: 17); > 3.0 mm: 5 (RB-03: 4); copper path > 4 mm: 3 (C6009.2 14.3 mm) |

Nearest-via distance (above) is a lower bound; `gnd_paths.json` (`rb03r_gnd_path.py`) gives the actual F.Cu GND copper path from
each pad to a GND via: 6 pads > 2 mm (RB-03: 7), 3 pads > 4 mm (RB-03: 2). The three long ones:

| Pad | Path to the GND via | Width | What it is |
|---|---|---|---|
| **C6009.2** | **14.3 mm** | **0.15 mm** | 220 nF capacitor on the ADS131M04 CAP pin (internal regulator) |
| R7106.2 | 5.3 mm | 0.3 mm | 150 kΩ resistor of the XIAO interface |
| R3004.2 | 4.6 mm | 0.2 mm | resistor of the electrode-bias group |

**C6009.2 is the one real analog cost of eliminating the via-in-pad.** Its pad is enclosed by X1, R6001, R7101 and U6001 (all
courtyards touch), so no via fits within 3 mm; the only legal tie is a 0.15 mm F.Cu wire that joins an existing GND chain 14.3 mm
away. Estimate (not measured): R ≈ 47 mΩ (95 squares at 0.49 mΩ/□), L ≈ 10 nH (0.67 nH/mm for a 0.15 mm track over In1 at 0.21 mm);
with 220 nF the tie resonates at ≈ 3.4 MHz and the capacitor is ≈ 0.5 Ω away from the pin at the 8.192 MHz clock. The previous
via-in-pad connection had ≈ 1 nH. Options (owner decision, section 8 of the via document): (a) accept; (b) move R7101 back and
accept this single via-in-pad; (c) RB-04: make C6009 a 0402 or move X1/R6001 so that a via fits. Pads with 2-4 mm paths are 1 nF
ADC input capacitors and 100 kΩ bias resistors in the band row: ground is deliberately kept 0.40 mm from hi-Z copper.

Where an exception exists, nothing hides: `gnd_ties.json` lists every pad.

## 6. Power distribution voltage drop (re-computed with justified current bounds)

Resistance from the supply pad to the farthest pad of the net is computed from the routed copper (35 µm, 0.49 mΩ/□, 1.2 mΩ per via)
by `rb03_audit.py`; drop = bound × R is a pessimistic bound (all load at the farthest pad).

| Net | Source pad | Current bound (mA) | Max R (mΩ) | Drop (mV) | Basis of the bound |
|---|---|---|---|---|---|
| `AFE_3V0` | U4002.5 | 13.8 | 142.0 | 1.96 | ADS131M04 IAVDD max 4.0 mA (high-resolution, SBAS890D rev D, 6.5 Electrical Characteristics) + 12 x TLV9064 IQ max 0.80 mA (-40..125 C, SBOS839, VS = 5.5 V; at 3.0 V it is lower) + 0.2 mA bias/divider/leakage allowance |
| `DVDD_F` | FB1.2 | 11.4 | 47.4 | 0.54 | X1 SX3M8.192M20F30TNN Icc <= 10 mA (15 pF, vendor sheet) + ADS131M04 IDVDD max 0.5 mA (SPI idle) + 0.5 mA SPI activity + 0.4 mA pull-ups (3.6 V / 10 k) |
| `/XIAO_Brain_Interface/XIAO_3V3` | U1.12 | 11.4 | 7.2 | 0.082 | DVDD_F bound (the 3V3 pin feeds FB1 only on this board) |
| `/Analog_Power_Interlock/VBAT_AFE` | C4007.1 | 14.8 | 16.7 | 0.247 | AFE_3V0 bound + TPS7A2030 ground current (<= 1 mA allowance) |
| `VBAT` | J1.1 | 500.0 | 14.9 | 7.45 | system bound, not a datasheet value: XIAO ESP32-S3 radio TX peak ~355 mA + charger/board margin -> 0.5 A; measure |
| `/XIAO_5V` | U1.14 | 20.0 | 56.6 | 1.132 | USB-presence sense / inhibit network only on this board (the charge current is inside the module); 20 mA allowance |

Datasheet sources (read 2026-10-10): ADS131M04 SBAS890D §6.5 (IAVDD high-resolution 3.5 typ / 4.0 max mA; IDVDD 0.4 typ / 0.5 max
mA, SPI idle); TLV9061/2/4 SBOS839 (IQ 538 µA typ, 750 µA max at 5.5 V, 800 µA max −40…125 °C per amplifier); SCTF SX3M8.192M20F30TNN
Icc ≤ 10 mA (15 pF, vendor sheet via RB-01R). The VBAT bound (0.5 A) is a system estimate, **not** a datasheet value; the
radio's peak current must be measured. Largest drop is 7.5 mV on VBAT (0.18 % of 4.2 V): non-critical. Largest analog drop 2.0
mV on AFE_3V0: the ADS131M04 measures against its internal 1.2 V reference (the 3.0 V rail is not the measurement reference); the
TLV9064 supply-rejection figure was not re-checked here. The RB-01R total (≈ 13 mA) is consistent with the bound used.

## 7. Spacing, exemptions and exceptions (full list)

* Hi-Z vs SPI ≥ 2.0 mm: min 24.8-28.5 mm. Buffered vs SPI ≥ 1.0 mm: min ADC input to SPI 2.1 mm.
* Hi-Z track / via to any foreign pad: 0.40 mm everywhere except at the pins of U501/U502/U503, where the package pin pitch
  (0.65 mm, 0.25 mm gap) makes 0.40 mm impossible. 42 clearance instances (`drc_without_hiz_exemptions.json`) rely on that
  exemption: 27 hi-Z-track-to-U50x-pad, 13 U50x-hi-Z-pad-to-track, 2 AFE_3V0-to-hi-Z track-to-track inside the IC rectangle (the V+
  pin next to +IN). `escape_area_purity.json`: **0** non-IC nets under the exemption (38/39/42 tracks, 4/2/4 vias, all of them
  IC nets or GND).
* No exception exists outside the three TLV9064 rectangles.

## 8. Weaknesses that remain

1. ADC input runs 43-57 mm with 7-11 vias per leg and P/N separation up to 1.9 mm. A different floorplan (ADC next to the
   buffers) would be the real fix; it is outside RB-03R.
2. Hi-Z leg P/N difference up to 4.2 mm (placement, 0.37 pF).
3. Some GND ties (3, above) and the 14.3 mm F.Cu GND wire at C6009.2.
4. CH1 buffer P/N Δ 3.9 mm, CH2/CH4 Δ 2.3 mm.
5. No SI simulation or measurement.
