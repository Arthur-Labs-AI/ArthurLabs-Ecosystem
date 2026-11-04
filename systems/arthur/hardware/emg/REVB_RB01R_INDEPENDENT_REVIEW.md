# A.R.T.H.U.R EMG Rev B — RB-01R Independent Schematic Review & Freeze

Date: 2026-10-10. Branch `hardware/emg-rev-b`, HEAD `214e8a8`, working tree modified (nothing committed).
Scope: schematic, BOM, documentation and verification tooling only. **No PCB, placement, routing, Gerber or order output exists.**
Rev A is untouched. Tool: `kicad-cli 10.0.6`.

## 0. Inputs and how they were treated

| Input | Treatment |
|---|---|
| Existing RB-00, RB-00.5, RB-00.6, RB-01 documents and the committed Rev B schematic | Re-read; connectivity re-exported fresh and re-audited |
| Externally supplied package `ARTHUR_RB01R_review_continuation.zip` (2 review documents, 1 checker, 1 mutation test, 1 README) | Treated as **review input, not as conclusions**. Its statements were re-checked against the manufacturer documents; the tools were run against the real KiCad export (§2). The two documents are replaced by this file and `REVB_RB01R_FOOTPRINT_QUALIFICATION.md` |
| Original schematic generator and its intended-net map | **Not present in the repository** (not found on disk). Nothing in the tooling depends on it |

Supplied-package statements that did **not** survive verification:

| Supplied statement | Finding |
|---|---|
| "Family page shows ±50 ppm stability; some entries ±50 ppm" | The exact-code datasheet decodes `20` = ±20 ppm tolerance and `F30` = ±30 ppm drift over −40…+85 °C (§5). No ±50 ppm figure appears in it |
| "LCSC ~2.9k in stock at $0.48" | LCSC page read 2026-10-10: stock 1,658, $0.3482 @1 … $0.2332 @500 |
| "X1 abs-max / land pattern not conclusively accessed → OPEN" | The exact datasheet PDF (9 pp.) was obtained and read; land pattern verified. The datasheet **publishes no absolute-maximum table** (§5, residual X1-a) |
| "Cached JLC page ~24k in stock for J1" | JLC page 2026-10-10: C295747 stock 14,405 |
| "gain ≥ 8 upper limit 1.2 V" | Correct only at AVDD = 3.0 V; the design's minimum is AVDD 2.955 V → **1.155 V** |
| "−1.04 V / +1.16 V proven labels to be replaced by provisional scenarios" | −1.04 V was derived with a log interpolation; it is replaced by a bound that uses only datasheet numbers: **−1.09 V** (§4.4). The "+1.16 V" figure has no counterpart in the design |
| Final gate "NOT FULLY RE-VERIFIED / OPEN" values | Superseded by §11 |

## 1. Baseline

| Item | Value |
|---|---|
| Branch / HEAD | `hardware/emg-rev-b` / `214e8a8` |
| Git status before work | only `tools/jev-bench/` untracked (unrelated) |
| Rev A production PCB SHA-256 | `d7a585e8ae46299215d26c0aa58ea0ca5829d46ce72a45d279290263e94a0005` — **unchanged** at start and end |
| Rev A tracked-tree hash (`git ls-files rev-a rev-a-cost \| xargs sha256sum \| sha256sum`) | `d5d72289…2c67` — **unchanged** at start and end |
| Rev B connectivity before/after the RB-01R edits | **357 pins, identical** (pin→net map compared) |

## 2. Independent pin-by-pin review, fresh netlist audit, mutation test

### 2.1 Pin tables checked against the manufacturer documents (this session, from the PDFs)

