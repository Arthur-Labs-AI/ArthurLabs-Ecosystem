# A.R.T.H.U.R EMG Rev B — RB-01R Footprint Qualification Matrix

Date: 2026-10-10. Scope: comparison of the footprint each Rev B symbol is linked to against the manufacturer's recommended land pattern / drawing. **No PCB, placement or routing was created.** A footprint name is not evidence of geometry: every row below was compared on measured pad numbers.

## 1. Method and provenance

* **Footprint files.** The exact KiCad **10.0.0** official library files (https://gitlab.com/kicad/libraries/kicad-footprints, tag `10.0.0`, file version 20260206) were retrieved and vendored unmodified into `rev-b-xiao/kicad/ARTHUR_EMG_RevB/fp-libs/` with a project `fp-lib-table`. Pad geometry below was parsed from those files (not from names).
* **Manufacturer geometry.** TI package outline and "Example Board Layout" pages (read in the SBAS890D, SBOS839N, SBVS338H PDFs); Nexperia SOT23 reflow footprint (BAV199/2N7002 datasheets); JST ePH.pdf **vector** drawing (dimensions measured from the PDF geometry, scale fixed by the 2.00 mm pitch); SCTF 3CM sheet (300 ppi page). Seeed official `XIAO-ESP32-S3-SMD.kicad_mod` (OPL_Kicad_Library) for the module.
* **Criteria for PASS**: (1) pad count, numbering and pitch identical to the package; (2) pad toe extends ≥ 0.2 mm beyond the maximum lead-tip position and the heel ≥ 0.1 mm inside the minimum lead-heel position (or equals the manufacturer's recommended land within ±0.1 mm); (3) no pad-to-pad gap below 0.2 mm; (4) pin 1 and orientation convention identical to the manufacturer's drawing.
* Pad coordinates are in the footprint frame, mm; "c-c" = centre-to-centre.

## 2. Matrix

| # | Part (exact MPN) | Package | Manufacturer drawing | Manufacturer recommended land | Selected KiCad footprint | Dimensional differences | Result |
|---|---|---|---|---|---|---|---|
| 1 | **ADS131M04IPWR** | TSSOP-20, TI PW0020A (4220206/A), MO-153, body 6.4–6.6 × 4.3–4.5, pitch 0.65 | SBAS890D p. 102 | 20 × 1.50 × 0.45, row c-c 5.80 (outer 7.30, inner 4.30) | `Package_SO:TSSOP-20_4.4x6.5mm_P0.65mm` 20 × 1.475 × 0.40, row c-c 5.725 (outer 7.20, inner 4.25), pitch 0.65, y = ±0.325 … ±2.925 | row c-c −0.075; pad −0.025 × −0.05; toe +0.30 beyond the 6.6 mm lead tips; heel +0.225; gap 0.25 (TI 0.20) | **PASS** |
| 2 | **TLV9064IPWR** | TSSOP-14, TI PW0014A (4220202/B), body 4.9–5.1 × 4.3–4.5 | SBOS839N p. 89 | 14 × 1.50 × 0.45, row c-c 5.80 | `Package_SO:TSSOP-14_4.4x5mm_P0.65mm` 14 × 1.475 × 0.40, row c-c 5.725, y = ±0.65 … ±1.95 | identical to row 1 | **PASS** |
| 3 | **TPS7A2030PDBVR** | SOT-23-5, TI DBV0005A (4214839/K), MO-178, lead span 2.6–3.0, lead length 0.3–0.6, pitch 0.95 | SBVS338H p. 56 | 5 × 1.10 × 0.60, row c-c 2.60 (outer 3.70, inner 1.50) | `Package_TO_SOT_SMD:SOT-23-5` 5 × 1.325 × 0.60, row c-c 2.275 (outer 3.60, inner 0.95), pitch 0.95 | row c-c −0.325; pad length +0.225 (KiCad is the IPC nominal; extends 0.275 further under the 1.6 mm body); toe +0.30; heel ≥ +0.225; width equal | **PASS** (KiCad pad larger than TI's example; no gap < 0.35) |
| 4 | **BAV199** (Nexperia) | SOT23 / TO-236AB, 2.9 × 1.3 × 1.0, pitch 1.9 (pins 1–2) | BAV199 datasheet Fig. 8 | Fig. 9 reflow: lands 0.6 wide × 0.7 long, pitch 1.9, row c-c 2.0 | `Package_TO_SOT_SMD:SOT-23` 3 × 1.475 × 0.60, x = ±0.9375 (row c-c 1.875), pin 1/2 at y = ∓0.95 | row c-c −0.125; land length +0.775 (outer 1.675 vs 1.35, inner 0.20 vs 0.65, i.e. extends under the body); width equal; pin numbering equal (1 = A1, 2 = K2, 3 = K1/A2) | **PASS** (superset of the manufacturer land; the Nexperia land stays the fallback if RB-02 needs area) |
| 5 | **2N7002** (generic, JLC Basic; Nexperia datasheet used) | SOT23 / TO-236AB (same drawing code as row 4) | 2N7002 datasheet Fig. 13 | Fig. 14 reflow = row 4 | same footprint as row 4 | as row 4; pins 1 G / 2 S / 3 D = symbol | **PASS** (manufacturer of the JLC Basic part to be fixed at RB-03; any maker uses the same TO-236AB outline) |
| 6 | **B2B-PH-SM4-TB(LF)(SN)** (JLC C160352) | JST PH top entry, SMT, A = 2.0, B = 7.95, h 6.6 | ePH.pdf p. 4 | p. 2 "PC board layout (SMT, top entry)": signal pads 1.0 × 5.5 @ 2.0 pitch; retention pads 1.6 × 3.0, inner edge 1.6 mm outboard of the signal-pad centre; retention outer edge 1 mm beyond the signal-pad tip | `Connector_JST:JST_PH_B2B-PH-SM4-TB_1x02-1MP_P2.00mm_Vertical` pads 1/2 1.0 × 5.5 @ (±1.0, 0.5); MP 1.6 × 3.0 @ (±3.4, −1.75) | none (signal 6.2 u = 1.00 mm; 34.0 u = 5.48 mm; MP 9.9 u = 1.60 mm × 18.5 u = 2.98 mm; MP outer edge 0.98 mm beyond the pad tip) | **PASS** |
| 7 | **S2B-PH-SM4-TB(LF)(SN)** (JLC C295747) | JST PH side entry, SMT, A = 2.0, B = 7.9, h 5.5, depth 6.0 (+2.6) | ePH.pdf p. 4 | p. 2 "side entry": signal pads 1.0 × 3.5 @ 2.0; retention pads 1.5 × 3.4, inner edge 1.6 mm outboard of the signal-pad centre; 2.3 mm gap between signal and retention pads | `Connector_JST:JST_PH_S2B-PH-SM4-TB_1x02-1MP_P2.00mm_Horizontal` pads 1/2 1.0 × 3.5 @ (±1.0, −2.85); MP 1.5 × 3.4 @ (±3.35, 2.9) | none beyond the ±0.1 drawing tolerance (MP centre 2.35 vs 2.33 mm from the signal pad; gap 2.30 = 2.29) | **PASS** |
| 8 | **SX3M8.192M20F30TNN** (SCTF, C2901557) | SMD3225-4P, 3.2 ± 0.1 × 2.5 ± 0.1 × 0.95 ± 0.15; package pads 0.9 (x) × 0.65/0.8 (y), x-gap 1.2, y-gap 1.0 | SCTF 3CM sheet p. 4 | pad c-c 2.20 × 1.75, pads 1.20 × 0.95 | **none exists**: `ARTHUR:OSC_SCTF_SX3M_SMD3225-4P` is named in the schematic but not authored. Nearest stock files differ: `Crystal:Crystal_SMD_3225-4Pin_3.2x2.5mm` pads 1.4 × 1.2 @ ±1.1 × ±0.85 (c-c 2.2 × 1.7); `Oscillator_SMD_Abracon_ASE-4Pin` 1.3 × 1.1 @ ±1.05 × ±0.825 | stock files: pads +0.2/+0.25 or +0.1/+0.15 larger, c-c Y −0.05/−0.10. The RB-00.5 YXC land (1.3 × 1.2 pads, gaps 0.8/0.7 → c-c 2.1 × 1.9) is wrong for this part (required c-c 2.2 × 1.75, pads 1.2 × 0.95) | **CHANGE REQUIRED**: author the footprint from §3.1 at RB-02 (spec fixed here) |
| 9 | **XIAO_ESP32S3_HANDSOLDER** (Seeed 202003751) | 17.78 × 21.02 mm module, 14 castellations @ 2.54 + BAT+ pad | Seeed `XIAO-ESP32-S3-SMD.kicad_mod`; `REVB_XIAO_MOUNTING_SPEC.md` | spec (§3.2) | **none exists**: `ARTHUR:XIAO_ESP32S3_HANDSOLDER` not authored | spec positions equal the Seeed centres (§3.2); hand-solder pad 1.50 × 2.90 vs Seeed reflow pad 2.0 × 2.75 by design; real plain-module dimensions not measured (R3/R9) | **CHANGE REQUIRED** (author at RB-02) + physical check before |
| 10 | **0603** R/C/FB | EIA 0603 (1.6 × 0.8) | generic MPNs (not yet selected) | IPC-7351B nominal | `Resistor_SMD:R_0603_1608Metric` 0.80 × 0.95 @ ±0.825 (gap 0.85); `Capacitor_SMD:C_0603_1608Metric` 0.90 × 0.95 @ ±0.775 (gap 0.65); `Inductor_SMD:L_0603_1608Metric` 0.875 × 0.95 @ ±0.7875 | n/a (no MPN-specific drawing exists yet) | **PASS for the package class**; MPN-specific recheck at RB-03 |
| 11 | **0805** R/C | EIA 0805 (2.0 × 1.25) | generic MPNs | IPC-7351B nominal | `Resistor_SMD:R_0805_2012Metric` 1.025 × 1.40 @ ±0.9125 (gap 0.80); `Capacitor_SMD:C_0805_2012Metric` 1.00 × 1.45 @ ±0.95 (gap 0.90) | n/a | **PASS for the package class**; R5002 0805 for creepage, C4007 22 µF: confirm part height ≤ 1.45 mm and DC-bias at RB-03 |

`TestPoint:TestPoint_Pad_D1.5mm` (bare pads TP1–TP8) is a PCB feature, not a purchased part; size is provisional (RB-02).

**Result: PARTIAL.** Rows 1–7, 10, 11 are geometry-verified PASS. Rows 8 and 9 have a fixed, manufacturer-derived specification but no footprint file; authoring them is the first RB-02 task and is not possible without starting the PCB library work this review was told not to start.

## 3. Specifications of the two footprints that do not exist yet

### 3.1 `ARTHUR:OSC_SCTF_SX3M_SMD3225-4P` (X1)

Footprint frame, mm, +x right, +y down, top view as placed on F.Cu (pin 1 at bottom-left, counter-clockwise numbering, dot at pin 1).

| Pad | Centre | Size | Net |
|---|---|---|---|
| 1 (OE) | (−1.10, +0.875) | 1.20 × 0.95 | DVDD_F |
| 2 (GND) | (+1.10, +0.875) | 1.20 × 0.95 | GND |
| 3 (OUT) | (+1.10, −0.875) | 1.20 × 0.95 | → R6001 |
| 4 (VDD) | (−1.10, −0.875) | 1.20 × 0.95 | DVDD_F |

Body 3.2 × 2.5 × 0.95 (+0.15) mm; pad-to-pad gaps 1.0 (x) and 0.8 (y); courtyard body + 0.25. Rounded corners per KiCad default. Paste: 1:1 (JLC), mask expansion default. The manufacturer's recommended land is the pad rectangle shown on p. 4 (2.2 × 1.75 c-c, 1.2 × 0.95).

### 3.2 `ARTHUR:XIAO_ESP32S3_HANDSOLDER` (U1) — source comparison

Module frame of the Seeed footprint (origin at the far-end corner on the D0–D6 side, y negative toward USB). The Seeed centres are the ones parsed from `XIAO-ESP32-S3-SMD.kicad_mod`:

| Item | Seeed official | Mounting spec RB-00.6 | Equal? |
|---|---|---|---|
| D0…D6 (pads 1–7) | x = 0.835, y = −18.12, −15.58, −13.04, −10.50, −7.96, −5.42, −2.88 | same y set, 2.54 pitch, USB-end first | yes |
| D7…D10, 3V3, GND, 5V (pads 8–14) | x = 17.0, y = −2.88 … −18.12 | same | yes |
| BAT+ (pad 23) | (4.445, −10.882), 2.5 × 1.1 | post hole at board (68.335, 21.862) = transform of (4.445, −10.882) | yes (72.78 − 4.445 = 68.335; 32.00 − (21.02 − 10.882) = 21.862) |
| BAT− (pad 24) | (4.445, −12.787) | not soldered, pin 13 provides GND | yes |
| Pads 15–22, 25 | Ø1.7 / 2.75 × 2.5 | not soldered, F.Cu keep-out | by design |
| Castellation land | 2.0 × 2.75 reflow | 1.50 × 2.90 (toe 1.30 + inner 1.60), no paste | **by design** (REVB_XIAO_MOUNTING_SPEC.md §2) |

Authoring input for RB-02: castellation pads as above at the Seeed centres, 14 pads numbered 1–14, one plated hole Ø1.40 numbered 23 (F.Cu ring Ø1.90 with 1.45 mask opening, B.Cu pad Ø3.00), no other copper. The physical plain-module dimensions (R3/R9) must be measured before the footprint is released.

## 4. Open items from this matrix

1. Author the two custom footprints (RB-02 start), then re-run the ERC (expected 0 warnings).
2. Measure two XIAO ESP32S3 plain modules (R3/R9).
3. RB-03: MPN-specific land-pattern check for the selected 0603/0805 JLC Basic parts; Q3001 manufacturer.
4. JLC CPL rotation for X1, J1 and the BAV199/TSSOP parts in the JLC preview.
