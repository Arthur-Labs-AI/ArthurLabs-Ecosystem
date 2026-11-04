# A.R.T.H.U.R EMG Rev B — Architecture Proposal (RB-00)

Status: RB-00 architecture/contract, **amended by RB-00.5 closure** ([REVB_RB00_CLOSURE.md](REVB_RB00_CLOSURE.md)) and by the **RB-00.6 direct-XIAO physical freeze** ([REVB_DIRECT_XIAO_ARCHITECTURE.md](REVB_DIRECT_XIAO_ARCHITECTURE.md)); the physical sections (§1 diagram, §6) follow RB-00.6. No schematic, PCB, routing or Rev A edit was made.
Date: 2026-09-28. Author role: lead PCB engineer (Claude, for Kaloyan3D).

Companion documents:
[REVB_MIGRATION_MATRIX.md](REVB_MIGRATION_MATRIX.md) ·
[REVB_POWER_ARCHITECTURE.md](REVB_POWER_ARCHITECTURE.md) ·
[REVB_INTERFACE_SPEC.md](REVB_INTERFACE_SPEC.md) ·
[REVB_MANUFACTURING_CONSTRAINTS.md](REVB_MANUFACTURING_CONSTRAINTS.md) ·
[REVB_COST_MODEL.md](REVB_COST_MODEL.md)

---

## 0. Baseline that was inspected

| Item | Value |
|---|---|
| Rev A path | `hardware/emg/rev-a-cost/kicad/ARTHUR_EMG_RevA_Cost/` |
| Production PCB SHA-256 | `d7a585e8ae46299215d26c0aa58ea0ca5829d46ce72a45d279290263e94a0005`, re-hashed in RB-00 and **matches** |
| Branch / HEAD | `feature/ads131m04-cost-first` @ `45fb9a4` |
| PCB | 55.0 × 35.0 mm, 4 layers (F.Cu / In1.Cu / In2.Cu / B.Cu), 151 vias, 138 footprints |
| Netlist | `ARTHUR_EMG_RevA_Cost.net` (Eeschema 10.0.6, 2026-09-23) |
| BOM CSV | `ARTHUR_EMG_RevA_Cost.csv`, 117 parts; it **omits the 21 `TP*` footprints** that exist on the PCB |

Ground truth used for every claim below is the **PCB pad→net map** (extracted by script). Where the markdown docs disagree with the copper, the copper wins; see §7.

### 0.1 What Rev A actually is (verified from pads, not docs)

- **ADC:** U6001 ADS131M04 (TSSOP-20). Pin 1 AVDD=`AFE_3V0`, pin 20 DVDD=`3V3`, pin 17 CLKIN=`AFE_CLKIN` driven from **nRF P0.21 (U7001 pad 43)**, pin 18 CAP 220 nF, pin 11 SYNC/RESET=`MCU_RESET_N_AFE`. There are **no LVC1G125 buffers** on the board.
- **Channel ×4 (identical):** electrode → 10 k (R1x1/R1x2) → hi-Z node (BAV199 clamp to GND/`AFE_3V0`, 100 pF to GND, 10 M to `VCM`) → TLV9064 unity follower → 2.2 µF AC-coupling → 100 k to GND → 1 k → `CHx_P/N` (1 nF CM to GND each leg, 10 nF differential) → ADC.
- **Reference:** R5003/R5004 100 k/100 k divide `AFE_3V0` to 1.5 V (C5001 1 µF + C5002 100 nF). U503A buffers it to `VCM`. U503 B/C/D are **unused** followers tied to VCM. `RLD_SAFE` = `VCM` through R5002 100 k to J5001 pin 2. **J5001 pin 1 is GND.**
- **"RLD" is therefore a passive, buffered VCM bias electrode, not a driven-right-leg loop.** No common-mode feedback exists.
- **Power:** U4002 TPS7A2030P **IN = `3V3`** (not SYS_RAW), EN=`AFE_ENABLE`, OUT=`AFE_3V0`.
- **Interlock:** R3003 100 k **pulls `AFE_ENABLE` up to 3V3**, so the AFE is ON by default whenever 3V3 exists. Q3001 gate = `USB_VBUS` direct (R3004 100 k gate pull-down) pulls EN low. Q3002 + R3005 (100 Ω) discharge `AFE_3V0` on VBUS. **There is no MCU request input.** The `AFE_DISABLE_REQ` pin was never wired.

