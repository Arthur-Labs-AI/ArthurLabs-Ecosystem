import pathlib,json,hashlib,math
D=pathlib.Path(__file__).resolve().parent;BASE='ARTHUR_EMG_RevA_Cost_Phase3B5A_U503SupplyClean';A='ARTHUR_EMG_RevA_Cost_Phase3B5B_OpAmpSupplyCandidate';B='ARTHUR_EMG_RevA_Cost_Phase3B5B_OpAmpSupplyClean'
def sha(n):return hashlib.sha256((D/n).read_bytes()).hexdigest()
r=json.loads((D/'phase3b5b_opamp_supply_verification.json').read_text());added=json.loads((D/'phase3b5b_opamp_supply_added.json').read_text())
for ext in ['.kicad_pcb','.kicad_pro','.kicad_dru']:assert sha(A+ext)==sha(B+ext)
for ext in ['.kicad_pro','.kicad_dru']:assert sha(B+ext)==sha(BASE+ext)
x=json.loads((D/'phase3b5b_opamp_supply_candidate_drc.json').read_text());y=json.loads((D/'phase3b5b_opamp_supply_drc.json').read_text())
def ident(z):return {(v['type'],tuple(sorted(i['uuid'] for i in v['items']))) for v in z['violations']}
assert ident(x)==ident(y) and len(y['violations'])==548 and len(y['unconnected_items'])==105
snap=json.loads((D/'phase3b5b_opamp_supply_baseline_geometry.json').read_text());assert all(sha(n)==h for n,h in snap['protected_file_sha256'].items())
assert sha(BASE+'.kicad_pcb')=='29d57a81a4bf46332a4cf39539740649e24a0baa5a7b9b7c7b845268d3a7acbe'
r.update(final_artifact=B+'.kicad_pcb',final_sha256=sha(B+'.kicad_pcb'),candidate_and_clean_byte_identical=True,rule_sidecars_identical_to_authority=True,final_drc_matches_refilled_candidate=True,final_drc_sha256=sha('phase3b5b_opamp_supply_drc.json'),visual_review='PASS: actual U501, U502 and authority copper images inspected; yellow added supply, blue frozen routing, green GND; solid F.Cu / dotted B.Cu',candidate_drc_command='kicad-cli pcb drc --severity-all --all-track-errors --refill-zones --save-board --format json --output phase3b5b_opamp_supply_candidate_drc.json '+A+'.kicad_pcb',final_drc_command='kicad-cli pcb drc --severity-all --all-track-errors --format json --output phase3b5b_opamp_supply_drc.json '+B+'.kicad_pcb')
r['production_sha256']=sha('ARTHUR_EMG_RevA_Cost.kicad_pcb')
r['no_neck_down_added']=True
(D/'phase3b5b_opamp_supply_verification.json').write_text(json.dumps(r,indent=2)+'\n')
metrics=r['branch_metrics'];rows='\n'.join('| '+role+' | '+f"{v['track_length_mm']:.6f}"+' | '+str(v['segment_count'])+' | 0.40 | '+', '.join(v['layers'])+' | '+str(v['via_count'])+' | '+f"{v['minimum_foreign_track_via_pad_clearance_mm']:.6f}"+' |' for role,v in metrics.items())
voidrows=[]
for k,v in r['ground_reference_samples'].items():
 role=next(x['role'] for x in added if x['uuid']==k)
 for interval in v['pre_existing_void_intervals']:
  fmt=lambda pt:'('+','.join(f'{n:.3f}' for n in pt)+')'
  voidrows.append('| '+role+' | '+v['adjacent_layer']+' | '+fmt(interval['start'])+' → '+fmt(interval['end'])+' |')
