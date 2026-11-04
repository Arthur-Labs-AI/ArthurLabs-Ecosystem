# A.R.T.H.U.R EMG Rev B — RB-01 Schematic Implementation Report

> **RB-01R (2026-10-10):** this is the RB-01 record. Superseded: X1 is now SCTF SX3M8.192M20F30TNN (C2901557); J1 is frozen as S2B-PH-SM4-TB(LF)(SN) (C295747); the "PGA gain ≥ 4" contract is withdrawn; §7.1 (R_OPT0/U_ID/R_SDA/R_SCL) and §8 (C_BAT) are closed; footprint libraries are now vendored (REVB_RB01R_FOOTPRINT_QUALIFICATION.md). See REVB_RB01R_INDEPENDENT_REVIEW.md.

Status: **RB-01 schematic created**. Schematic only: no `.kicad_pcb`, placement, routing, Gerber, CPL or production output exists.
Date: 2026-09-28. Tool: `10.0.6` (kicad-cli). Role: implementer (architecture frozen by RB-00 / RB-00.5 / RB-00.6, precedence RB-00.6 > RB-00.5 > RB-00).

Companion reports: [REVB_RB01_NETLIST_AUDIT.md](REVB_RB01_NETLIST_AUDIT.md) · [REVB_RB01_ERC_REPORT.md](REVB_RB01_ERC_REPORT.md) · [REVB_RB01_BOM.md](REVB_RB01_BOM.md)

## 1. Pre-work record

| Item | Value |
|---|---|
| Branch | `feature/ads131m04-cost-first` |
| HEAD | `45fb9a480d98fdd4a7665ddd30bf1a4f22cb35d4` (`feat(emg-pcb): freeze Phase 3B analog routing`) |
| `git status --short` before work | 366 entries, **all untracked (`??`)**: the 11 `REVB_*.md` RB-00 documents, `XIAO_MOUNTING_1TO1.{pdf,py}` and Rev A phase scratch files. **0 tracked files modified** |
| Rev A production PCB before work | `hardware/emg/rev-a-cost/kicad/ARTHUR_EMG_RevA_Cost/ARTHUR_EMG_RevA_Cost.kicad_pcb` → `d7a585e8ae46299215d26c0aa58ea0ca5829d46ce72a45d279290263e94a0005` (**matches**) |
| Rev A copper used as ground truth | Pad→net map extracted read-only from the production PCB (U6001 AIN pin order, BAV199 pinning 1 = GND / 2 = AFE_3V0 / 3 = node, TLV9064 section per channel, U503 B/C/D followers, 2N7002 1 = G / 2 = S / 3 = D, TPS7A2030 SOT-23-5 pinning) |

## 2. Files created

Project directory: `hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB/`

| File | SHA-256 |
|---|---|
| `adc.kicad_sch` | `2f7230865d74bfc88cafda74962cf664305382e45fe6478e278d27a7f253307d` |
| `analog_power_interlock.kicad_sch` | `e70d686328abadc173d7333842272ac88182ec6efa722a3479fa582164484127` |
| `ARTHUR_EMG_RevB.kicad_pro` | `1a5ea1808b46f00ed00ccefc21a44ac48e1ef6c4f2083b77e3fe5a15bf0a3bda` |
| `ARTHUR_EMG_RevB.kicad_sch` | `d2a18b130471362a94f7a8d40d8afd8da463d2a0629cd897e72598e6eeae7cdb` |
| `ARTHUR_RevB.kicad_sym` | `d615e865c22fdb76ad212c735ea55c7d88d49f7bf904783019f6747a946d0562` |
| `emg_channel.kicad_sch` | `1cd41ad6be6e0fddb882c5b1b58afb500da907ab20d59a5eabce10655bb52158` |
| `reference_vcm.kicad_sch` | `903795b88ae8c0c7bacf8d7ae5f65f8b4b9189f2d792f66012104cad4e2d239d` |
| `sym-lib-table` | `fd599146dee6f251c34a74b1e975c3660c69e331696478fd32c1b04946127b02` |
| `xiao_brain_interface.kicad_sch` | `7591ea41b144661d78c8a7ac445c758f78fa541963f0159e57cd793f9984cd22` |