| Part | Pins | Source | Result |
|---|---|---|---|
| ADS131M04 (TSSOP-20, U6001) | 20 | SBAS890D Table 5-1 TSSOP column: 1 AVDD, 2 AGND, 3/4 AIN0P/N, 5 AIN1N, 6 AIN1P, 7 AIN2P, 8 AIN2N, 9 AIN3N, 10 AIN3P, 11 SYNC/RESET, 12 CS, 13 DRDY, 14 SCLK, 15 DOUT, 16 DIN, 17 CLKIN, 18 CAP, 19 DGND, 20 DVDD | symbol names and every connection match (note the AIN1/AIN2 N/P pin order, which differs from AIN0/AIN3) |
| TLV9064 (TSSOP-14, U501–U503) | 14 | SBOS839N Table 5-5 | match: OUT1 1, IN1− 2, IN1+ 3, V+ 4, IN2+ 5, IN2− 6, OUT2 7, OUT3 8, IN3− 9, IN3+ 10, V− 11, IN4+ 12, IN4− 13, OUT4 14 |
| TPS7A2030PDBV (SOT-23-5, U4002) | 5 | SBVS338H: 1 IN, 2 GND, 3 EN, 4 N/C, 5 OUT | match; pin 4 is a flagged NC |
| BAV199 ×16 | 3 | Nexperia 2023-04-01: 1 A1, 2 K2, 3 K1/A2 | match; ADC clamps use 1 = GND, 3 = AIN, 2 = NC |
| 2N7002 (Q3001) | 3 | Nexperia: 1 G, 2 S, 3 D; VGS(th) min 1.0 V | match |
| SCTF SX3M (X1) | 4 | SCTF 3CM sheet: 1 tri-state/OE, 2 GND, 3 output, 4 Vdd | match; pin 1 and 4 on DVDD_F |
| XIAO ESP32S3 (U1) | 15 | Seeed wiki pin map + Seeed `Seeed_Studio_XIAO_Series.kicad_sym` (1–11 = D0–D10, 12 = 3V3, 13 = GND, 14 = VBUS, 23 = VBAT) | match; GPIO map D0 = GPIO1 … D7 = GPIO44, D8/D9/D10 = SPI SCK/MISO/MOSI |
| JST B2B/S2B | 2 + MP | JST ePH.pdf | pin 1 = left in the mating-face-down view |

No electrical contradiction with the frozen architecture was found. Items examined and found consistent with the RB-00 documents: electrode path (10 k → hi-Z node with 100 pF, 10 M to VCM, BAV199 to GND/AFE_3V0 → follower), AC coupling and GND-referenced 100 k return, 1 k + BAV199 clamp (pin 2 NC), VCM buffer and unused followers, RLD_SAFE through R5002, VBAT star → R4001 4.7 Ω → C4007 → TPS7A2030, EN pull-down/Q3001/R3007 inhibit, FB1 DVDD filter, SPI source terminations and pull-ups, VBAT and USB sense dividers, test-point policy.

### 2.2 Fresh export, audit, mutation

```
kicad-cli sch export netlist --format kicadxml   (10.0.6, from the 5 .kicad_sch files)
rb01r_netlist_audit.py        23/23 check groups PASS
external_supplied audit       67/67 PASS     (unmodified supplied checker, real export)
test_audit_mutations.py       1510 mutants, 1510 killed, 0 survivors, no vacuous check
                              (+31 no-op "mutants" identified by circuit fingerprint and excluded:
                               moves of already-open pins, follower OUT/IN− swaps, NC-pin swaps)
external_supplied mutation    11/11 detected
```

Mutant classes: every one of the pins moved to GND, to a second net and to an open net (1053 non-trivial moves), 97 value changes, 135 component deletions, 116 pin swaps, 67 symbol-pin-name corruptions, 20 BOM-field regressions (old X1 MPN/LCSC/footprint, blank fields, DNP/exclude flags), 4 forbidden parts (R_OPT0 bridging VBAT_AFE↔3V3, R_SDA, U_ID, Q3002), 18 named historical defects (Rev A J5001.1 on GND, clamp before the 1 k, D3 straight to EN, BAT+ on VBAT_AFE, J1 reversed …).

Demonstration that the tools see the real export (and not only synthetic data): run on the **pre-RB-01R** export, the audit fails exactly the identity items RB-01R changed (X1 MPN, J1 MPN, missing LCSC fields) and passes the other 22 groups; on the corrected export all pass.

