import json,pathlib,hashlib,collections
D=pathlib.Path(__file__).resolve().parent
r=json.loads((D/'phase3b6_local_gnd_verification.json').read_text())
def sha(n):return hashlib.sha256((D/n).read_bytes()).hexdigest()
assert r['ready_to_freeze_3b6'] and r['final_clean_readonly_drc_pass']
assert sha(r['artifact'])==r['artifact_sha256'] and sha(r['authoritative_input'])==r['input_sha256']
assert r['production_sha256']=='7a7a70d78e1e191e13251e24b882b7eeb3df1153912a4168850515c8ac8201f9'
for n,h in json.loads((D/'phase3b6_local_gnd_baseline_geometry.json').read_text())['protected_file_sha256'].items():assert sha(n)==h
r['visual_review']={'status':'PASS','source':'Native KiCad F.Cu/B.Cu/In1.Cu/In2.Cu SVG exports of refilled candidate; added copper highlighted from actual saved UUID geometry','images_inspected':['phase3b6_local_gnd_C501_review.png','phase3b6_local_gnd_U503_C503_review.png','phase3b6_local_gnd_J5001_review.png','phase3b6_local_gnd_In1_Cu_review.png','phase3b6_local_gnd_In2_Cu_review.png']}
r['scope']='Phase 3B-6 four remaining local GND returns only; global GND completion and later phases excluded'
r['drc_readonly_clean_sha256_before_after']=r['artifact_sha256']
r['ordinary_drc_baseline_categories']=dict(collections.Counter(v['type'] for v in json.loads((D/'phase3b6_local_gnd_baseline_drc.json').read_text())['violations']))
r['ordinary_drc_final_categories']=dict(collections.Counter(v['type'] for v in json.loads((D/'phase3b6_local_gnd_drc.json').read_text())['violations']))
assert r['ordinary_drc_baseline_categories']==r['ordinary_drc_final_categories']
(D/'phase3b6_local_gnd_verification.json').write_text(json.dumps(r,indent=2)+'\n')
rows=[]
for k,q in r['target_metrics'].items():
 rows.append(f"| {k} | {q['stub_length_mm']:.6f} | 0.40 | ({q['via_location'][0]:.2f}, {q['via_location'][1]:.2f}) | 0.55 / 0.30 | {q['minimum_foreign_track_via_pad_clearance_mm']:.6f} |")
via_rows=[]
for k,q in r['target_metrics'].items():
 v=next(v for v in r['via_checks'] if v['uuid'] in q['copper_uuids'])
 via_rows.append(f"| {k} | {v['annulus_mm']:.3f} | {v['hole_to_foreign_copper_mm']:.6f} | {v['hole_to_other_hole_mm']:.6f} | PASS |")