Why more than two files:
- A hierarchical schematic needs one `.kicad_sch` per sheet. The required hierarchy (4 × `emg_channel`, `reference_vcm`, `adc`, `analog_power_interlock`, `xiao_brain_interface`) therefore needs 5 sub-sheet files; `emg_channel.kicad_sch` is **one file instanced 4 times**.
- `ARTHUR_RevB.kicad_sym` is the project-local symbol library. It is **strictly required**: the authoring host has **no KiCad stock symbol libraries installed** (`/usr/share/kicad` contains only `template/kicad.kicad_pro`), and Rev A's `ARTHUR.kicad_sym` is ADS1294-era and inconsistent (e.g. `R_BIAS` used for capacitors).
- `sym-lib-table` registers that library for the project (without it every symbol fails library resolution).
- Not created: `.kicad_pcb`, `.kicad_dru`, footprint libraries, `.kicad_prl` (kicad-cli created one during ERC; it was deleted, it is also git-ignored by `**/*.kicad_prl`).

Method: the files were produced by a generator script (kept outside the repo, in the session scratchpad) that writes every symbol and connection, then normalised with `kicad-cli sch upgrade --force` / `kicad-cli sym upgrade --force` into native KiCad 10 format (file version 20260306). Connections are drawn as a wire stub from every pin end to a label, hierarchical label, power symbol or no-connect flag. ERC, netlist, BOM and PDF were then produced by kicad-cli from the files **in the repo location**; the SHA-256 table above was re-verified after those runs (unchanged).

## 3. Hierarchy

| Page | Sheet name | File | Content | References |
|---|---|---|---|---|
| 1 | Root | `ARTHUR_EMG_RevB.kicad_sch` | Sheet symbols, inter-sheet nets, architecture notes | — |
| 2–5 | CH1 … CH4 | `emg_channel.kicad_sch` (×4) | One bipolar channel incl. RB-00.5 ADC-input clamps | J n01, R n01–R n08, C n01–C n07, D n01–D n04, U501/U502 section (n = 1…4) |
| 6 | Reference_VCM | `reference_vcm.kicad_sch` | VCM divider, R5005 10 k, U503A buffer, U503 B/C/D, R5002, J5001, op-amp supply units + decoupling, TP4/TP5/TP7 | R5002–R5005, C5001, C5002, U503, C501–C503, J5001 |
| 7 | ADC | `adc.kicad_sch` | ADS131M04, decoupling, X1, 33 Ω CLK, 33 Ω MISO, 100 Ω DRDY | U6001, C6007–C6010, X1, R6001–R6003 |
| 8 | Analog_Power_Interlock | `analog_power_interlock.kicad_sch` | J1, RC pre-filter, TPS7A2030P, hardware USB inhibit, 4.7 k VBUS load, TP1/TP2/TP6 | J1, R4001, C4005–C4007, U4002, C4006, Q3001, R3004, R3006–R3009 |
| 9 | XIAO_Brain_Interface | `xiao_brain_interface.kicad_sch` | U1 XIAO (DNP), DVDD filter, SPI source terms, CS/SYNC pull-ups, VBAT and USB_PRESENT dividers, TP3/TP8 | U1, FB1, C7101–C7103, R7101–R7108 |

Per-instance op-amp sections (KiCad per-instance unit, verified in the exported netlist): CH1 = U501 A (+IN 3) / B (+IN 5), CH2 = U501 C (+IN 10) / D (+IN 12), CH3 = U502 A / B, CH4 = U502 C / D. Identical to Rev A copper.