Independence caveat (also in `tools/README.md`): the rule author also read the netlist. The datasheet tables (`D02`) and the exhaustive mutation suite are the defence against a shared misreading; they are not a formal proof.

## 3. ERC and footprint-link accounting

`kicad-cli sch erc --severity-all` (default severities, no exclusions, project has no `erc` section):

| Severity | Type | Count | Classification |
|---|---|---|---|
| error | any | **0** | — |
| warning | `footprint_link_issues` | **2** | X1 `ARTHUR:OSC_SCTF_SX3M_SMD3225-4P`, U1 `ARTHUR:XIAO_ESP32S3_HANDSOLDER`: custom footprints defined by the qualification document, **not authored until RB-02** |
| warning | anything else | **0** | — |

RB-01 reported 81 `footprint_link_issues`. The 79 stock-package warnings existed only because the authoring host had no KiCad footprint libraries. They are cleared **without suppression** by vendoring the exact KiCad 10.0.0 footprints (unmodified, 12 files) into `fp-libs/` with a project `fp-lib-table`; the pad geometry of each is compared with the manufacturer drawings in `REVB_RB01R_FOOTPRINT_QUALIFICATION.md`.

## 4. ADC operating requirements and the diode correction

All numbers are produced by `tools/rb01r_calcs.py` from datasheet constants.

### 4.1 Limits (ADS131M04 SBAS890D)

| Quantity | Value |
|---|---|
| Absolute maximum, each AIN | AGND − 1.6 V … AVDD + 0.3 V (§6.1) |
| Recommended, gain 1/2/4 | AGND − 1.3 V … AVDD |
| Recommended, gain 8…128 | AGND − 1.3 V … AVDD − 1.8 V (1.155 V at AVDD 2.955 V) |
| Differential | ±1.2 V / gain (±1.2 V, 600, 300, 150, 75, 37.5, 18.75, 9.375 mV) |
| Input bias | 0.6 µA (gain ≤ 4) / 0.2 µA (gain ≥ 8), (IBP+IBN)/2 typ; through 100 k → 60 / 20 mV common-mode, sign unspecified; **IBP/IBN mismatch is not specified** |
| CLKIN | 0.3…8.4 MHz (HR mode), duty 40–60 % (tw ≥ 49 ns), VIH ≥ 0.8·DVDD |

AIN DC ≈ 0 V (GND-referenced bias) lies inside the recommended window **for every gain**; common-mode pickup (50/60 Hz) is passed by the 0.72 Hz high-pass, so |AIN| must stay below 1.1 V at gain ≥ 8 and above −1.3 V at any gain.

### 4.2 "PGA gain ≥ 4" → REMOVED

The RB-00.5 contract rested on "Is ≤ 4.4 pA, derived from VF max". That derivation is **backwards**: VF(max) at a given IF means the diode conducts IF at or below that voltage, i.e. it bounds Is from *below* (Is ≥ IF/exp(VF/nVT)). No upper bound follows. Independently, gain only changes the PGA; whether a BAV199 conducts depends on the pin voltage. The contract is withdrawn from every document (INTERFACE_SPEC §9, POWER_ARCHITECTURE, ARCHITECTURE_PROPOSAL, MIGRATION_MATRIX, RB00_CLOSURE, RB01 report, schematic note) and replaced by the limits above. **No gain setting is unsafe for the hardware.**

### 4.3 What the datasheet can and cannot bound

