# Rev B verification tooling (RB-01R)

All scripts are read-only, need only Python 3 and `kicad-cli` 10.x, and create no PCB.

| File | Purpose |
|---|---|
| `rb01r_netlist_audit.py` | Independent audit of a **KiCad-exported** XML netlist: 23 check groups (partition vs hand-authored datasheet/role map, symbol pin names vs manufacturer pin tables, NC census, values, MPN/LCSC/footprint identity, BOM census, resistive-path safety, clamp/VCM/inhibit/rail rules). |
| `test_audit_mutations.py` | Fault-injection: ~1500 single-fault mutants of the exported netlist; the audit must kill every one and every check must kill at least one. |
| `rb01r_calcs.py` | Reproducible numbers quoted in the review: ADC limits, noise, diode bounds, transients, DVDD_F budget. |
| `run_rb01r_checks.sh` | One command: export → ERC → audit → mutation → BOM → Rev A hash. |
| `rev_a_baseline.txt` | Recorded Rev A hashes (PCB and tracked-tree). |
| `external_supplied/` | The externally supplied RB-01R checker and its 11-case test, **unmodified**, kept for provenance. They also pass on the real export (67/67, 11/11) but are not the oracle of record. |

## Commands

```bash
# everything (exit 0 = all pass; ERC warnings other than footprint_link_issues, or any error, fail it)
bash hardware/emg/rev-b-xiao/tools/run_rb01r_checks.sh /tmp/rb01r

# step by step, from hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB/
kicad-cli sch export netlist --format kicadxml -o /tmp/revb.xml ARTHUR_EMG_RevB.kicad_sch
kicad-cli sch erc --severity-all --format json -o /tmp/erc.json ARTHUR_EMG_RevB.kicad_sch
python3 ../../tools/rb01r_netlist_audit.py /tmp/revb.xml          # --list prints the check table, --json for machine output
python3 ../../tools/test_audit_mutations.py /tmp/revb.xml        # ~70 s
python3 ../../tools/rb01r_calcs.py
```

## What "independent" means here

* The audit reads only the XML written by `kicad-cli` from the `.kicad_sch` files. It imports nothing from the original
  schematic generator (which is not in the repository and was never an oracle for this tooling).
* The oracle is hand-authored in `rb01r_netlist_audit.py` from (a) manufacturer pin tables (ADS131M04, TLV9064, TPS7A20,
  BAV199, 2N7002, SCTF 3CM, Seeed XIAO symbol/pinout) and (b) the frozen RB-00/RB-00.5/RB-00.6 requirement documents.
* The `D02` check compares the **symbol pin names that KiCad exports** with the manufacturer tables, so a symbol
  numbering error cannot hide behind a self-consistent netlist.
* Evidence that the tooling works on a real export: it was first run on the unmodified RB-01 export (only the X1/J1/LCSC
  metadata checks failed, exactly the fields RB-01R changed) and then on the corrected export (all pass).

## Limits

Connectivity and BOM metadata only. Not covered: analog behaviour, footprint geometry (see
`REVB_RB01R_FOOTPRINT_QUALIFICATION.md`), ERC, EMC, patient safety. The rule author also read the netlist, so a shared
misunderstanding of the design intent is possible; the datasheet tables and the mutation suite are the defence, not a proof.
A PASS here is **not** a safety claim: Rev B is an unisolated experimental EMG prototype and must never have electrodes
attached while USB is connected.

---

# RB-02 placement tooling (footprints, PCB, checks)

Needs Python 3 and `kicad-cli` 10.x. Nothing here routes, fills zones or writes manufacturing files.

