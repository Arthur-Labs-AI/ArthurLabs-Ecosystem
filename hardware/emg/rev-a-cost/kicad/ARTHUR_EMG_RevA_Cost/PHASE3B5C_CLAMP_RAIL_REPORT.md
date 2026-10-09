# Phase 3B-5C — AFE_3V0 clamp-rail distribution

READY TO FREEZE 3B-5C: YES. All requested gates passed. Two new C1 segments have 0.202341 mm clearance and are explicitly flagged for review; they pass the formal 0.20 mm rule. Readiness is limited to this increment, with the unrelated baseline DRC violations retained.

Authoritative input: `ARTHUR_EMG_RevA_Cost_Phase3B5B_OpAmpSupplyClean.kicad_pcb`  
Accepted input SHA-256, unchanged: `350d90a013e0a1cfbe44a16e1b6b51dd9c177fac78fc8104aac2e37f2ee91777`  
Final board: `ARTHUR_EMG_RevA_Cost_Phase3B5C_ClampRailClean.kicad_pcb`  
Final SHA-256: `a2d6172651e884521db27631c453cfad8d149189ffdd5d66fa7a59867f80c8ed`

## Final gate

```text
D101.2 CONNECTED: YES
D102.2 CONNECTED: YES
D201.2 CONNECTED: YES
D202.2 CONNECTED: YES
D301.2 CONNECTED: YES
D302.2 CONNECTED: YES
D401.2 CONNECTED: YES
D402.2 CONNECTED: YES
ALL 8 CLAMP ENDPOINTS CONNECTED: YES

UNCONNECTED PAIRS: 105 -> 97
AFE_3V0 GROUPS: 12 -> 4
AFE_3V0 MISSING PAIRS: 11 -> 3
ORDINARY DRC VIOLATIONS: 548 -> 548

REMAINING AFE_3V0 GROUPS EXACTLY:
main authority
U6001.1/C6007.1
R3005.2
TP601.1

NEW COPPER VIOLATIONS: 0
NEW CROSSINGS: 0
NEW SHORTS: 0
DANGLING TRACKS/VIAS: 0/0

MINIMUM NEW CLEARANCE: 0.202341 mm
ANY NEW CLEARANCE <0.22 mm: YES
In1 GND: PASS
In2 GND: PASS
ISOLATED GND POLYGONS: 0
UNEXPLAINED GND REFERENCE GAPS: 0

Phase 3B-5B unchanged: YES
Phase 3B-5A unchanged: YES
Phase 3B-5E unchanged: YES
All earlier Phase 3B increments unchanged: YES
Phase 3A unchanged: YES
All non-target AFE_3V0 copper unchanged: YES
ALL EARLIER FROZEN GEOMETRY PRESERVED: YES
READY TO FREEZE 3B-5C: YES
```

## Connectivity and sequential checkpoints

Pre-edit connectivity independently established eight distinct isolated singleton clamp groups. The main authority had nine pads; the final main authority has those nine plus exactly the eight targets. Its 17 pads are `C4006.1, C501.2, C502.2, C503.2, D101.2, D102.2, D201.2, D202.2, D301.2, D302.2, D401.2, D402.2, R5003.2, U4002.5, U501.4, U502.4, U503.4`. The three remaining non-authority groups are exactly {C6007.1,U6001.1}, {R3005.2}, {TP601.1}; their connectivity is unchanged. All unrelated pad/zone connectivity is unchanged. These are actual KiCad connected-component checks, independent of the global unconnected counter.

Each checkpoint was added only after its predecessor passed real refilled DRC, connected-component analysis and mechanical comparison. Immutable checkpoint boards, DRC JSON and verification JSON retain the evidence.

| Checkpoint | Newly connected pads | Global unconnected pairs | AFE groups | Ordinary DRC | New copper violations | Frozen objects |
|---|---|---:|---:|---:|---:|---|
| Baseline | — | 105 | 12 | 548 | — | Authority |
| C1 | D101.2 / D102.2 | 103 | 10 | 548 | 0 | PASS |
| C2 | D201.2 / D202.2 | 101 | 8 | 548 | 0 | PASS |
| C3 | D301.2 / D302.2 | 99 | 6 | 548 | 0 | PASS |
| C4 | D401.2 / D402.2 | 97 | 4 | 548 | 0 | PASS |