voidtable='\n'.join(voidrows)
samples=sum(v['samples'] for v in r['ground_reference_samples'].values());hits=sum(v['gnd_hits'] for v in r['ground_reference_samples'].values());newholes=sum(v['intentional_new_supply_via_antipad_samples'] for v in r['ground_reference_samples'].values());oldvoid=sum(v['pre_existing_gnd_void_samples'] for v in r['ground_reference_samples'].values())
checks=r['structural_comparison'];count=lambda tag:checks[tag]['before']
report=f'''# Phase 3B-5B — U501/U502 analog supply

READY TO FREEZE 3B-5B: YES. Readiness applies only to these three supply endpoint attachments; full-board completion is not claimed.

Authoritative input: `{BASE}.kicad_pcb`  
Accepted input SHA-256, unchanged: `{r['input_sha256']}`  
Final artifact: `{B}.kicad_pcb`  
Final SHA-256: `{r['final_sha256']}`

## Final gate

```text
U501.4 CONNECTED: YES
U502.4 CONNECTED: YES
C501.2 CONNECTED: YES

UNCONNECTED PAIRS: 108 -> 105
AFE_3V0 GROUPS: 15 -> 12
AFE_3V0 MISSING PAIRS: 14 -> 11
ORDINARY DRC VIOLATIONS: 548 -> 548

NEW COPPER VIOLATIONS: 0
NEW CROSSINGS: 0
NEW SHORTS: 0
DANGLING TRACKS/VIAS: 0/0

MINIMUM NEW CLEARANCE: {r['minimum_foreign_track_via_pad_clearance_mm']:.6f} mm
ANY NEW CLEARANCE <0.22 mm: NO

In1 GND: PASS
In2 GND: PASS
isolated polygons: 0

3B-5A PRESERVED: YES
ALL EARLIER FROZEN GEOMETRY PRESERVED: YES

READY TO FREEZE 3B-5B: YES
```

Added copper: {r['track_length_mm']:.6f} mm, {r['segment_count']} track segments, {r['via_count']} ordinary through-vias. Every new track is 0.40 mm. No neck-down was required or added. The accepted 0.30 mm / 1.40 mm neck remains unchanged.

## Connectivity and branched topology

Pre-edit KiCad connectivity established three distinct singleton groups: {{U501.4}}, {{U502.4}}, {{C501.2}}. The accepted main authority comprised {{C4006.1, C502.2, C503.2, R5003.2, U4002.5, U503.4}}. After routing, this authority contains exactly those six pads plus the three targets. All other AFE_3V0 groups and all non-AFE connected-pad/zone groups are unchanged. This independently proves the expected three-pair reduction, rather than inferring completion from global DRC counts.

U502.4 attaches independently to the frozen 3B-5A F.Cu vertex (29.30,8.10), with a short local path through (28.50,8.05) and (27.80,8.10) to the fixed supply pin at (27.15,8.10). The 0.05 mm offset improves clearance to the frozen D302-COM signal via without changing track width or any existing copper. It uses zero vias.

U501 and C501 share a separate feed tapped at (29.00,2.50) on the pre-existing LDO-side AFE_3V0 track. That original segment was not split or replaced. A 0.80 mm F.Cu stub reaches a new standard through-via at (29.00,1.70). B.Cu follows the available upper-board corridor around frozen power/ground obstacles, then changes to F.Cu at (8.40,5.50). The final landing reaches a compact fork at (9.50,8.10). From that fork, U501.4 has a 1.15 mm direct F.Cu branch and C501.2 has a 0.948736 mm direct F.Cu branch. Their pad-to-pad path through the fork is 2.098736 mm. Neither branch runs serially through the other pad. No long op-amp-to-op-amp daisy-chain was added.

| Newly added portion | Track length mm | Segments | Width mm | Layers | Vias | Minimum foreign copper clearance mm |
|---|---:|---:|---:|---|---:|---:|
{rows}

The shared-feed vias are counted once in the table. Full new authority-to-U501.4 path: {metrics['U501 shared authority feed']['track_length_mm']+metrics['U501.4 local branch']['track_length_mm']:.6f} mm, two shared vias, F.Cu/B.Cu. Full new authority-to-C501.2 path: {metrics['U501 shared authority feed']['track_length_mm']+metrics['C501.2 local branch']['track_length_mm']:.6f} mm, the same two vias. Both paths have minimum clearance {metrics['U501 shared authority feed']['minimum_foreign_track_via_pad_clearance_mm']:.6f} mm. U502.4 is a separate {metrics['U502.4 branch']['track_length_mm']:.6f} mm F.Cu branch with no vias and {metrics['U502.4 branch']['minimum_foreign_track_via_pad_clearance_mm']:.6f} mm minimum clearance.

Initial broad path searches produced 55–65 mm detours; direct inspection established the substantially shorter LDO-side upper corridor. No exhaustive global-shortest-path proof is claimed. The initial real DRC passed with two new 0.20 mm regions, but exact shape measurement identified those margins. Only new copper was adjusted to raise every new clearance above 0.22 mm; the first result is retained in the initial DRC/verification evidence. No accepted trace or watchpoint was changed.

All foreign track/via/pad clearance measurements use exact KiCad copper shapes on common layers with 1 nm binary-search resolution. The minimum is {r['minimum_foreign_track_via_pad_clearance_mm']:.6f} mm, above the formal 0.20 mm rule and requested 0.22 mm review threshold. Refilled DRC also checks zone clearance; frozen GND-zone local clearance remains 0.50 mm. The delivered verification JSON contains every added object's clearance witness and an empty sub-0.22 mm review list.

Both new vias are standard 0.55 mm diameter / 0.30 mm drill through-vias with 0.125 mm annulus. Actual annuli overlap no pad; drill, annulus, hole-to-copper and hole-to-hole rules pass. There is no via-in-pad, HDI, microvia, blind/buried via or added process. Standard cost-first four-layer fabrication remains applicable; the approximately 20–25 EUR assembled-board target was not requoted.

## GND planes and documented reference interruptions

No GND track, via or pad access was added. Each internal GND plane retains one filled polygon and zero islands after refill. Every original GND pad retains its connected group and zone access. Zone definitions, existing internal copper, outline and keepout are mechanically unchanged; only derived candidate fills were regenerated for new signal vias.

Adjacent-plane centerline sampling at ≤0.01 mm spacing records {samples} samples: {hits} on GND, {newholes} in the two new supply-via antipad envelopes, and {oldvoid} over pre-existing GND voids. There are zero unexplained missing samples. F.Cu references In1, B.Cu references In2. Antipad classification uses the frozen 0.50 mm zone clearance plus 0.275 mm annulus radius, with 0.0251 mm allowance for polygon approximation. The sample data retains actual GND hits separately from excluded holes.

New reference interruptions occur around (29.00,1.70) and (8.40,5.50), the two new ordinary supply vias. The following route intervals were explicitly confirmed absent from the accepted baseline plane fill; they were not counted as GND-covered:

| Added portion | Adjacent plane | Approximate interval mm |
|---|---|---|
{voidtable}

These include pre-existing power/signal-via openings in the upper supply corridor and the old D302-COM via opening beneath the U502 local branch. They do not split either plane or introduce islands. Continuous plane topology is verified; uninterrupted reference beneath every point of these routes is not claimed. No noise, transient or maximum-load simulation was performed for this routing increment.

## Executed preservation and verification gates

| Gate | Result | Evidence |
|---|---|---|
| Accepted input / earlier evidence | PASS | Accepted SHA verified before and after; protected files and all seven Phase 3A manifest hashes match |
| Three target groups completed | PASS | Main authority expands from six to nine pads; groups 15 → 12; unrelated AFE groups unchanged |
| Candidate refill / DRC | PASS | Real KiCad, all four flags; 548 ordinary / 105 unconnected; ordinary violation identities exactly match baseline |
| Final Clean DRC | PASS | Independent read-only run with both required flags; identical results |
| New copper, crossings, shorts, dangling items | PASS | Zero new copper violations; no crossing/short/dangling categories |
| New clearance review | PASS | All added objects measured; minimum {r['minimum_foreign_track_via_pad_clearance_mm']:.6f} mm; none below 0.22 mm |
| Frozen copper and footprints | PASS | Parsed PCB-object comparison: all {count('segment')} original segments, {count('via')} original vias, {count('footprint')} footprints identical; only 17 AFE segments / two AFE vias added |
| Phase 3B-5A and watchpoints | PASS | Every accepted added UUID preserved, including all supply vias, the 0.30 mm neck and 0.201789 mm region |
| Phase 3B-5E and earlier phases | PASS | All original objects preserved; VCM exception UUIDs and all 14 Phase 3A vias retained |
| Placement, outline, RF keepout, settings, zones | PASS | Mechanical top-level object and zone-definition comparison |
| GND topology and connectivity | PASS | One polygon / zero islands per plane; all original GND pad groups and zones unchanged |
| Ground-reference documentation | PASS | Every missing sample classified as a new antipad or explicitly confirmed baseline void |
| Visual inspection | PASS | Inspected actual U501, U502 and authority copper images |
| Final artifact provenance | PASS | Clean byte-identical to refilled candidate; project/rule sidecars unchanged from accepted authority |

Executed commands:

```bash
/usr/bin/python3 phase3b5b_opamp_supply_inspect.py
kicad-cli pcb drc --severity-all --all-track-errors --format json --output phase3b5b_opamp_supply_baseline_drc.json {BASE}.kicad_pcb
/usr/bin/python3 phase3b5b_opamp_supply_work.py
{r['candidate_drc_command']}
/usr/bin/python3 phase3b5b_opamp_supply_verify.py
/usr/bin/python3 phase3b5b_opamp_supply_visual.py
{r['final_drc_command']}
python3 phase3b5b_opamp_supply_finalize.py
```

The 548 baseline silk/library/text/edge violations and 105 unrelated missing pairs remain. No unrelated DRC cleanup was attempted. Production SHA-256 remains `{r['production_sha256']}`.

Produced the separate Candidate and verified Clean board, this report, final DRC and verification JSON, unchanged copied rule sidecars, and supporting scripts/logs/images. No clamp rail, U6001.1/C6007.1 integration, R3005.2, TP601.1 or GND was connected. No accepted AFE, analog, VCM, RLD_SAFE, reference, follower or Phase 3A routing was modified. Stopped after Phase 3B-5B.
'''
(D/'PHASE3B5B_OPAMP_SUPPLY_REPORT.md').write_text(report)
for n in [B+'.kicad_pcb','PHASE3B5B_OPAMP_SUPPLY_REPORT.md','phase3b5b_opamp_supply_drc.json','phase3b5b_opamp_supply_verification.json']:assert (D/n).stat().st_size>0
print('FINAL GATES PASS',r['final_sha256'])