Supplies are global power symbols: `VBAT`, `AFE_3V0`, `DVDD_F`, `GND` (one net, no split). Every other inter-sheet signal is a hierarchical pin: `CH1_P … CH4_N`, `VCM`, `SCLK`, `MOSI`, `MISO`, `CS_N`, `DRDY_N`, `SYNC_RESET_N`, `AFE_EN_REQ`, `XIAO_5V`.

## 4. Implementation against the frozen requirements

| # | Requirement | Implementation (refs / values) | Evidence |
|---|---|---|---|
| 1 | Four identical EMG channels | electrode J n01 → R n01/R n02 10 k 1 % → hi-Z node (D n01/D n02 BAV199 to GND/AFE_3V0, C n03/C n04 100 pF C0G to GND, R n05/R n06 10 M 5 % to VCM) → TLV9064 unity follower → C n01/C n02 2.2 µF 16 V X7R → R n03/R n04 100 k to GND → R n07/R n08 1.0 k → AIN. AAF kept: C n06/C n07 1.0 nF C0G to GND, C n05 10 nF C0G differential | Audit C1 PASS |
| 2 | RB-00.5 ADC shutdown clamps | D n03 / D n04 BAV199: pin 1 GND, pin 3 AIN (ADC side of R n07/R n08), pin 2 NC flag. 8 parts. 100 k returns stay GND | Audit K2/K3/K4 PASS/PASS/PASS |
| 3 | VCM / reference | AFE_3V0 → R5003/R5004 100 k/100 k → `VCM_DIV` (C5001 1 µF + C5002 100 nF at the node) → **R5005 10 k** → `VCM_BUF_IN` → U503A (+IN 3, OUT 1 = −IN 2) → `VCM`. U503 B/C/D: unity followers with +IN on VCM (TI unused-amp guidance: buffer, +IN at a mid-supply voltage inside the CM range). No DRL loop | Audit V1/V2 PASS/PASS |
| 4 | Patient reference connector | J5001 pin 1 **NC flag**, pin 2 = `RLD_SAFE`, MP = NC flag. VCM → R5002 100 k 0805 → RLD_SAFE → J5001.2 | Audit A1/A2/A3 PASS/PASS/PASS |
| 5 | ADC | U6001 ADS131M04IPWR: AVDD (1) = AFE_3V0 + C6007 1 µF; DVDD (20) = DVDD_F + C6008 1 µF; CAP (18) = C6009 220 nF; AGND (2)/DGND (19) = GND. DVDD 2.7–3.6 V internal-LDO mode | Audit P1 PASS |
| 6 | Local ADC clock | X1 YXC OT2JI-111-8.192M (LCSC C7425393): OE (1) and VDD (4) = DVDD_F, C6010 100 nF, OUT (3) → R6001 33 Ω → U6001 CLKIN (17). Status field keeps the RB-00.5 R4 residuals (family datasheet, 3.3 V top of range, CPL rotation) | Audit P2 PASS |
| 7 | AFE power | J1.1 = VBAT (star node) → U1 pad 23 (BAT+ post) and → R4001 4.7 Ω → `VBAT_AFE` (C4007 22 µF 10 V X5R 0805 + C4005 1 µF at IN) → U4002 TPS7A2030PDBVR → AFE_3V0 (C4006 1 µF). AFE_3V0 feeds only U6001 AVDD, U501–U503, the VCM divider and the 8 hi-Z clamp rails | Audit P4/P5 PASS/PASS |
| 8 | DVDD | U1 pad 12 (XIAO 3V3) → `XIAO_3V3` → FB1 600 Ω@100 MHz → DVDD_F (C7101 10 µF + C7102 100 nF). DVDD_F feeds U6001 DVDD, X1, R7103, R7104 only | Audit P3 PASS |
| 9 | XIAO interface | D0 VBAT_SENSE, D1 DRDY_N, D2 SYNC_RESET_N, D3 AFE_EN_REQ, D4/D5 NC, D6 USB_PRESENT, D7 CS_N, D8 SCLK, D9 MISO, D10 MOSI, 3V3 → FB1, GND, 5V = XIAO_5V, pad 23 BAT+ = VBAT. U1 is `DNP` | Audit X1 PASS |
| 10 | SPI conditioning | R7101 33 Ω SCLK and R7102 33 Ω MOSI at the XIAO end; R6002 33 Ω MISO at the ADC DOUT; R6003 100 Ω DRDY at the ADC; R7103 100 k CS_N and R7104 10 k SYNC/RESET_N pull-ups to DVDD_F. Firmware default SCLK 4 MHz (no schematic impact) | Audit S1 PASS |
| 11 | Hardware USB inhibit | D3 → R3007 10 k → `AFE_EN` (= U4002 EN); R3008 100 k AFE_EN → GND; Q3001 2N7002 D = AFE_EN, S = GND, G = `VBUS_GATE`; XIAO_5V → R3006 10 k → VBUS_GATE, R3004 100 k → GND; R3009 4.7 k XIAO_5V → GND. No Q3002 / R3005 | Audit I1–I6 all PASS |
| 12 | Battery sensing | VBAT → R7107 1 M → `VBAT_SENSE` (label) → R7108 1 M → GND, C7103 100 nF → D0 (2.1 µA) | Audit B1 PASS |
| 13 | USB-present sense | XIAO_5V → R7105 100 k → `USB_PRESENT` → R7106 150 k → GND → D6 only | Audit B2/I5 PASS/PASS |
| 14 | BAT+ post | U1 pin **23 "BAT+ (bottom pad → POST)"** is a separate pin, drawn on the bottom of the symbol and not among the castellations 1–14; sheet note documents pad → AWG24 solid post → plated Ø1.40 hole at (68.335, 21.862) → Ø3.00 B.Cu pad → VBAT. BAT− has no post (castellation 13) | Audit P6 PASS |
| 15 | Test points | TP1 VBAT, TP2 AFE_3V0, TP3 DVDD_F, TP4 VCM, TP5 RLD_SAFE, TP6 AFE_EN, TP7 GND (analog end), TP8 GND (brain end). Bare pads: `in_bom no`, `in_pos_files no`. None on hi-Z, AIN, SPI, CLKIN | Audit T1 PASS |
| 16 | Removals | No MDBT50Q/U7001, BQ24074, TPS63031, USB-C, CC resistors, USB ESD/data, SWD, Q3002/R3005, charger nets, Rev A TPs, ADS1294-era circuitry | Audit D1 PASS |
| 17 | Library quality | Every component: value, footprint, datasheet (URL or explicit N/A text), description, MPN field, plus Manufacturer / Spec / Role / JLC_Class. Intentional NC pins carry explicit no-connect flags (J n01.MP ×4, J5001.1, J5001.MP, J1.MP, D n03.2/D n04.2 ×8, U4002.4, U1.5, U1.6) | Audit L1 PASS |