---

## 1. Rev B product concept (validated)

The custom PCB becomes an **analog acquisition module with a soldered-on brain**:

```
 ┌─────────────────────── EMG Rev B PCB (4L, 1.6 mm, ~75 × 32 mm) ───────────────────────┐
 │ ZONE A: ANALOG FRONT END      │ ZONE B: ADC │ ZONE C: BOUNDARY   │ ZONE D: BRAIN      │
 │ J101..J401, J5001 (edge)      │ U6001       │ SPI 33 Ω, pulls,   │ XIAO ESP32-S3      │
 │ 8× 10k/10M/BAV199/100p        │ ADS131M04   │ interlock Q, DVDD  │ (castellated SMT)  │
 │ U501/U502 followers           │ X1 8.192MHz │ ferrite, VBAT div, │ USB-C at board edge│
 │ U503 VCM buffer, R5002        │ AVDD/DVDD/  │ LDO + RC prefilter │ U.FL antenna       │
 │ 2.2µ/100k/1k/1n/10n per ch    │ CAP decoup  │                    │ J_BAT (JST-PH 2p)  │
 └───────────────────────────────┴─────────────┴────────────────────┴────────────────────┘
   high impedance ─────────────────────────────────────────────────────────► high di/dt
```

The XIAO provides MCU, BLE/Wi-Fi, USB-C, LiPo charging, 3V3 regulation and firmware/DSP/ML. The custom board contains no switching regulator, no USB data, no RF and no charger.

