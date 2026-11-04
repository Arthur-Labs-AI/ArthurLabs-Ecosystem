# Phase 3B-5D — ADC AFE_3V0 group integration

READY TO FREEZE 3B-5D: YES. All requested routing gates were executed and passed. This readiness applies only to the ADC supply attachment; the unrelated full-board baseline violations remain.

Authoritative input: `ARTHUR_EMG_RevA_Cost_Phase3B5C_ClampRailClean.kicad_pcb`  
Accepted input SHA-256, unchanged: `a2d6172651e884521db27631c453cfad8d149189ffdd5d66fa7a59867f80c8ed`  
Final artifact: `ARTHUR_EMG_RevA_Cost_Phase3B5D_ADC3V0Clean.kicad_pcb`  
Final SHA-256: `4683602370c4c6ff2b84c2edf484d481af3904598f8bb5fdb9d96649f18020e5`

## Final gate

```text
ADC AFE_3V0 GROUP JOINED: YES
U6001.1 CONNECTED: YES
C6007.1 LOCAL DECOUPLING PRESERVED: YES
R3005.2 STILL DEFERRED: YES
TP601.1 STILL DEFERRED: YES

UNCONNECTED PAIRS: 97 -> 96
AFE_3V0 GROUPS: 4 -> 3
AFE_3V0 MISSING PAIRS: 3 -> 2
ORDINARY DRC VIOLATIONS: 548 -> 548

ADDED TRACK LENGTH: 14.273852 mm
SEGMENT COUNT: 3
TRACK WIDTHS: 0.40 mm
LAYERS: F.Cu / B.Cu
VIA COUNT: 1 ordinary through-via
MINIMUM NEW CLEARANCE: 0.273000 mm
MINIMUM CLEARANCE TO PHASE 3A DIGITAL COPPER: 1.460755 mm
ANY NEW CLEARANCE <0.22 mm: NO

NEW COPPER VIOLATIONS: 0
NEW CROSSINGS: 0
NEW SHORTS: 0
DANGLING TRACKS/VIAS: 0/0

In1 GND: PASS
In2 GND: PASS
ISOLATED GND POLYGONS: 0
UNEXPLAINED GND REFERENCE GAPS: 0

Phase 3B-5C unchanged: YES
Phase 3B-5B unchanged: YES
Phase 3B-5A unchanged: YES
Phase 3B-5E unchanged: YES
All earlier Phase 3B geometry unchanged: YES
Phase 3A unchanged: YES
Existing ADC local AFE_3V0 copper unchanged except attachment: YES
ALL EARLIER FROZEN GEOMETRY PRESERVED: YES
READY TO FREEZE 3B-5D: YES
```

## Connectivity and attachment

Before editing, KiCad connected-component analysis verified exactly four AFE_3V0 groups: the accepted 17-pad main authority, {C6007.1,U6001.1}, {R3005.2}, and {TP601.1}. The ADC group already had three 0.20 mm segments and two ordinary 0.50/0.30 mm vias. All five local copper objects remain exactly unchanged, including the existing local pin-to-capacitor path and both via locations.

After routing the main authority contains exactly its original 17 pads plus U6001.1 and C6007.1, for 19 pads. The two remaining groups are exactly {R3005.2} and {TP601.1}. Every other net's pad/zone component and every unrelated AFE group is unchanged. The actual component merger establishes the one-pair reduction independently of the global counter.

Existing frozen C2/C3 B.Cu AFE branch at (21.20,25.50) -> (21.20,21.90) on B.Cu; one new standard through-via; F.Cu to (19.80,12.00), then C6007.1 at (19.49,11.40). Original local ADC tracks and both ADC vias unchanged.

The authority attachment is to the existing Phase 3B-5C supply segment `fd989b82-424c-4c95-993d-79f6639379b0`, without splitting, moving or replacing it. The local landing is directly on C6007.1; it preserves the original decoupling group and avoids any added pad-to-pad stub or replacement local path.

