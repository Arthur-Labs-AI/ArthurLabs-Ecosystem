# Phase 3A three-net routing — PASS

Authoritative input: ARTHUR_EMG_RevA_Cost_Phase3A_Recovered.kicad_pcb.
Result: ARTHUR_EMG_RevA_Cost_Phase3A_ThreeNetClean.kicad_pcb, with matching
unchanged project/rule sidecars and saved, refilled zones. Recovered and
Combined checkpoints were not overwritten. Phase 3B was not started.

## Final gate

| Gate | Result |
|---|---|
| CS_N U6001 → U7001 connected | YES |
| SCLK U6001 → U7001 connected | YES |
| MOSI U6001 → U7001 connected | YES |
| All seven U6001 → U7001 interfaces connected | YES |
| CS_N / SCLK / MOSI crossings | 0 / 0 / 0 |
| New copper clearance violations | 0 |
| New shorts | 0 |
| New hole-clearance violations | 0 |
| Dangling tracks/vias | 0 |
| Frozen four-net geometry/vias modified | NO |
| Phase 1 / Phase 2 modified | NO / NO |
| Placement / RF keepout / zone definitions modified | NO / NO / NO |
| In1 / In2 GND continuity | PASS / PASS |
| Southern bypass successful | YES |
| Six saved via positions preserved | NO — two escapes relocated |
| Extra vias required | 0 |
| Phase 3A three-net routing clean | YES |

Endpoint connectivity was checked through KiCad's connectivity graph.
The remaining 126 unconnected items include pre-existing testpoint branches;
this gate establishes U6001–U7001 connectivity, not completion of every branch
on the board.

## Routing metrics

Lengths are track centreline lengths in mm, excluding vertical via barrels.
Minimum clearance is measured by a disposable 0.600 mm clearance probe in
KiCad, which reports actual distances. Production rules were unchanged.

| Net | Total mm | F.Cu mm | B.Cu mm | Vias | Net minimum mm | Added routing minimum mm |
|---|---:|---:|---:|---:|---:|---:|
| MCU_CS_N | 50.704 | 5.050 | 45.654 | 2 | 0.2000 | 0.2500 |
| MCU_SCLK | 54.571 | 5.931 | 48.641 | 2 | 0.2190 | 0.2500 |
| MCU_MOSI | 53.991 | 5.123 | 48.868 | 2 | 0.2190 | 0.2358 |

The 0.2000 mm CS_N minimum is the retained escape via against the frozen MISO
track. The 0.2190 mm SCLK/MOSI minima are existing U6001 pad-to-MISO-via gaps.
New routing has >=0.2500 / 0.2500 / 0.2358 mm measured clearance respectively.
All added tracks are 0.20 mm wide. No length matching or serpentine was added.

## Topology and via changes

The B.Cu cross-under lanes are Y=19.400, 19.850, and 20.300 mm (CS_N, SCLK,
MOSI), below both the analog barrier ending at Y=17.950 and the CH4 routing
ending at Y=18.950. The bundle turns north at X=41.800 / 42.250 / 42.700,
before crossing the VCM vertical branch at X=45.650. Planar order is retained.

The first full-bundle attempt with the six saved vias was electrically connected
but failed real DRC at the escape throat, stitching vias, and entry fanout.
Bounded B.Cu searches found paths individually but could not fit three lanes
through the shared west throat. Near Y=7.800 the GND via at X=22.850 and the
CH4_N track at X=24.075 leave approximately 0.300 mm legal centre span, versus
at least 0.800 mm required for three tracks. Relocation-only trials also failed
F.Cu escape access. The accepted solution relocates SCLK/MOSI escape vias,
uses short F.Cu escape crossovers, and keeps the long bypass on B.Cu. No global
router or seven-net search was run; the two-layer search was confined to the
U6001 escape neighborhood (X=16–26, Y=2.8–12.4 mm).

The actual recovered coordinates differ from the prompt. Actual saved input
coordinates were used throughout:

| Net | Saved escape | Final escape | Entry, unchanged |
|---|---|---|---|
| CS_N | (24.075, 5.950) | (24.075, 5.950) | (49.000, 12.950) |
| SCLK | (22.775, 6.100) | (22.850, 8.600) | (54.000, 13.350) |
| MOSI | (22.775, 6.900) | (20.250, 7.350) | (51.000, 14.150) |

The two relocated vias retain their original UUIDs, 0.50 mm diameter and
0.30 mm drill. Each remaining net still has two vias; Phase 3A has 14 total.

## DRC classification and preservation evidence

Executed final command:

```sh
kicad-cli pcb drc --severity-all --all-track-errors --refill-zones --save-board --format json -o phase3a_three_net_clean_drc.json ARTHUR_EMG_RevA_Cost_Phase3A_ThreeNetClean.kicad_pcb
```

Recovered baseline: 525 violations, 129 unconnected items.
Final: 548 violations, 126 unconnected items. Unconnected delta: -3.
Violation identity/category comparison preserves all 525 baseline violations;
the only additions are the 23 nonmirrored back-layer text warnings. No baseline
violations were repaired. An otherwise unchanged copy of Recovered also reports
548 violations, demonstrating that these warnings are latent on existing text
and can appear from checkpoint copying alone. No text/silkscreen was edited.

KiCad API comparison verifies all tracks/vias outside the three permitted nets,
all footprint/pad geometry, zone outlines/settings, and RF keepouts unchanged.
Both refilled inner GND planes have exactly one filled polygon and zero isolated
polygons. The four complete interface nets retain exact geometry and connectivity.

Recovered SHA-256: `5d6e6774bdce98a8ae04a4861ed1376df37e176f4c88a87bb856af60160ba046`
Clean SHA-256: `7a7a70d78e1e191e13251e24b882b7eeb3df1153912a4168850515c8ac8201f9`

Evidence: phase3a_three_net_clean_drc.json, phase3a_three_net_drc_delta.json,
phase3a_three_net_verification.json, and bounded search/probe artifacts in
phase3a_three_net_work/. Probe boards use temporary stricter rules and are
measurement artifacts only; use the ThreeNetClean checkpoint for continuation.