* Upper bound used: Is ≤ IR(max, 75 V) = 5 nA @25 °C; 80 nA @150 °C → doubles every 31 K → 7.8 nA @45 °C (RB-00.5 had guessed ×4 → 20 nA); n ≥ 1 is the only limit on the ideality factor.
* Zero-bias resistance ≥ n·VT/Is = 5.1 MΩ (25 °C) / 3.5 MΩ (45 °C) → HPF corner 0.72 → 0.75 Hz; CM→DM from the resulting 2.8 % R mismatch ≈ −67 dB at 50 Hz (below the existing ±10 % C mismatch floor of −57 dB). The RB-00.5 figures (1.3 MΩ, −58 dB) were conservative guesses and are replaced.
* Rigorous upper bound on one clamp's forward current (45 °C, n = 1): 3.4 nA @10 mV, 7.8 nA @19 mV, 23 nA @37.5 mV, 0.11 µA @75 mV, 1.8 µA @150 mV, **0.44 mA @300 mV**. Equivalent nonlinear error through the 4.6 kΩ signal-band source: −71 / −65 / −57 / −45 / −25 dB re the amplitude at 10 / 19 / 37.5 / 75 / 150 mV. These are datasheet-extremum bounds, not predictions: typical IR is 3 pA and Fig. 2 shows conduction only above ≈ 0.6 V. **The datasheet cannot guarantee linearity above a few tens of mV; this is documented rather than hidden.**
* Required measurement (bring-up item, before any human use): shorted-input offset/noise and a 10 Hz–500 Hz large-signal sweep of one populated channel at gains 8/16/32 with the clamps fitted, comparing THD with and without a BAV199 populated.

### 4.4 Transients

| Event | Result | Margin |
|---|---|---|
| Shutdown / inhibit, worst case (V_C up to 3.05 V, ≤ 3.1 mA through 990 Ω): AIN ≥ −(VF(10 mA) = 1.00 V + 0.09 V cold) = **−1.09 V** | uses only the 10 mA VF maximum, valid for any IF ≤ 10 mA | 0.21 V to the recommended −1.3 V; 0.51 V to absolute maximum |
| Peak clamp current | ≤ 2.2 mA (VF(1 mA) = 0.9 V) / 3.1 mA ignoring VF | ADC pin limit 10 mA |
| Power-up: AIN steps to the follower output (1.5 V typ, 1.84 V with 300 mV electrode offset, 3.05 V if a follower saturates) and decays with τ = 100 k × C (C derated 50–100 % of 2.2 µF → 0.11–0.22 s) | above the gain ≥ 8 ceiling 1.155 V for ≤ 0.21 s; never above AVDD | absolute maximum AVDD + 0.3 V respected at every instant |
| Settling | 5τ ≤ 1.1 s | firmware: standby or gain ≤ 4 until ≥ 0.3 s after AFE_EN, data valid after ≥ 1.1 s |
| AVDD-off / DVDD-alive | AIN ≤ 0 V (no positive path; hi-Z nodes clamped to GND by D1 diodes via the collapsed rail) | AIN ≤ AVDD + 0.3 V |

### 4.5 Gain policy (performance recommendation only)

ADC input-referred noise at 1 kSPS (Table 7-1): gain 1/4/8/16/32/64/128 = 3.38/2.88/1.74/1.17/0.77/0.77/0.77 µVrms. Front-end (2 × 10 kΩ + TLV9064 16 nV/√Hz, 20–450 Hz, skin impedance excluded) ≈ 0.6 µVrms. Noise stops improving at gain 32; full scale there is ±37.5 mV, which a motion-artefact-prone surface EMG may exceed. **Recommended 8–32, default 16, final choice by bench measurement.** This is not a hardware requirement.

## 5. X1 — SCTF SX3M8.192M20F30TNN (LCSC/JLC C2901557) → FROZEN

Source: SCTF "Multi Voltage MHz Crystal Oscillator 0CM–7CM", revision 05/12/2026, the PDF LCSC/JLC serve for C2901557 (9 pp., image-only; read visually; dimensions confirmed at 300 ppi). LCSC and JLC pages read 2026-10-10.

