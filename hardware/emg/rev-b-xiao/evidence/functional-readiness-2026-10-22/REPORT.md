# RevB functional-readiness review — NOT RELEASED

2026-10-22, Europe/Sofia. Branch `hardware/revb-horizontal-jst`; inspected source HEAD `69b3f7410b88d11a77dddeeee453310e0d5b39b9`. Earlier uncommitted Gerber-check evidence/navigation changes are preserved. This pass adds evidence only; no PCB, schematic, component selection, manufacturing CSV/archive or constraints changed. No commit, push, order or authorization performed.

## Decision

**A 100% functional guarantee is not established and cannot follow from the design/manufacturing-file checks.** No new connectivity defect was found in the inspected current source; the topology remains a plausible controlled bench prototype. This is not a release for production or a qualified wearable. Successful acquisition, RF coexistence, battery/charger operation and safe body contact require actual assembled-unit measurements and firmware integration.

**The JLCPCB assembly is intentionally incomplete:** U1 XIAO ESP32-S3 is factory DNP/manual. The 126 factory references exclude it; TP1–TP8 are copper features. The received PCBA therefore will not be a functioning complete EMG device until the exact module is manually mounted, its BAT+ post connection qualified, suitable firmware installed and the board brought up. This is an intended assembly boundary, not a newly discovered missing BOM item.

## Executed gates

All native KiCad checks used an isolated copy at `/tmp/arthur-functional-20261022-x2dm_w26/project`, exported afresh from the current canonical source. No in-place editor/PCB rebuild scripts were used.

| Gate | Status | Executed result / limitation |
| --- | --- | --- |
| Source identity | PASS | All 27 PCB/project/schematic/symbol/library hashes match the audited package. `source-membership.json`. |
| Native ERC | PASS | KiCad 10.0.6, `sch erc --severity-all --format json`: 0 violations. `erc.json`. |
| Native DRC / parity | PASS for errors/connectivity; WARNING retained | `pcb drc --severity-all --schematic-parity --format json`: 0 errors, 0 unconnected, 0 schematic parity issues, 1 existing U1 `lib_footprint_mismatch` warning. Existing ignored categories remain recorded. `drc.json`. |
| Fresh source partition/pin/role audit | **FAIL: 22/23 groups pass** | Existing `rb01r_netlist_audit.py` reports only D06: its exact-string expectation is BAV199 while all 16 selected parts specify BAV199,215. `netlist-audit.json`. This is not hidden or relabeled as 23/23. |
| D06 manufacturer identity review | PASS for identity disposition | Nexperia's primary identity table explicitly maps OPN BAV199,215 to type BAV199, SOT23, 12NC934032640215. It supports the selected identity, not arbitrary diode substitution or reel orientation. Checker code remains unchanged. |
| Full netlist mutation suite | **UNVERIFIED / baseline blocked** | Invoked against fresh XML; stops immediately with `BASELINE FAILS: ['D06']`. No claim that its approximately 1500 mutants passed. `mutation-baseline.txt`. |
| PCB pad nets vs fresh schematic XML | PASS | 364 net-connected PCB pad instances compared; 0 mismatches. Two KiCad `{slash}` escape encodings in intentionally unconnected U1.5/U1.6 names are explicitly normalized and listed. No electrical nodes are ignored to obtain a pass. `check_source.py`, `source-membership.json`. |
| Current BOM vs fresh XML | PASS | 28 groups, 126 unique refs; every value/MPN/footprint/LCSC field agrees. U1 manual/DNP and TP1–TP8 excluded by intent. |
| Rotation regressions | PASS | Four `test_jlc_rotations.py` tests, including guarded five-header exception and preservation of primary J1/other 121 placements. This checks current exporter behavior, not approval of legacy J1=270. |
| Mechanical checker fault cases | PASS | Four deliberate bad pad-width/rotation/part/outline cases rejected. Run under a scratch working root so earlier evidence is not overwritten. `mechanical-tests.txt`. An initial unittest-discovery attempt lacked the script's temporary directory; it was rerun using its documented script invocation with scratch setup. |
| Selected fabrication/CPL integrity | PASS | Today's read-only `gerber-orientation-check.../verify.py` rerun: 11 native export members match current fabrication geometry; all 24 JST land centers match F.Cu/F.Mask/F.Paste and copper pin/net identities. The separate J1-90 CPL changes exactly six rotation cells from RC1, no coordinates or other 120 rotations. `package-gerber-check.json`. |
| Corrected connector mouth direction | User/image corroborated; limited | Today's supplied image and user confirmation corroborate outward five-header and J1 mouths. Final factory 2D numbered-terminal overlay and all polarized marking/reel checks are not established by this image. |
| Physical rails, clock, ADC acquisition, signal fidelity, charger and mechanical fit | **UNVERIFIED** | No assembled hardware/instruments or target-firmware execution available in this task. |
| Full worst-case transient/nonlinear/RF simulation | **UNVERIFIED** | Screening calculations and idealized small-signal model below are not substitutes. |
| Factory CAM, exact stocked parts, panel/process and actual production approval | **UNVERIFIED** | Prepared files and screenshot are not factory production-file signoff. |
| Human-contact safety | **UNVERIFIED; not approved** | No galvanic isolation; functional regulator inhibit does not disconnect ground. Separate qualified review and measured safety evidence remain required. |