## Branch topology and geometry

- C1: B.Cu branch from the frozen supply via (8.40,5.50), following the clear left corridor to a new via (3.20,25.50); compact F.Cu fork with independent connections to D101.2 and D102.2. The D101 leg steps right at y=24.75 to clear TP610.
- C2: B.Cu branch from the frozen supply via (32.40,21.90) down to (32.40,25.50), then left to a new via (19.20,25.50). A local F.Cu rail supplies D201.2 and D202.2 through separate 0.75 mm stubs.
- C3: New via (27.00,25.50) taps the C2 B.Cu branch directly. Its compact F.Cu rail supplies D301.2 and D302.2 through separate 0.75 mm stubs; no additional B.Cu track length.
- C4: Independent B.Cu branch from the frozen supply vertex (41.80,22.30) to a new via (37.50,25.50). Its local F.Cu rail supplies D401.2 and D402.2 through separate 0.75 mm stubs.

| Channel pair | Added track length mm | Segments | Width mm | Track layers | Vias | Minimum foreign copper clearance mm |
|---|---:|---:|---:|---|---:|---:|
| C1 | 33.782590 | 11 | 0.40 | B.Cu, F.Cu | 1 | 0.202341 |
| C2 | 24.537500 | 5 | 0.40 | B.Cu, F.Cu | 1 | 0.300000 |
| C3 | 5.700000 | 3 | 0.40 | F.Cu | 1 | 0.700000 |
| C4 | 11.060037 | 4 | 0.40 | B.Cu, F.Cu | 1 | 0.700000 |

Total added track length: 75.080127 mm; 23 segments; four standard through-vias. Every added track is 0.40 mm; no neck-down was required. C3 uses F.Cu tracks plus a through-via to B.Cu. C2's B.Cu branch is shared by C2 and C3 and its length is counted once. This is a branched distribution with compact per-channel forks; no supply path passes serially through all eight diode pads.

Local rails lie at y=25.50, with short pad branches from y=24.75. C1's TP610 and frozen signal/VCM geometry require its offset first leg and separate left-corridor feed. A common F.Cu rail across channels would intersect the frozen input-channel frame traces. The new B.Cu branches cross some F.Cu geometry on a different layer without electrical contact; real all-track DRC verifies zero copper crossings/shorts. The original tracks and vias used as attachment points were not split, shortened or replaced. No global shortest-path proof is claimed.

## Clearance review and manufacturing

Exact KiCad copper-shape measurements on all common copper layers use 1 nm binary-search resolution. New foreign track/via/pad clearance is at least 0.202341 mm. Refilled real DRC additionally checks zone copper clearance; the frozen internal GND-zone clearance remains 0.50 mm.

The following two connected C1 feed segments are below the requested 0.22 mm review threshold, at their common corner near (2.40,5.70):

- `107e7cef-c7f6-445f-9347-bb8d2d2bc6ec`: [3.2, 5.6] → [2.4, 5.7], B.Cu, clearance 0.202341 mm to `Net-(U501A--)` / `5508eacf-bd2e-45ce-859c-0efae3621513`.
- `4bf22c48-480f-4275-94cf-3d8bcaf97121`: [2.4, 5.7] → [1.3, 14.5], B.Cu, clearance 0.202341 mm to `Net-(U501A--)` / `5508eacf-bd2e-45ce-859c-0efae3621513`.

Both pass 0.20 mm DRC. C2's minimum is 0.30 mm; C3 and C4 minima are 0.70 mm. The review list and witnesses are retained in the verification JSON.

Each new via is ordinary through-hole, 0.55 mm diameter / 0.30 mm drill / 0.125 mm annulus. Actual annuli overlap no pad. Drill, annular-width, hole-to-copper and hole-to-hole checks pass. Four-layer standard fabrication remains applicable; no HDI, microvia, blind/buried via, via-in-pad, special stackup or added process is introduced. The 20–25 EUR assembled-board target was not requoted.