## 5. Reference map (RB-00 role names → RB-01 designators)

| RB-00 role | Ref | Value | RB-00 role | Ref | Value |
|---|---|---|---|---|---|
| R_VCMIN | R5005 | 10 k | R_PRE | R4001 | 4.7 Ω |
| R_VBUSLD | R3009 | 4.7 k | C_PRE | C4007 | 22 µF 0805 |
| R_EN_S | R3007 | 10 k | R_EN_PD (replaces Rev A R3003 pull-up) | R3008 | 100 k |
| R_VG_S | R3006 | 10 k | Gate pull-down (Rev A role kept) | R3004 | 100 k |
| C_X1 | C6010 | 100 nF | R_CLK | R6001 | 33 Ω |
| R_MISO | R6002 | 33 Ω | R_DRDY | R6003 | 100 Ω |
| R_SCLK | R7101 | 33 Ω | R_MOSI | R7102 | 33 Ω |
| R_CS_PU | R7103 | 100 k | R_SYNC_PU | R7104 | 10 k |
| R_US1 / R_US2 | R7105 / R7106 | 100 k / 150 k | R_VB1 / R_VB2 / C_VB | R7107 / R7108 / C7103 | 1 M / 1 M / 100 nF |
| FB1 | FB1 | 600 Ω@100 MHz | C_DV1 / C_DV2 | C7101 / C7102 | 10 µF / 100 nF |
| J_BAT | J1 | S2B-PH-SM4-TB | XIAO | U1 (DNP) | XIAO ESP32S3 |
| X1 | X1 | OT2JI-111-8.192M | ADC-input clamps | D103/D104 … D403/D404 | BAV199 |