## Functional review findings

No new proven copper/net/pinout defect requiring a PCB redesign emerged from the current source checks. The following are real unresolved gates, not assertions that hardware will definitely fail. Severity is scoped to a claim of a complete working product.

| ID / importance | Evidence | Why 100% operation cannot be claimed / required closure |
| --- | --- | --- |
| F01 — blocker for out-of-box functionality | Fresh BOM and PCB mark U1 factory DNP; XIAO BAT+ is host PTH/post pad 23, other module contacts are manual castellations. | PCBA alone cannot boot/read ADC/transmit. Obtain the exact headerless module, qualify physical alignment and hand assembly, then program and test it. Do not add it to factory BOM without an authorized process change. |
| F02 — important assembly risk | Current BAT hole Ø1.90, top land Ø2.30, top mask Ø1.95, bottom land/opening Ø3.00. Prior source analysis gives nominal neighboring BAT− gap about 0.247 mm; physical module/post/jig not demonstrated. See prior `BAT_POST_ASSESSMENT.md`. | A bridged or missed BAT+ post can prevent operation or short the supply. Measure the actual received module revision; fit an unpowered dummy post, inspect clearance/fillet and check continuity before power. Nominal CAD fit is not an actual fit test. |
| F03 — important ADC startup/configuration risk | ADS131M04 recommended upper input voltage at gain≥8 is AVDD−1.8 V. With AVDD minimum 2.955 V this is 1.155 V. Buffers bias near 1.5 V; AC coupling can transmit startup/common-mode transients. | Startup samples may clip or be outside recommended operation; shutdown injection/absolute-max compliance needs capture. Begin acquisition in a controlled low-gain/settling sequence, verify all AIN/rail waveforms and currents, then qualify the chosen gain. A recommended-range issue is not itself proof of permanent device damage. |
| F04 — important power/interlock margin risk | R4001=4.7 Ω drops 65.8 mV at assumed 14 mA. TPS7A20 1uF nominal output capacitor must retain effective ≥0.47uF. Q3001 exact JSCJ gate worst-case calculation ≈4.083 V at 4.5 V USB; required pull-down current ≈0.33 mA. Prior low-gate worst-case qualification remains absent. | Verify actual LDO input/output, minimum battery headroom, Wi-Fi/BLE current-step sag, output stability and USB inhibit across limits. These calculations neither show a definite failure nor guarantee all conditions. |
| F05 — important unverified firmware/signal-chain behavior | Fresh pin roles agree with the expected XIAO/ADS131 mapping. X1 intended 8.192 MHz, ADC SPI/DRDY/gain/ODR/reset/CRC configuration has not been exercised on target hardware. | No live register readback, sample stream, timing/error log or channel-calibration result exists here. The software repository search under src/tests did not provide a tested RevB acquisition implementation; this is not a proof that no firmware exists elsewhere. Hardware needs an actual bench firmware build and target run. |
| F06 — important EMG performance risk | Four differential channels use unity buffers, 2.2uF coupling,100k returns,1k series,1n shunts and10n differential capacitors. ADC input loading and digital filtering change the transfer function. Reference output is a fixed VCM buffer through100k, not a closed-loop active common-mode cancellation circuit. | Dry-electrode offsets/impedance mismatch, motion, leakage/contamination, 50Hz pickup and RF can cause clipping/noise. Measure gain/phase/noise/CMRR/crosstalk using dummy electrode impedances and simulated signals with radio off/on. Do not promise dry-EMG quality from connectivity. |
| F07 — important cell/charging/harness risk | Host J1 directly supplies VBAT; no host reverse-polarity protection/fuse/pack PCM is established. Charging is performed by the manually selected module; exact cell, protection, capacity, allowed charge current and actual module charger revision are not qualified. Six headers share the same mating family. | Use controlled labeled harnesses and verify polarity; qualify exact protected cell/charger combination on a suitable simulator before cell operation. The JST key/color alone is not polarity protection. |
| F08 — blocker for use on a person | Electrode/reference/USB/module networks share ground; 10k input resistors, diodes and100k reference resistor are not a qualified isolation/safety system. No normal/single-fault current, battery/thermal/material or completed enclosure testing exists here. | Even a functioning ADC does not prove body-contact safety. Keep initial tests on dummy loads. Qualified independent safety review and physical tests remain separate; no person connected with USB/charging/external wired equipment. Battery-only operation is not automatic approval either. |
| F09 — important manufacturing-file selection risk | Primary RC2 and current default exporter preserve J1=270; the specifically supplied alternative has J1=90, five north headers180, and matches the latest user-confirmed preview. | Use the exact preview-corresponding CPL; do not rerun the exporter or upload the main RC2 bundle and assume J1 is identical. Keep selected CPL and unchanged Gerbers paired, and require factory polarity/pin review of all 29 oriented placements. No file is silently promoted by this review. |
| F10 — order/process gate | Panel/rails, exact part stock/substitutions, X1 exact supplier/reel data, BAT-hole CAM treatment, module selection and final factory production-file review remain unconfirmed in the repository. | Close factory questions before unconditional PCBA authorization. Do not infer closed gates from prepared email drafts/checklists or successful upload. |

