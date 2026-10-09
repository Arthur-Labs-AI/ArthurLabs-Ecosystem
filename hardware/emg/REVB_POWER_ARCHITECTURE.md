# A.R.T.H.U.R EMG Rev B — Power Architecture & Sequencing (RB-00, amended RB-00.5)

Datasheets used, all read in RB-00 (not recalled):
- TI ADS131M04, SBAS890D (May 2021)
- TI TPS7A20, SBVS338H (Jul 2024)
- TI TLV906x (current rev)
- Espressif ESP32-S3 Series Datasheet v2.2
- Seeed Wiki "XIAO ESP32S3 getting started"
- RB-00.5: Seeed official XIAO ESP32S3 KiCad module netlist (served as Sense v1.5), Nexperia BAV199, LRC LMBR4010, YXC YSO110TR ([REVB_RB00_CLOSURE.md](REVB_RB00_CLOSURE.md))

## 1. Power tree

```
            ┌───────────────── Zone D (brain) ─────────────────┐
 LiPo 1S ── J1 (JST-PH 2p) ── VBAT ──┬── XIAO BAT+ pad ──► XIAO charger SGM40567 (VIN = VBUS, 50 mA fast)
 (PCM req.)                          │                      XIAO Q1 PMOS (on when VBUS absent) ─► VIN ◄─ D2 Schottky ◄─ VBUS
                                     │                      VIN ─► SGM6029 BUCK (470 nH) ─► XIAO 3V3 pin (≤700 mA)
                                     │
                                     ├── R_VB1 1M ─┬─ R_VB2 1M ─ GND ; C_VB 100n ─► D0 VBAT_SENSE
                                     │
                                     └── R_PRE 4.7Ω ─ VBAT_AFE ─┬─ C_PRE 22µF ─ GND
                                          (R_OPT0 0Ω DNP from 3V3)│
                                                                 └─ C4005 1µF ─ U4002 TPS7A2030P IN
            └─────────────────────────────────────────────────┘
                     U4002 EN ◄── AFE_EN (interlock, REVB_INTERFACE_SPEC §4)
                     U4002 OUT ─► AFE_3V0 ─┬─ C4006 1µF
                                            ├─ U6001 AVDD (C6007 1µF)
                                            ├─ U501/U502/U503 V+ (C501/C502/C503 100n)
                                            ├─ R5003/R5004 VCM divider
                                            └─ BAV199 ×8 upper clamp rail (hi-Z inputs)
                                               [+ BAV199 ×8 at the ADC inputs: pin 1 GND, pin 3 AIN, pin 2 NC]

 XIAO 3V3 ── FB1 ── DVDD_F ─┬─ C_DV1 10µF, C_DV2 100n
                            ├─ U6001 DVDD (C6008 1µF) ; CAP C6009 220n
                            ├─ X1 YXC OT2JI-111-8.192M, OE→DVDD_F (C_X1 100n)
                            └─ R_CS_PU 100k, R_SYNC_PU 10k

 XIAO 5V (= raw VBUS; XIAO R9 100k to GND) ── R_VBUSLD 4.7k ── GND   (swamps D2 reverse leakage)
                                   └─ R_VG_S 10k ── Q3001 gate (R3004 100k to GND)
                                   └─ R_US1 100k ── D6 USB_PRESENT ── R_US2 150k ── GND

 GND: single net, single continuous plane system (In1 solid everywhere, In2 solid under Zones A/B).
```

## 2. Why the AFE LDO is fed from VBAT (not XIAO 3V3)

| Feed | Headroom for a 3.0 V output | Behaviour |
|---|---|---|
| XIAO 3V3 (Rev A topology) | 3.3 − 3.0 = 0.30 V nominal. The XIAO SGM6029 buck enters 100 %-duty dropout as VBAT approaches 3.3 V, and 3V3 carries buck ripple plus Wi-Fi/BLE load steps | TPS7A20 dropout is 145 mV max @300 mA. At light load it is small, but PSRR collapses near dropout, exactly while radio bursts are largest |
| **VBAT through 4.7 Ω / 22 µF** | 4.2 V → 1.14 V; 3.30 V → 0.24 V (after the 56 mV RC drop at 12 mA) | Clean regulation over the usable range. VIN max 6.0 V > 4.2 V |