**The partition is correct.** The one thing that must not be copied from the proposed baseline is feeding the AFE LDO from the XIAO 3V3 (Rev A's topology). It must come from VBAT; see §3.

---

## 2. Exact Rev B electrical architecture

### 2.1 Blocks

| Block | Content | Rail |
|---|---|---|
| EMG input ×4 | J (JST-PH 2p SMD) → 10 k → hi-Z node (BAV199 → GND/AFE_3V0, 100 pF → GND, 10 M → VCM) | AFE_3V0 clamps |
| Followers | U501, U502 TLV9064 (8 unity followers) | AFE_3V0 |
| AC coupling / AAF | 2.2 µF → 100 k to GND → 1 k → 1 nF CM ×2 + 10 nF diff | — |
| ADC | U6001 ADS131M04, AVDD 1 µF, DVDD 1 µF, CAP 220 nF | AVDD=AFE_3V0, DVDD=DVDD_F |
| Clock | X1 **SCTF SX3M8.192M20F30TNN (JLC C2901557; RB-01R, replaces the RB-00.5 YXC part)**, 3225, OE (pin 1) tied to DVDD_F → 33 Ω → CLKIN | DVDD_F |
| VCM/bias electrode | 100 k/100 k divider (C5001/C5002 at the node) → **10 k** → U503A +IN follower → VCM; 100 k → RLD_SAFE → J5001 pin 2 (**pin 1 NC**) | AFE_3V0 |
| AFE LDO | VBAT → 4.7 Ω + 22 µF → TPS7A2030PDBVR → AFE_3V0 | VBAT |
| DVDD filter | XIAO 3V3 → ferrite (600 Ω@100 MHz, 0603) → 10 µF + 100 nF → DVDD_F | 3V3 |
| Interlock | AND logic around TPS7A20 EN (see §4) | — |
| Sense | VBAT 1 M/1 M + 100 nF → D0; 5 V 100 k/150 k → D6; **4.7 k load on XIAO 5V** (defeats XIAO D2 leakage, RB-00.5) | — |
| ADC-input clamps | 8 × BAV199 (pin 1 GND, pin 3 CHx_y, pin 2 NC) at the ADC side of each 1 k. Bounds the power-down transient (RB-00.5 R6) | — |
| Brain | XIAO ESP32S3 plain, unsoldered-header version (Seeed PN 202003751, v1.4). **Hand-soldered** by its 14 castellations to the RB-00.6 extended pads; BAT+ via a soldered post through a plated hole; DNP at JLC ([REVB_XIAO_MOUNTING_SPEC.md](REVB_XIAO_MOUNTING_SPEC.md)) | own |
| Battery | JST-PH 2-pin SMD next to XIAO, protected 1S LiPo (PCM mandatory) | VBAT |
| Test | Bare pads only (see Interface Spec §6) | — |

### 2.2 Design-intent changes vs Rev A (not just deletions)

1. **AFE LDO input moves from 3V3 to VBAT** (headroom 0.2–1.2 V instead of ≤0.3 V from a rail that sags during ESP32 bursts).
2. **EN default flips from pull-up (always on) to pull-down + MCU request.**
3. **CLKIN becomes a local oscillator** instead of an MCU GPIO-generated clock.
4. **Q3002/R3005 are deleted.** TPS7A2030**P** has an internal 150 Ω active discharge (datasheet SBVS338H, `RPULLDOWN`, "P indicates an active output discharge feature").
5. **Channel test points are deleted** (8 × `CHx_P/N` B.Cu TPs with via stubs on the most sensitive nets).
6. **J5001 pin 1 = NC** (closed in RB-00.5). Rev A tied it to GND, a 0 Ω body-to-GND contact that bypassed R5002. Every patient contact now sees ≥ 10 kΩ (electrodes) / ≥ 100 kΩ (reference) to GND.
7. **ADC-input negative clamps** (8 × BAV199 behind the existing 1 k) bound the power-down transient to ≥ −1.04 V worst case. Rev A could reach −1.84 V to −3.05 V vs the −1.6 V absmax. See [REVB_RB00_CLOSURE.md](REVB_RB00_CLOSURE.md) R6.
8. **10 k in series with U503A +IN** limits the power-down back-drive from C5001/C5002 into the collapsing rail (TLV906x input ≤ 10 mA rule).

---

## 3. Power (summary; full detail in REVB_POWER_ARCHITECTURE.md)

```
LiPo(PCM) ─ J_BAT ─ VBAT ─┬─► XIAO BAT+ pad ─► [XIAO: SGM40567 charger; Q1 PMOS/D2 Schottky power path; SGM6029 **buck** → 3V3] ─► XIAO 3V3
                          ├─► 4.7Ω ─┬─ 22µF ─► TPS7A2030P IN   EN◄─interlock   OUT ─► AFE_3V0
                          └─► 1M/1M + 100nF ─► D0 (VBAT_SENSE)
XIAO 3V3 ─► FB1 ─► 10µF‖100nF ─► DVDD_F ─► U6001 DVDD, X1, CS_N/SYNC pull-ups
XIAO 5V (=VBUS) ─┬─► 4.7k ─► GND (leakage load)
                 ├─► 10k/100k ─► Q3001 gate
                 └─► 100k/150k ─► D6
GND: one continuous plane (In1 solid, In2 solid under analog), no split.
```

Verified ADS131M04 facts (SBAS890D):
- AVDD 2.7–3.6 V (3.0 nominal).
- **DVDD 2.7–3.6 V** with the internal digital LDO. 1.65–2.0 V is only allowed with CAP shorted to DVDD. **The earlier claim "DVDD 1.65–3.6 V, bus IO-agnostic" was wrong.**
- Supplies may sequence in any order, but no analog or digital input may exceed its own supply.
- AGND–DGND ±0.3 V; TI recommends joining the grounds at the device.
- IAVDD 3.5 mA typ / 4.0 mA max (HR mode); IDVDD 0.4 / 0.5 mA.
- Digital VIH = 0.8·DVDD, VIL = 0.2·DVDD (CMOS levels).

---

## 4. USB interlock (summary; truth table in REVB_INTERFACE_SPEC.md §4)

```
AFE_EN (TPS7A20 EN) = AFE_EN_REQ(D3, 10k series, 100k pull-down)  AND  NOT VBUS(Q3001 drain on EN)
```

- EN thresholds (TPS7A20): VEN(HI) = 0.9 V min-to-enable, VEN(LOW) = 0.3 V. Internal smart pull-down is 500 kΩ.
- With Q3001 on, EN = 3.3 V × Rds(on)/10 kΩ ≈ 1 mV. The MCU cannot overpower the inhibit.
- ESP32-S3 GPIO4 (D3) emits a **low-level** 60 µs glitch at power-up (ESP32-S3 datasheet v2.2, Table 2-2). That is the safe direction.
- This interlock is **defense-in-depth only**. Rev A's `SAFETY_ASSUMPTIONS.md` operating rule stands: no electrodes on body while USB is attached, and there is no isolation.

---

## 5. Noise and safety regressions introduced by XIAO/ESP32 (Task 14)

| # | Regression | Mechanism | Mitigation in Rev B | Residual |
|---|---|---|---|---|
| N1 | Supply-borne radio bursts | ESP32-S3 Wi-Fi TX ≈ 300 mA+, BLE TX bursts tens of mA vs nRF52840 ~15 mA | AFE LDO from VBAT behind an RC. TPS7A20 PSRR is 95 dB @1 kHz and 65 dB @100 Hz (300 mA, VIN=VOUT+1 V) | Low. The LDO must stay out of dropout, so acquisition stops below VBAT 3.30 V |
| N2 | In-band periodic lines | BLE connection interval 7.5–50 ms → 20–133 Hz fundamentals inside the 20–450 Hz EMG band | Fixed connection interval chosen with its fundamental known; characterise the line; notch in DSP | **Measure**; open risk R2 |
| N3 | Ground-return coupling | Burst current sharing plane with µV inputs | Battery connector adjacent to XIAO; burst loop BAT→XIAO never crosses Zone A; solid In1 | Low if the floorplan is obeyed |
| N4 | Radiated RF | 2.4 GHz rectified at the hi-Z follower inputs | 10 k + 100 pF per input (≈160 kHz), TLV9064 has an internal EMI filter, U.FL antenna routed away from electrode leads, XIAO ≥ 5 mm from Zone A | Medium: measure with the antenna in the enclosure |
| N5 | Wi-Fi during acquisition | 300 mA bursts, 10 Hz beacons | **Wi-Fi OFF during acquisition** (firmware contract) | Policy |
| N6 | DVDD noise | XIAO 3V3 comes from an **SGM6029 buck** (470 nH), not an LDO (verified from Seeed's module netlist). It carries MHz ripple, possible PFM bursts and ESP32 core/RF current | Ferrite + 10 µF + 100 nF. DVDD PSRR is 85 dB at 50/60 Hz. The buck's input current also ripples VBAT, which the 4.7 Ω/22 µF RC in front of the TPS7A20 absorbs | Low; bench-check the PFM burst spectrum |
| S1 | Charging safety | BQ24074 (TS/NTC, 250 mA, DPPM) replaced by the XIAO charger: **no NTC input**, 50 mA fast / 3.8 mA trickle (Seeed wiki, regular S3) | Cell **must** have PCM; charge only off-body at room temperature; document in Rev B safety file | **Regression accepted with conditions** |
| S2 | USB ground | USB GND still galvanically common with electrode ground | Unchanged rule; hardware inhibit | Same as Rev A (no improvement) |
| S3 | XIAO 5V pin semantics | Verified from Seeed's module netlist: 5V = raw VBUS (R9 100 k to GND). On battery, the D2 Schottky (LMBR4010, IR ≤ 30 µA @10 V) leaks VIN→VBUS and could lift it to 1–4 V with RB-00 loads → false inhibit | **4.7 k load on 5V** → ≤ 0.42 V at a 100 µA allowance | Closed by design; confirm at bring-up |
| S4 | Boot-time pin activity | GPIO1–9 60 µs low glitches; GPIO43 (D6) is UART0 TX and outputs the boot log | No control function on D6; D6 is sense-only behind 100 k; DRDY/MISO series R | Low |
| S5 | Firmware complexity | Wi-Fi/BLE stack, OTA | Hardware interlock does not depend on firmware | Low |

---

## 6. Mechanical floorplan regions (Task 11)

Board ≈ **75 × 32 mm** (RB-00.6 estimate; board frame origin at the north-west corner). The XIAO is 21.02 × 17.78 mm. The analog block is re-placed, not copied. Authoritative geometry: [REVB_XIAO_MOUNTING_SPEC.md](REVB_XIAO_MOUNTING_SPEC.md).

| Zone | X span (from analog edge) | Content | Rules |
|---|---|---|---|
| A — Analog | 0 – 39 mm | 5 electrode JST-PH on the south long edge (J101..J401, J5001), four channel columns, U501/U502 in a row, U503 + VCM divider at the east end of Zone A | F.Cu-only for hi-Z nets, In1 + In2 solid GND beneath, no digital copper on any layer |
| B — ADC | 39 – 48 mm | U6001 oriented with pins 1–10 (analog) facing west and pins 11–20 (digital) facing east, X1 ≤ 5 mm from pin 17, U4002 + caps on the north edge above U6001 | AVDD/DVDD/CAP caps ≤ 1.5 mm from pins, no via in pads |
| C — Boundary | 48 – 53.7 mm | 33 Ω series R, pull-ups/pull-downs, DVDD ferrite, 4.7 k VBUS load (south); inhibit cluster at the U4002 EN pin (north) | Only SPI/control/power cross here. Parts > 1.2 mm tall only at x ≤ 49.7 or y < 12.5 |
| D — Brain | 53.7 – 75 mm | **RB-00.6: XIAO rotated 180°** (USB-C → south edge at the east end, module end flush; receptacle overhangs 1.51 mm). Module x 55.00–72.78, y 10.98–32.00. SPI/3V3/GND/5V pins face west (Zone C). **U.FL at the module's north-east corner, antenna cable exits east.** BAT+ post at (68.34, 21.86). J_BAT in the north strip (y 0–11) | XIAO toe copper ≥ 5.7 mm from Zone B; no F.Cu under the XIAO exposed pads |

Hard rules:
- Side-by-side only. **No stacking of the XIAO over Zone A.**
- USB-C and antenna at the brain end. Electrodes on the south edge in Zone A; USB-C on the same south wall but ≥ 20 mm east of the nearest electrode connector (RB-00.6).
- Battery current loop (J_BAT → XIAO BAT pads → XIAO GND) stays entirely in Zone D.
- Mounting: 2 × M2 NPTH (or plated to GND) at the Zone A/B corners. Final positions depend on the enclosure (open item).

---

## 7. Stale Rev A assumptions and documents (Task 13)

| Artifact | Stale content | Actual state (copper) |
|---|---|---|
| `SCHEMATIC_ARCHITECTURE.md` | ADS1294 (9 refs), nRF-centric architecture | ADS131M04 |
| `COMPONENT_SELECTION.md` | ADS1294, LVC1G125 buffers, MDBT | ADS131M04, no buffers |
| `ELECTRICAL_DESIGN_FREEZE.md` | All of §1–§4: ADS1294 pins/registers, 2.2 k series / 390 k bias / 4.7 nF network, internal 2.048 MHz clock, RLDINV loop, 6× Ioff buffers, "DVDD 1.65–3.6 V" | 10 k / 10 M / follower / AC-coupled network; CLKIN from nRF; passive VCM bias electrode; no buffers |
| `SAFETY_ASSUMPTIONS.md` | Conductive paths 1–4 describe the ADS1294 network and buffers | Operating rule still valid; the path list must be rewritten |
| `POWER_BUDGET.md` | ADS1294 3 mA, LVC buffers, nRF 8 mA, TPS63031; **omits the 12 TLV9064 amplifiers (538 µA/amp typ → ~6.5 mA)** | Real AFE_3V0 load ≈ 10–13 mA |
| `PRE_LAYOUT_AUDIT_2_ADS1294_POWER.md` | Entire document | Obsolete |
| `ERC_UNRESOLVED.md` | ADS1294 / LVC | Obsolete |
| `ARTHUR_EMG_RevA_Cost.kicad_pro` netclass patterns | `AFE_CS_N`, `AFE_MOSI`, `AFE_SCLK`, `AFE_START`, `AFE_PWDN_N`, `AFE_RESET_N`, `VCAP1..4`, `VREFP_2V4`, `RLDINV`, `RLDOUT`, `ELECTRODE_P/N`, `U6001-TESTP/WCT/GPIO1..4` pads (64-pin ADS1294) | These nets don't exist. **The real hi-Z nodes (`Net-(Dx0x-COM)`) fall in `Default`** |
| `ARTHUR_EMG_RevA_Cost.kicad_dru` | `analog_L1_only` and `sclk_separation` conditions reference `EMG_INPUT` / `EMG_FRONT` | No live net is in those classes; the rules are **inert** |
| `ARTHUR_EMG_RevA_Cost.csv` | Missing 21 TPs; `C7002 "TBD"`; value ranges instead of values (C2001–C2003, C4001–C4004) | — |
| `ARTHUR_EMG_RevA.csv` | Duplicate, older BOM | — |
| `AGENTS.md`, `PHASE3A/3B*` | Rev A routing freeze rules | Apply only to Rev A; **not** Rev B contracts |
| `PHASE3C*_USB*` (7 docs) | USB-C DFM work | Irrelevant to Rev B (USB is on the XIAO) |
| Schematic `mcu_ble`, `power_charging`, `usb_c_interlock`, `debug` sheets | nRF / BQ24074 / TPS63031 / USB / SWD | Deleted in Rev B (the interlock is re-implemented) |
| Rev A root schematic title block | "Architecture schematic; unresolved values TBD" | Rev B needs a real title block |

---

## 8. Open risks (feed into RB-01)

| ID | Risk | Owner/Action | Blocks |
|---|---|---|---|
| R1 | XIAO 5V pin voltage on battery only | **Mitigated by design** (4.7 k load, RB-00.5); confirm < 0.5 V at bring-up | — |
| R2 | BLE-interval noise lines in band | Bench prototype: Rev A AFE on battery + XIAO on the same ground; FFT | Product claims |
| R3 | Seeed footprint / bottom pads / JLC part | Footprint frozen (official `XIAO-ESP32-S3-SMD`, 25 pads verified). JLC C9900124959 not used (0 stock, MOQ 445). **Residual:** Seeed's plain-v1.4 files are unobtainable (the link serves Sense v1.5); verify purchased modules at incoming inspection | RB-02 layout freeze |
| R4 | Oscillator | **Closed (RB-01R)**: SCTF SX3M8.192M20F30TNN, C2901557 | no absolute-maximum table published; verify frequency/marking on the first reel |
| R5 | J5001 pin 1 = GND | **Closed**: pin 1 NC | — |
| R6 | ADC-input power-down transient | **Closed**: 8 × BAV199 negative clamps at AIN (≥ −1.09 V worst case, RB-01R) + 10 k at U503A +IN. No gain restriction (RB-01R withdrew "PGA gain ≥ 4") | — |
| R7 | Charging: 50 mA, no NTC | Cell with PCM; accept or add an external charger (out of scope) | Product |
| R8 | ESP32-S3 battery life (~3× nRF) | Firmware power budget | Product |
| R9 | Module revision drift | Folded into R3 (incoming inspection + Seeed file request). 0 Ω option to feed the LDO from 3V3 kept | RB-02 |

## 9. RB-00.6 note: remote brain carrier rejected

The brain-carrier / JST-GH 15-pin Sensor Bus proposal (discussed before RB-00.6) is **not** part of the active Rev B architecture. Rev B is one 4-layer PCB with a directly hand-soldered XIAO. Rationale and the rejected-alternatives table: [REVB_DIRECT_XIAO_ARCHITECTURE.md](REVB_DIRECT_XIAO_ARCHITECTURE.md) §2 and §9.

The future-bus pinout in [REVB_INTERFACE_SPEC.md](REVB_INTERFACE_SPEC.md) §7 remains a documentation-only concept for later revisions.

