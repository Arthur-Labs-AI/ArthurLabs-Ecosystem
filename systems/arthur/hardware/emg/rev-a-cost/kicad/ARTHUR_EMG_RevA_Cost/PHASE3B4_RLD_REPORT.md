# Phase 3B-4 — RLD_SAFE reference-electrode path

Date: 2026-09-26. Authoritative input: `ARTHUR_EMG_RevA_Cost_Phase3B3_FollowersClean.kicad_pcb`, with the exact user-accepted SHA-256. User-authorized Phase 3B continuation supersedes the older Phase-3A-only base wording. Production was not the routing base and was not overwritten.

```text
RLD_SAFE COMPLETE: YES
R5002.2 and J5001.2 one connected group: YES

TRACK LENGTH: 6.600580 mm
SEGMENT COUNT: 1
VIA COUNT: 0
LAYERS: F.Cu
MINIMUM CLEARANCE: 1.050000 mm
MINIMUM PHASE 3A DIGITAL SEPARATION: 9.982529 mm (same F.Cu layer)
MINIMUM PHASE 3A DIGITAL XY SEPARATION: 8.121394 mm (all layers projected)

UNCONNECTED PAIRS: 112 -> 111

NEW COPPER VIOLATIONS: 0
NEW CROSSINGS: 0
NEW SHORTS: 0
DANGLING TRACKS/VIAS: 0 / 0

Phase 1 modified: NO
Phase 2 modified: NO
Phase 3A modified: NO
Phase 3B-1 modified: NO
Phase 3B-2 modified: NO
Phase 3B-3 modified: NO
VCM modified: NO
AFE_3V0 modified: NO
placement modified: NO
board outline modified: NO
RF keepout modified: NO
zone definitions modified: NO

Phase 3B-1 preserved: YES
Phase 3B-2 preserved: YES
Phase 3B-3 preserved: YES
Phase 3A preserved: YES

In1 GND continuity: PASS
In2 GND continuity: PASS
isolated GND polygons introduced: 0

READY TO FREEZE 3B-4: YES
```

## Implementation and measurements

A single 0.15 mm-wide F.Cu segment connects R5002.2 at (49.9125,24.40) mm directly to J5001.2 at (50.00,31.00) mm. It is the straight-line shortest path between the fixed pad centers, with no branch, stub, detour or via. Length includes copper within endpoint pads. Only RLD_SAFE was added; VCM is unchanged. The circuit remains buffered VCM → R5002 → RLD_SAFE → J5001.2, not an active ADS1294-style RLD feedback loop. No circuit reinterpretation or redesign occurred.

Minimum foreign-net clearance is measured from added track copper to all foreign-net tracks, vias and pads on the common F.Cu layer, using KiCad copper shapes with 1 nm binary-search resolution. The nearest foreign net is the adjacent R5002.1 VCM pad, at 1.05 mm. Minimum digital separation includes copper on all seven Phase 3A nets and their currently isolated physical testpoint pads. Nearest digital net is MCU_MOSI: 9.982529 mm on F.Cu; 8.121394 mm when all copper layers are projected into XY. The latter is a planar distance, not a three-dimensional stackup distance. No parallel digital adjacency was added. The route lies in the clear lower reference-electrode corridor, away from the switching converter and USB region. Future long digital routes do not yet exist; their separation must be maintained in their owning tasks.

Every one of 662 centerline samples at ≤0.01 mm intervals lies over filled adjacent In1 GND copper after candidate refill, with no samples excluded. Both complete internal GND zones, including their filled polygon geometry, are mechanically identical to the accepted input. Each remains one filled polygon with zero islands. Other nets' pad groups and connected-zone identities are unchanged. J5001.1 remains in its original disconnected GND group; it was deliberately not routed, as requested.

No HDI, blind/buried via, microvia, via-in-pad, special stackup or additional fabrication process was introduced. The cost-first standard four-layer process remains unchanged; the assembled-board price was not requoted.

## Executed verification

