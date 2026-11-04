# Phase 3B-3 — U503 unused follower closures

Date: 2026-09-26. Authoritative input: `ARTHUR_EMG_RevA_Cost_Phase3B2_VCMClean.kicad_pcb`. Its SHA-256 matches the user-accepted value. User-authorized Phase 3B continuation supersedes the older Phase-3A-only base wording in AGENTS.md. Production was not used as the routing base and was not overwritten.

```text
U503B FOLLOWER COMPLETE: YES
U503C FOLLOWER COMPLETE: YES
U503D FOLLOWER COMPLETE: YES

UNCONNECTED PAIRS: 115 -> 112

NEW COPPER VIOLATIONS: 0
NEW CROSSINGS: 0
NEW SHORTS: 0
DANGLING TRACKS/VIAS: 0 / 0

Phase 1 modified: NO
Phase 2 modified: NO
Phase 3A modified: NO
Phase 3B-1 modified: NO
Phase 3B-2 modified: NO
VCM modified: NO
AFE_3V0 modified: NO
placement modified: NO
outline modified: NO
RF keepout modified: NO
zone definitions modified: NO

Phase 3B-1 preserved: YES
Phase 3B-2 preserved: YES
Phase 3A preserved: YES

In1 GND continuity: PASS
In2 GND continuity: PASS
isolated GND polygons introduced: 0

READY TO FREEZE 3B-3: YES
```

## Added routing

| Net | Pads | Track length (mm) | Segments | Vias | Layers | Minimum foreign-net copper clearance (mm) |
|---|---|---:|---:|---:|---|---:|
| `Net-(U503B--)` | U503.6 ↔ U503.7 | 0.650000 | 1 | 0 | F.Cu | 0.365000 |
| `Net-(U503C--)` | U503.8 ↔ U503.9 | 0.650000 | 1 | 0 | F.Cu | 0.365000 |
| `Net-(U503D--)` | U503.13 ↔ U503.14 | 0.650000 | 1 | 0 | F.Cu | 0.365000 |

Each closure is one direct vertical 0.15 mm-wide F.Cu segment between adjacent pad centers. Total track length is **1.950000 mm**, three segments, zero vias. These are straight-line shortest paths for the fixed pad centers; no detour, shared trunk, additional VCM branch, or interconnection among the three nets was added. The exposed track between each pair of pad edges is 0.23 mm; the reported 0.65 mm centerline length includes the portions within the pads. KiCad foreign-net copper-shape distance was measured by binary search to 1 nm resolution; each closure's nearest foreign-net copper is an adjacent VCM pad. No special fabrication process is required, and no via-in-pad, blind/buried via or microvia was added. The cost-first standard four-layer process is unchanged; assembled-board pricing was not requoted.

## Verification gates

| Gate | Result | Evidence |
|---|---|---|
| Accepted input authority | PASS | Input SHA-256 equals the user-provided accepted 3B-2 SHA before and after work |
| Baseline DRC | PASS | Real KiCad DRC with both requested flags: 548 ordinary violations / 115 unconnected pairs |
| Per-net connectivity | PASS | Each target has exactly its two required pads; two disconnected groups before, exactly one connected group after |
| Other-net connectivity | PASS | All non-target pad groups and connected-zone identities are unchanged, including VCM and 3B-1 GND access |
| Refilled candidate DRC | PASS | 548 ordinary violations / 112 unconnected pairs; ordinary violation identities exactly match baseline |
| Copper delta / crossings / shorts / dangling items | PASS | No new copper violation identity; no crossing, short, dangling-track or dangling-via categories |
| Frozen PCB object preservation | PASS | All 452 existing segments, 137 existing vias and 138 footprints unchanged; only three target-net segments added |
| Phase 3A / 3B-1 / 3B-2 | PASS | All original objects preserved, including 14 Phase 3A vias, 3 accepted local GND vias and 3 accepted VCM vias; prior protected-file hashes unchanged |
| Outline, placement, RF keepout, zone definitions | PASS | All non-segment top-level PCB objects unchanged; complete zone objects including filled copper are identical |
| In1/In2 GND continuity | PASS | Each plane retains exactly one filled polygon with no islands; GND connectivity unchanged |
| Local continuous GND reference | PASS | Every new closure sampled at ≤0.01 mm along its centerline lies above filled In1 GND copper, with no excluded samples |
| Visual copper review | PASS | Inspected `phase3b3_followers_layout.png`, generated from actual KiCad geometry |
| Final clean board | PASS | Byte-identical to refilled candidate; independently reran DRC under clean filename using unchanged copied project/rule sidecars |

Baseline ordinary DRC issues were not repaired or hidden. Final DRC remains **548 ordinary violations**, with **112 unconnected pairs**. Readiness is scoped only to these three follower closures, not to full-board manufacturing completion. Zone refill/save was performed only on the separate candidate. The clean artifact copies that verified saved geometry; its final DRC was read-only.

Executed commands (all exited 0; DRC exit 0 indicates report generation):

```bash
kicad-cli pcb drc --severity-all --all-track-errors --format json --output phase3b3_followers_baseline_drc.json ARTHUR_EMG_RevA_Cost_Phase3B2_VCMClean.kicad_pcb
/usr/bin/python3 phase3b3_followers_work.py
kicad-cli pcb drc --severity-all --all-track-errors --refill-zones --save-board --format json --output phase3b3_followers_candidate_drc.json ARTHUR_EMG_RevA_Cost_Phase3B3_FollowersCandidate.kicad_pcb
/usr/bin/python3 phase3b3_followers_verify.py
kicad-cli pcb drc --severity-all --all-track-errors --format json --output phase3b3_followers_drc.json ARTHUR_EMG_RevA_Cost_Phase3B3_FollowersClean.kicad_pcb
python phase3b3_followers_finalize.py
```

## Deliverables and provenance

- `ARTHUR_EMG_RevA_Cost_Phase3B3_FollowersCandidate.kicad_pcb`: routed/refilled working candidate.
- `ARTHUR_EMG_RevA_Cost_Phase3B3_FollowersClean.kicad_pcb`: final verified board.
- `phase3b3_followers_drc.json`: final clean-board DRC.
- `phase3b3_followers_verification.json`: mechanical object comparison, per-net connectivity/length/clearance, plane checks, preserved hashes and readiness gates.
- Baseline geometry/DRC, candidate DRC, build/verify/finalize scripts and local copper overview provide reproducibility.
- Both candidate filenames have unchanged copies of accepted `.kicad_pro` and `.kicad_dru` rule sidecars.

Accepted 3B-2 input SHA-256 before and after:
`ed9d6cb2585d4d489f24de7d32d563635ada8b9a182cd1bbc7e7acd9e98d55b4`

Final clean-board SHA-256:
`406ccfa5d9b22dc57a04ca05d7afbf9095935f2ff90baab1c2c51b230d8d604e`

Production remains byte-identical at SHA-256:
`7a7a70d78e1e191e13251e24b882b7eeb3df1153912a4168850515c8ac8201f9`

Stopped after 3B-3. No RLD_SAFE, AFE_3V0, USB, power, debug, testpoint, VCM extension, 3B-4 or later routing was started. Production promotion and a new freeze manifest were not performed.
