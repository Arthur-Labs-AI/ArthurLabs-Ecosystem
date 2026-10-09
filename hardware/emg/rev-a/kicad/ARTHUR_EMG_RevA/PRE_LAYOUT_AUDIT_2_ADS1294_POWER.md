# PRE-LAYOUT AUDIT 2 — ADS1294 power sequencing + analog operating range

Date: 2026-09-20. Tool: KiCad CLI 10.0.6. Schematic state: post-Audit-1 (buffer A/OE fix, globals-only MCU nets, ERC 0/1).
Scope: schematic only. No placement/routing started. No unrelated circuitry changed.

## 0. Source citations + evidence status

- TI ADS1294 datasheet (SBAS459K) + ADS129x family application guidance (SBAU181): [TI ADS1294 datasheet](https://www.ti.com/lit/ds/symlink/ads1294.pdf), [TI document viewer SBAS459](https://www.ti.com/document-viewer/lit/html/SBAS459K), ADS129x Bring-up Figure 93 / §11.1 sequencing.
- In-repo prior extraction (SBAS459K, this-pass): absmax AVDD−AVSS −0.3..5.5 V; DVDD−DGND −0.3..3.9 V; analog in AVSS−0.3..AVDD+0.3 V; digital in DGND−0.3..DVDD+0.3 V; clamp 100 mA momentary / 10 mA continuous; operating AVDD 2.7..5.25 V (3.0 V nom), DVDD 1.65..3.6 V (3.3 V nom); VCAP1 22 µF, VCAP2/3/4 1 µF; internal 2.4 V ref; internal 2.048 MHz osc (CLKSEL=1, CLK_EN=0); DAISY_IN→DGND, RESV1→DGND when unused.
- ⚠️ Live-PDF re-read was NOT possible from this sandbox (all HTTPS egress fails: PowerShell `Invoke-WebRequest` → "connection closed", curl → `SEC_E_NO_CREDENTIALS`; `web_search` returns URLs only, no numeric snippets — same blockade as Audit 1). Datasheet-cell claims below therefore rest on (a) the in-repo SBAS459K extraction, (b) exported-netlist ground truth from the current files, and (c) stable ADS129x-family specifications. Anything that depends on exact §11.1/Figure 93 wording is flagged TBD-reconfirm and assigned to the pre-existing blocker (freeze §9 item 5). No conclusion in this audit requires a razor-edge datasheet number: all margins are ≥0.5 V / orders of magnitude.

## 1. Architecture under audit (netlist-verified, current files)

- `DVDD` (pins 48, 50) + `CLKSEL` (52, =1 internal osc) → always-on **3V3**. `AVDD` bank (19, 21, 22, 54, 56, 59) → switched **AFE_3V0** (TPS7A2030, EN=AFE_ENABLE). AVSS/DGND/VREFN/DAISY_IN/RESV1 → GND.
- Unused IN5–8P/N tied to AFE_3V0 (same rail as AVDD: no differential across the tie in any rail state; at AVDD=3 V the 3.0 V tie is inside analog-in absmax AVSS−0.3..AVDD+0.3).
- Control SCLK/DIN/CS/START/RESET/PWDN via 6× SN74LVC1G125 (VCC=AFE_3V0, OE=GND, Audit 1). DOUT→MISO (P0.15) and DRDY_N (P0.17) direct, point-to-point.
- **No AFE_3V0 rail-good feedback to the MCU exists** (AFE_3V0 net members: TPS7A20 OUT, decoupling, ADS1294 AVDD bank + IN5–8, six buffer VCC pins — no MCU pin). All AVDD sequencing must therefore be **time-based in firmware**, never polled.
- AVDD-off is always externally imposed (USB-insert hardware interlock via VBUS NFET, or battery connect/disconnect). MCU cannot command AFE shutdown (P0.22 unconnected). Firmware sequencing is reactive (detect → park → wait → re-init), and the hardware interlock can race an orderly firmware shutdown on USB insert.

## 2. Power-state table

| State | DVDD | AVDD | AFE_3V0 loads | Status |
|---|---|---|---|---|
| S0 cold, both ramping | 0→3.3 | 0→3.0 | ramp | Supported (any order per ADS129x family: independent analog/digital POR domains; firmware RESET covers whichever POR does not fire). Exact §11.1 text TBD-reconfirm (pre-existing blocker). |
| S1 normal acquisition | 3.3 | 3.0 | ~4–6 mA | Supported (nominal). |
| S2 AFE off (USB / standby) | 3.3 | 0 | ~0 (LDO off) | **Conditionally supported** (see §3–§4): all pin voltages/currents bounded; logic states partially undefined; firmware contract required. Not a damage state. |
| S3 transitions (AVDD 0→3 / 3→0, DVDD held) | 3.3 | ramp/fall | VCAP charge/discharge | Supported under firmware contract (§5). No order violation known in family; absmax never exceeded (§4). |

## 3. Partial-power state DVDD=3.3 V / AVDD=0 V — analysis

- Digital interface (DVDD domain) is alive: input thresholds valid; 0 V/low inputs are legal levels (inside DGND−0.3..DVDD+0.3). No digital-pin absmax violation in any sub-case below.
- **MCU→ADC direction:** buffer Y outputs are Hi-Z (VCC=0) with Ioff blocking (Audit 1): ADS1294 control inputs float at leakage scale. No back-power into AFE_3V0 (Ioff disconnects the VCC path by definition of the feature). MCU-side 3.3 V on buffer A inputs is within LVC input tolerance, including while buffer VCC ramps.
- **ADC→MCU direction:** DOUT/DRDY_N remain DVDD-driven CMOS into high-Z nRF52840 inputs (3.6 V absmax): currents are input-leakage scale; **no back-power** (MCU rail already powered; nothing charges an unpowered rail).
- **Analog side:** RLDREF dead → VCM star ≈ 0 V; RLD amp dead → RLDOUT undriven (leakage); bias network pulls CHx nodes to ≈0 V. Pin window collapses to AVSS−0.3..AVDD+0.3 = ±0.3 V. Realistic electrode levels (§6) stay inside or clamp at ≪10 mA (§4). Not a damage state.
- Undefined-but-bounded items: six control inputs float (logic undefined; input-stage shoot-through possible at DVDD, budgeted in the 3V3 rail, no damage); conversions, if spuriously started, produce garbage the firmware discards; PWDN_N floating low = standby (safe direction), high = analog attempts on 0 V AVDD (quiescent only, re-RESET recovers).
- Verdict for S2: **conditionally supported** — conditions are the firmware contract in §5 (park safe idles, ignore MISO/DRDY, time-based re-init with RESET). No copper change required (nothing datasheet-proven to add: Y-side pulls were considered and deferred — §7).

## 4. Digital pin-state table (AVDD-off, DVDD=3.3, MCU powered)

| Pin | Dir (ADC view) | AVDD-off state | Risk |
|---|---|---|---|
| SCLK (40) | in | Hi-Z buffer → floats, legal level range | none (damage); undefined logic only |
| DIN/MOSI (34) | in | same as SCLK | none |
| CS_N (39) | in | same; deselect (high) not guaranteed — point-to-point bus, no sharing hazard | none |
| START (38) | in | same; spurious start → garbage data only | none |
| RESET_N (36) | in | same; spurious reset → benign while idle | none |
| PWDN_N (35) | in | same; either standby or analog-attempt, both bounded | none |
| DOUT/MISO (43) | out (DVDD) | driven CMOS → MCU P0.15 | none (leakage-scale) |
| DRDY_N (47) | out (DVDD) | driven CMOS → MCU P0.17 | none |

Back-power/undefined-state paths: **none that move charge into an unpowered rail**. All AVDD-off pin currents are leakage- or clamp-diode-scale, ≥10× below the 10 mA continuous absmax (worst realistic: 1 V motion fault → (1−0.3)/2.2k ≈ 320 µA per leg).
Existing 6× LVC1G125 arrangement: **sufficient, no change**. (Considered and deferred: weak Y-side pulls to 3V3 to define control levels during Hi-Z — standard practice, but no datasheet mandate applies while there is no operation, and wake-up RESET re-establishes state. Revisit only with measured misbehavior.)

## 5. Sequencing requirements (firmware contract; time-based — no rail-good signal exists)

- **Cold power-up / AVDD re-enable (DVDD already active):** (1) park MCU idles CS=1, SCLK=0, MOSI=0, START=0, RESET_N=0, PWDN_N=1; (2) wait AVDD ramp + VCAP1–4 recharge (fixed delay; charge of 22 µF VCAP1 is ms-scale — use ≥50 ms margin); (3) Figure 93 flow: VCAP1>1.1 V criterion, CLKSEL already strapped, pulse RESET_N; (4) wait settle (Figure 93 flow; family value 2^18 fCLK ≈ 128 ms @2.048 MHz — exact §11.1 text TBD-reconfirm); (5) SDATAC before WREG, configure (ref/RLD/PGA/rate), input-short noise check; (6) START. **Always issue RESET after every AVDD cycle** (AVDD-only ramp may not re-fire a DVDD-domain POR).
- **Power-down / USB-triggered AFE shutdown:** best-effort orderly path PWDN_N=0 → CS=1, SCLK=0, START=0 → release to hardware interlock (note: VBUS NFET kills AFE_ENABLE immediately on insert and can race firmware — hardware wins by design); on wake, run the full re-enable sequence above and enable MCU pulls on MISO/DRDY while DOUT is Hi-Z (CS=1).
- **Safe control levels:** normal run PWDN_N=1, RESET_N=1, CS per-transaction (idle 1), START per acquisition (idle 0), SCLK/MOSI driven only in transactions (idle 0). During ramp keep the parked idles; buffer Y follows A once VCC is alive (LVC functional from ~1.65 V).

## 6. Analog-input / common-mode calculations (frozen values)

Frozen: R_SER=2.2k×2, R_BIAS=390k to VCM, VCM=1.5 V (internal RLDREF mid-supply), Vref=2.4 V internal, no blocking caps, shared RLD. PGA gain **TBD** (family steps 1,2,3,4,6,8,12) — parametric result, no guessing.
Divider: pin = (Vsrc·390k + VCM·2.2k)/392.2k → differential loss 390/392.2 = 0.9944 (0.05 dB, negligible); bias current 200 pA·390k = 78 nV (negligible).
Full-scale differential = ±Vref/G: G=1 → ±2.4 V; G=8 → ±300 mV; G=12 → ±200 mV. Balanced per-side swing = half the differential, around 1.5 V CM:

| Case (diff) | Pins (VCM=1.5) | %FS @G=12 | %FS @G=1 | vs absmax [−0.3, 3.3] |
|---|---|---|---|---|
| 0.5 mVpp EMG | 1.49975 / 1.50025 | 0.125% | ~0.01% | >1.7 V margin |
| 5 mVpp EMG | 1.49875 / 1.50125 | 1.25% | 0.1% | >1.7 V margin |
| ±50 mV electrode offset | 1.475 / 1.525 | 25% | ~2% | >1.7 V margin |
| ±100 mV transient | 1.45 / 1.55 | 50% | ~4% | >1.7 V margin |
| Stacked ±155 mV worst | 1.42 / 1.58 | 77.5% | 6.5% | >1.7 V margin |

Common-mode: with pins inside any sane linear window (working assumption [0.5, 2.5] V — CMVR exact spec TBD-reconfirm), CM tolerance is ≈ ±1.0 V around 1.5 V CM at zero differential; RLD holds body CM at mV scale in practice. Multi-volt CM (mains fault/defib/ESD without populated TVS) is outside the design intent and already blocked by the body-safe gate.
AVDD-off window [−0.3, +0.3] V (VCM≈0): ±50 mV → ±49.7 mV pins ✓; ±100 mV → ±99.4 mV ✓; ±300 mV → ±298 mV ✓ (borderline, no violation); 1 V fault → diode-clamped, ≈230–320 µA ≪ 10 mA ✓.

## 7. VCAP / reference restart

VCAP1 22 µF + VCAP2/3/4 1 µF discharge through internal loads on AVDD collapse and recharge on ramp (ms-scale worst case). Internal 2.4 V ref + RLDREF restart with AVDD. Firmware must apply the §5 fixed delays (≥50 ms post-EN before RESET; Figure 93 settle after RESET) because no rail-good feedback exists. Minimum rail-good→START interval = ramp/charge wait + RESET + settle + config — all covered by the §5 sequence. No schematic change (a rail-good sense divider would be speculative new copper).

## 8. Schematic corrections required by this audit

**None.** Evaluated and explicitly declined: (a) RLDIN tie-point (copper says VCM; freeze text says RLDOUT — see §9, not datasheet-arbitrated, no rewire without SBAS459 text); (b) Y-side control pulls (no operation during Hi-Z, wake RESET suffices); (c) AFE rail-good sense (speculative copper); (d) input network values (headroom enormous at any gain 1–12). No value tuning, no ERC suppression.

## 9. Remaining uncertainties (must clear before ROUTING freeze; none blocks PLACEMENT)

1. Exact SBAS459 §11.1/Figure 93 sequencing text (pre-existing freeze blocker §9.5) — re-confirm live from TI; firmware numbers above follow the frozen Figure 93 flow.
2. RLDIN tie arbitration: netlist proves RLDIN→VCM / RLDREF→VCM with RLDOUT on its own driven net (comp R 1M + C 1.5 nF to RLDINV intact) — consistent with RLDIN-as-reference-input; freeze §3 sentence "RLDIN tied RLDOUT" contradicts copper and must be corrected or the trace moved per live §RLD text. One-trace ECO in the ADC zone; placement-neutral.
3. ADS1294 internal pulls on START/CS/RESET/PWDN (float-idle behavior refinement only).
4. Datasheer CMVR exact linear window (working assumption [0.5, 2.5] V used above; nothing binds near it).
5. Live re-read of SN74LVC1G125 SCES223 cells (Audit 1 caveat carries over; margins make revision risk nil).

## 10. Verdict

**PASS FOR PCB PLACEMENT** (conditional): the DVDD-always-on / AVDD-switched architecture is electrically valid in every intended rail state; all pin voltages/currents are bounded in normal, transitional, and AVDD-off states; the 6× LVC1G125 isolation is sufficient; analog headroom is enormous at any TBD gain 1–12. Conditions: implement the §5 firmware sequencing contract (time-based), and clear uncertainties 1–2 from the live TI datasheet before ROUTING freeze. No schematic edit in this audit. PCB placement/routing NOT started.