| File | Purpose |
|---|---|
| `rb02_make_footprints.py` | Generates the two project-local footprints in `kicad/ARTHUR_EMG_RevB/fp-libs/ARTHUR.pretty` (`XIAO_ESP32S3_HANDSOLDER`, `OSC_SCTF_SX3M_SMD3225-4P`) from the RB-02A CAD numbers. |
| `rb02_placement.py` | The placement table (RB-00.6 x' frame, +22 mm board offset) and board size. |
| `rb02_build_pcb.py` | Builds `ARTHUR_EMG_RevB.kicad_pcb` from a fresh XML netlist, the footprint libraries and the placement table (no routing, unfilled zone outlines). |
| `rb02_sexpr.py` | Small s-expression reader/writer used by the above. |
| `rb02_write_project.py` | Netclasses, patterns, design rules (`.kicad_pro`) and custom DRC rules (`.kicad_dru`). |
| `rb02_check_placement.py` | 28 placement checks (sync, pad nets, courtyards, XIAO geometry, keep-outs, heights, proximity, symmetry, JLC single-side). |
| `rb02_audit_footprints.py` | 15 footprint checks against the Seeed CAD extraction and schematic pins. |
| `rb02_check_netclasses.py` | Every net must land in a non-Default class. |
| `rb02_seed_drc_rules.py` | Seeds violations on scratch copies to prove each custom DRC rule fires. |
| `rb02_post_tolerance_stack.py` | BAT+ post tolerance stack, options A-E (worst case + Monte-Carlo). |
| `run_rb02_checks.sh` | One command for all of the above plus the RB-01R re-run. Rebuilds the PCB in place. |

```bash
bash hardware/emg/rev-b-xiao/tools/run_rb02_checks.sh /tmp/rb02
```

---

# RB-02E Economic PCBA audit

| File | Purpose |
|---|---|
| `rb02e_economic_audit.py` | Read-only audit of the placed PCB against the recorded JLCPCB Economic PCBA rules: side/method inventory (JSON/CSV), per-part edge clearance (body, courtyard, pad), DNP-aware CPL check via `kicad-cli pcb export pos --exclude-dnp` (scratch only), B.Paste check, extended-part lines. |
| `run_rb02e_checks.sh` | `bash run_rb02e_checks.sh <outdir>`; exit 0 = no bottom parts, no THT, U1 absent from CPL, no B.Paste, no edge FAIL. UNKNOWN edge items do not fail it. |

The official JLCPCB pages used are archived as text in `evidence/rb02e/jlc_sources/` (read 2026-10-10).

---

# RB-02F edge-clearance clarification tooling

| File | Purpose |
|---|---|
| `rb02f_annotate.py` | Top-view SVG/PNG edge map (2.5 mm keep-in line, status colours, J1/J5001 callouts) + zoom views. |
| `rb02f_variant.py` | Builds a **scratch** what-if PCB from a JSON move spec (`evidence/rb02f/fallback_F18_spec.json`); never writes the project PCB. |
| `run_rb02f_checks.sh` | Regenerates the map and re-evaluates the fallback on scratch copies. |

---

# RB-02G compact-layout study tooling (scratch variants only)

| File | Purpose |
|---|---|
| `rb02g_layouts.py` | Rigid functional blocks of the RB-02 placement (A12, A34, REF, AIN, ADC, PWR, BATT, XIAO, J1, TRIO) and the rotate/translate model. |
| `rb02g_variants.py` | Variant definitions: V1 (51.3 x 62.5), V2 (60.4 x 58.9), V1R (48.6 x 62.5, sensitivity) and the infeasibility probes P50x60, P45x60, P45x55. |
| `rb02g_build.py` | Builds a scratch placement-only PCB with the unchanged `rb02_build_pcb.py`; never writes the project PCB. |
| `rb02g_check.py` | RB-02 checker on a variant (module translated to its frame) + C29 USB-edge + C30 J1 plug corridor. |
| `rb02g_metrics.py` | Routing/analog proxies: HPWL by netclass, AC-run lengths, P/N mismatch, hi-Z-to-module distance. |
| `rb02g_render.py`, `rb02g_compare_img.py` | Top-view images and the to-scale outline comparison. |
| `rb02g_run.py` | Everything above for all variants + DRC with schematic parity; writes `summary.json`. |

```bash
python3 hardware/emg/rev-b-xiao/tools/rb02g_run.py --out /tmp/rb02g
```

---

# RB-02H packaging tooling

| File | Purpose |
|---|---|
| `rb02h_packaging.py` | Battery-pocket search (documented envelopes only), BAT+ post / test-pad / U.FL map and lead-path estimate for a variant PCB. |
| `rb02h_corridors.py` | Zone-A crossing nets, channel gaps, power-path lengths, hi-Z-to-U.FL distance and maximum corner radius. |

---

# RB-03 routing tooling (V1 board, 51.3 x 62.45 mm)

| File | Purpose |
|---|---|
| `run_rb03_route.sh` | One command: build the V1 placement, route, fill zones, DRC (+schematic parity), ERC, audit, RB-02 module-frame checks, economic audit. **Overwrites the main PCB** (set `RB03_INSTALL=0` to keep it). All pcbnew work happens in a scratch copy of the project because pcbnew rewrites `.kicad_pro` and drops the netclasses. |
| `rb03_promote_v1.sh` | Builds the placement-only V1 board (scratch). |
| `rb03_router.py` | Project-specific orthogonal grid router (0.1 mm; F.Cu/B.Cu/In2.Cu in the module half), netclass widths/clearances, hi-Z/SPI/ZONE_A rules, keep-outs, GND vias, rip-up of the failed nets, local GND repair. No third-party router is used. |
| `rb03_fill.py` | Fills the zones (zone clearance 0.30 mm). |
| `rb03_audit.py` | Net/layer/via inventory, hi-Z symmetry, plane outlines, return-path coverage over In1, power-path resistance, via-in-pad list. |
| `rb03_seed_hiz_rule.py` | Proves the amended `hiz_leakage` rule fires outside and is exempt inside the TLV9064 courtyards. |
| `archive/rb02_97x32/` | The RB-02 97 x 32 board and the V2 scratch board (references). |