Silkscreen and the three BOM rating declarations found by the older audit were subsequently corrected in closure; those old findings are not reintroduced as current defects. The existing U1 library warning and D06 test-oracle mismatch remain explicitly visible.

## Independent screening calculations

`screening-calculations.json` records values recomputed from the current nominal circuit. The AC high-pass estimate without ADC loading is 0.723 Hz (τ=0.22 s), VCM divider RC about55 ms, and differential analog RC low-pass scale about7.58 kHz. These are not proof of an EMG passband or startup wait time.

`small-signal-screening.json` solves an idealized symmetric half-circuit including a typical330kΩ ADC differential load at gain1/fMOD4.096MHz. It uses the actual TI digital topology: sinc3 for OSR≤1024; for larger OSR, sinc3 fixed1024 followed by sinc1(OSR/1024). At450 Hz, the model's analog magnitude is about−0.149 dB; the ADC filter alone is about−3.478/−1.099/−0.545 dB at1/2/4 kSPS respectively with8.192MHz clock. These are conditional model values, not measurements or firmware settings already verified. A generic third-order sinc approximation at the final output rate would be incorrect at the higher OSRs and is not used here.

The model excludes electrode variability, opamp dynamics, nonlinear clamp leakage/conduction, saturation, tolerance/DC-bias/temperature, layout parasitics, cable/RF and actual startup/shutdown. No performance percentage or probability of success follows from it.

## Smallest meaningful physical validation

Use the detailed existing [bench-only bring-up checklist](../pre-manufacturing-audit/FINAL_AUDIT.md#g-bench-only-bring-up-and-acceptance-checklist) as the baseline, with the current corrected placement files. At minimum record:

1. Exact module/part/cell identities and microscope inspection; no shorts, correct post joint and connector pin identities.
2. Current-limited first power with no person/cell/USB initially; measure actual VBAT,3V3,AFE≈3.0V,DVDD_F andVCM≈1.5V in all enable/reset states. Screening nominal values do not replace datasheet/load/temperature limits.
3. Clock at the ADC pin, SPI identity/registers/CRC/DRDY/channel mapping, and a documented sustained acquisition run using the actual firmware commit/settings.
4. Power/USB/battery-simulator transitions and each ADC input waveform, settling and non-clipping at intended gains; regulator/clock stability with radio activity.
5. Known differential simulated signals and matched/imbalanced dummy electrode impedances; measured gain, bandwidth, noise, crosstalk and RF/50Hz sensitivity. Establish acceptance criteria before calling the prototype successful.
6. Physical PHR-2 mating, harness polarity/retention and strain relief; module-post joint qualification and exact charger/cell compatibility. Final enclosure/strap integration remains separate.

No physical step above ran in this task. A first controlled bench build can be used to close these unknowns after the factory/order gates and explicit prototype-risk decision. It cannot be sold or described as a 100%-verified working wearable, and revision/rework may be required.

## Commands and evidence

- Fresh KiCad XML: `kicad-cli sch export netlist --format kicadxml` on scratch project; `netlist.xml` retained.
- Fresh native ERC/DRC commands and flags listed in gate table; JSON retained.
- `python3 hardware/emg/rev-b-xiao/tools/rb01r_netlist_audit.py <fresh-XML> --json` →22/23, D06 fail recorded.
- `python3 hardware/emg/rev-b-xiao/tools/test_audit_mutations.py <fresh-XML>` →baseline blocked, recorded.
- `python3 .../functional-readiness-2026-10-22/check_source.py <fresh-XML>` →PASS source/BOM/pad-net checks.
- Existing rotation unit tests and mechanical fault-injection script ran; mechanical test cwd/evidence routed to scratch.
- Today's Gerber verifier rerun against fresh export; output retained.

Primary sources checked on2026-10-22: [TI ADS131M04](https://www.ti.com/lit/ds/symlink/ads131m04.pdf), [TI TPS7A20](https://www.ti.com/lit/ds/symlink/tps7a20.pdf), [JSCJ exact2N7002](https://www.jscj-elec.com/gallery/file/2N7002%20SOT-23%20J.pdf), [Nexperia BAV199 identity](https://www.nexperia.com/chemical-content/BAV199.html), [Seeed module documentation](https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/). `sources.json` records what each supports. Earlier controlled physical/firmware qualifications remain absent; no manufacturer document certifies this complete design.

**Verdict: no new proven connectivity defect found; functional success remains UNVERIFIED. NOT RELEASED.**