| Check | Datasheet | Requirement | Result |
|---|---|---|---|
| Order-code decoding | `SX` SCTF · `3M` 3.2×2.5×0.95 mm · `8.192` MHz · `M` 1.62–3.63 V · `20` ±20 ppm tolerance · `F` −40…+85 °C · `30` ±30 ppm drift · `T` CMOS 15 pF · `N` std. current · `N` std. phase noise | 8.192 MHz CMOS, 3.3 V | **PASS** |
| Frequency | 1–54 MHz family range; 8.192 MHz = 1 MHz ≤ f < 40 MHz band | ADS131M04 HR mode 0.3–8.4 MHz, nominal 8.192 | **PASS** (+50 ppm worst-case offset stays ≪ 8.4 MHz) |
| VDD | 1.62–3.63 V | DVDD_F = XIAO 3V3 (3.3 V, ≤ 3.4 V at +3 %) | **PASS**, ≥ 0.23 V headroom (RB-00.5 YXC part had none) |
| Absolute maximum | **not published** in the manufacturer sheet | — | **Residual X-1a** (see below) |
| Output | VOH ≥ 0.9·VDD, VOL ≤ 0.1·VDD, 15 pF | ADS CLKIN VIH ≥ 0.8·DVDD, VIL ≤ 0.2·DVDD, same rail | **PASS** (10 % margin each side) |
| Duty cycle | 45–55 % at 50 % VDD, ≤ 15 pF | ADS 40–60 %; tw ≥ 49 ns → 0.45 × 122 ns = 55 ns | **PASS** (6 ns margin) |
| Rise/fall | ≤ 5 ns (10–90 %) | 33 Ω source termination at X1 | **PASS** |
| Start-up | ≤ 5 ms to 90 % amplitude | XO powers with the XIAO seconds before the ADC reset is released | **PASS** |
| Current | Icc ≤ 10 mA (1 MHz ≤ f < 40 MHz, 15 pF) | DVDD_F budget §6 | **PASS** |
| Load | 15 pF | 33 Ω + ≤ 6 mm trace + CLKIN ≈ 5–8 pF | **PASS** |
| OE | pin 1 high or open = enabled; low = disabled | always on → tie to DVDD_F | **PASS** (tied) |
| Pinout | 1 Tri-state, 2 GND, 3 Output, 4 Vdd; pin 1 dot bottom-left in the top view | as schematic | **PASS** |
| Package | 3.2 ± 0.1 × 2.5 ± 0.1 × 0.95 ± 0.15 mm | ≤ 1.2 mm component height band | **PASS** |
| Land pattern | pad centres 2.2 × 1.75 mm, pads 1.2 × 0.95 mm (package pads 0.9 × 0.65/0.8, gap 1.0) | author at RB-02 | **Defined**, footprint qualification §3 |
| Stability | ±20 ppm @25 °C, ±30 ppm −40…85 °C, aging ±3 ppm first year; 8 MHz sample curves within ±17 ppm | EMG sampling-rate accuracy (non-critical) | **PASS** |
| MSL | JLC page: MSL 1; datasheet reflow: peak 260 °C (Pb-free), ≤ 2 reflows | JLC SMT | **PASS** |
| JLC | library type *expand* (Extended); PCBA type **Economic and Standard**; SMT | Economic PCBA | **PASS** |
| Stock / cost | LCSC 1,658 pcs; $0.3482 @1, $0.2661 @100, $0.2332 @500 | — | available; JLC order-time stock to be re-confirmed at RB-03 |

Residuals (non-blocking, recorded in the schematic *Status* field and the BOM):

* **X-1a** The manufacturer publishes no absolute-maximum table. The design stays inside the stated 1.62–3.63 V operating range with ≥ 0.23 V headroom; request a written abs-max statement from SCTF before a production order.
* **X-1b** 8.192 MHz is not in the datasheet's "list of available part numbers" (standard frequencies 8/12/16/24/25/27/50 MHz; "contact us for available frequencies"). The part is a catalogue line with its own LCSC datasheet copy (file name `…SX3M8-192M20F30TNN_C2901557`) and decodes validly. Verify marking and a scope measurement of 8.192 MHz on the first reel.
* **X-1c** JLC CPL rotation: pin-1 marker in the JLC preview.

Changed in the schematic: value, MPN `SX3M8.192M20F30TNN`, Manufacturer `SCTF (Shenzhen SCTF Elec)`, LCSC `C2901557`, footprint `ARTHUR:OSC_SCTF_SX3M_SMD3225-4P`, datasheet URL, description, spec, JLC class, status, sheet note (symbol library and the instance). **No connection changed.**

## 6. DVDD_F worst-case current (replaces the 5.5 mA figure)

