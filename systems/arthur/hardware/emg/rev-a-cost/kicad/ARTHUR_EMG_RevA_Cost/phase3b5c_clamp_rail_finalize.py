import pathlib,json,hashlib,collections
D=pathlib.Path(__file__).resolve().parent
BASE='ARTHUR_EMG_RevA_Cost_Phase3B5B_OpAmpSupplyClean';A='ARTHUR_EMG_RevA_Cost_Phase3B5C_ClampRailCandidate';B='ARTHUR_EMG_RevA_Cost_Phase3B5C_ClampRailClean'
def sha(n):return hashlib.sha256((D/n).read_bytes()).hexdigest()
def ident(z):return collections.Counter((v['type'],tuple(sorted(i['uuid'] for i in v['items']))) for v in z['violations'])
r=json.loads((D/'phase3b5c_clamp_rail_verification.json').read_text());added=json.loads((D/'phase3b5c_clamp_rail_added.json').read_text())
for ext in ['.kicad_pcb','.kicad_pro','.kicad_dru']:assert sha(A+ext)==sha(B+ext)
for ext in ['.kicad_pro','.kicad_dru']:assert sha(B+ext)==sha(BASE+ext)
x=json.loads((D/'phase3b5c_clamp_rail_candidate_drc.json').read_text());y=json.loads((D/'phase3b5c_clamp_rail_drc.json').read_text());z=json.loads((D/'phase3b5c_clamp_rail_baseline_drc.json').read_text())
assert ident(x)==ident(y)==ident(z) and len(y['violations'])==548 and len(y['unconnected_items'])==97
snap=json.loads((D/'phase3b5c_clamp_rail_baseline_geometry.json').read_text());assert all(sha(n)==h for n,h in snap['protected_file_sha256'].items())
assert sha(BASE+'.kicad_pcb')=='350d90a013e0a1cfbe44a16e1b6b51dd9c177fac78fc8104aac2e37f2ee91777'
checkpoints=[]
for i in range(1,5):
 v=json.loads((D/f'phase3b5c_clamp_rail_c{i}_verification.json').read_text());d=json.loads((D/f'phase3b5c_clamp_rail_c{i}_drc.json').read_text())
 assert ident(d)==ident(z) and len(d['unconnected_items'])==105-2*i and v['afe_group_count_after']==12-2*i
 assert v['all_original_tracks_vias_footprints_preserved'] and v['all_other_pad_connectivity_preserved']
 checkpoints.append({'checkpoint':f'C{i}','connected_clamp_endpoints':2*i,'unconnected_pairs':105-2*i,'afe_groups':12-2*i,'ordinary_drc_violations':548,'new_copper_violations':0,'new_crossings':0,'new_shorts':0,'dangling_tracks_vias':0,'frozen_objects_preserved':True,'drc_sha256':sha(f'phase3b5c_clamp_rail_c{i}_drc.json'),'board_sha256':sha(f'ARTHUR_EMG_RevA_Cost_Phase3B5C_C{i}Checkpoint.kicad_pcb')})
r.update(final_artifact=B+'.kicad_pcb',final_sha256=sha(B+'.kicad_pcb'),candidate_and_clean_byte_identical=True,rule_sidecars_identical_to_authority=True,final_drc_matches_refilled_candidate=True,final_drc_sha256=sha('phase3b5c_clamp_rail_drc.json'),production_sha256=sha('ARTHUR_EMG_RevA_Cost.kicad_pcb'),visual_review='PASS: actual clamp-pair and C1 source copper images inspected; gold added supply, blue frozen routing, green GND, purple VCM; solid F.Cu / dotted B.Cu',checkpoints=checkpoints,no_neck_down_added=True,remaining_afe_groups_exactly_expected=True,all_eight_clamp_endpoints_connected=True)
r['plane_fill_changes']='Only derived candidate fills regenerated for four new supply through-vias; frozen zone definitions and original copper unchanged.'
r['candidate_drc_command']='kicad-cli pcb drc --severity-all --all-track-errors --refill-zones --save-board --format json -o phase3b5c_clamp_rail_candidate_drc.json '+A+'.kicad_pcb'
r['final_drc_command']='kicad-cli pcb drc --severity-all --all-track-errors --format json -o phase3b5c_clamp_rail_drc.json '+B+'.kicad_pcb'
topologies={
'C1':'B.Cu branch from the frozen supply via (8.40,5.50), following the clear left corridor to a new via (3.20,25.50); compact F.Cu fork with independent connections to D101.2 and D102.2. The D101 leg steps right at y=24.75 to clear TP610.',
'C2':'B.Cu branch from the frozen supply via (32.40,21.90) down to (32.40,25.50), then left to a new via (19.20,25.50). A local F.Cu rail supplies D201.2 and D202.2 through separate 0.75 mm stubs.',
'C3':'New via (27.00,25.50) taps the C2 B.Cu branch directly. Its compact F.Cu rail supplies D301.2 and D302.2 through separate 0.75 mm stubs; no additional B.Cu track length.',
'C4':'Independent B.Cu branch from the frozen supply vertex (41.80,22.30) to a new via (37.50,25.50). Its local F.Cu rail supplies D401.2 and D402.2 through separate 0.75 mm stubs.'}
for role,v in r['branch_metrics'].items():v['attachment_topology']=topologies[role];v['through_via_layer_pair']=['F.Cu','B.Cu']
for role in topologies:
 plan={'segments':[x for x in added if x['type']=='segment' and x['role']==role],'vias':[x for x in added if x['type']=='via' and x['role']==role]}
 (D/f'phase3b5c_clamp_rail_{role.lower()}_as_built.json').write_text(json.dumps(plan,indent=2)+'\n')