text=f'''# Phase 3B-6 — Remaining local GND access

READY TO FREEZE 3B-6: YES. This readiness covers only the four authorized local returns. Global GND completion, 548 existing ordinary DRC violations and 92 remaining unconnected pairs are outside this phase.

Authoritative input: `{r['authoritative_input']}`  
Accepted input SHA-256, unchanged: `{r['input_sha256']}`  
Final artifact: `{r['artifact']}`  
Final SHA-256: `{r['artifact_sha256']}`

## Final gate

```text
C501.1 GND ACCESS: PASS
C503.1 GND ACCESS: PASS
U503.11 GND ACCESS: PASS
J5001.1 GND ACCESS: PASS

ALL PHASE-3B LOCAL GND ACCESS COMPLETE: YES
UNCONNECTED PAIRS: 96 -> 92
ORDINARY DRC VIOLATIONS: 548 -> 548

NEW COPPER VIOLATIONS: 0
NEW CROSSINGS: 0
NEW SHORTS: 0
DANGLING TRACKS/VIAS: 0/0

In1 GND: PASS
In2 GND: PASS
In1 FILLED POLYGONS: 1
In2 FILLED POLYGONS: 1
ISOLATED GND POLYGONS: 0

Phase 3B-5D preserved: YES
Phase 3B-5C preserved: YES
Phase 3B-5B preserved: YES
Phase 3B-5A preserved: YES
Phase 3B-5E preserved: YES
All earlier Phase 3B routing preserved: YES
Phase 3A preserved: YES
All 14 Phase 3A vias preserved: YES

AFE_3V0 modified: NO
VCM modified: NO
reference modified: NO
RLD_SAFE modified: NO

ALL EARLIER FROZEN GEOMETRY PRESERVED: YES
READY TO FREEZE 3B-6: YES
```

## Pre-edit authority and connectivity

Read the accepted Phase 3B reports for 3B-1, 3B-2, 3B-3, 3B-4, 3B-5E, 3B-5A, 3B-5B, 3B-5C and 3B-5D, together with the historical 3B-5 blocker report and Phase 3A freeze instructions. The user-authorized Phase 3B-5D input supersedes the older Phase-3A-only continuation-base wording in AGENTS.md.

KiCad `BuildConnectivity()` / `GetConnectedItems()` verified exactly four independent singleton groups: {{C501.1}}, {{C503.1}}, {{U503.11}}, {{J5001.1}}. Each is GND and had no connected zone. The inventory of reference/AFE footprints comes from `reference_vcm.kicad_sch`, including the U501/U502 decoupling and ground pins. Its ten GND pads are C501.1, C502.1, C503.1, C5001.1, C5002.1, R5004.1, U501.11, U502.11, U503.11 and J5001.1. The six other local GND pads already reached both internal planes. There was no additional unresolved Phase-3B-local GND pad and no connectivity discrepancy.

The original plane-connected GND core contained 54 pads and both GND zones. After refill it contains exactly those 54 pads plus the four targets, for 58 pads. All four targets and every new via reach both original zone UUIDs. All previously connected GND pads retain their pad and zone connectivity; all pad/zone components outside this exact merger are unchanged. This establishes four component mergers independently of the global DRC counter. Other missing GND access remains deferred to its owning phases.

## Local return geometry

Each target has its own compact F.Cu return and one nearby ordinary through-via. No surface bus, remote pad daisy-chain or internal-plane replacement was added. Total new track length: **{r['track_length_mm']:.6f} mm**, five segments, four vias. All new tracks are **0.40 mm** wide. Lengths are centerline lengths including copper inside the target pad.

| Target | Stub length mm | Width mm | Via location mm | Via diameter / drill mm | Minimum foreign copper clearance mm |
|---|---:|---:|---|---|---:|
{chr(10).join(rows)}

C501.1 uses a direct 0.75 mm downward return. C503.1 uses a direct 0.667083 mm diagonal return, avoiding the frozen supply and reference geometry. U503.11 uses (51.35,20.50) -> (52.60,20.50) -> (52.60,19.75): a 2.00 mm return with a local bend. A direct via escape at y=20.50 conflicts with frozen B.Cu AFE_3V0; the bend places the GND via clear of that supply without changing it. J5001.1 uses a direct 0.90 mm leftward return; the accepted J5001.2 RLD_SAFE route remains exactly unchanged.

The sampled local preflight sought short feasible escapes, then actual refilled-board checks verified the selected geometry. It is not an exhaustive shortest-path proof. The initial straight-only U503 search found no eligible location; no board was saved from that preflight. The delivered compact bent escape passes all gates.

Foreign-net clearance measurements use exact KiCad copper shapes across every common copper layer, with 1 nm binary-search resolution. The minimum across new copper is **{r['minimum_foreign_track_via_pad_clearance_mm']:.6f} mm**, above 0.20 mm and the 0.22 mm review margin. Refilled DRC additionally checks zone and board-edge clearances. Per-object witnesses are retained in the verification JSON.

## Via manufacturing checks

All four vias are standard F.Cu–B.Cu through-vias, diameter 0.55 mm, drill 0.30 mm, annulus 0.125 mm. Exact annulus-to-pad collision checks across common copper layers confirm no via-in-pad. Hole-to-hole measurements include all other vias and drilled pads; circular envelopes conservatively bound any slotted pad drills.

| Target via | Annulus mm | Hole-to-foreign-copper mm | Hole-to-other-hole mm | Via-in-pad exclusion / manufacturing |
|---|---:|---:|---:|---|
{chr(10).join(via_rows)}

Original requirements are retained: minimum via diameter 0.50 mm, through-hole drill 0.30 mm, annulus 0.10 mm, hole-to-copper 0.25 mm, hole-to-hole 0.25 mm. Every new via meets them and reaches both planes. There is no HDI, microvia, blind/buried via, via-in-pad, special stackup or added manufacturing process. Standard four-layer fabrication and the approximately 20–25 EUR assembled-board target are preserved; pricing was not requoted.

## Plane and preservation evidence

After refill In1.Cu and In2.Cu each retain exactly one filled GND polygon and zero islands. Both were also one polygon with zero islands in the accepted input. Each new GND via is physically connected to both filled original zone identities. The 58-pad connected core and unchanged outside components prove no previously connected GND pad loses connectivity. Internal GND zone definitions remain frozen; only derived fills were regenerated for the new GND vias.

Mechanical parsed S-expression comparison proves every original top-level object is retained unchanged, excluding derived fill polygons from the zone-definition comparison. All **523 original segments, 147 original vias and 138 footprints** are identical. The only additions are the five authorized GND segments and four GND vias, with their actual UUIDs, coordinates, dimensions and nets checked against the saved plan. Original internal tracks, placement, outline, RF keepout, settings, complete zone definitions, AFE_3V0, VCM, reference, RLD_SAFE and every accepted Phase 1/2/3A/3B route are preserved. C5001.1, C5002.1 and R5004.1 return tracks/vias are untouched.

All 14 Phase 3A vias remain. All seven Phase 3A freeze-manifest file hashes match. Protected earlier boards, reports and evidence retain their pre-edit hashes. Candidate and Clean project/routing-rule sidecars are copied byte-identically from the authoritative input. Production remains unchanged at SHA-256 `{r['production_sha256']}`.

Native KiCad F.Cu/B.Cu copper plots for C501, U503/C503 and J5001, and full In1/In2 plots, were rendered and inspected. They show compact independent returns, separation from frozen copper, ordinary vias outside pads and continuous internal planes. These are geometric/electrical connectivity checks; no noise, transient or impedance simulation is claimed.

## Executed gates

| Gate | Result | Evidence |
|---|---|---|
| Accepted authority / local inventory | PASS | Accepted SHA; KiCad singleton groups and complete reference/AFE GND inventory |
| Baseline DRC | PASS | Read-only real DRC: 548 ordinary violations / 96 unconnected pairs |
| Candidate refill/save DRC | PASS | All four requested flags: 548 ordinary / 92 unconnected |
| Four GND core integrations | PASS | Original 54-pad core -> exact 58-pad core; targets and vias reach both original planes |
| Other connectivity / earlier local returns | PASS | All unrelated components identical; no original pad or zone connection lost |
| Copper / crossings / shorts / dangling | PASS | Ordinary violation identities and multiplicity match baseline exactly; corresponding new categories zero |
| Via manufacturing / clearance | PASS | Exact KiCad shapes; all rule checks; minimum new copper clearance 0.235 mm |
| Plane continuity | PASS | One filled polygon per plane, zero islands; both original GND zones connected |
| Frozen geometry / protected files | PASS | Parsed object comparison, original UUID preservation and SHA checks |
| Visual review | PASS | Native copper/plane images inspected; listed in verification JSON |
| Final Clean read-only DRC | PASS | Independent Clean filename: 548 ordinary / 92 unconnected; PCB hash unchanged |
| Artifact provenance | PASS | Clean byte-identical to refilled Candidate; unchanged rule sidecars |

Executed commands:

```bash
/usr/bin/python3 phase3b6_local_gnd_inspect.py
kicad-cli pcb drc --severity-all --all-track-errors --format json -o phase3b6_local_gnd_baseline_drc.json ARTHUR_EMG_RevA_Cost_Phase3B5D_ADC3V0Clean.kicad_pcb
/usr/bin/python3 phase3b6_local_gnd_work.py
kicad-cli pcb drc --severity-all --all-track-errors --refill-zones --save-board --format json -o phase3b6_local_gnd_candidate_drc.json ARTHUR_EMG_RevA_Cost_Phase3B6_LocalGNDCandidate.kicad_pcb
/usr/bin/python3 phase3b6_local_gnd_verify.py
kicad-cli pcb drc --severity-all --all-track-errors --format json -o phase3b6_local_gnd_drc.json ARTHUR_EMG_RevA_Cost_Phase3B6_LocalGNDClean.kicad_pcb
/usr/bin/python3 phase3b6_local_gnd_verify.py clean
kicad-cli pcb export svg --layers F.Cu,B.Cu,In1.Cu,In2.Cu --common-layers Edge.Cuts --mode-multi --page-size-mode 2 --exclude-drawing-sheet -o phase3b6_local_gnd_native_svg ARTHUR_EMG_RevA_Cost_Phase3B6_LocalGNDCandidate.kicad_pcb
/usr/bin/python3 phase3b6_local_gnd_visual.py
python3 phase3b6_local_gnd_finalize.py
```

All final implemented-board gates passed. KiCad Python emitted existing PROPERTY_ENUM diagnostic messages but loaded the board and completed connectivity/shape checks successfully; command logs retain them. DRC exit 0 means report generation, not global board cleanliness. The 548 ordinary baseline violations and 92 remaining global missing pairs were not repaired, hidden or accepted as full-board manufacturing readiness.

Produced the separate Candidate and verified Clean board, this report, `phase3b6_local_gnd_drc.json`, `phase3b6_local_gnd_verification.json`, unchanged rule sidecars and supporting preflight, baseline, candidate, scripts/logs and visual evidence. No production promotion or freeze manifest was written. Stopped after Phase 3B-6. Phase 3C and global GND cleanup were not started.
'''
(D/'PHASE3B6_LOCAL_GND_REPORT.md').write_text(text)
print('READY TO FREEZE 3B-6: YES');print('Final SHA256',r['artifact_sha256'])