| Load | mA | Basis |
|---|---|---|
| ADS131M04 IDVDD, HR mode, SPI idle | 0.50 | SBAS890D §6.5 max |
| ADS131M04 SPI activity (DOUT 20 pF @ 8 MHz) | 0.50 | allowance |
| X1 SCTF SX3M | **10.00** | datasheet max (15 pF) |
| R7104 10 k SYNC/RESET pull-up, driven low at 3.6 V | 0.36 | — |
| R7103 100 k CS pull-up, driven low at 3.6 V | 0.04 | — |
| **Total worst case** | **11.4** | |

| Margin | Value |
|---|---|
| XIAO 3V3 (Seeed: "you can draw 700 mA") | 11.4 mA = 1.6 % of it; 688.6 mA left for the ESP32 (the buck's RF-burst headroom is Seeed's, not re-measured) |
| FB1 (0603 600 Ω@100 MHz, ≥ 200 mA, DCR ≤ 0.5 Ω) | 5.7 % of rating (×18); DC drop 5.7 mV |
| DVDD at U6001/X1 | 3.3 V − 6 mV; limits ADC 2.7–3.6 V, X1 1.62–3.63 V → ≥ 0.3 V |
| Decoupling | C7101 10 µF + C7102 100 nF + C6008 1 µF + C6010 100 nF at X1; X1 edge ripple 10 mA × 61 ns / 100 nF ≈ 6 mV |
| Traces/vias | ≈ 11 mA is two orders below any routed width/via; rules in MANUFACTURING_CONSTRAINTS unchanged |

## 7. J1 — JST S2B-PH-SM4-TB(LF)(SN), JLC C295747 → FROZEN

| Check | Evidence | Result |
|---|---|---|
| Exact part / series | JST ePH.pdf "Header (SMT type), Side entry": S2B-PH-SM4-TB, A = 2.0, B = 7.9; `(LF)(SN)` = lead-free, tin | PASS |
| Pin numbering | "No. 1 circuit" at the left end with the mating face toward the bottom of the layout view; KiCad pin 1 at x = −1.0 | PASS (pin 1 = BAT+ **by this design**) |
| Land pattern vs drawing | measured from the JST vector drawing (scale 6.2 u/mm): signal pads 1.0 × 3.5 mm @ 2.0 mm; retention pads 1.5 × 3.4 mm, 2.35 mm outboard (drawing 2.33 ± 0.1); pad-to-retention gap 2.3 mm | **PASS** (KiCad 10.0.0 footprint equal) |
| Mating direction | side entry, plug parallel to the PCB; mating face opposite the solder tails; envelope 9.6 mm with plug, height 5.5 mm | RB-02 layout rule |
| Retention | two reinforcement tabs soldered (MP, no net) | PASS |
| Ratings | 2 A AC/DC (AWG24), 100 V AC/DC, −40…+105 °C, contact ≤ 10 mΩ | PASS (battery peak ≤ 0.35 A) |
| Mating | housing PHR-2 + contacts SPH-002T-P0.5S (AWG 30–24); PH 2-circuit has no polarisation feature in the catalogue drawing | harness requirement below |
| JLC | C295747, library *expand* (Extended), PCBA type Economic and Standard, MSL 1, stock 14,405, $0.2387 @5 → $0.1475 @1000 | PASS |

**Battery polarity remains an explicit assembly verification requirement:** JST-PH does not define lead polarity and a 2-pin PH plug is not keyed. Before the first connection verify with a meter that the cell lead on J1 pin 1 is the positive terminal; there is no reverse-polarity protection on Rev B (neither on the XIAO BAT pad). Recorded in the J1 `Spec` field, `REVB_XIAO_ASSEMBLY_PROCEDURE.md` pre-mount check 5 (line 37) and the risk table.

Also added: LCSC **C160352** for the five B2B-PH-SM4-TB(LF)(SN) electrode connectors (Extended, Economic and Standard PCBA, MSL 1, stock 10,600).

## 8. Optional parts and C_PRE

