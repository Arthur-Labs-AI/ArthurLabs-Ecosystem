# ARTHUR NEURON RevB — Comprehensive Pre-Manufacturing Audit

## Mission

Perform a comprehensive, evidence-based, independent engineering audit of the complete Arthur Neuron RevB EMG PCB before placing the first prototype manufacturing order.

The goal is to determine whether the current design is ready to be ordered as a prototype PCB/PCBA, identify all remaining manufacturing or engineering blockers, and distinguish manufacturing readiness from electrical safety for human use.

**This is an AUDIT, not a redesign or implementation milestone.**

Do not automatically fix issues, alter the PCB, modify the schematic, or regenerate production files over existing artifacts.

## Project context

Repository: `A.R.T.H.U.R`

Hardware directory: `hardware/emg/rev-b-xiao/`

Existing branch: `codex/revb-horizontal-jst`

Recent work:
- Five vertical electrode JST connectors were replaced with horizontal JST-PH connectors.
- The existing battery JST connector remains unchanged.
- The 51.30 × 64.95 mm PCB outline was preserved.
- Schematic and PCB footprints were synchronized.
- Electrical routing was updated.
- A nominal mechanical validation was completed.
- Previous KiCad DRC reported zero errors, zero unconnected items, zero parity issues and one pre-existing XIAO footprint/library warning.
- Prototype fabrication exports already exist under `NOT_RELEASED_fabrication/`.

Relevant evidence:
- `evidence/horizontal-jst/`
- `evidence/horizontal-jst/mechanical-validation/REPORT.md`
- Existing PCB, schematic, BOM, CPL and manufacturing scripts.

Review these files as evidence, but independently verify their conclusions wherever possible.

## Phase 1 — Repository and design integrity

1. Identify the authoritative schematic, PCB, libraries and production artifacts.
2. Inspect Git status and record existing uncommitted changes.
3. Verify that all schematic sheets and PCB files represent the same revision.
4. Compare against the pre-JST-ECO baseline where appropriate.
5. Verify that unrelated circuitry and board geometry were preserved.
6. Check for missing libraries, stale dependencies, obsolete footprints and mismatched manufacturing exports.
7. Identify any undocumented engineering changes.

Do not discard or overwrite existing work.

## Phase 2 — Comprehensive electrical design review

Independently examine the entire electrical design, not only the JST modifications.

Review:

- All EMG analog signal paths.
- Electrode input protection and current-limiting networks.
- Input impedance and loading.
- Differential signal routing and channel symmetry.
- Analog amplifier configuration, gain, filtering and usable bandwidth.
- Reference and RLD circuitry.
- Power supply architecture.
- Battery connections, voltage regulation and decoupling.
- Charging circuitry, if present.
- ESP32-S3 integration and GPIO assignments.
- ADC input compatibility and voltage limits.
- Grounding, reference planes and analog/digital interference.
- ESD protection and likely failure modes.
- Reverse-polarity, overvoltage and short-circuit behavior.

Cross-check relevant components against manufacturer datasheets.

For every meaningful finding, distinguish verified defects from engineering concerns that require physical testing.

## Phase 3 — Body-contact electrical safety assessment

Treat the nine electrode connections as a safety-critical interface.

Review:

1. Possible current paths from battery, USB, charging circuits and external equipment to electrodes.
2. Single-fault behavior and component failures.
3. Electrode current-limiting implementation.
4. Reference/RLD output behavior under normal operation and faults.
5. Whether USB connectivity or charging could expose the wearer to unacceptable electrical hazards.
6. The absence or presence of galvanic isolation and protective measures.
7. Whether firmware restrictions are being used as substitutes for hardware protection.
8. Remaining evidence required for a qualified body-contact safety review.

Use applicable medical electrical safety principles as guidance, without claiming standards compliance or certification.

**Do not declare the device safe to wear or safe for human electrode contact based solely on schematic inspection, DRC or simulation.**

The existing restriction against connecting electrodes to the body while USB is connected remains in force. Do not assume that this restriction alone establishes safety.

Identify which safety-critical checks require qualified independent review, measurements or physical testing.

## Phase 4 — PCB layout and signal integrity

Inspect:

- Placement and orientation of all components.
- Analog trace routing.
- High-impedance input paths.
- Differential channel symmetry.
- Ground and power planes.
- Return current paths.
- Via placement.
- Decoupling capacitor positioning.
- Switching and digital interference near sensitive analog sections.
- Copper-to-edge distances.
- Trace widths, spacing and clearances.
- Thermal relief and solderability.
- Mechanical stress around connectors.

Check all five new horizontal JST connectors and their nearby resistors.

Verify the pin mappings, footprint geometries, insertion directions and mechanical retention pads.