(D/'phase3b5c_clamp_rail_verification.json').write_text(json.dumps(r,indent=2)+'\n')
rows='\n'.join(f"| {role} | {v['track_length_mm']:.6f} | {v['segment_count']} | 0.40 | {', '.join(v['layers'])} | {v['via_count']} | {v['minimum_foreign_track_via_pad_clearance_mm']:.6f} |" for role,v in r['branch_metrics'].items())
voidrows=[]
for k,v in r['ground_reference_samples'].items():
 role=next(x['role'] for x in added if x['uuid']==k)
 for interval in v['pre_existing_void_intervals']:
  fmt=lambda pt:'('+','.join(f'{n:.3f}' for n in pt)+')'
  voidrows.append('| '+role+' | '+v['adjacent_layer']+' | '+fmt(interval['start'])+' → '+fmt(interval['end'])+' |')
samples=sum(v['samples'] for v in r['ground_reference_samples'].values());hits=sum(v['gnd_hits'] for v in r['ground_reference_samples'].values());newholes=sum(v['intentional_new_supply_via_antipad_samples'] for v in r['ground_reference_samples'].values());oldvoid=sum(v['pre_existing_gnd_void_samples'] for v in r['ground_reference_samples'].values())
review=[]
for x in r['clearances_below_0_22mm']:
 t=next(t for t in added if t['uuid']==x['uuid']);review.append(f"- `{x['uuid']}`: {t['start']} → {t['end']}, {t['layer']}, clearance {x['minimum_foreign_track_via_pad_clearance_mm']:.6f} mm to `{x['witness']['net']}` / `{x['witness']['uuid']}`.")