Burst coupling estimate: ESP32 BLE/Wi-Fi burst of 300 mA through ≈0.2 Ω (cell + PCM + connector) gives a 60 mV step on VBAT.
- The RC (corner ≈ 1.5–3 kHz with the derated C) attenuates edge content.
- The TPS7A20 PSRR is **65 dB @100 Hz, 92 dB @1 kHz** (datasheet table, 300 mA, VIN = VOUT + 1 V), better at the actual ~12 mA load.
- 60 mV × 10^(−65/20) ≈ **34 µV worst-case at 100 Hz on AVDD**, before ADC AVDD PSRR (78 dB at 50/60 Hz, datasheet). That gives ≈ 4 nV-class equivalent. **Supply coupling is not the dominant risk; ground return (§5) and radiated coupling are.**

Acquisition low-battery cutoff: **VBAT_SENSE < 3.30 V → firmware stops acquisition** (LDO margin). Hard stop at 3.20 V.

## 3. Rail budget (Rev B, typical)

| Load | Rail | Typ | Max | Source |
|---|---|---|---|---|
| ADS131M04 AVDD, HR mode | AFE_3V0 | 3.5 mA | 4.0 mA | SBAS890D §6.5 |
| TLV9064 ×3 (12 amps × 538 µA) | AFE_3V0 | 6.5 mA | 9.0 mA (750 µA/amp max) | TLV906x EC table |
| VCM divider | AFE_3V0 | 15 µA | — | 3.0 V / 200 k |
| **AFE_3V0 total** | | **≈ 10 mA** | **≈ 13 mA** | Rev A POWER_BUDGET said 3–5 mA (stale, omitted the op-amps) |
| TPS7A20 IQ | VBAT | 6.5 µA | — | |
| ADS131M04 DVDD | DVDD_F | 0.4 mA | 0.5 mA | |
| X1 YXC OT2JI-111-8.192M | DVDD_F | ≤ 5 mA | 5 mA (datasheet max, 3.3 V, 15 pF) | YSO110TR table |
| **DVDD_F total** | | **≈ 3–5.5 mA** | 5.5 mA | FB1 DC drop negligible |
| VBAT divider | VBAT | 2.1 µA | | |
| ESP32-S3 BLE streaming | VBAT via XIAO | 30–45 mA avg (estimate) | 300 mA+ Wi-Fi bursts | Not datasheet-verified at system level; measure |

LDO dissipation worst case: (4.2 − 3.0) × 13 mA = **16 mW**. Trivial.

Battery life (500 mAh, BLE only, estimate): 500 / (≈ 40 + 13 + 4) ≈ **8–10 h**. With nRF52840 XIAO: ≈ 20–25 h.

## 4. Sequencing

### 4.1 Power-up (battery inserted, no USB)

| Step | Event | Hardware state | Guarantee |
|---|---|---|---|
| 0 | Cell connected | VBAT at XIAO BAT and LDO IN. EN held low by R_EN_PD 100 k + internal 500 k | AFE OFF |
| 1 | XIAO boots | 3V3 rises → DVDD_F, X1 starts, ADC digital POR (tPOR = 250 µs). GPIO1–9 emit 60 µs **low** glitches | AFE still OFF (low = safe). SYNC glitch < 2048 tCLKIN = 250 µs → no reset pulse |
| 2 | FW checks | D6 USB_PRESENT = low, VBAT_SENSE ≥ 3.40 V | — |
| 3 | FW drives D3 high | EN > 0.9 V → LDO soft-start. AFE_3V0 → 3.0 V in < 1 ms (datasheet start-up, MPN-level) | The ADS supply order is free (§10.2). Analog inputs ≤ AVDD holds because the followers are powered from the same rail |
| 4 | Settling wait | VCM τ = 55 ms; input bias 10 M × 100 pF = 1 ms; AC coupling 2.2 µF × 100 k = 0.22 s | Wait **≥ 1.1 s** (5τ of the AC coupling) before valid data |
| 5 | ADC reset | SYNC/RESET low ≥ 2048 tCLKIN (**≥ 250 µs, use 1 ms**), then wait tREGACQ (5 µs) or DRDY rising | Clock is local and already running |
| 6 | Configure, stream | DRDY_N falling-edge ISR | — |

### 4.2 Power-down / inhibit

| Trigger | Path | Time to AFE_3V0 < 0.3 V |
|---|---|---|
| FW clears D3 | EN pulled low via 10 k from the GPIO | LDO off + 150 Ω active discharge. τ ≈ 150 Ω × ~3 µF ≈ 0.5 ms plus load current → **< 3 ms** |
| USB inserted | XIAO 5V → Q3001 on → EN ≈ 0 V regardless of D3 | Same, **< 3 ms** after VBUS reaches ~2 V at the gate |
| XIAO reset/crash-reset | GPIO high-Z → R_EN_PD | Same |
| XIAO removed / 3V3 lost | D3 absent → R_EN_PD; DVDD collapses | Same |
| Battery removed | Everything off | — |

