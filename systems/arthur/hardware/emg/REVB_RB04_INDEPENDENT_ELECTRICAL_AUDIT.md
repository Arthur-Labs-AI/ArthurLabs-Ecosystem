# RB-04 — Independent Electrical Audit

Date: 2026-10-11. Subject: the installed Rev B PCB `rev-b-xiao/kicad/ARTHUR_EMG_RevB/ARTHUR_EMG_RevB.kicad_pcb` (sha256 `d70401f3…`,
51.30 × 64.95 mm, four copper layers, 135 footprints). Nothing was committed, ordered, uploaded or released. No electrical-safety
certification and no permission for human electrode use is implied anywhere in this document.

Companions: `REVB_RB04_DFM_AUDIT.md`, `REVB_RB04_ECONOMIC_PCBA_AND_BOM.md`, `REVB_RB04_OPEN_RISKS_AND_DECISIONS.md`.
Evidence: `rev-b-xiao/evidence/rb04/`. Tools: `rev-b-xiao/tools/rb04_*.py`, `rb04_run_all.sh` (one command reproduces everything).

> **RB-04A update.** Superseded by RB-04A (2026-10-11): board is now `B / RB-04A`; the TP2 dependence is repaired (R1 closed), the BOM candidates are selected (R5 reduced to the 2.2 µF approval), the JLC inquiry is prepared and **not sent**. Details: `REVB_RB04A_*.md`.
> The only copper change is two 0.30 mm B.Cu segments (AFE_3V0, 4.5 mm). With TP2 removed from the graph: 0 unreached pads, AFE_3V0 140.8 mΩ / 1.94 mV (before: 15 pads unreached). Every other audit result in this document is unchanged (analog, mask, electrical, iron-access JSONs byte-identical).

## 1. Method and what "independent" means here

Prior PASS statements were treated as claims. Every number below was recomputed by code written for RB-04 that does **not** call the
earlier RB-03R/RB-03S audit scripts or KiCad's DRC engine:

| Check | Tool | Shared with earlier work |
|---|---|---|
| schematic ↔ PCB parity (refs, values, footprints, 357 pad nets) | `rb04_parity.py` (kicad-cli netlist XML vs .kicad_pcb text) | s-expression parser (`rb02_sexpr.py`) |
| copper clearance (class-aware), hole-to-copper, hole-to-hole, copper-to-edge, plane fills, return path, rule areas, custom-rule re-implementation | `rb04_geom.py` | pcbnew only as a pad-polygon provider; s-expression parser |
| via / mask geometry vs JLC figures | `rb04_mask.py` | same providers |
| supply resistance (own graph + Dijkstra) | `rb04_power.py` | none |
| connectivity without test-pad bridging | `rb04_conn.py` | none |
| coupling, noise, thresholds | `rb04_electrical.py` | none |
| Gerber / drill / CPL / BOM read-back | `rb04_gerber.py` (own RS-274X + Excellon reader) | none |

The s-expression parser and pcbnew pad shapes are shared dependencies; if either were wrong, both audits would be wrong the same way. Datasheet
values were read from the TI PDFs (ADS131M04 SBAS890D, TLV9061/2/4 SBOS839) in this session.

## 2. Verdicts