Designators R3003, R3005, Q3002, C7001/C7002 and all Rev A `TP*` numbers are deliberately **not reused**, so removal audits cannot alias.

## 6. Symbols (project-local `ARTHUR_RevB`)

| Symbol | Pinning source | Notes |
|---|---|---|
| ADS131M04 | SBAS890D Table 5-1, Rev A U6001 pads | 20 pins, power pins `power_in`, DOUT `tri_state`, DRDY `output` |
| TLV9064 | Rev A U501–U503 pads | Units A–D identical geometry (per-instance unit), unit E = V+ 4 / V− 11 |
| TPS7A2030PDBV | Rev A U4002 pads | Pin 4 typed `no_connect` and flagged NC |
| BAV199 | Nexperia, Rev A D101 pads | 1 = A1, 2 = K2, 3 = K1/A2 |
| 2N7002 | Rev A Q3001 pads | 1 = G, 2 = S, 3 = D |
| OSC_CMOS_4P (X1) | RB-00.5 R4 (YSO110TR family) | 1 OE, 2 GND, 3 OUT, 4 VDD |
| XIAO_ESP32S3_HANDSOLDER | Interface spec §1/§8, RB-00.6 | Pins 1–14 castellations, **23 = BAT+ post**; pads 15–22, 24, 25 intentionally absent (not soldered) |
| Conn_2P_MP, R, C, FerriteBead, TestPad | generic | MP pad explicit on every JST |
| GND, AFE_3V0, DVDD_F, VBAT, PWR_FLAG | power | 4 PWR_FLAGs: VBAT, GND, VBAT_AFE, DVDD_F (justified in the ERC report) |

## 7. Implementation decisions and items for the reviewer

These are interpretations made while implementing. None changes a frozen connection.

1. **RB-00 optional DNP parts not instantiated: R_OPT0, U_ID (24C02), R_SDA, R_SCL.** They are listed in the RB-00 migration matrix §6 as DNP options but are absent from the RB-01 frozen list (which says "implement exactly" for the AFE power path and gives the XIAO map without D4/D5). R_OPT0 (0 Ω XIAO 3V3 → LDO input) would, if ever fitted with a battery present, tie VBAT_AFE (VBAT through 4.7 Ω, up to 4.2 V) to the XIAO 3V3 buck output; its purpose (BAT pads unreachable) no longer exists after the RB-00.6 BAT+ post. **Reviewer decision requested**; adding them later is a pure addition.
2. **XIAO D4/D5 = explicit NC** (reserved, interface spec §1).
3. **Footprints.** Stock KiCad 10 names are assigned for standard packages (`Resistor_SMD:R_0603_1608Metric`, `Package_SO:TSSOP-20_4.4x6.5mm_P0.65mm`, …). The Rev A local `ARTHUR:TSSOP-*` footprints are not referenced; the migration matrix asks for re-validation against the TI PW land pattern at RB-02 either way. Two custom footprints are named but **not authored** (outside RB-01 scope): `ARTHUR:XIAO_ESP32S3_HANDSOLDER` (Mounting Spec §2/§3; pad numbering must be 1–14 castellations + **pad 23 = the plated post hole**) and `ARTHUR:OSC_YXC_SMD3225-4P` (RB-00.5 R4 land pattern). Test-pad size (`TestPoint_Pad_D1.5mm`) is provisional.
4. **0603 minimum** (Manufacturing Constraints §2: no 0402). Rev A copper used 0402 for many channel parts; Rev B uses 0603 throughout, R5002 and C4007 0805.
5. **J1 MPN** is provisional (`S2B-PH-SM4-TB`, side entry, "e.g." in the Mounting Spec). It differs from the vertical electrode connector, so it is a second JLC line unless RB-02 aligns them.
6. **VBAT star**: electrically one net `VBAT`; the "split at the J1 pad" is a layout rule, documented on the sheet for RB-02 (a net-tie was not added; the architecture does not call for one).
7. **Netclasses** from Manufacturing Constraints §3 are not yet written into the project (RB-02 task). Local net names were chosen to make the class patterns trivial: `/CHn/ELEC_*` (EMG_ELECTRODE), `/CHn/HIZ_*` (EMG_HIZ), `/CHn/BUF_*`, `/CHn/ACN_*`, `/CHn_P|N` (EMG_BUF), `/VCM`, `VCM_DIV`, `VCM_BUF_IN`, `RLD_SAFE` (ANALOG_REF), `AFE_CAP` (ADC_CAP), `ADC_CLKIN` (SPI_FAST).