* **R_OPT0, U_ID, R_SDA, R_SCL: OMITTED. D4/D5 remain NC.** R_OPT0 is obsolete since the RB-00.6 BAT+ post; if fitted with a battery present it would tie VBAT_AFE (VBAT via 4.7 Ω, up to 4.2 V) to the XIAO 3V3 buck output. It must not be re-added without a new review. Enforced by audit checks `D10` and `R02`.
* **C_PRE = C4007 = one 22 µF 10 V X5R 0805.** Electrically: R4001 4.7 Ω with ≈ 10 µF effective at 4 V → corner 3.4 kHz (1.5 kHz at the nominal 22 µF); a second 22 µF "C_BAT" ahead of R4001 would not change that filter, would duplicate the XIAO module's own BAT-side capacitance, and appears in no electrical document, BOM, or cost model. The `REVB_XIAO_MOUNTING_SPEC.md` wording is corrected; no component added. Enforced by audit check `R01`.

## 9. Files changed

Schematic / libraries (connectivity unchanged): `adc.kicad_sch`, `analog_power_interlock.kicad_sch`, `emg_channel.kicad_sch` (note), `reference_vcm.kicad_sch`, `ARTHUR_RevB.kicad_sym`; new `fp-lib-table`, `fp-libs/` (12 stock footprints, README, empty `ARTHUR.pretty`).
Documents: `REVB_INTERFACE_SPEC.md`, `REVB_POWER_ARCHITECTURE.md`, `REVB_ARCHITECTURE_PROPOSAL.md`, `REVB_MIGRATION_MATRIX.md`, `REVB_COST_MODEL.md`, `REVB_MANUFACTURING_CONSTRAINTS.md`, `REVB_DIRECT_XIAO_ARCHITECTURE.md`, `REVB_XIAO_MOUNTING_SPEC.md`, `REVB_RB00_CLOSURE.md` (corrections marked **[RB-01R]**), `REVB_RB01_BOM.md`, `REVB_RB01_SCHEMATIC_REPORT.md`, `REVB_RB01_NETLIST_AUDIT.md` and `REVB_RB01_ERC_REPORT.md` (banners), this file and `REVB_RB01R_FOOTPRINT_QUALIFICATION.md`.
New tooling: `rev-b-xiao/tools/` (`rb01r_netlist_audit.py`, `test_audit_mutations.py`, `rb01r_calcs.py`, `run_rb01r_checks.sh`, `rev_a_baseline.txt`, `README.md`, `external_supplied/`).
Not changed: Rev A (both trees), the Rev B architecture, any net.

## 10. Remaining risks and blockers

| ID | Item | Class |
|---|---|---|
| R3/R9 | Physical XIAO ESP32S3 **plain** v1.4 module dimensions/BAT+ pad position not measured (Seeed files are the Sense v1.5 layout); incoming inspection of ≥ 2 modules **before RB-02** | **blocks RB-02** |
| FP-1 | `ARTHUR:OSC_SCTF_SX3M_SMD3225-4P` and `ARTHUR:XIAO_ESP32S3_HANDSOLDER` are defined but not authored | RB-02 task (2 ERC warnings) |
| X-1a/b | SCTF absolute maximum unpublished; 8.192 MHz outside the sheet's standard list | accepted residuals, check at first reel |
| D-1 | BAV199 clamp leakage/linearity not provable from the datasheet | bench measurement before human use |
| Q-1 | Q3001 open-circuit single point (inherited) | defence in depth only |
| P-1 | Passive MPNs (21 generic lines), Q3001 maker, BAV199 packing suffix, ceramic DC-bias of 2.2 µF/22 µF/10 µF | RB-03 BOM freeze |
| S-1 | Unisolated board: USB ground is common with electrodes; "no electrodes while USB connected" is an operating rule, not a hardware guarantee; no isolation or medical-safety claim | permanent |

A passing ERC or netlist audit is **not** a patient-safety proof. This is an unisolated experimental EMG prototype; simultaneous electrode attachment and USB connection remain prohibited.

## 11. Final gate