| Phase item | Verdict | One-line reason |
|---|---|---|
| Schematic ↔ PCB parity | **PASS** | 135/135 refs, values and footprints equal, 357/357 netlist pins have the same net on the pad, 0 extra / missing; only the two `unconnected-(U1-…/…)` names differ by KiCad's `/` → `{slash}` escaping |
| DRC / ERC / unconnected | **0 / 0 / 0** | KiCad 10.0.6, `--schematic-parity --severity-all`; 1 warning (`lib_footprint_mismatch` U1, accepted) |
| Clearances (own geometry) | **PASS** | 0 class-aware violations; lowest same-layer gap 0.205 mm (X1_OUT ↔ C6009.1); 0 hole-to-copper < 0.25, 0 hole-to-hole < 0.5; copper-to-edge ≥ 0.50 mm |
| Inner layers / planes | **PASS** | In1 one fill outline (3057 mm², 0 islands), In2 one fill outline (2314 mm²) |
| Return path | **PASS** (99.87 %) | uncovered samples are only VBAT under the BAT+ post |
| Power distribution | **CONDITIONAL** | resistances small (§6) but **AFE_3V0 trunk continuity depends on test pad TP2** (finding F1) |
| EMG analog routing | **CONDITIONAL** | hi-Z legs clean (0 vias, F.Cu, 100 % over In1); ADC-input runs 43–58 mm with 7–11 vias; P/N length differences up to 11.7 mm (shown to be electrically negligible, §7) |
| ADC CAP decoupling | **CONDITIONAL** | 0.3 mm via-to-In1 tie (≈ 0.25 nH est.), but its via annulus overlaps the pad opening by 0.040 mm (DFM item) and nothing is measured |
| Oscillator / CLKIN / SPI | **CONDITIONAL** | clock 4.3 mm + 9.8 mm, but CLKIN runs 0.35–0.45 mm from AFE_CAP / MOSI / DVDD_F and 26 % of its B.Cu section is over no In2 pour |
| XIAO geometry / access | **PASS** | 11/11 rule areas coincide with the footprint-defined polygons (deviation 0.000 mm); C17/C18 PASS; iron-body model PASS at 45–60°, 30° short by 0.13 mm on toes 12–13 |
| Single-sided SMT | **PASS** | 126 SMT on F.Cu; B.Cu only the 8 bare test pads and the BAT+ post pad |
| Dimensions / stack-up | **PASS with notes** | 51.30 × 64.95 mm; stack-up 1.606 mm computed (nominal 1.6); JLC04161H-7628 values |

## 3. Findings (new in RB-04)

| # | Severity | Finding | Evidence | Proposal |
|---|---|---|---|---|
| F1 | **Medium** | The AFE_3V0 copper is two sets of tracks that do not touch: the B.Cu trunk ends at (28.8, 33.9) and the LDO-side copper at (28.3, 34.45). They are joined **only by the copper of bare test pad TP2** (Ø1.5 mm, no mask, on the skin side). DRC/connectivity treat a pad as copper, so every earlier check passed. Current is only 13.8 mA, but a probed, scratched or bridged test point would interrupt the analog rail | `conn.json` (without TP pads AFE_3V0 has 2 components; no other net) | add two 0.3 mm B.Cu segments (28.8,33.9)→(28.3,33.9)→(28.3,34.45). Scratch candidate: DRC 0 errors, 0 unconnected, guard PASS. **Not applied** (owner decision D1) |
| F2 | Low-Medium | SPI nets run on In2 for 3.6–4.4 mm (SCLK_MCU, MISO, MOSI_MCU) and on B.Cu for 6.4–8.9 mm (SCLK, MOSI, CLKIN). In2 tracks sit 1.065 mm from In1 (5× the 0.21 mm of F.Cu); B.Cu tracks reference the In2 pour except where the In2 pour is cut away (26 % of CLKIN B.Cu samples) | `electrical.json`, `geom.json` | none required at ≤ 8 MHz; list for EMC pre-compliance |
| F3 | Low | Fast-net layer-change vias are 1.1–6.0 mm from the nearest GND via (MISO 6.0 mm, SCLK_MCU 5.2 mm, MOSI_MCU 4.7 mm). F.Cu→In2 hops stay referenced to In1 (no stitching needed); F.Cu→B.Cu hops (SCLK 2.9 mm, MOSI 2.8 mm, CLKIN 2.0 mm) rely on plane-to-plane capacitance | `electrical.json` | accept; add GND stitching vias at SCLK/MOSI/CLKIN transitions if EMC testing demands |
| F4 | Low | ADS131M04 differential input impedance is 300 kΩ at gain 1–4 (SBAS890D 6.5); the 2 × 1 kΩ AAF series resistors give a 0.67 % deterministic gain error, identical on all channels | datasheet | calibrate; no layout change |
| F5 | Info | RB-02/RB-03 "DRC clean" rested on KiCad defaults for 5 DRC checks (`missing_courtyard`, `track_not_centered_on_via`, `tuning_profile_track_geometries`, `footprint_filters_mismatch`, `footprint_type_mismatch`) and 4 ERC checks (`single_global_label`, `four_way_junction`, `simulation_model_issue`, `footprint_filter`) being **ignored**. Checked directly: 0 footprints without courtyard, 0 named single-pin nets, 18 `unconnected-` pins (all expected: BAV199 pin 2 ×8, JST retention pads ×6, J5001 pin 1, XIAO D4/D5, LDO NC) | `drc.json`, `erc.json`, `parity.json` | none |
| F6 | Info | Title block says "B / RB-02", text variable REVISION "B / RB-01" | job file | update at release preparation |
| F7 | Info | The job file reports 51.4 × 65.05 mm because Edge.Cuts has 0.1 mm line width; the outline centre-line is 51.30 × 64.95 mm | `gerber_report.json` | state the size explicitly on the order |