## 8. Documentation inconsistencies found (not acted on)

| Where | Observation | RB-01 handling |
|---|---|---|
| Mounting Spec §5 | "R_PRE, C_PRE, C_BAT 22 µF" — a separate C_BAT appears nowhere else; the cost model counts one 22 µF | One 22 µF (C4007 = C_PRE). **[RB-01R] Resolved: wording corrected in the Mounting Spec; no second capacitor** |
| Cost Model §1 | Omits C6009 220 nF (CAP, KEEP in the migration matrix) and C7103 100 nF (C_VB, migration matrix §6) | Both implemented; +2 parts vs the cost count |
| Manufacturing Constraints §2 | "≤ 7 extended lines … JST-PH" counts the JST once, but J_BAT (side entry) ≠ electrode JST (vertical) | Reported as 7 firm extended lines + 10 nF C0G conditional (REVB_RB01_BOM.md) |
| Interface Spec §4 row 12 | Refers to a future FPC brain (not in RB-00.6) | No impact |

## 9. Open electrical risks (carried, none introduced by RB-01)

| ID | Risk | Status |
|---|---|---|
| R3/R9 | Seeed plain-v1.4 files unobtainable; geometry verified on Sense v1.5 | Open, incoming inspection before RB-02 (does not affect the schematic) |
| R4-res | X1: family datasheet only; 3.3 V is the top of the stated VDD range | **[RB-01R] Closed by replacing X1 with the SCTF SX3M8.192M20F30TNN (1.62–3.63 V range, 0.3 V headroom); its residuals are listed in REVB_RB01R_INDEPENDENT_REVIEW.md** |
| TT-14 | Q3001 open-circuit with USB present and D3 high leaves the AFE on | Single point, defense-in-depth only (D6 lets FW drop D3) |
| R1 | XIAO 5V leakage on battery | Mitigated by R3009; measure < 0.5 V at bring-up |
| R2 / S1 / S2 | BLE in-band lines; 50 mA no-NTC charging; USB GND common with electrodes | Unchanged; operating rule "no electrodes while USB connected", no isolation claimed |
| Gain | ~~PGA gain ≥ 4 required with the ADC-input clamps fitted~~ **[RB-01R] withdrawn**: unproven and not a hardware-safety requirement | Replaced by REVB_INTERFACE_SPEC.md §9 (operating limits; gain 8–32 is a performance recommendation) |
| J1 | JST-PH battery polarity not standardised | Verify cell lead before first power (assembly procedure step 0.5) |

## 10. Post-work record

| Item | Value |
|---|---|
| Rev A production PCB after work | `d7a585e8ae46299215d26c0aa58ea0ca5829d46ce72a45d279290263e94a0005` → **unchanged** |
| Tracked files modified | **none** (`git diff --stat` is empty) |
| New untracked paths | `hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB/` (9 files above) and the 4 reports `hardware/emg/REVB_RB01_*.md` |
| `git status --short` delta | before 366 entries → after: + `?? hardware/emg/rev-b-xiao/` + 4 × `?? hardware/emg/REVB_RB01_*.md` |
| Commit | **none** (not instructed) |