## Ground-plane audit

No GND copper or pad access was routed. Both internal GND planes retain one filled polygon and zero islands; every original GND pad group and zone access is unchanged. Existing internal copper and zone definitions are preserved; only derived candidate fills were regenerated around the new supply vias.

Outer-layer centerlines were sampled at intervals no greater than 0.01 mm against the adjacent refilled GND plane: F.Cu against In1, B.Cu against In2. Of 7535 samples, 6427 are GND-backed, 952 are classified as new supply-via antipads, and 156 are confirmed existing baseline voids. Unexplained samples: zero. New via locations are (3.20,25.50), (19.20,25.50), (27.00,25.50), and (37.50,25.50). Antipad classification uses 0.775 mm nominal radius (0.275 mm copper radius plus 0.50 mm frozen zone clearance), with 0.0251 mm allowance for polygon approximation; actual GND hits remain separately recorded.

The following centerline intervals lack adjacent GND in the accepted baseline as well as the candidate:

| Pair | Adjacent plane | Approximate baseline-void interval mm |
|---|---|---|
| C2 | In2.Cu | (32.400,21.900) → (32.400,22.670) |
| C1 | In2.Cu | (8.400,5.500) → (7.631,5.515) |

These are documented reference interruptions, not claimed to be continuous GND beneath every point. Neither plane is split and no island is introduced. No noise or load-transient simulation was performed.

## Executed verification and preservation

- Accepted SHA verified before editing and after final verification; production and earlier accepted artifacts/evidence remain byte-identical. All Phase 3A manifest hashes match and all 14 frozen Phase 3A vias remain.
- Mechanical parsed-object comparison preserves all 497 original segments, 142 original vias, and 138 footprints exactly. Only 23 AFE_3V0 segments and four AFE_3V0 vias were added. Placement, outline, RF keepout, zone definitions and all other PCB object categories are unchanged.
- This includes every frozen Phase 1/2/3A/3B object, accepted VCM exception, reference node, follower closure, RLD_SAFE route, and existing AFE_3V0 copper. Accepted 3B-5A neck, supply vias and minimum-clearance watchpoint remain unchanged.
- Baseline, C1, C2, C3, C4 and final read-only DRC all executed. Ordinary violation identities, including multiplicity in the final comparison, exactly match the 548 baseline violations. No unrelated baseline cleanup was attempted.
- Final Clean is byte-identical to the refilled candidate, including unchanged copied project and routing-rule sidecars. The independent final read-only DRC returned 548 ordinary violations and 97 unconnected pairs without changing the board.
- Actual clamp and C1 source copper images were inspected. Per-object clearances, via checks, component memberships, ground-reference classifications and protected hashes are in the verification JSON.

Commands used for every checkpoint:

```bash
kicad-cli pcb drc --severity-all --all-track-errors --refill-zones --save-board --format json -o phase3b5c_clamp_rail_candidate_drc.json ARTHUR_EMG_RevA_Cost_Phase3B5C_ClampRailCandidate.kicad_pcb
/usr/bin/python3 phase3b5c_clamp_rail_verify.py CHECKPOINT_NUMBER
```

Final read-only command:

```bash
kicad-cli pcb drc --severity-all --all-track-errors --format json -o phase3b5c_clamp_rail_drc.json ARTHUR_EMG_RevA_Cost_Phase3B5C_ClampRailClean.kicad_pcb
```

Production SHA-256, unchanged: `7a7a70d78e1e191e13251e24b882b7eeb3df1153912a4168850515c8ac8201f9`.

Deliverables: verified Clean board, this report, `phase3b5c_clamp_rail_drc.json`, `phase3b5c_clamp_rail_verification.json`, separate Candidate, unchanged rule sidecars and checkpoint/supporting evidence. U6001.1/C6007.1, R3005.2 and TP601.1 remain deferred; no GND routing was added. Stopped after Phase 3B-5C.