## 4. Parity, geometry and plane results (numbers)

* Parity: 135 components, 357 netlist nodes, 90 nets in both; 0 pads whose net differs; DNP set = {U1}; attributes: 126 `smd`, 1 `dnp+through_hole`, 8 `exclude_from_bom+exclude_from_pos_files`.
* Items: 1516 track segments, 201 vias (all 0.60 / 0.30 mm, annular ring 0.15 mm), 364 pads, 1 PTH (post, 1.40 mm).
  Track widths: 0.15 mm ×24, 0.20 ×962, 0.25 ×81, 0.30 ×405, 0.50 ×44.
* Class-aware clearance (netclass clearance = max of both items, floor 0.15): **0 violations**; custom rules re-implemented independently:
  hi-Z-to-foreign copper < 0.40 mm **not exempt: 0**, exempt pairs 72 (all U501/U502 pin pitch, none involves a via);
  SPI→hi-Z < 2.0 mm: 0; SPI→buffered < 1.0 mm: 0.
* Fills: In1 3057.1 mm² single outline, In2 2313.6 mm² single outline (the In2 pour is cut at x = 25.5 mm in the lower-right quadrant by design).
* Return path over In1: 5990 samples (own-via antipads excluded, radius 0.62 mm), 99.87 % covered; only VBAT at the BAT+ post (keep-out) is uncovered.
* Rule areas (underside XIAO keep-outs, ZONE_A, six TLV9064 areas): 0 tracks/vias inside a no-track / no-via area.

## 5. Ground and supply integrity

Single solid In1 plane; In2 two zones tied through the plane. 71 SMD ground pads: median 0.97 mm to the nearest ground via; 11 pads > 2 mm, 5 > 3 mm
(1 nF ADC-input capacitors and 100 kΩ bias resistors in the hi-Z band, kept 0.40 mm clear of hi-Z copper). The C6009 return is 0.3 mm
(see RB-03S); ADS131M04 decoupling: C6007 AVDD 2.1 mm, C6008 DVDD 1.5 mm, C6009 CAP 2.0 mm (pad centre to pin), X1 C6010 3.3 mm.

## 6. Power distribution (own solver) and current bounds

Resistance model: 35 µm copper (0.49 mΩ/□), 1.17 mΩ per via, T-junctions and same-net overlaps merged, pads attached by contact.

| Net | Source pad | Bound (mA) | Max R to a pad (mΩ) | Drop (mV) |
|---|---|---|---|---|
| `AFE_3V0` | U4002.5 | 13.8 | 138.8 (U502.4) | 1.915 |
| `DVDD_F` | FB1.2 | 11.4 | 47.4 (C6010.1) | 0.54 |
| `VBAT` | J1.1 | 500.0 | 14.3 (U1.23) | 7.15 |
| `/Analog_Power_Interlock/VBAT_AFE` | R4001.2 | 14.8 | 17.0 (C4005.1) | 0.252 |
| `/XIAO_Brain_Interface/XIAO_3V3` | U1.12 | 11.4 | 7.2 (FB1.1) | 0.082 |
| `/XIAO_5V` | U1.14 | 20.0 | 57.8 (R3006.1) | 1.156 |

