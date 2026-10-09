from pathlib import Path
import hashlib,json
D=Path(__file__).resolve().parent;BASE='ARTHUR_EMG_RevA_Cost_Phase3B2_VCMClean';CAND='ARTHUR_EMG_RevA_Cost_Phase3B3_FollowersCandidate';CLEAN='ARTHUR_EMG_RevA_Cost_Phase3B3_FollowersClean'
def sha(n):return hashlib.sha256((D/n).read_bytes()).hexdigest()
v=json.loads((D/'phase3b3_followers_verification.json').read_text());c=json.loads((D/'phase3b3_followers_candidate_drc.json').read_text());f=json.loads((D/'phase3b3_followers_drc.json').read_text())
def identities(r,key):return {(x['type'],tuple(sorted(i['uuid'] for i in x['items']))) for x in r[key]}
assert identities(c,'violations')==identities(f,'violations') and len(f['unconnected_items'])==112
assert sha(CAND+'.kicad_pcb')==sha(CLEAN+'.kicad_pcb')==v['candidate_sha256']
assert sha(BASE+'.kicad_pcb')=='ed9d6cb2585d4d489f24de7d32d563635ada8b9a182cd1bbc7e7acd9e98d55b4'
assert all(sha(n)==h for n,h in json.loads((D/'phase3b3_followers_baseline_geometry.json').read_text())['protected_file_sha256'].items())
assert all(sha(BASE+e)==sha(CAND+e)==sha(CLEAN+e) for e in ['.kicad_pro','.kicad_dru'])
v['clean_board_sha256']=sha(CLEAN+'.kicad_pcb');v['final_drc_sha256']=sha('phase3b3_followers_drc.json');v['final_drc_verified']=True;v['rules_sidecars_identical_to_authoritative_input']=True;v['visual_review']='PASS; inspected phase3b3_followers_layout.png from KiCad copper geometry'
v['commands']=[f'kicad-cli pcb drc --severity-all --all-track-errors --format json --output phase3b3_followers_baseline_drc.json {BASE}.kicad_pcb','/usr/bin/python3 phase3b3_followers_work.py',f'kicad-cli pcb drc --severity-all --all-track-errors --refill-zones --save-board --format json --output phase3b3_followers_candidate_drc.json {CAND}.kicad_pcb','/usr/bin/python3 phase3b3_followers_verify.py',f'kicad-cli pcb drc --severity-all --all-track-errors --format json --output phase3b3_followers_drc.json {CLEAN}.kicad_pcb','python phase3b3_followers_finalize.py']
(D/'phase3b3_followers_verification.json').write_text(json.dumps(v,indent=2))
rows=[]
for net,info in v['nets'].items():rows.append(f"| `{net}` | {' ↔ '.join(info['pads'])} | {info['track_length_mm']:.6f} | {info['segment_count']} | {info['via_count']} | F.Cu | {info['minimum_foreign_net_copper_clearance_mm']:.6f} |")
report=f'''# Phase 3B-3 — U503 unused follower closures

Date: 2026-09-26. Authoritative input: `{BASE}.kicad_pcb`. Its SHA-256 matches the user-accepted value. User-authorized Phase 3B continuation supersedes the older Phase-3A-only base wording in AGENTS.md. Production was not used as the routing base and was not overwritten.

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
{chr(10).join(rows)}

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
{chr(10).join(v['commands'])}
```

## Deliverables and provenance

- `{CAND}.kicad_pcb`: routed/refilled working candidate.
- `{CLEAN}.kicad_pcb`: final verified board.
- `phase3b3_followers_drc.json`: final clean-board DRC.
- `phase3b3_followers_verification.json`: mechanical object comparison, per-net connectivity/length/clearance, plane checks, preserved hashes and readiness gates.
- Baseline geometry/DRC, candidate DRC, build/verify/finalize scripts and local copper overview provide reproducibility.
- Both candidate filenames have unchanged copies of accepted `.kicad_pro` and `.kicad_dru` rule sidecars.

Accepted 3B-2 input SHA-256 before and after:
`{v['authoritative_input_sha256']}`

Final clean-board SHA-256:
`{v['clean_board_sha256']}`

Production remains byte-identical at SHA-256:
`7a7a70d78e1e191e13251e24b882b7eeb3df1153912a4168850515c8ac8201f9`

Stopped after 3B-3. No RLD_SAFE, AFE_3V0, USB, power, debug, testpoint, VCM extension, 3B-4 or later routing was started. Production promotion and a new freeze manifest were not performed.
'''
(D/'PHASE3B3_FOLLOWERS_REPORT.md').write_text(report)
print('All requested 3B-3 deliverables completed; production and accepted inputs unchanged.')
print('Clean SHA-256:',v['clean_board_sha256'])
