import pathlib,json,hashlib,collections
D=pathlib.Path(__file__).resolve().parent;BASE='ARTHUR_EMG_RevA_Cost_Phase3B5E_VCMExceptionClean';A='ARTHUR_EMG_RevA_Cost_Phase3B5A_U503SupplyCandidate';B='ARTHUR_EMG_RevA_Cost_Phase3B5A_U503SupplyClean'
def sha(n):return hashlib.sha256((D/n).read_bytes()).hexdigest()
r=json.loads((D/'phase3b5a_u503_supply_verification.json').read_text());added=json.loads((D/'phase3b5a_u503_supply_added.json').read_text())
for ext in ['.kicad_pcb','.kicad_pro','.kicad_dru']:assert sha(A+ext)==sha(B+ext)
for ext in ['.kicad_pro','.kicad_dru']:assert sha(B+ext)==sha(BASE+ext)
x=json.loads((D/'phase3b5a_u503_supply_candidate_drc.json').read_text());y=json.loads((D/'phase3b5a_u503_supply_drc.json').read_text())
def ident(z):return {(v['type'],tuple(sorted(i['uuid'] for i in v['items']))) for v in z['violations']}
assert ident(x)==ident(y) and len(y['violations'])==548 and len(y['unconnected_items'])==108
snap=json.loads((D/'phase3b5a_u503_supply_baseline_geometry.json').read_text());assert all(sha(n)==h for n,h in snap['protected_file_sha256'].items())
assert sha(BASE+'.kicad_pcb')=='38c89f12dec3ad741a90148dd5a72faacc2613daf31cc721dbdca1e9dd2cefa5'
r.update(final_artifact=B+'.kicad_pcb',final_sha256=sha(B+'.kicad_pcb'),candidate_and_clean_byte_identical=True,rule_sidecars_identical_to_authority=True,final_drc_matches_refilled_candidate=True,final_drc_sha256=sha('phase3b5a_u503_supply_drc.json'),visual_review='PASS: actual local and authority copper images inspected; yellow added supply, purple frozen VCM, pink reference, green GND; dotted B.Cu projection overlaps are separated by internal GND layers',candidate_drc_command='kicad-cli pcb drc --severity-all --all-track-errors --refill-zones --save-board --format json --output phase3b5a_u503_supply_candidate_drc.json '+A+'.kicad_pcb',final_drc_command='kicad-cli pcb drc --severity-all --all-track-errors --format json --output phase3b5a_u503_supply_drc.json '+B+'.kicad_pcb')
metrics={}
for role in ['authority attachment','U503.4 escape','U503 local branch','short neck between frozen VCM vias','C503 shared via attachment','R5003 branch']:
 xs=[v for v in added if v.get('role')==role];metrics[role]={'length_mm':sum(v['length_mm'] for v in xs),'segments':len(xs),'widths_mm':sorted({v['width_mm'] for v in xs}),'layers':sorted({v['layer'] for v in xs}),'minimum_clearance_mm':min(r['per_object_clearance'][v['uuid']]['minimum_foreign_track_via_pad_clearance_mm'] for v in xs)}