Current bounds (datasheets read this session): ADS131M04 IAVDD ≤ 4.0 mA (high-resolution), IDVDD ≤ 0.5 mA (SPI idle); TLV9064 IQ ≤ 0.8 mA per
amplifier (−40…125 °C), 12 amplifiers; SX3M oscillator ≤ 10 mA (15 pF); 0.5 A VBAT bound is a system estimate. Worst drop is 7.2 mV on
VBAT (0.17 % of 4.2 V) and 1.9 mV on AFE_3V0. These agree with the RB-03S numbers (142 mΩ → 138.8 mΩ). **Limits:** DC resistance only; no
transient (radio burst) or inductive analysis; the 0.5 A is not a datasheet figure.

## 7. Phase 3 — electrical quality review

**7.1 Input impedance and protection.** Chain per electrode: 10 kΩ (R101/R102…) → hi-Z node with 100 pF C0G, BAV199 to GND / AFE_3V0, 10 MΩ to VCM →
TLV9064 unity-gain follower. Node capacitance ≈ 111.4 pF (100 pF + 2 × 2 pF diode halves + 4 pF CIC + 2 pF CID + track 0.088 pF/mm);
single-ended input impedance at 50 Hz ≈ 9.45 MΩ. Common-mode → differential conversion from electrode-impedance imbalance at
50 Hz: -59.5 dB for 10 kΩ, -45.5 dB for 50 kΩ, -39.5 dB for 100 kΩ (this is the dominant term;
the 1 % tolerance of the 10 MΩ resistors adds only -86.0 dB). Protection: the 10 kΩ limiter holds the clamp current to
0.13 mA at 5 V, 4.63 mA at 50 V; at 230 V rms the limiter would dissipate 5.29 W (0603, 0.1 W) — **there is no mains / defibrillation
protection and none is claimed**. The patient-reference electrode (RLD_SAFE) is VCM through 100 kΩ (≤ 30 µA if VCM were forced to a rail).

**7.2 P/N symmetry and parasitics (current board).**

| Ch | hi-Z P / N (mm) | Δ | buffer→clamp P / N | clamp→1 nF P / N | buffer→ADC P / N | Δ | vias/leg | min to SPI (mm) |
|---|---|---|---|---|---|---|---|---|
| CH1 | 18.3 / 15.7 | 2.6 | 10.2 / 15.4 | 6.8 / 6.8 | 57.5 / 55.5 | 2.0 | 7 | 2.91 |
| CH2 | 15.7 / 19.9 | 4.2 | 9.4 / 7.1 | 6.8 / 6.8 | 54.5 / 42.8 | 11.7 | 10 | 2.12 |
| CH3 | 18.4 / 16.5 | 1.9 | 10.2 / 10.2 | 6.8 / 6.8 | 53.6 / 52.5 | 1.2 | 11 | 3.01 |
| CH4 | 15.7 / 19.9 | 4.2 | 9.4 / 7.1 | 6.8 / 6.8 | 52.0 / 57.6 | 5.6 | 10 | 3.52 |

Hi-Z legs: F.Cu only, 0 vias, Δ ≤ 4.2 mm → ΔC ≤ 0.37 pF on a 111 pF node (0.3 %); resulting CM→DM ≈ Zs·ω·ΔC = 50 kΩ × 2π·50 × 0.37 pF ≈ −104 dB,
below the −82 dB produced by the ±5 % tolerance of the 100 pF C0G caps themselves. ADC-input runs (low-impedance, behind the follower and 1 kΩ):
Δ up to 11.7 mm ≈ 1.0 pF against 1 nF CM caps (0.1 %), delay skew ≈ 70 ps; at 500 Hz the phase skew is 2×10⁻⁷ rad. No differential-pair
length matching is warranted and none was imposed.

