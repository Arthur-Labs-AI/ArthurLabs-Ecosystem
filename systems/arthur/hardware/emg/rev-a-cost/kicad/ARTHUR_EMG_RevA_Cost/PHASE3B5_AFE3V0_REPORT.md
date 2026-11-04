# Phase 3B-5 — quiet AFE_3V0 distribution: Checkpoint A blocked

Date: 2026-09-26. Authoritative input: `ARTHUR_EMG_RevA_Cost_Phase3B4_RLDClean.kicad_pcb`. Accepted SHA-256 verified exactly:
`14c41b66ab073d8f9e4891cd979d336f404ffbfefe862ff217cee983cd2b3f9a`

**AFE_3V0 QUIET CORE COMPLETE: NO. READY TO FREEZE 3B-5: NO.** Stopped before adding copper at Checkpoint A. Checkpoints B–D were not started. No frozen geometry, production board, other net, GND access, R3005.2 or TP601.1 was modified.

## Concrete routing blocker

The accepted Phase 3B-2 U503.2-to-U503.5 F.Cu VCM branch encloses the U503.4 supply pad against the Phase 3B-1 reference-node copper and adjacent pads. The enclosing vertical VCM segment is UUID `30a501c9-ab5c-4380-ba9f-44465f57214b`, from (46.75,19.20) to (46.75,21.15) mm, width 0.15 mm.

- U503.4 occupies x=44.925–46.375, y=20.29–20.71 mm.
- U503.3 reference pad above ends at y=20.06 mm; U503.5 VCM pad below begins at y=20.94 mm.
- The left reference trunk right edge is x=44.625 mm; the right VCM vertical left edge is x=46.675 mm.
- The side opening between adjacent pad edges and those barriers is only 0.30 mm. Even a 0.10 mm minimum-board-width escape needs 0.10 + 2×0.20 = 0.50 mm to pass between foreign-net copper.
- Between the upper and lower pads, the 0.88 mm opening is smaller than 0.50 + 2×0.20 = 0.90 mm required for the smallest allowed 0.50 mm via. Rounded pad-end corners do not create a route around the side barriers.

The independent KiCad-shape flood-fill preflight at 0.025 mm spacing confirms that both the 0.40 mm nominal supply trace and a diagnostic 0.10 mm minimum-width trace remain in a closed local component. Neither can reach open routing area. There are zero legal 0.50 mm via centers in either reachable component, even before excluding via-in-pad. The grid component stays well inside the search boundary, so the result is not caused by the search window. The physical gap analysis supplements the sampled search; the grid is not the sole proof.

No narrow escape was actually routed. A standard through-via cannot solve the enclosure under the accepted geometry. Via-in-pad, microvia, blind/buried via, a clearance violation, component movement or an unauthorized frozen-copper change would violate this task's constraints. The blocker was caught in preflight; no failed routed candidate was used as continuation authority.

## Smallest proposed exception, not applied

Replace **only the 1.95 mm vertical VCM segment** above with this 0.15 mm-wide F.Cu path, preserving its original endpoints and both existing horizontal VCM segments:

```text
(46.75,19.20) -> (47.50,19.20) -> (47.50,21.15) -> (46.75,21.15)
```

The replacement length is 3.45 mm, adding 1.50 mm locally. It opens space for a 0.40 mm U503.4 supply escape to an ordinary 0.55/0.30 mm through-via at (46.90,20.50) mm. Exact virtual KiCad-shape checks, without adding any object to a PCB, found minimum foreign-net clearances of 0.24 mm for the supply escape and 0.25 mm for the supply via and replacement VCM branch. The via annulus does not overlap any pad. This proposal affects one frozen Phase 3B-2 segment; no other frozen copper is proposed for alteration.

The local shape preflight passes. Full-board proposal DRC, zone refill and subsequent AFE distribution are **UNVERIFIED** because the proposal is not applied or authorized. This is a concrete exception proposal, not a completed routing artifact or guarantee that later checkpoints will pass. User approval is required because the current request explicitly says to preserve Phase 3B-2 VCM additions exactly; the older AGENTS.md blocker exception does not override that user instruction.