r['branch_metrics']=metrics
r['new_via_antipads_only_fill_delta_verified']=False # Fill topology/connectivity verified; no claim of exact polygon-difference localization.
(D/'phase3b5a_u503_supply_verification.json').write_text(json.dumps(r,indent=2)+'\n')
rows='\n'.join('| '+role+' | '+f"{v['length_mm']:.6f}"+' | '+str(v['segments'])+' | '+', '.join(map(str,v['widths_mm']))+' | '+', '.join(v['layers'])+' | '+f"{v['minimum_clearance_mm']:.6f}"+' |' for role,v in metrics.items())
checks=r['structural_comparison'];count=lambda tag:checks[tag]['before']
samples=sum(v['samples'] for v in r['ground_reference_samples'].values());hits=sum(v['gnd_hits'] for v in r['ground_reference_samples'].values());newholes=sum(v['intentional_new_supply_via_antipad_samples'] for v in r['ground_reference_samples'].values());oldvoid=sum(v['pre_existing_gnd_void_samples'] for v in r['ground_reference_samples'].values())
report=f'''# Phase 3B-5A — U503 local AFE_3V0 supply

READY TO FREEZE 3B-5A: YES. Scope is the three requested U503/reference supply pads only; this is not full-board manufacturing completion.

Authoritative input: `{BASE}.kicad_pcb`  
Accepted input SHA-256, unchanged: `{r['input_sha256']}`  
Final board: `{B}.kicad_pcb`  
Final SHA-256: `{r['final_sha256']}`

## Result

```text
U503.4 CONNECTED: YES
C503.2 CONNECTED: YES
R5003.2 CONNECTED: YES

TRACK LENGTH: {r['track_length_mm']:.6f} mm (new copper only)
SEGMENT COUNT: 22
VIA COUNT: 3
WIDTHS: 0.40 mm; one 1.40 mm-long 0.30 mm neck
LAYERS: F.Cu / B.Cu; ordinary through-vias span the standard four layers
MINIMUM CLEARANCE: {r['minimum_foreign_track_via_pad_clearance_mm']:.6f} mm to foreign tracks/vias/pads (requirement 0.20 mm)

UNCONNECTED PAIRS: 111 -> 108
AFE_3V0 CONNECTED GROUPS: 18 -> 15
AFE_3V0 MISSING PAIRS: 17 -> 14
ORDINARY DRC VIOLATIONS: 548 -> 548

NEW COPPER VIOLATIONS: 0
NEW CROSSINGS: 0
NEW SHORTS: 0
DANGLING TRACKS/VIAS: 0/0

3B-5E PRESERVED: YES
ALL EARLIER FROZEN PHASES PRESERVED: YES
In1 GND continuity: PASS
In2 GND continuity: PASS
isolated GND polygons: 0

READY TO FREEZE 3B-5A: YES
```

## Topology and width

Pre-edit KiCad connectivity established three singleton groups for U503.4, C503.2 and R5003.2. Main authority was {{U4002.5, C4006.1, C502.2}}. The resulting six-pad authority is exactly that group plus the three requested endpoints. Every other AFE_3V0 group and every other net's pad/zone connectivity remains unchanged. The exact expected reduction was three missing pairs, independently confirmed by groups and final DRC.

The new authority attachment leaves the existing C502.2 pad without splitting or replacing original copper. It passes through the available F.Cu corridor, changes to B.Cu at (32.40,21.90), then approaches C503 from below the frozen channel/VCM distribution. A shared ordinary via at (53.00,22.20) feeds C503.2 and the U503 local branch. The main authority attachment is 41.597264 mm; frozen digital/analog barriers prevent a direct straight feed in this geometry. A tested F.Cu-only authority feed required approximately 60.43 mm, so two ordinary transitions give a substantially shorter practical feed. No global-shortest-path or exhaustive minimum-via proof is claimed.

The accepted U503.4 escape is now actual copper: (45.65,20.50) → (46.90,20.50), 0.40 mm F.Cu, followed by the authorized 0.55/0.30 mm standard through-via. Its F.Cu clearance is 0.24 mm; its via-to-foreign-copper clearance is 0.25 mm. The branch reaches the shared C503 via on B.Cu. C503.2 has a 0.675352 mm F.Cu landing, and R5003.2 has a separate 3.50 mm F.Cu branch around the right side of C503.1, at x=54.30 mm. No GND pad was routed or newly connected.

Only the 1.40 mm neck from (49.30,20.50) to (50.70,20.50) uses 0.30 mm width. The frozen VCM vias at (50.00,19.85) and (50.00,21.15), diameter 0.55 mm, leave a 0.75 mm copper-edge gap. A 0.40 mm trace plus two 0.20 mm clearances needs 0.80 mm and cannot fit. The 0.30 mm neck retains 0.225 mm clearance to each via; all other added segments remain 0.40 mm. The 0.30 mm width also matches existing frozen LDO-side AFE_3V0 routing. No maximum-load, IR-drop or transient simulation is claimed for this routing increment.

| Added routing portion | Length mm | Segments | Width mm | Layers | Minimum foreign copper clearance mm |
|---|---:|---:|---|---|---:|
{rows}

All three new vias are ordinary through-vias, diameter 0.55 mm, drill 0.30 mm, annulus 0.125 mm. Exact shape checks exclude via-in-pad for every via. Hole clearance and hole-to-hole clearance meet the original rules. For the U503.4 via, drill-to-foreign copper is 0.375 mm and drill-to-existing-hole is 2.75 mm. Actual refilled DRC confirms no clearance, annulus, drill or frozen-copper collision errors. The unchanged internal zones enforce 0.50 mm local zone clearance around foreign vias; this is separate from the 0.20 mm AFE track/pad clearance requirement.

## Ground reference and its local limitation

In1 and In2 each remain one filled GND polygon with zero islands. Every original GND pad retains its original connected group and zone access. Only derived candidate fills were regenerated; original internal copper and zone definitions are unchanged.

Adjacent-plane centerline sampling at ≤0.01 mm spacing produced {samples} samples: {hits} on GND, {newholes} within new supply-via antipad envelopes, and {oldvoid} over a pre-existing GND void. There are zero unexplained missing samples. New-via classification uses a nominal 0.775 mm antipad radius plus 0.0251 mm allowance for polygon approximation; raw GND hit counts are retained in the verification JSON. Every authority-feed sample outside its new via antipads has adjacent GND. The feed was adjusted after initial plane inspection to avoid pre-existing antipads.

The B.Cu local U503 neck crosses approximately 1 mm of the pre-existing merged GND void around the two frozen VCM vias. These points were explicitly confirmed absent from the accepted baseline GND fill, not treated as GND-covered. Both internal layers have that existing void. Uninterrupted local plane reference therefore has this documented limitation, while overall In1/In2 plane continuity passes. Avoiding that opening would require a different routing topology with more layer transitions; no frozen geometry was changed to improve it. Standard via antipads are also intentional local reference gaps.

Visual inspection used `phase3b5a_u503_supply_local.png` and `phase3b5a_u503_supply_authority.png`, rendered from actual KiCad copper. Yellow is added supply; purple is frozen VCM; pink is reference; green is GND. Dotted B.Cu projections beneath F.Cu pads/traces do not represent same-layer crossings; two internal GND layers separate the outer layers.

## Executed gates

| Gate | Result | Evidence |
|---|---|---|
| Accepted base and earlier artifacts | PASS | Accepted SHA matches; protected files and all seven Phase 3A manifest hashes match |
| Exactly three target groups integrated | PASS | KiCad connectivity: authority now six pads; AFE groups 18 → 15; all unrelated groups unchanged |
| Candidate refill and DRC | PASS | Real KiCad with all four requested flags; 548 ordinary / 108 unconnected; ordinary violation identities unchanged |
| Final clean DRC | PASS | Independent read-only run; same identities and counters |
| Escape, vias and clearances | PASS | Actual KiCad shape measurements and full DRC; minimum {r['minimum_foreign_track_via_pad_clearance_mm']:.6f} mm; all vias outside pads |
| Frozen-object preservation | PASS | Parsed PCB-object comparison: all {count('segment')} original segments, {count('via')} original vias and {count('footprint')} footprints unchanged; exactly 22 segments / 3 vias added, AFE_3V0 only |
| Prior phases, VCM exception and AFE authority | PASS | All original objects retained, including the three accepted 3B-5E UUIDs; all 14 Phase 3A vias retained |
| Placement, outline, RF keepout, zones and settings | PASS | Mechanical comparison, excluding regenerated fill polygons from zone-definition comparison |
| Internal GND topology | PASS | One polygon / zero islands per layer; original GND connectivity unchanged |
| Adjacent GND reference | PASS with documented local limitation | Every missing sample classified explicitly; pre-existing VCM antipad void described above |
| Visual review | PASS | Actual local and authority geometry inspected |
| Final artifact provenance | PASS | Clean byte-identical to refilled candidate; original project/rule sidecars copied unchanged |

Readiness is limited to this routing increment under the stated preferences and frozen geometry. The 548 ordinary baseline violations and 108 other missing pairs remain; no unrelated cleanup was attempted.

Executed commands:

```bash
/usr/bin/python3 phase3b5a_u503_supply_inspect.py
kicad-cli pcb drc --severity-all --all-track-errors --format json --output phase3b5a_u503_supply_baseline_drc.json {BASE}.kicad_pcb
/usr/bin/python3 phase3b5a_u503_supply_plane_aware.py
/usr/bin/python3 phase3b5a_u503_supply_work.py
{r['candidate_drc_command']}
/usr/bin/python3 phase3b5a_u503_supply_verify.py
/usr/bin/python3 phase3b5a_u503_supply_visual.py
{r['final_drc_command']}
python3 phase3b5a_u503_supply_finalize.py
```

No HDI, microvia, blind/buried via, via-in-pad, special stackup or new fabrication process was introduced. Standard cost-first four-layer fabrication is retained; the approximately 20–25 EUR assembled-board target was not requoted.

Deliverables include the separate Candidate and Clean boards, this report, final DRC and verification JSON, unchanged rule sidecars, and reproducibility scripts/logs/geometry images. Production was not overwritten. R3005.2, TP601.1, U501.4, U502.4, C501.2, clamp rails and U6001.1/C6007.1 integration remain untouched. No GND, VCM, reference, follower, RLD_SAFE or later-phase routing was added. Stopped after 3B-5A.
'''
(D/'PHASE3B5A_U503_SUPPLY_REPORT.md').write_text(report);print(r['final_sha256'])