| Added segment, mm | Length mm | Layer | Width mm | Minimum foreign copper clearance mm |
|---|---:|---|---:|---:|
| [21.2, 25.5] → [21.2, 21.9] | 3.600000 | B.Cu | 0.40 | 0.350000 |
| [21.2, 21.9] → [19.8, 12.0] | 9.998500 | F.Cu | 0.40 | 0.298589 |
| [19.8, 12.0] → [19.49, 11.4] | 0.675352 | F.Cu | 0.40 | 0.273000 |

The new via at (21.20,21.90) has minimum foreign-copper clearance 0.275 mm to frozen B.Cu VCM. It is 0.55 mm diameter / 0.30 mm drill, with 0.125 mm annulus. Its annulus overlaps no pad; hole-to-foreign copper is 0.400 mm and hole-to-existing-hole clearance is 2.386104 mm. Drill, annulus, via diameter and hole clearances meet the unchanged board rules.

Straight feeds from nearby upper B.Cu authority and U502's F.Cu supply intersect frozen analog, 3V3 or Phase 3A copper. A 0.10 mm-grid B.Cu-only search using 0.40 mm width and 0.23 mm search clearance found no path in the permitted board region. This is sampled feasibility evidence, not an exhaustive mathematical proof. A mixed-layer path to the existing ADC via used two new transitions and 14.229848 mm of track; direct inspection proved the legal C6007.1 F.Cu landing eliminates the second transition. The delivered one-via path is 14.273852 mm. No global shortest-path or exhaustive minimum-via claim is made.

All new tracks are 0.40 mm. No neck-down is required or added; the frozen local ADC 0.20 mm copper is preserved. The measured minimum 0.273 mm is to CH1_P on F.Cu near the C6007 landing. Exact KiCad shape measurements across every common copper layer use 1 nm binary-search resolution. All new clearance is above the 0.22 mm review threshold. Refilled DRC additionally verifies zone copper clearance. Minimum common-layer separation to all seven Phase 3A digital nets is 1.460755 mm; those tracks, vias and endpoint pads were included in the measurement.

One ordinary through-via preserves the standard four-layer fabrication process. No new via-in-pad, microvia, blind/buried via, HDI, special stackup or additional process is introduced. The approximately 20–25 EUR assembled-board target was not requoted.

## Ground-plane reference

No GND track, via or pad access was added. In1.Cu and In2.Cu each retain one filled GND polygon with zero islands. Every original GND pad's connected group and zone access remain unchanged. Zone definitions and original internal copper remain frozen; only derived candidate fills changed for the new supply via.

Adjacent-plane centerline samples at ≤0.01 mm spacing classify 1193 samples as GND-backed, 156 as the new signal-via antipad, and 82 as existing baseline voids. Unexplained samples: zero. F.Cu references In1; B.Cu references In2. The new via's antipad has nominal radius 0.775 mm (0.275 mm copper radius plus frozen 0.50 mm zone clearance); classification allows 0.0251 mm for polygon approximation while retaining actual GND hits separately.

The following centerline intervals were independently confirmed missing from the accepted baseline GND fill, around the original C6007 supply via at (19.49,11.45):

| Adjacent plane | Existing baseline-void interval mm |
|---|---|
| In1.Cu | (19.8000,12.0000) → (19.4900,11.4000) |
| In1.Cu | (19.8168,12.1188) → (19.8000,12.0000) |

In addition, the full new track strips, including their rounded end caps, were sampled longitudinally at ≤0.01 mm and transversely at ≤0.02 mm. The 34216 area samples classify as: 26038 GND-backed, 4622 new signal-via antipad, 3556 baseline GND void, and zero unexplained. Per-segment counts and missing-reference coordinate extents are in the verification JSON. This is geometric sampling evidence, not an electromagnetic simulation. Continuous plane topology is verified; uninterrupted reference under the short landing through the pre-existing ADC via void is not claimed.

## Executed gate evidence

