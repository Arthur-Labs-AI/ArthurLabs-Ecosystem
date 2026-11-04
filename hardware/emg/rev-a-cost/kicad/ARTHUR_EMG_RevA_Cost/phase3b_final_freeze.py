import json,pathlib,hashlib,collections,datetime
D=pathlib.Path(__file__).resolve().parent
FINAL='ARTHUR_EMG_RevA_Cost_Phase3B_FinalClean'
def sha(n):return hashlib.sha256((D/n).read_bytes()).hexdigest()
r=json.loads((D/'phase3b_final_verification.json').read_text());assert r['ready_to_freeze'] and r['ready_for_production_promotion'] and not r['gate_scope_clarification_pending']
assert sha(FINAL+'.kicad_pcb')==r['artifact_sha256']==sha(r['authoritative_input'])
assert sha('ARTHUR_EMG_RevA_Cost.kicad_pcb')==r['phase3a_sha256']
for n,h in json.loads((D/'phase3b_final_provenance_before.json').read_text())['protected_sha256'].items():assert sha(n)==h
route=json.loads((D/'phase3b_final_route_metrics.json').read_text());r['source_to_required_endpoint_route_metrics']=route
r['statistics']['neck_down_region_count']=1;r['statistics']['minimum_neck_down_width_mm']=.3;r['statistics']['minimum_neck_down_length_mm']=1.4;r['statistics']['standard_through_via_count']=20
r['statistics']['longest_new_source_to_required_endpoint_route']=route['largest_phase3b_added_length_on_source_route']
r['statistics']['historical_added_segments_including_superseded_vcm_segment']=105
r['statistics']['historical_added_track_length_including_superseded_vcm_segment_mm']=r['statistics']['track_length_mm']+1.95
r['statistics']['superseded_vcm_segment_length_mm']=1.95
r['readonly_verification_copy_drc']='PASS'
r['visual_review']={'result':'PASS','source':'Native KiCad plots exported from FinalClean without refill or save','images_inspected':['phase3b_final_'+l+'_review.png' for l in ['F_Cu','B_Cu','In1_Cu','In2_Cu']]}
r['final_evidence_sha256']={n:sha(n) for n in [FINAL+'.kicad_pcb',FINAL+'.kicad_pro',FINAL+'.kicad_dru','phase3b_final_drc.json']}
r['production_promotion_performed']=False;r['user_acceptance_of_final_report']='PENDING';r['readiness_limitation']='Ready to promote the routing checkpoint after user acceptance; not a fully routed board, full-board DRC clearance or final manufacturing release.'
r['baseline_via_in_pad_disposition']='Unchanged frozen Phase 3A geometry. User explicitly scoped no-via-in-pad gate to Phase 3B additions. No blanket whole-board no-via-in-pad claim.'
r['executed_commands']=['python3 phase3b_final_prepare.py','kicad-cli pcb drc --severity-all --all-track-errors --format json -o phase3b_final_phase3a_baseline_drc.json '+r['phase3a_baseline'],'kicad-cli pcb drc --severity-all --all-track-errors --refill-zones --save-board --format json -o phase3b_final_candidate_drc.json ARTHUR_EMG_RevA_Cost_Phase3B_VerificationCandidate.kicad_pcb','/usr/bin/python3 phase3b_final_verify.py','kicad-cli pcb drc --severity-all --all-track-errors --format json -o phase3b_final_readonly_verification_drc.json ARTHUR_EMG_RevA_Cost_Phase3B_VerificationCandidate.kicad_pcb','kicad-cli pcb drc --severity-all --all-track-errors --format json -o phase3b_final_drc.json '+FINAL+'.kicad_pcb','/usr/bin/python3 phase3b_final_verify.py final','/usr/bin/python3 phase3b_final_route_metrics.py','kicad-cli pcb export svg --layers F.Cu,B.Cu,In1.Cu,In2.Cu --common-layers Edge.Cuts --mode-multi --page-size-mode 2 --exclude-drawing-sheet -o phase3b_final_native_svg '+FINAL+'.kicad_pcb','python3 phase3b_final_freeze.py']
(D/'phase3b_final_verification.json').write_text(json.dumps(r,indent=2)+'\n')
gate='''PHASE 3B REFERENCE CORE: PASS
PHASE 3B VCM: PASS
PHASE 3B FOLLOWERS: PASS
PHASE 3B RLD_SAFE: PASS
PHASE 3B AFE_3V0 QUIET CORE: PASS
PHASE 3B LOCAL GND: PASS

R3005.2 DEFERRED: YES
TP601.1 DEFERRED: YES

FINAL UNCONNECTED PAIRS: 92
PHASE 3B PAIRS ELIMINATED: 34

NEW COPPER VIOLATIONS: 0
NEW CROSSINGS: 0
NEW SHORTS: 0
DANGLING TRACKS/VIAS: 0/0

In1 GND: PASS
In2 GND: PASS
GND ISLANDS: 0

Phase 1 preserved: YES
Phase 2 preserved: YES
Phase 3A preserved: YES
all 14 Phase 3A vias preserved: YES

PLACEMENT PRESERVED: YES
RF KEEPOUT PRESERVED: YES
ZONE DEFINITIONS PRESERVED: YES

STANDARD 4-LAYER / COST-FIRST PROCESS PRESERVED: YES

PHASE 3B READY TO FREEZE: YES
PHASE 3B READY FOR PRODUCTION PROMOTION: YES'''
mergers='\n'.join(f"| `{n}` | {r['component_reconciliation_by_net'][n]['groups_before']} | {r['component_reconciliation_by_net'][n]['groups_after']} | {v} |" for n,v in r['component_mergers_by_phase3b_net'].items())
netstats='\n'.join(f"| `{n}` | {s['track_length_mm']:.6f} | {s['segment_count']} | {s['via_count']} | {', '.join(s['width_counts_mm'])} | {', '.join(s['layers'])} |" for n,s in r['statistics']['by_net'].items())
watchrows='\n'.join(f"| {phase} | {q['accepted_minimum_mm']:.6f} | {q['final_measured_minimum_mm']:.6f} | PASS |" for phase,q in r['watchpoints'].items())
chainrows='\n'.join(f"| {q['phase']} | {q['added_geometry_statistics']['segment_count']} | {q['surviving_final_statistics']['segment_count']} | {q['surviving_final_statistics']['via_count']} | {q['surviving_final_statistics']['track_length_mm']:.6f} |" for q in r['incremental_geometry_reconciliation'])
net_categories=dict(collections.Counter(v['type'] for v in json.loads((D/'phase3b_final_phase3a_baseline_drc.json').read_text())['violations']))
catrows='\n'.join(f'| `{n}` | {v} | {v} |' for n,v in net_categories.items())
long=route['largest_phase3b_added_length_on_source_route']
text=f'''# Routing Phase 3B — full verification and freeze preparation

Date: 2026-09-27. All Phase 3B-F verification gates PASS. The immutable routing checkpoint is prepared. Production promotion remains pending user acceptance of this report and has not been performed. Readiness concerns promotion of the routing checkpoint; it does not certify a finished or globally DRC-clean board.

## Authority and immutable checkpoint

Authoritative accumulated input: `{r['authoritative_input']}`  
Accepted input SHA-256: `{r['input_sha256']}`  
Frozen Phase 3A baseline: `{r['phase3a_baseline']}`  
Baseline SHA-256: `{r['phase3a_sha256']}`  
Final checkpoint: `{FINAL}.kicad_pcb`  
Final SHA-256: `{r['artifact_sha256']}`

FinalClean is byte-identical to the fully refilled and verified separate verification copy, and also to the accepted Phase 3B-6 input. The verification refill did not change its bytes. Final project and custom-rule sidecars are byte-identical to the input and frozen Phase 3A rule sidecars. `phase3b_routing_freeze.json` binds the PCB, both sidecars, final DRC JSON, final verification JSON and this document with SHA-256 hashes.

Do not edit this checkpoint or its bound evidence. Preserve every Phase 3B reference, VCM, follower, RLD_SAFE, quiet AFE_3V0 and local GND copper object. Future routing starts from this complete checkpoint after acceptance, without optimizing frozen copper. This explicit Phase 3B continuation supersedes the older Phase-3A-only continuation-base wording in AGENTS.md. Phase 1, Phase 2 and Phase 3A remain frozen. This task does not authorize production overwrite or any later-phase routing.

## Final gate

```text
{gate}
```

Board outline is also preserved exactly. Both internal planes have one filled polygon each and zero islands.

## Independent full-system connectivity

KiCad connected-component analysis was rebuilt from the frozen Phase 3A board and the final combined board. Individual increment reports were read as scope/provenance evidence, but their PASS labels were not substituted for final-board execution. Every physical PCB net's pad component partition was reconstructed, and every per-net component deficit was reconciled against the actual baseline/final DRC airwire count.

| Net / local unit | Before groups | Final groups | Pairs eliminated |
|---|---:|---:|---:|
{mergers}
| **Total reduction** | | | **34** |

All 92 physical net partitions were checked. The missing-pair sum is exactly 126 -> 92. Every previously connected pad/zone relationship remains connected; all non-Phase-3B partitions are identical. GND changes only by the seven explicitly authorized local endpoints. No unrelated component was accidentally merged.

- `Net-(U503A-+)`: exactly C5001.2, C5002.2, R5004.2, R5003.1 and U503.3 in one group.
- VCM: all 14 pads in one group, including R5002.1 and U503.5/10/12. Original Phase 1 distribution is mechanically unchanged.
- U503B/C/D: exactly the respective U503.6/7, U503.8/9 and U503.13/14 output-to-inverting-input pairs are joined.
- RLD_SAFE: exactly R5002.2 and J5001.2 in one group. Buffered U503A VCM -> R5002.1 -> resistor R5002 -> R5002.2 / RLD_SAFE -> J5001.2 is preserved.
- AFE_3V0 quiet core: exactly 19 pads in the authority group: {', '.join(r['afe_3v0_final_components'][0]) if len(r['afe_3v0_final_components'][0])>1 else ', '.join(next(g for g in r['afe_3v0_final_components'] if len(g)>1))}. This includes all sixteen requested Phase 3B endpoints and the three original main-authority pads.
- The other AFE_3V0 groups are exactly {{R3005.2}} and {{TP601.1}}. Total groups 3, missing pairs 2. R3005.2 belongs to Phase 3D discharge/interlock; TP601.1 belongs to the later testpoint phase. Neither was connected. This is quiet-core completion, not global AFE_3V0 completion.
- The original GND plane-connected core contains 51 pads. It now contains exactly those pads plus C5001.1, C5002.1, R5004.1, C501.1, C503.1, U503.11 and J5001.1, for 58 pads. All seven targets reach both original GND zone identities. All other GND components and every previously connected GND pad remain unchanged.

## Mechanical preservation and authorized exception

The complete parsed PCB object comparison preserves all **424 Phase 3A-baseline segments, 131 baseline vias and 138 footprints** exactly. Final totals are **528 segments and 151 vias**. All non-copper top-level categories are equal, including setup/stackup, placement, outline and RF keepout. Both zone definitions are identical; derived fill polygons are compared separately through plane topology and connectivity.

Every accepted Phase 3B checkpoint was loaded and compared to its predecessor. Its exact accepted SHA, added objects, permitted nets, segment/via counts and surviving objects in FinalClean were verified. The only removed/changed previously accepted Phase 3B object is VCM segment `30a501c9-ab5c-4380-ba9f-44465f57214b`, the documented 3B-5E exception. Its forbidden path (46.75,19.20) -> (46.75,21.15) is absent. Exactly the three accepted 0.15 mm F.Cu replacements remain:

```text
(46.75,19.20) -> (47.50,19.20)
(47.50,19.20) -> (47.50,21.15)
(47.50,21.15) -> (46.75,21.15)
```

The original endpoints are preserved. Removed length 1.95 mm; replacement length 3.45 mm; increment +1.50 mm. No other accepted VCM copper was altered. This exception changes a 3B-2 addition, not Phase 1/2/3A copper. Every one of the fourteen original Phase 3A vias and all seven Phase 3A freeze-manifest hashes match. All {len(r['protected_file_hash_checks'])} captured pre-existing root-file hashes remain unchanged, including production, accepted boards and prior reports/evidence.

| Increment | Historically added segments | Surviving final segments | Added vias retained | Surviving track length mm |
|---|---:|---:|---:|---:|
{chainrows}

The historical total is 105 added segments / 235.894268 mm, including the subsequently removed 1.95 mm VCM segment. Manufacturing statistics below describe the actual final additions relative to Phase 3A: 104 surviving segments / 233.944268 mm. The removed segment is not double-counted.

## Manufacturing statistics and watchpoints

| Phase 3B net/category | Added length mm | Segments | Vias | Widths mm | Track layers |
|---|---:|---:|---:|---|---|
{netstats}
| **Total** | **{r['statistics']['track_length_mm']:.6f}** | **104** | **20** | **0.15, 0.30, 0.40** | **F.Cu, B.Cu** |

All **20 added vias** are standard F.Cu–B.Cu through-vias, **0.55 mm diameter / 0.30 mm drill / 0.125 mm annulus**: AFE_3V0 10, GND 7, VCM 3. Each was independently checked against every pad shape, common-layer foreign copper and all other drills in the final board. New via-in-pad count is zero. Annulus, drill, diameter, hole-to-copper and hole-to-hole requirements pass. All 151 board vias are ordinary through-vias; no microvia, blind or buried via exists. The unchanged board has four copper layers; Phase 3B introduces no special stackup or manufacturing process. The approximately 20–25 EUR assembled-board target was not requoted.

The user explicitly confirmed that the no-via-in-pad gate applies to **Phase 3B additions**. The preserved Phase 3A baseline has **72 vias with annulus/pad overlap**, including **70 with drill/pad overlap** and **64 with the drill center inside a pad**. All are pre-existing, byte-for-byte unchanged and listed by UUID, coordinates, net and pad in `phase3b_final_verification.json`. Examples include the existing AFE_3V0 via at (19.49,11.45) on C6007.1 and the GND via at (20.51,11.40) on C6007.2. No blanket whole-board no-via-in-pad statement or final assembly qualification is made. No repair of frozen baseline geometry was attempted.

Exact KiCad shape-distance measurements on every common copper layer, resolved to 1 nm, give minimum surviving Phase 3B foreign track/via/pad clearance **0.201789 mm**. Refilled DRC independently verifies zones, holes and edges. All four requested low-margin regions remain unchanged:

| Watchpoint | Accepted minimum mm | Final measured minimum mm | Formal 0.20 mm rule |
|---|---:|---:|---|
{watchrows}

The 3B-5C value is the C1 branch. Its two sub-0.22 mm corner segments and the 3B-5A minimum objects/witnesses are explicitly recorded in the verification JSON. No geometry was optimized in this task.

There is exactly **one AFE neck-down region**: B.Cu (49.30,20.50) -> (50.70,20.50), width **0.30 mm**, length **1.40 mm**. All other Phase 3B AFE supply segments are 0.40 mm. Reference/VCM/RLD/follower segments use 0.15 mm by design and are not supply neck-downs. Original baseline LDO/ADC widths remain unchanged.

For route-length statistics, the longest separately introduced feed is the 3B-5A authority attachment, **41.597264 mm**, measured again from its actual saved copper UUIDs. The longest individual new segment is the 3B-5C B.Cu supply trunk (32.40,25.50) -> (19.20,25.50), **13.20 mm**. To also account for accumulated feeds across increments, a copper-contact/centerline graph was independently reconstructed for the final AFE_3V0 network. Among source U4002.5 -> required Phase 3B quiet-core endpoints, the longest shortest source route reaches **{long['endpoint']}**, with **{long['projected_centerline_length_mm']:.6f} mm** projected centerline length and **{long['phase3b_added_portion_length_mm']:.6f} mm** on Phase 3B additions. Pads and via transitions are zero-length connectors in this statistic; vertical barrel and finite pad-copper length are excluded. This is a defined route metric, not a claim about the longest possible simple graph path, electrical delay, resistance or globally optimal routing. Full per-endpoint paths are included in verification evidence. Whole AFE_3V0 added copper length, counting branches once, is 176.018317 mm.

## DRC and remaining baseline issues

Executed a new read-only DRC on the exact Phase 3A baseline, a full all-track refill/save DRC on the separate verification copy, a second read-only DRC on that saved copy, and a final independent read-only DRC under the FinalClean filename. All final runs return 548 ordinary violations and 92 unconnected pairs. The accepted input, verification copy and final PCB hashes are equal; production remains unchanged.

| Baseline ordinary category | New Phase 3A run | Final Phase 3B |
|---|---:|---:|
{catrows}
| `nonmirrored_text_on_back_layer` (known serialization warnings) | 0 | 23 |
| **Ordinary total** | **525** | **548** |
| **Unconnected pairs (separate)** | **126** | **92** |

All 525 newly executed Phase 3A ordinary violation identities and multiplicities are present unchanged in final DRC; the entire delta is exactly the known 23 back-layer text warnings. Final ordinary identities/multiplicity also exactly match accepted 3B-6. There are no copper-to-copper clearance, crossing, shorting, dangling-track or dangling-via categories. All three pre-existing copper-edge violation identities remain; no new copper violation exists. Individual airwire-pair choices are not treated as component identity evidence; every per-net pair count was independently matched to actual components.

The 92 remaining airwires include the two explicitly deferred AFE branches and other GND/USB/power/debug/testpoint work outside completed Phase 3B scope. No global GND or AFE completion is claimed. The discovery's unresolved charger exposed-pad, USB shield mapping and connector-edge matters remain for their owning later tasks. No full-board manufacturing release or cleanup is claimed.

## Executed gate evidence

| Gate | Result | Executed evidence |
|---|---|---|
| Authority, protected inputs, accepted chain | PASS | Exact input/baseline/checkpoint SHA and {len(r['protected_file_hash_checks'])} protected hash checks |
| Six Phase 3B functional units | PASS | Fresh KiCad final-board connectivity; complete intended pad groups |
| 34-pair reconciliation / unrelated groups | PASS | Per-net component analysis over all 92 physical nets and actual per-net DRC pairs |
| Deferred AFE branches | PASS | Exactly three AFE groups, two singleton deferrals unchanged |
| Frozen Phase 1/2/3A and authorized VCM exception | PASS | Full parsed baseline/chain comparisons, all fourteen Phase 3A via UUIDs |
| GND core / In1 / In2 | PASS | Exact 58-pad core, both original zone identities, one polygon each, zero islands |
| Refilled verification-copy DRC | PASS | All four required flags; 548 ordinary / 92 unconnected |
| Read-only saved-copy and FinalClean DRC | PASS | Same results and identities, no board save, unchanged SHA |
| Manufacturing additions and watchpoints | PASS | All twenty vias, all 124 new copper objects, four remeasured minima; user-scoped via-in-pad audit |
| Full-board visual geometry review | PASS | Native FinalClean F.Cu/B.Cu/In1/In2 plots rendered and inspected |
| Final artifact and unchanged sidecars | PASS | FinalClean byte-identical to refilled copy and accepted 3B-6 |

Commands:

```bash
{chr(10).join(r['executed_commands'])}
```

KiCad Python's existing PROPERTY_ENUM and duplicate-image-handler diagnostics are retained in logs; the API loads and all assertions completed successfully. DRC exit 0 denotes successful report generation, not full-board cleanliness. No load, noise, IR-drop, transient or assembly-process simulation was performed or inferred from routing acceptance.

## Bound deliverables and stop point

- `{FINAL}.kicad_pcb`, with unchanged `.kicad_pro` and `.kicad_dru` sidecars.
- `phase3b_final_drc.json` and `phase3b_final_verification.json`.
- This `PHASE3B_ROUTING_FREEZE.md` document and `phase3b_routing_freeze.json` hash manifest.
- Separate verification copy, executed baseline/candidate/read-only DRCs, protected-file snapshot, independent verifier/route-statistics scripts/logs and native copper plots remain supporting evidence.

Production SHA-256 is still `{r['phase3a_sha256']}`. Production promotion was not performed. User acceptance of this final report is required before a later production-promotion task. No Phase 3C or later routing was started; stopped after 3B-F verification/freeze preparation.
'''
(D/'PHASE3B_ROUTING_FREEZE.md').write_text(text)
names=[FINAL+'.kicad_pcb',FINAL+'.kicad_pro',FINAL+'.kicad_dru','phase3b_final_drc.json','phase3b_final_verification.json','PHASE3B_ROUTING_FREEZE.md']
manifest={'phase':'3B-F','status':'VERIFIED_IMMUTABLE_CHECKPOINT_PREPARED','prepared_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'authoritative_checkpoint':FINAL+'.kicad_pcb','sha256':{n:sha(n) for n in names},'authoritative_input':r['authoritative_input'],'authoritative_input_sha256':r['input_sha256'],'phase3a_baseline':r['phase3a_baseline'],'phase3a_baseline_sha256':r['phase3a_sha256'],'frozen_nets':sorted(r['component_mergers_by_phase3b_net']),'gnd_freeze_scope':'Only original GND geometry plus the seven accepted Phase 3B local returns; other GND access remains deferred','quiet_core_only':True,'deferred_pads':{'R3005.2':'Phase 3D discharge/interlock','TP601.1':'Later testpoint phase'},'authorized_vcm_exception':r['authorized_vcm_exception'],'via_in_pad_gate_scope':r['via_in_pad_gate_scope'],'ready_to_freeze':True,'ready_for_production_promotion':True,'production_promotion_performed':False,'production_sha256_unchanged':sha('ARTHUR_EMG_RevA_Cost.kicad_pcb'),'user_acceptance':'PENDING','global_drc_clean':False,'pairs_eliminated':34,'final_unconnected_pairs':92,'remaining_ordinary_violations':548,'known_serialization_text_warnings':23,'statistics':r['statistics'],'limitations':r['readiness_limitation']}
(D/'phase3b_routing_freeze.json').write_text(json.dumps(manifest,indent=2)+'\n')
for n,h in manifest['sha256'].items():assert sha(n)==h
print(gate);print('Bound SHA-256 entries verified:',len(names));print('Final PCB SHA256:',r['artifact_sha256'])