**7.3 Hi-Z inputs near digital / RF.** Hi-Z copper is ≥ 31.8 mm from the XIAO module centre, ≥ 24.7 mm from any SPI/clock copper (rule: 2.0 mm), 
and has 0 parallel runs with SPI nets. Largest coupling (coplanar-strip upper bound, ignores the plane): /CH1/HIZ_N ↔ AFE_3V0: 146.89 fF; /CH3/HIZ_P ↔ AFE_3V0: 114.82 fF; /CH2/HIZ_N ↔ /CH2/HIZ_P: 102.76 fF — hi-Z ↔ AFE_3V0 (a decoupled rail) and P ↔ N, not digital.

**7.4 ADC buffered-input routes.** 43–58 mm, 7–11 vias per leg (table above). Source impedance behind them ≈ 1 kΩ + follower output; track capacitance 55 mm × 0.088 = 4.8 pF.
Parallel runs with SPI/clock within 2 mm: none found by the model; minimum distance 2.1–3.5 mm. A 0.2 pF SPI coupling onto the 1 nF node would give 0.66 mV for a full-swing edge before filtering — unmeasured.

**7.5 CAP decoupling and DGND return.** AFE_CAP net 2.7 mm F.Cu, 0 vias; C6009 ground tie 0.3 mm to a via into In1 (0.21 mm below). Estimated loop ≈ 0.25 nH
(Johnson via + Hammerstad microstrip), series resonance with a 0.7 nH 0603 MLCC ≈ 11 MHz. Limits as in RB-03S: ±50 %, no field solver. Needs: a CAP-pin noise measurement.

**7.6 ADC_CLKIN vs AFE_CAP / MOSI / DVDD_F.** Edge-to-edge 0.35 mm (AFE_CAP), 0.45 mm (MOSI, DVDD_F), 0.70 mm (SCLK) at the closest points. Parallel-run model:
/ADC/ADC_CLKIN ↔ /MOSI: 201.42 fF; /ADC/ADC_CLKIN ↔ /SCLK: 160.33 fF; /ADC/ADC_CLKIN ↔ DVDD_F: 34.77 fF; /ADC/ADC_CLKIN ↔ /MISO: 31.67 fF; AFE_CAP: /ADC/ADC_DOUT ↔ /ADC/AFE_CAP: 24.3 fF; /ADC/AFE_CAP ↔ /ADC/X1_OUT: 23.38 fF; /ADC/AFE_CAP ↔ DVDD_F: 0.55 fF. Crosstalk estimate for the worst line (MOSI, 0.2 pF): V ≈ R·Cc·dV/dt = 58 Ω × 0.2 pF × 1.65 V/ns ≈ 19 mV
on a 3.3 V line (≈ 0.6 %), far inside the 0.3·DVDD noise margin. Injection into the 1.8 V CAP node: 24 fF × 1.65 V/ns × 0.5 Ω ≈ 20 µV. Acceptable; not measured.

**7.7 Clock / SPI return geometry.** All fast nets over In1 at 99.9 %; layer-change vias per F3. F.Cu runs are over the solid In1 plane. In2 segments (F2) are the weakest return geometry.

**7.8 Analog / digital supply filtering.** AFE: R4001 4.7 Ω + C4007 22 µF 0805 (≈ 10 µF effective at 4 V) → corner ≈ 3386 Hz before the TPS7A2030
(LDO PSRR 65 dB @ 100 Hz, 92 dB @ 1 kHz per the RB-01R sheet); VCM: 100 kΩ/100 kΩ divider with 1.1 µF, τ ≈ 55 ms. DVDD: FB1 600 Ω@100 MHz → C7101 10 µF + C7102 100 nF + C6008 1 µF + C6010 100 nF;
DC drop 0.54 mV at 11.4 mA. The ferrite/10 µF corner is not calculated here (ferrite inductance at low frequency is not specified in the data in the BOM); needs a lab measurement of DVDD ripple.