![U503.4 enclosure and unapplied exception](phase3b5_afe3v0_blocker.png)

Purple is accepted VCM; pink is the frozen reference; yellow is U503.4. Dashed cyan shows the unapplied exception proposal, not copper in the candidate.

## Power width and current inspection

The accepted `POWER_AFE_3V0` class specifies 0.40 mm nominal track width and 0.20 mm clearance, with 0.80/0.40 mm default vias. Global board minimums are 0.10 mm tracks, 0.50 mm via diameter and 0.30 mm through-hole drill. Existing frozen LDO-side AFE tracks are 0.30 mm; existing ADC local tracks are 0.20 mm with two 0.50/0.30 mm through-vias. Those existing widths and all local output/decoupling geometry remain untouched. A future authorized distribution would use 0.40 mm or wider where practical, rather than automatically reusing 0.15 mm reference routing.

Actual fitted devices are three TLV9064IPWR quad amplifiers, ADS131M04IPWR, and TPS7A2030PDBVR. TI specifies 0.538 mA typical quiescent current per TLV9064 amplifier; twelve amplifiers therefore account for approximately 6.456 mA typical unloaded quiescent current. This excludes signal/output load and clamp fault currents. [TI TLV9064](https://www.ti.com/product/TLV9064)

TI specifies 3.3 mW typical total ADS131M04 consumption at 3 V AVDD/DVDD; this is not a separate worst-case AVDD budget. [TI ADS131M04](https://www.ti.com/product/ADS131M04/part-details/ADS131M04IPWR)

The actual TPS7A20 LDO family is rated for 300 mA. Its rating does not imply that every AFE branch must carry 300 mA; load conditions, copper drop, transient behavior and clamp current require the appropriate distribution review. [TI TPS7A20](https://www.ti.com/product/TPS7A20)

No maximum-load/IR-drop simulation or final width qualification is claimed because Checkpoint A cannot be implemented under the frozen authority. No fabrication or cost change was introduced.

## Actual connectivity and gates

| Required endpoint | Joined to LDO authority |
|---|---|
| U501.4 | NO |
| U502.4 | NO |
| U503.4 | NO |
| C501.2 | NO |
| C503.2 | NO |
| D101.2 | NO |
| D102.2 | NO |
| D201.2 | NO |
| D202.2 | NO |
| D301.2 | NO |
| D302.2 | NO |
| D401.2 | NO |
| D402.2 | NO |
| R5003.2 | NO |
| U6001.1 | NO |
| C6007.1 | NO |

```text
U501.4 CONNECTED TO AFE_3V0: NO
U502.4 CONNECTED TO AFE_3V0: NO
U503.4 CONNECTED TO AFE_3V0: NO
C501.2 CONNECTED: NO
C503.2 CONNECTED: NO
D101.2 CONNECTED: NO
D102.2 CONNECTED: NO
D201.2 CONNECTED: NO
D202.2 CONNECTED: NO
D301.2 CONNECTED: NO
D302.2 CONNECTED: NO
D401.2 CONNECTED: NO
D402.2 CONNECTED: NO
R5003.2 CONNECTED: NO
U6001.1/C6007.1 GROUP JOINED TO MAIN AFE_3V0: NO

R3005.2 INTENTIONALLY DEFERRED: YES
TP601.1 INTENTIONALLY DEFERRED: YES

AFE_3V0 QUIET CORE CONNECTED GROUPS: 16 (target 1)
AFE_3V0 TOTAL GROUPS AFTER TASK: 18 (target 3)
AFE_3V0 MISSING PAIRS: 17 -> 17
UNCONNECTED PAIRS: 111 -> 111
ORDINARY DRC VIOLATIONS: 548 -> 548

ADDED TRACK LENGTH: 0 mm
ADDED SEGMENT COUNT: 0
ADDED VIA COUNT: 0
ADDED TRACK WIDTHS/LAYERS: none
MINIMUM ADDED-COPPER FOREIGN/DIGITAL CLEARANCE: N/A (no added copper)

NEW COPPER VIOLATIONS: 0
NEW CROSSINGS: 0
NEW SHORTS: 0
DANGLING TRACKS/VIAS: 0 / 0

In1 GND continuity: PASS
In2 GND continuity: PASS
isolated polygons introduced: 0

Phase 1 modified: NO
Phase 2 modified: NO
Phase 3A modified: NO
Phase 3B-1 modified: NO
Phase 3B-2 modified: NO
Phase 3B-3 modified: NO
Phase 3B-4 modified: NO
existing AFE_3V0 geometry modified: NO
VCM modified: NO
RLD_SAFE modified: NO
reference node modified: NO
placement modified: NO
outline modified: NO
RF keepout modified: NO
zone definitions modified: NO

Phase 3B-1 preserved: YES
Phase 3B-2 preserved: YES
Phase 3B-3 preserved: YES
Phase 3B-4 preserved: YES
Phase 3A preserved: YES

READY TO FREEZE 3B-5: NO
```

The U6001.1/C6007.1 local group remains internally connected but disconnected from the LDO group, as before. Every non-AFE net and GND pad retains the accepted geometry/connectivity. No remaining local GND access was performed.

| Verification gate | Result | Evidence |
|---|---|---|
| Accepted input hash | PASS | Exact accepted SHA-256 before and after |
| Frozen PCB objects | PASS | Entire candidate PCB byte-identical to accepted input, stronger than individual-object comparison |
| Checkpoint A route feasibility | FAIL | Closed U503.4 escape component; minimum standard via cannot fit |
| Checkpoints B/C/D | UNVERIFIED / NOT STARTED | Stopped at Checkpoint A |
| Actual candidate DRC delta | PASS | Real KiCad DRC on baseline and unchanged candidate; all 548 ordinary violation identities match; 111 unconnected pairs |
| GND structure | PASS | Unchanged fills; each internal plane has one polygon, no islands |
| Proposed exception local clearance | PASS | Virtual shape checks only; no PCB mutation |
| Proposed exception full-board DRC | UNVERIFIED | Not applied, frozen exception requires user authorization |
| Final quiet-core completion | FAIL | Required groups remain disconnected |

Executed commands:

```bash
/usr/bin/python3 phase3b5_afe3v0_preflight.py
kicad-cli pcb drc --severity-all --all-track-errors --format json --output phase3b5_afe3v0_baseline_drc.json ARTHUR_EMG_RevA_Cost_Phase3B4_RLDClean.kicad_pcb
kicad-cli pcb drc --severity-all --all-track-errors --format json --output phase3b5_afe3v0_drc.json ARTHUR_EMG_RevA_Cost_Phase3B5_AFE3V0Candidate.kicad_pcb
/usr/bin/python3 phase3b5_afe3v0_blocker_verify.py
```

No zone refill/save was needed: no copper was added and the candidate is byte-identical to the accepted filled board. DRC exit 0 means report generated, not global DRC cleanliness.

## Artifacts and status

Produced `ARTHUR_EMG_RevA_Cost_Phase3B5_AFE3V0Candidate.kicad_pcb` as an **unchanged inspection copy**, with identical project/rule sidecars; `phase3b5_afe3v0_drc.json`; `phase3b5_afe3v0_verification.json`; this report; baseline geometry/DRC, preflight scripts/logs and blocker illustration.

**`ARTHUR_EMG_RevA_Cost_Phase3B5_AFE3V0Clean.kicad_pcb` was not produced:** there is no completed/verified Phase 3B-5 routing to label as a clean continuation artifact. Continue from the accepted Phase 3B-4 input after the scope exception is resolved, not from a purported completed 3B-5 checkpoint.

Stopped at Checkpoint A. No production promotion, frozen edit, Phase 3B-6, 3C or later routing occurred. Production and all protected earlier evidence files remain unchanged.