| Gate | Result | Evidence |
|---|---|---|
| Accepted input | PASS | User-provided 3B-3 SHA matches before and after |
| Baseline DRC | PASS | 548 ordinary violations / 112 unconnected pairs, both requested flags |
| Target connectivity | PASS | Exactly two RLD_SAFE pads; two groups before, one group after; no RLD_SAFE airwire remains |
| Other-net connectivity | PASS | All other connected-pad groups and zone identities identical, including J5001.1 GND |
| Refilled candidate DRC | PASS | 548 ordinary violations / 111 unconnected pairs; all ordinary violation identities exactly match baseline |
| Copper delta / crossings / shorts / dangling tracks-vias | PASS | Zero new copper violations; no corresponding error categories |
| Mechanical frozen-object comparison | PASS | All 455 existing segments, 137 existing vias and 138 footprints unchanged; only one RLD_SAFE segment added |
| Prior phases and evidence | PASS | All original objects and protected prior file hashes unchanged; seven Phase 3A manifest hashes verified; 14 Phase 3A vias preserved |
| Outline, placement, RF keepout, zones | PASS | All original top-level objects preserved; complete zone objects and fills identical |
| In1/In2 GND and local reference | PASS | One polygon per plane, zero islands, unchanged GND connectivity, 662/662 adjacent plane samples |
| Visual copper inspection | PASS | Inspected `phase3b4_rld_layout.png` generated from actual KiCad geometry |
| Final clean artifact | PASS | Byte-identical to refilled candidate, independently reran read-only DRC using unchanged copied rule sidecars |

All commands exited 0. DRC exit 0 means report generation, not full-board clearance of baseline defects:

```bash
kicad-cli pcb drc --severity-all --all-track-errors --format json --output phase3b4_rld_baseline_drc.json ARTHUR_EMG_RevA_Cost_Phase3B3_FollowersClean.kicad_pcb
/usr/bin/python3 phase3b4_rld_work.py
kicad-cli pcb drc --severity-all --all-track-errors --refill-zones --save-board --format json --output phase3b4_rld_candidate_drc.json ARTHUR_EMG_RevA_Cost_Phase3B4_RLDCandidate.kicad_pcb
/usr/bin/python3 phase3b4_rld_verify.py
kicad-cli pcb drc --severity-all --all-track-errors --format json --output phase3b4_rld_drc.json ARTHUR_EMG_RevA_Cost_Phase3B4_RLDClean.kicad_pcb
python phase3b4_rld_finalize.py
```

Final DRC retains all **548 ordinary baseline violations** and **111 unrelated unconnected pairs**. No unrelated DRC cleanup was performed. Freeze readiness applies only to 3B-4, not global manufacturing completion. Refill/save ran only on the separate candidate; the final clean artifact is a byte-identical copy and received a read-only DRC run.

## Deliverables and provenance

- `ARTHUR_EMG_RevA_Cost_Phase3B4_RLDCandidate.kicad_pcb`: routed/refilled working candidate.
- `ARTHUR_EMG_RevA_Cost_Phase3B4_RLDClean.kicad_pcb`: final verified artifact.
- `phase3b4_rld_drc.json`: final clean-board DRC.
- `phase3b4_rld_verification.json`: mechanical preservation, connectivity, routing metrics, clearance/digital separation, plane checks and hashes.
- Baseline geometry/DRC, candidate DRC, work/verify/finalize scripts and local layout image provide reproducibility. Candidate and clean filenames have unchanged copied project/rule sidecars.

Accepted input SHA-256 before and after:
`406ccfa5d9b22dc57a04ca05d7afbf9095935f2ff90baab1c2c51b230d8d604e`

Final clean-board SHA-256:
`14c41b66ab073d8f9e4891cd979d336f404ffbfefe862ff217cee983cd2b3f9a`

Production SHA-256 remains:
`7a7a70d78e1e191e13251e24b882b7eeb3df1153912a4168850515c8ac8201f9`

Stopped after 3B-4. No AFE_3V0, remaining local GND, USB, power, debug, testpoint, extra VCM branch or 3B-5/later routing was started. No production promotion or new freeze manifest was performed.