**7.9 USB presence and AFE shutdown.** XIAO 5V → R3006 10 kΩ → Q3001 gate (R3004 100 kΩ pull-down): V_gate = 4.32–4.77 V for VBUS 4.75–5.25 V
(2N7002 VGS(th) ≤ 2.5 V → margin ≥ 1.8 V). Inhibited AFE_EN ≈ 2.5 mV (RDS(on) ≈ 7.5 Ω, 10 kΩ series); not inhibited with request high: 3.0 V
(R3008 100 kΩ pull-down), above the TPS7A2030 EN threshold; request low or MCU unpowered → AFE_EN pulled to 0 by R3008 (fail-safe off). USB_PRESENT divider 100 kΩ/150 kΩ:
2.7–3.15 V at 4.5–5.25 V (≤ 3.3 V GPIO limit; ≥ 0.75·3.3 V = 2.48 V for a valid high at 4.5 V). Datasheet thresholds for the XIAO GPIO and the LDO EN pin were
not re-read in this session (only the RB-01R sheet values were used).

**7.10 Start-up / shutdown input excursions.** ADS131M04 limits: recommended AIN ≥ AGND − 1.3 V, absolute max AGND − 1.6 V and AVDD + 0.3 V, ±10 mA per pin (SBAS890D 6.1, 6.3).
On shutdown the follower outputs fall with the rail while the 2.2 µF coupling capacitors hold their ≈ 1.5 V charge: the ADC side of C101 would be driven to ≈ −1.5 V
(τ = R103·C101 = 0.22 s). The BAV199 negative clamps on the ADC inputs (D103/D104… to GND) hold the pin at ≈ −0.7 V (10 mA max, current (1.5 − 0.7)/1 kΩ = 0.8 mA),
0.6 V inside the recommended limit and 0.9 V inside the absolute limit. Start-up: VCM rises with τ ≈ 55 ms and the coupling network settles with the 0.72 Hz high-pass corner → ≈ 1 s to < 1 %.
Electrode side: with the AFE off the clamps to the collapsed AFE_3V0 rail conduct and the 10 kΩ limiter bounds the back-feed to (V − 0.7)/10 kΩ per input; the TLV9064 input protection limit is 10 mA (100 V through 10 kΩ); no analysis of the
rail being back-driven above the LDO output was done — it needs a bench test with a known electrode source.

## 8. Assumptions and unsupported conclusions (flagged)

1. "Tented by default" — JLC publishes plugged and filled/capped options with conditions; it does not state the default on the page read (DFM audit §3).
2. All coupling numbers are upper bounds from a coplanar-strip model that ignores the plane 0.21 mm below; none was measured.
3. Parasitic inductance (0.25 nH, 6–10 nH) uses closed-form microstrip/via formulas, stack-up nominal.
4. Current bounds: datasheet maxima plus a 0.5 A VBAT system estimate; no measurement.
5. The return-path coverage excludes samples inside a track's own via antipad (0.62 mm); a track passing another net's via antipad counts as uncovered (none found).
6. `rb02g_check` C06 (board size) FAILS by definition against the RB-00.6 estimate and is not a design finding; C26 (JLC process rails) is CONDITIONAL by design.
7. ERC/DRC passes depend on KiCad's default-ignored checks listed in F5.
8. No ESD, EMC, radiated-emission, safety (IEC 60601) or leakage-current analysis exists; the patient-connected circuit has no certified protection.
9. Behaviour with the XIAO ESP32-S3 radio (current bursts, antenna) is outside the layout evidence.

## 9. What only measurement can prove

CAP-pin noise and ground-return impedance of C6009; DVDD / AFE ripple with the radio active; input-referred noise and CMRR with real electrode networks; clock-to-ADC
input crosstalk; start-up / shutdown input excursions; leakage of the hi-Z nodes (10 MΩ bias, humidity, HASL flux residue); skin-side test pad exposure.

## 10. Reproduction

```
bash hardware/emg/rev-b-xiao/tools/rb04_run_all.sh /tmp/rb04_scratch          # everything; exports stay in the scratch dir
python3 hardware/emg/rev-b-xiao/tools/rb04_geom.py --pcb <board> --out geom.json
python3 hardware/emg/rev-b-xiao/tools/rb04_conn.py --pcb <board> --out conn.json
```