**Power-down transient at the ADC inputs (R6, CLOSED in RB-00.5).**
- C1x1 (2.2 µF) holds V_C = follower DC − 0 V: 1.50 V nominal, **1.84 V** with tolerances + 300 mV electrode offset, **3.05 V** with a saturated follower.
- The rail collapses in ≈ 1 ms ≪ τ_N = 0.22 s, so an unprotected AIN steps to −V_C. **The RB-00 statement "within ratings, 0.1 V margin" was wrong:** the tolerance cases exceed the −1.6 V absmax, and SBAS890D has no current-limited exemption.
- **Fix:** BAV199 negative clamp at each ADC input, behind the existing 1 k (pin 1 GND, pin 3 AIN, pin 2 NC).
  - Worst-case AIN **≥ −1.04 V**: 3.1 mA, VF max, −20 °C.
  - That is 0.26 V inside the recommended −1.3 V and 0.56 V from absmax.
- The GND-referenced bias is retained: AIN ≈ 0 V is mid-window for gain ≥ 8 (AGND − 1.3 … AVDD − 1.8 V). A VCM return is invalid there.
- **PGA gain ≥ 4 with the clamps fitted.**
- **Also fixed:** 10 k in series with U503A +IN, so C5001/C5002 cannot back-drive > 0.16 mA into the collapsing rail (the TLV906x input limit is 10 mA).
- Full derivation: [REVB_RB00_CLOSURE.md](REVB_RB00_CLOSURE.md) §R6.

## 5. Ground strategy

- **One GND net. No AGND/DGND split, no net-tie, no bead in any ground.** ADS131M04 datasheet: AGND–DGND must stay within ±0.3 V, and grounds are recommended to be joined close to the device. Nothing in the Rev A evidence or the Rev B architecture justifies a split.
- In1.Cu: solid GND over the entire board, no routing.
- In2.Cu: solid GND under Zones A and B. Power pours (VBAT, DVDD_F) allowed only in Zones C and D. **No In2 routing under the hi-Z nodes.**
- F.Cu/B.Cu: GND fill with via stitching at ≤ 3 mm pitch along the Zone B/C boundary and around the XIAO courtyard.
- Current-return discipline:
  - Battery → XIAO burst loop is entirely in Zone D (x ≥ 53.7). RB-00.6: J_BAT in the north strip, VBAT star at its + pad, BAT+ via the post at (68.34, 21.86), BAT− returning via XIAO castellation pin 13 → In1 → J_BAT−; loop ≤ ≈ 250 mm². See [REVB_DIRECT_XIAO_ARCHITECTURE.md](REVB_DIRECT_XIAO_ARCHITECTURE.md) §5.
  - The AFE_3V0 return (≈ 13 mA) flows in Zones A/B.
  - SPI return currents flow on In1 directly under the Zone C corridor.
- USB shield: owned by the XIAO; nothing added.

## 6. DVDD requirements (verified)

- DVDD must be **2.7–3.6 V** (internal digital LDO path; CAP = 220 nF to DGND).
- The 1.65–2.0 V option requires CAP tied to DVDD. It is not used, and a future brain needs **≥ 2.7 V VIO**.
- Logic thresholds scale with DVDD (VIH ≥ 0.8·DVDD). DVDD and the brain IO **must be the same 3V3 source**, which is why DVDD comes from XIAO 3V3 and not from AFE_3V0 or a separate LDO.
- DVDD cannot come from AFE_3V0: SPI and CS from a live brain into an unpowered DVDD would violate "digital inputs ≤ DVDD + 0.3 V" and back-power the part.

## 7. Charging (Task: do not assume parity with BQ24074)

| Parameter | Rev A BQ24074 | Rev B XIAO ESP32-S3 (Seeed wiki) |
|---|---|---|
| Fast charge | 250 mA (RISET 3.57 k) | **50 mA** (Sense variant: 100 mA) |
| Trickle | per datasheet | 3.8 mA |
| NTC / TS | Yes (10 k NTC via J2001 pin 2) | **None** |
| Power path (DPPM) | Yes | Not documented, treat as none |
| 500 mAh full charge | ~2.5 h | **~10+ h** |

Requirements that follow:
- Cell **must** include PCM (over-charge, over-discharge, over-current, short).
- Charge off-body only, at room temperature.
- Consider a 150–300 mAh cell if a 10 h charge is unacceptable.