counts=r['structural_comparison']
report=f'''# Phase 3B-5C — AFE_3V0 clamp-rail distribution

READY TO FREEZE 3B-5C: YES. All requested gates passed. Two new C1 segments have 0.202341 mm clearance and are explicitly flagged for review; they pass the formal 0.20 mm rule. Readiness is limited to this increment, with the unrelated baseline DRC violations retained.

Authoritative input: `{BASE}.kicad_pcb`  
Accepted input SHA-256, unchanged: `{r['input_sha256']}`  
Final board: `{B}.kicad_pcb`  
Final SHA-256: `{r['final_sha256']}`

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

Pre-edit connectivity independently established eight distinct isolated singleton clamp groups. The main authority had nine pads; the final main authority has those nine plus exactly the eight targets. Its 17 pads are `{', '.join(r['authority_after'])}`. The three remaining non-authority groups are exactly {{C6007.1,U6001.1}}, {{R3005.2}}, {{TP601.1}}; their connectivity is unchanged. All unrelated pad/zone connectivity is unchanged. These are actual KiCad connected-component checks, independent of the global unconnected counter.

Each checkpoint was added only after its predecessor passed real refilled DRC, connected-component analysis and mechanical comparison. Immutable checkpoint boards, DRC JSON and verification JSON retain the evidence.

| Checkpoint | Newly connected pads | Global unconnected pairs | AFE groups | Ordinary DRC | New copper violations | Frozen objects |
|---|---|---:|---:|---:|---:|---|
| Baseline | — | 105 | 12 | 548 | — | Authority |
| C1 | D101.2 / D102.2 | 103 | 10 | 548 | 0 | PASS |
| C2 | D201.2 / D202.2 | 101 | 8 | 548 | 0 | PASS |
| C3 | D301.2 / D302.2 | 99 | 6 | 548 | 0 | PASS |
| C4 | D401.2 / D402.2 | 97 | 4 | 548 | 0 | PASS |

## Branch topology and geometry

{chr(10).join('- '+role+': '+text for role,text in topologies.items())}

| Channel pair | Added track length mm | Segments | Width mm | Track layers | Vias | Minimum foreign copper clearance mm |
|---|---:|---:|---:|---|---:|---:|
{rows}

Total added track length: {r['track_length_mm']:.6f} mm; 23 segments; four standard through-vias. Every added track is 0.40 mm; no neck-down was required. C3 uses F.Cu tracks plus a through-via to B.Cu. C2's B.Cu branch is shared by C2 and C3 and its length is counted once. This is a branched distribution with compact per-channel forks; no supply path passes serially through all eight diode pads.

Local rails lie at y=25.50, with short pad branches from y=24.75. C1's TP610 and frozen signal/VCM geometry require its offset first leg and separate left-corridor feed. A common F.Cu rail across channels would intersect the frozen input-channel frame traces. The new B.Cu branches cross some F.Cu geometry on a different layer without electrical contact; real all-track DRC verifies zero copper crossings/shorts. The original tracks and vias used as attachment points were not split, shortened or replaced. No global shortest-path proof is claimed.

## Clearance review and manufacturing

Exact KiCad copper-shape measurements on all common copper layers use 1 nm binary-search resolution. New foreign track/via/pad clearance is at least 0.202341 mm. Refilled real DRC additionally checks zone copper clearance; the frozen internal GND-zone clearance remains 0.50 mm.

The following two connected C1 feed segments are below the requested 0.22 mm review threshold, at their common corner near (2.40,5.70):

{chr(10).join(review)}

Both pass 0.20 mm DRC. C2's minimum is 0.30 mm; C3 and C4 minima are 0.70 mm. The review list and witnesses are retained in the verification JSON.

Each new via is ordinary through-hole, 0.55 mm diameter / 0.30 mm drill / 0.125 mm annulus. Actual annuli overlap no pad. Drill, annular-width, hole-to-copper and hole-to-hole checks pass. Four-layer standard fabrication remains applicable; no HDI, microvia, blind/buried via, via-in-pad, special stackup or added process is introduced. The 20–25 EUR assembled-board target was not requoted.

## Ground-plane audit

No GND copper or pad access was routed. Both internal GND planes retain one filled polygon and zero islands; every original GND pad group and zone access is unchanged. Existing internal copper and zone definitions are preserved; only derived candidate fills were regenerated around the new supply vias.

Outer-layer centerlines were sampled at intervals no greater than 0.01 mm against the adjacent refilled GND plane: F.Cu against In1, B.Cu against In2. Of {samples} samples, {hits} are GND-backed, {newholes} are classified as new supply-via antipads, and {oldvoid} are confirmed existing baseline voids. Unexplained samples: zero. New via locations are (3.20,25.50), (19.20,25.50), (27.00,25.50), and (37.50,25.50). Antipad classification uses 0.775 mm nominal radius (0.275 mm copper radius plus 0.50 mm frozen zone clearance), with 0.0251 mm allowance for polygon approximation; actual GND hits remain separately recorded.

The following centerline intervals lack adjacent GND in the accepted baseline as well as the candidate:

| Pair | Adjacent plane | Approximate baseline-void interval mm |
|---|---|---|
{chr(10).join(voidrows)}

These are documented reference interruptions, not claimed to be continuous GND beneath every point. Neither plane is split and no island is introduced. No noise or load-transient simulation was performed.

## Executed verification and preservation

- Accepted SHA verified before editing and after final verification; production and earlier accepted artifacts/evidence remain byte-identical. All Phase 3A manifest hashes match and all 14 frozen Phase 3A vias remain.
- Mechanical parsed-object comparison preserves all {counts['segment']['before']} original segments, {counts['via']['before']} original vias, and {counts['footprint']['before']} footprints exactly. Only 23 AFE_3V0 segments and four AFE_3V0 vias were added. Placement, outline, RF keepout, zone definitions and all other PCB object categories are unchanged.
- This includes every frozen Phase 1/2/3A/3B object, accepted VCM exception, reference node, follower closure, RLD_SAFE route, and existing AFE_3V0 copper. Accepted 3B-5A neck, supply vias and minimum-clearance watchpoint remain unchanged.
- Baseline, C1, C2, C3, C4 and final read-only DRC all executed. Ordinary violation identities, including multiplicity in the final comparison, exactly match the 548 baseline violations. No unrelated baseline cleanup was attempted.
- Final Clean is byte-identical to the refilled candidate, including unchanged copied project and routing-rule sidecars. The independent final read-only DRC returned 548 ordinary violations and 97 unconnected pairs without changing the board.
- Actual clamp and C1 source copper images were inspected. Per-object clearances, via checks, component memberships, ground-reference classifications and protected hashes are in the verification JSON.

Commands used for every checkpoint:

```bash
{r['candidate_drc_command']}
/usr/bin/python3 phase3b5c_clamp_rail_verify.py CHECKPOINT_NUMBER
```

Final read-only command:

```bash
{r['final_drc_command']}
```

Production SHA-256, unchanged: `{r['production_sha256']}`.

Deliverables: verified Clean board, this report, `phase3b5c_clamp_rail_drc.json`, `phase3b5c_clamp_rail_verification.json`, separate Candidate, unchanged rule sidecars and checkpoint/supporting evidence. U6001.1/C6007.1, R3005.2 and TP601.1 remain deferred; no GND routing was added. Stopped after Phase 3B-5C.
'''
(D/'PHASE3B5C_CLAMP_RAIL_REPORT.md').write_text(report)
for n in [B+'.kicad_pcb','PHASE3B5C_CLAMP_RAIL_REPORT.md','phase3b5c_clamp_rail_drc.json','phase3b5c_clamp_rail_verification.json']:assert (D/n).stat().st_size>0
print('FINAL GATES PASS',r['final_sha256'])