```
RB-01 ELECTRICAL DESIGN:
PASS (no architectural contradiction; 357-pin connectivity unchanged)

INDEPENDENT PIN-BY-PIN REVIEW:
PASS (7 devices + 2 connector types against manufacturer pin tables)

FRESH NETLIST AUDIT:
PASS (23/23 groups on a fresh kicad-cli 10.0.6 export; supplied checker 67/67)

MUTATION TESTS:
PASS (1510/1510 killed, 0 survivors, no vacuous check; supplied suite 11/11)

PGA >= 4 REQUIREMENT:
REMOVED

ADC OPERATING LIMITS:
VERIFIED (datasheet-derived; clamp linearity/leakage explicitly requires bench measurement)

RB-00.5 DIODE CALCULATION:
CORRECTED

X1:
FROZEN
MPN: SX3M8.192M20F30TNN (SCTF, LCSC/JLC C2901557)
DVDD_F WORST-CASE CURRENT: 11.4 mA
DVDD_F MARGIN: 1.6 % of the 700 mA XIAO 3V3; FB1 at 5.7 % of rating; >= 0.3 V voltage headroom

J1:
FROZEN
MPN: S2B-PH-SM4-TB(LF)(SN)
JLC PART: C295747

CRITICAL FOOTPRINT QUALIFICATION:
PARTIAL (8 of 10 groups geometry-verified PASS; X1 and XIAO land patterns defined but footprints not authored: RB-02)

OPTIONAL DNP PARTS:
R_OPT0, U_ID, R_SDA, R_SCL omitted; D4/D5 NC

C_PRE / C_BAT:
C4007 = C_PRE, the single 22 uF; "C_BAT" was stale wording, corrected

ERC ERRORS: 0
ERC ELECTRICAL WARNINGS: 0
FOOTPRINT-LINK WARNINGS: 2 (X1, U1: custom footprints, RB-02); 79 stock warnings cleared by vendored KiCad 10.0.0 libraries, no suppression

INDEPENDENT AUDIT:
PASS

REV A HASH UNCHANGED:
YES (PCB d7a585e8...0005; tracked tree d5d72289...2c67)

SCHEMATIC CHANGES: X1 identity/footprint/metadata; J1 MPN+LCSC; B2B LCSC; one sheet note; no connection changed
DOCUMENTATION CHANGES: 13 existing documents corrected, 2 new
TOOLING ADDED: rev-b-xiao/tools (audit, mutation, calcs, runner, baseline)

REMAINING RISKS: see §10
BLOCKERS: R3/R9 physical XIAO plain-module measurement (blocks RB-02 start only)

RB-01 FROZEN:
YES

READY FOR RB-02:
NO (single blocker: R3/R9)
```

## Sources

* TI ADS131M04 SBAS890D rev D (May 2021): https://www.ti.com/lit/ds/symlink/ads131m04.pdf
* TI TLV9064 SBOS839N: https://www.ti.com/lit/ds/symlink/tlv9064.pdf
* TI TPS7A20 SBVS338H: https://www.ti.com/lit/ds/symlink/tps7a20.pdf
* Nexperia BAV199 (2023-04-01): https://assets.nexperia.com/documents/data-sheet/BAV199.pdf
* Nexperia 2N7002: https://assets.nexperia.com/documents/data-sheet/2N7002.pdf
* SCTF SX3M exact-code datasheet (LCSC): https://wmsc.lcsc.com/wmsc/upload/file/pdf/v2/lcsc/2110091030_Shenzhen-SCTF-Elec-SX3M8-192M20F30TNN_C2901557.pdf ; LCSC https://www.lcsc.com/product-detail/C2901557.html ; JLC https://jlcpcb.com/partdetail/C2901557
* JST PH catalogue: https://www.jst-mfg.com/product/pdf/eng/ePH.pdf ; JLC https://jlcpcb.com/partdetail/C295747 , https://jlcpcb.com/partdetail/C160352
* Seeed XIAO ESP32S3 wiki: https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/ ; footprint/symbol: https://github.com/Seeed-Studio/OPL_Kicad_Library
* KiCad footprints 10.0.0: https://gitlab.com/kicad/libraries/kicad-footprints