Re-run DRC, ERC and schematic parity checks independently.

Investigate the existing U1 XIAO footprint/library mismatch rather than silently accepting it.

## Phase 5 — Component and BOM verification

Audit EVERY BOM line.

For each component, check:

- Manufacturer and MPN.
- Package and footprint compatibility.
- Electrical ratings.
- Component tolerances.
- Voltage and temperature ratings.
- Availability and assembly compatibility.
- LCSC identification where applicable.
- Appropriate substitutes if unavailable.

Specifically investigate the existing BAV199 versus BAV199,215 MPN audit discrepancy.

Do not assume that differences in suffixes are harmless without manufacturer evidence.

Verify that every BOM reference matches the actual PCB and schematic.

## Phase 6 — Manufacturing DFM and DFA review

Audit the design against the relevant documented capabilities of PCBASIC and JLCPCB.

Check:

- Board dimensions, thickness and layer stackup.
- Copper weight and track/spacing constraints.
- Minimum drilling requirements.
- Solder-mask openings and clearances.
- SMT assembly constraints.
- Component orientation and pick-and-place data.
- JST connector assembly and mechanical access.
- Fiducials and tooling needs.
- Silkscreen alignment.
- Solder paste and stencil geometry.
- Assembly-side requirements.
- Potential hand-soldering or partial-assembly requirements.
- Manufacturing tolerances and prototype yield risks.

Do not invent factory requirements. Flag any requirement that needs direct manufacturer confirmation.

## Phase 7 — Gerber, drill, BOM and CPL verification

Independently validate the existing generated manufacturing package.

Confirm:

1. Gerber layers correspond to the authoritative PCB.
2. Drill files are correct.
3. Board outline is correct.
4. BOM and CPL references match the schematic/PCB.
5. X/Y positions and rotation corrections are consistent.
6. SMD footprints correspond to the ordered components.
7. No required parts are missing.
8. No unintended parts are included.
9. Fabrication output has not been generated from an obsolete PCB revision.

Perform a visual inspection of the plotted manufacturing layers.

Do not overwrite the original release package during the audit.

## Phase 8 — Prototype testing readiness

Develop a practical bring-up checklist for the first physical board, covering:

- Visual inspection and continuity checks.
- Power supply verification using current-limited bench equipment.
- Regulator voltages and power consumption.
- Battery operation and charger tests, where applicable.
- MCU flashing and firmware communication.
- Analog front-end verification with controlled simulated signals.
- EMG channel noise and gain measurements.
- RLD/reference circuit bench verification.
- Connector continuity and polarity.
- Fault simulations where safely practical.
- Acceptance criteria for progressing to the next stage.

Initially perform testing using bench equipment and simulated electrode signals, without connecting electrodes to a person.

Keep any subsequent human-contact testing explicitly blocked pending a separate electrical safety review.

## Phase 9 — Final verdict

Create a detailed audit report at:

`hardware/emg/rev-b-xiao/evidence/pre-manufacturing-audit/FINAL_AUDIT.md`

The report must contain:

### A. Executive summary
Overall readiness and the most important findings.

### B. Findings table
For each issue:
- Unique identifier.
- Severity: CRITICAL / HIGH / MEDIUM / LOW / INFO.
- Exact file and component references.
- Evidence.
- Potential consequence.
- Recommended correction or verification.
- Whether it blocks prototype manufacturing.

### C. Verification matrix
List each test, outcome, evidence location and unresolved limitation.

### D. Manufacturing readiness
Explicit verdict:

- READY FOR PROTOTYPE ORDER
- CONDITIONAL — FIXES OR FACTORY CONFIRMATION REQUIRED
- BLOCKED — DO NOT ORDER

### E. Separate safety verdict
State whether electrical body-contact safety has been independently established. Never infer this from manufacturing readiness.

### F. Required actions
Separate:
1. Must fix before ordering.
2. Must verify with the manufacturer.
3. Can test on the manufactured prototype.
4. Must resolve before human contact.

### G. Prototype bring-up checklist
An actionable test procedure for the first assembled board.

## Rules

- Be skeptical of previous PASS results.
- Prefer independent verification over trusting previous scripts.
- Never suppress or weaken DRC/ERC findings merely to obtain a pass.
- Clearly distinguish measurement, simulation, calculation, manufacturer specification and engineering assumption.
- Do not modify unrelated project files.
- Do not create a commit unless explicitly requested.
- Keep the current NOT RELEASED status throughout the audit.
- Do not claim manufacturing approval or electrical safety certification without the necessary evidence.

**Deliver a real engineering audit, not a generic checklist.**

Finish with a clear answer to:

"Can we order the first Arthur Neuron RevB prototype PCB/PCBA now, and exactly what remains before the board may be connected to a person?"