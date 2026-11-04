# ERC and unresolved electrical issues

Last run: KiCad CLI 10.0.6, 2026-09-20  
Command: `kicad-cli sch erc --format json --severity-all --output ARTHUR_EMG_RevA-erc.json ARTHUR_EMG_RevA.kicad_sch`

Result (Audit 1): **0 errors, 1 warning, 0 exclusions**. No ERC suppression configured (default ignored checks only: `single_global_label`, `four_way_junction`, `simulation_model_issue`, `footprint_filter`).

## Retained warnings (all `isolated_pin_label`, all reviewed)

- `USB_SHIELD` (root): receptacle shield with no termination. Intentionally undecided until enclosure/EMC plan. BLOCKER for layout sign-off.
- Audit 1 removed the 20x co-located global+hierarchical `MCU_*` pairs on the ADC side: the ADC sheet's six `MCU_*` hierarchical labels, six duplicate globals, and six root ADC-instance sheet pins are deleted. Each `MCU_*` net now runs globals-only (MCU module pin <-> buffer A pin, verified in the exported netlist); the pattern no longer warns and, more importantly, no longer confuses net resolution.

## Electrical issues outside ERC's scope (blockers, unchanged)

- NOT body-safe, NOT galvanically isolated, NOT IEC 60601 compliant. Electrodes MUST NOT be connected while USB is attached.
- Battery cell MPN + NTC + PCM + connector lock (drives ISET/TS final).
- Live LCSC/JLCPCB stock re-check at order (MCU, ADS1294, BQ24074, TPS63031, TPS7A20, buffers, connectors).
- IEC 60601 risk file + creepage/coating + patient-leakage allocation.
- RFI campaign + measured electrode impedance/artifact spectrum (C_CM/TVS DNP by default).
- ADS1294 Section 11.1 power-sequencing exact-text confirm + firmware register map review + APPROTECT policy.
- Enclosure/EMC: USB_SHIELD termination, cable shield, creepage.
- Buffer geometry note (Audit 1): `BUF_IOFF` (SN74LVC1G125-class) had its A and OE_N graphic rows swapped: A is now upper-left, OE_N lower-left, matching the drawn wires (MCU_* into A, GND into OE). VCC renders low side, GND high side of the drawn symbol; pad-to-net mapping (pad 5 = VCC = `AFE_3V0`, pad 3 = GND) is by pin NUMBER and is correct for layout. Pre-Audit-1, A/OE were graphically swapped vs the wires, so copper intent was A=GND with all six OE commoned (SPI/control dead) — fixed and netlist-verified. No `AFE_PWR_GOOD` divider exists; OE is tied GND.

Machine-readable report: `ARTHUR_EMG_RevA-erc.json`.