## 11. Final RB-01 gate

```
RB-01 SCHEMATIC CREATED:
YES

REV B PROJECT PATH:
hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB/ARTHUR_EMG_RevB.kicad_pro

REV A PCB HASH UNCHANGED:
YES

ERC ERRORS:
0

ERC WARNINGS:
81 (all footprint_link_issues: 79 = KiCad stock footprint libraries not installed on the
authoring host; 2 = custom footprints ARTHUR:XIAO_ESP32S3_HANDSOLDER / ARTHUR:OSC_YXC_SMD3225-4P,
authored in RB-02). Each listed and justified in REVB_RB01_ERC_REPORT.md. No suppression.

FOUR EMG CHANNELS:
PASS

J5001 PATIENT-GND FIX:
PASS

ADC POWER-DOWN CLAMPS:
PASS

U503 TRANSIENT FIX:
PASS

ADS131M04 POWER:
PASS

DVDD FILTER:
PASS

LOCAL ADC CLOCK:
PASS

AFE DEFAULT-OFF:
PASS

HARDWARE USB INHIBIT:
PASS

XIAO INTERFACE:
PASS

BAT+ POST ELECTRICAL PATH:
PASS

SPI CONDITIONING:
PASS

TEST-POINT POLICY:
PASS

REMOVED REV-A SUBSYSTEMS:
PASS

NETLIST AUDIT:
PASS

BOM AUDIT:
PASS (126 populated / 1 DNP / 8 bare pads; deltas vs cost model and migration matrix explained
in REVB_RB01_BOM.md; no component substituted)

UNRESOLVED MPNS:
- 20 generic passive lines + FB1 ferrite (value/tolerance/dielectric/package fully specified;
  JLC Basic part to be chosen at RB-03 BOM freeze)
- J1 battery connector: S2B-PH-SM4-TB(LF)(SN) is provisional ("e.g." in the RB-00.6 mounting spec)
- Q3001 2N7002: manufacturer not frozen (any JLC Basic 2N7002)
- BAV199: MPN frozen (Nexperia); orderable packing suffix to confirm on the JLC line
- U1 XIAO: Seeed PN 202003751 frozen; not a JLC line (DNP, retail)

OPEN ELECTRICAL RISKS:
- R3/R9 XIAO plain-v1.4 geometry: incoming inspection of 2 modules before RB-02 (unchanged, open)
- X1 residuals: [RB-01R] SCTF family datasheet publishes no absolute-maximum table; 8.192 MHz is a catalogue line outside the datasheet's standard-frequency list
- Q3001 open-circuit single point (truth table row 14): FW backup via D6 only; defense-in-depth
- R1 XIAO 5V leakage on battery: mitigated by R3009 4.7k; confirm < 0.5 V at bring-up
- R2 BLE-interval in-band lines; S1 50 mA / no-NTC charging; no isolation (operating rule unchanged)
- [RB-01R] "PGA gain >= 4" firmware contract withdrawn; ADC operating limits in REVB_INTERFACE_SPEC.md §9; clamp leakage/linearity requires a bench measurement
- J1 battery polarity not standardised between LiPo vendors (verify cell lead before first power)

ARCHITECTURE CHANGES MADE:
NONE to the frozen RB-01 circuit. For the reviewer: the RB-00 optional DNP items R_OPT0,
U_ID (24C02), R_SDA and R_SCL are NOT instantiated (not in the RB-01 frozen list; R_OPT0 would
bridge VBAT_AFE to XIAO 3V3 if ever fitted). XIAO D4/D5 are explicit NC. See schematic report §7.

PCB CREATED:
NO

READY FOR INDEPENDENT RB-01 REVIEW:
YES

READY FOR RB-02 PLACEMENT:
NO — independent RB-01 review required first
```