| Gate | Result | Evidence |
|---|---|---|
| Accepted input and baseline | PASS | Accepted SHA matches; real read-only baseline DRC: 548 ordinary / 97 unconnected |
| ADC component integration / deferred groups | PASS | Actual components 4 → 3; authority 17 → 19 pads; R3005.2 and TP601.1 singleton groups unchanged |
| Local decoupling preservation | PASS | All three original ADC segments and both original ADC vias identical |
| Refilled candidate DRC | PASS | Both requested flags plus refill/save; 548 ordinary / 96 unconnected; ordinary violation identities and multiplicity exactly match baseline |
| Final clean read-only DRC | PASS | Required flags, independent clean filename; same counts and identities; no PCB save |
| New copper / crossing / short / dangling gates | PASS | No new violations and no crossing, shorting or dangling categories |
| Clearance / manufacturing | PASS | Minimum new clearance 0.273 mm; digital separation 1.460755 mm; one legal ordinary via outside pads |
| All frozen objects | PASS | All 520 original segments, 146 original vias and 138 footprints identical; only three AFE segments and one AFE via added |
| Earlier phases and watchpoints | PASS | All original objects and protected files preserved; all seven Phase 3A manifest hashes match; all 14 Phase 3A vias retained |
| Placement, outline, RF keepout, zones, settings | PASS | Parsed top-level PCB-object and zone-definition comparison |
| GND topology / reference classification | PASS | One polygon / zero islands per plane; unchanged GND connectivity; zero unexplained centerline or area samples |
| Visual copper review | PASS | Actual attachment and ADC-local images inspected |
| Artifact provenance | PASS | Clean byte-identical to refilled candidate; project/routing-rule sidecars unchanged from authority |

Executed commands:

```bash
/usr/bin/python3 phase3b5d_adc3v0_inspect.py
kicad-cli pcb drc --severity-all --all-track-errors --format json -o phase3b5d_adc3v0_baseline_drc.json ARTHUR_EMG_RevA_Cost_Phase3B5C_ClampRailClean.kicad_pcb
/usr/bin/python3 phase3b5d_adc3v0_route.py zero
/usr/bin/python3 phase3b5d_adc3v0_route.py mixed
/usr/bin/python3 phase3b5d_adc3v0_route.py fewvias
/usr/bin/python3 phase3b5d_adc3v0_selected_preflight.py
/usr/bin/python3 phase3b5d_adc3v0_work.py
kicad-cli pcb drc --severity-all --all-track-errors --refill-zones --save-board --format json -o phase3b5d_adc3v0_candidate_drc.json ARTHUR_EMG_RevA_Cost_Phase3B5D_ADC3V0Candidate.kicad_pcb
/usr/bin/python3 phase3b5d_adc3v0_verify.py
/usr/bin/python3 phase3b5d_adc3v0_visual.py
kicad-cli pcb drc --severity-all --all-track-errors --format json -o phase3b5d_adc3v0_drc.json ARTHUR_EMG_RevA_Cost_Phase3B5D_ADC3V0Clean.kicad_pcb
/usr/bin/python3 phase3b5d_adc3v0_ground_area.py
python3 phase3b5d_adc3v0_finalize.py
```

The zero-via sampled search returned no path; this was preflight only, not a failed saved candidate. All required implemented-board verification gates passed. DRC exit 0 means report generation, not full-board cleanliness. The 548 unrelated ordinary baseline violations and 96 remaining global unconnected pairs are outside this increment; no unrelated cleanup was attempted. No load, IR-drop, transient or noise simulation is claimed.

Production SHA-256, unchanged: `7a7a70d78e1e191e13251e24b882b7eeb3df1153912a4168850515c8ac8201f9`.

Produced the separate Candidate, verified Clean board, this report, final DRC and verification JSON, unchanged copied rule sidecars and supporting geometry/preflight/visual evidence. The user-accepted Phase 3B-5C authority supersedes the older Phase-3A-only continuation-base wording. No production promotion, GND routing, R3005.2, TP601.1, or later-phase routing was performed. Stopped after Phase 3B-5D.
