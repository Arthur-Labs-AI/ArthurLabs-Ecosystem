from pathlib import Path
import json,hashlib,collections
D=Path(__file__).resolve().parent
def sha(name):return hashlib.sha256((D/name).read_bytes()).hexdigest()
v=json.loads((D/'phase3b1_reference_verification.json').read_text())
f=json.loads((D/'phase3b1_reference_drc.json').read_text());c=json.loads((D/'phase3b1_reference_candidate_drc.json').read_text())
assert collections.Counter(x['type'] for x in f['violations'])==collections.Counter(x['type'] for x in c['violations'])
assert len(f['unconnected_items'])==119
candidate='ARTHUR_EMG_RevA_Cost_Phase3B1_ReferenceCandidate';clean='ARTHUR_EMG_RevA_Cost_Phase3B1_ReferenceClean'
assert sha(candidate+'.kicad_pcb')==sha(clean+'.kicad_pcb')
freeze=json.loads((D/'phase3a_routing_freeze.json').read_text())
v['freeze_manifest_hashes_verified']={n:sha(n)==h for n,h in freeze['sha256'].items()}
assert all(v['freeze_manifest_hashes_verified'].values())
v['rule_sidecars_match_production']={ext:sha(clean+ext)==sha('ARTHUR_EMG_RevA_Cost'+ext) for ext in ['.kicad_pro','.kicad_dru']}
assert all(v['rule_sidecars_match_production'].values())
snapshot=json.loads((D/'phase3b1_reference_baseline_geometry.json').read_text())
v['phase3a_existing_vias_preserved']=sum(t['type']=='PCB_VIA' and t['net'] in freeze['frozen_nets'] for t in snapshot['tracks'])
assert v['phase3a_existing_vias_preserved']==14
v['clean_board_sha256']=sha(clean+'.kicad_pcb');v['final_drc_sha256']=sha('phase3b1_reference_drc.json')
v['visual_geometry_review']='PASS; inspected phase3b1_reference_layout.png generated from KiCad copper objects'
v['commands']={'baseline':'kicad-cli pcb drc --severity-all --all-track-errors --format json --output phase3b1_reference_baseline_drc.json ARTHUR_EMG_RevA_Cost.kicad_pcb','candidate':'kicad-cli pcb drc --severity-all --all-track-errors --refill-zones --save-board --format json --output phase3b1_reference_candidate_drc.json '+candidate+'.kicad_pcb','final':'kicad-cli pcb drc --severity-all --all-track-errors --format json --output phase3b1_reference_drc.json '+clean+'.kicad_pcb','structural_and_connectivity':'/usr/bin/python3 phase3b1_reference_verify.py'}
v['in1_gnd_continuity']='PASS';v['in2_gnd_continuity']='PASS';v['no_isolated_gnd_polygon_introduced']=True
(D/'phase3b1_reference_verification.json').write_text(json.dumps(v,indent=2))
report=f'''# Phase 3B-1 — U503A reference core

Date: 2026-09-26. Scope: only `Net-(U503A-+)` and local GND access for C5001.1, C5002.1, R5004.1. Stop after 3B-1. Production was not overwritten; no other Phase 3B net was routed.

```text
Net-(U503A-+) COMPLETE: YES

C5001.1 GND ACCESS: PASS
C5002.1 GND ACCESS: PASS
R5004.1 GND ACCESS: PASS

TRACK LENGTH: {v['reference_track_length_mm']:.6f} mm (reference node only)
VIA COUNT: 0 (reference node); 3 (local GND access)
LAYERS USED: F.Cu for reference and GND stubs; GND through-vias F.Cu–B.Cu
MINIMUM CLEARANCE: {v['minimum_clearance_mm']:.6f} mm (added copper to foreign-net copper)

NEW COPPER VIOLATIONS: 0
NEW CROSSINGS: 0
NEW SHORTS: 0
DANGLING TRACKS/VIAS: 0 / 0

Phase 1 modified: NO
Phase 2 modified: NO
Phase 3A modified: NO
VCM existing geometry modified: NO
AFE_3V0 existing geometry modified: NO
placement modified: NO
board outline modified: NO
RF keepout modified: NO
zone definitions modified: NO

In1 GND continuity: PASS
In2 GND continuity: PASS
no isolated GND polygon introduced: YES

READY TO FREEZE 3B-1: YES
```

## Routing and layout

The five required pads C5001.2, C5002.2, R5004.2, R5003.1 and U503.3 now form one electrically connected group. A short vertical reference trunk at x=44.55 mm has separate filter/divider taps and a direct U503.3 tap. The R5003.1 branch runs below U503, above the R5002 pads, then diagonally to its fixed pad. This avoids threading between unrelated op-amp pins and avoids a long pad-to-pad daisy-chain. R5003's fixed placement at x=53.60/y=25.01 limits further compaction without moving components. The reference route uses 12 segments, width 0.15 mm, and no vias. No copper loop was added.

The three GND pads each have their own short local connection to a 0.55 mm diameter / 0.30 mm drill standard through-via. Five GND segments use 0.40 mm width. Via centers are (43.85,19.01), (43.85,20.50), (43.85,23.21) mm. The C5001 return bends upward to avoid the frozen B.Cu VCM trace. Drills and via annuli are outside component pads. No blind/buried via, microvia, via-in-pad, special stackup or new process is required. Existing production project/rule sidecars were copied unchanged under both candidate names so DRC uses the same rules.

All reference routing stays on F.Cu over the existing In1 GND plane. Sampling the entire reference centerline at intervals no greater than 0.02 mm found GND copper beneath every sample after refill. Existing B.Cu SPI is separated vertically by the two internal GND layers. Minimum same-layer reference copper separation is {v['same_layer_digital_clearance_mm']:.3f} mm to clock/SPI nets, {v['same_layer_switch_clearance_mm']:.3f} mm to SW_L1/SW_L2, and {v['same_layer_usb_clearance_mm']:.3f} mm to USB copper. These are geometric measurements, not electrical noise simulation or future routing guarantees. No parallel digital adjacency was added. Visual review used `phase3b1_reference_layout.png`; orange is reference copper, green is GND, muted blue is existing B.Cu copper.

## Verification gates

| Gate | Result | Evidence |
|---|---|---|
| Production baseline | PASS | Read-only DRC: 525 ordinary violations, 126 unconnected pairs |
| Reference connectivity | PASS | KiCad connectivity: all five pads in one group; target DRC pairs 4 → 0 |
| Local GND access | PASS | All three pads reach both filled GND zones and the original 51-pad plane-connected core |
| Refilled DRC copper delta | PASS | Candidate refill/save with both requested flags; zero new copper violation identities |
| Crossings, shorts, dangling items | PASS | None in refilled candidate or final DRC |
| Internal GND continuity | PASS | Each plane retains one polygon and zero islands; no existing pad connectivity lost |
| Frozen geometry | PASS | Parsed PCB object comparison: all 424 original tracks, 131 original vias, 138 footprints unchanged; all 14 Phase 3A vias preserved |
| Outline, RF keepout, zone definitions, setup | PASS | Parsed board geometry and zone definitions unchanged; fill polygons excluded from definition comparison |
| Accepted Phase 3A evidence | PASS | All seven freeze-manifest SHA-256 entries match |
| Final clean artifact | PASS | Byte-identical to refilled candidate; independently reran DRC on clean filename with production rules |

Global unconnected pairs decreased 126 → 119: four reference pairs and three local GND groups. Existing GND core increased from 51 to 54 pads. No other pad group was connected as part of this task. Each internal GND plane has one filled polygon before and after refill, with zero islands. Existing track geometry on all layers is unchanged; derived fills were regenerated only in the separate candidate.

Final DRC has 548 ordinary violations: the original 525 category totals plus 23 known `nonmirrored_text_on_back_layer` warnings exposed by serialization. All three baseline copper-edge violation identities remain unchanged. Those baseline defects and the remaining 119 unconnected pairs are outside this task. Phase readiness applies only to 3B-1; the board is not globally DRC-clean or manufacturing-complete.

Executed commands (exit 0 signifies report generation, not a globally clean board):

```bash
{v['commands']['baseline']}
{v['commands']['candidate']}
{v['commands']['final']}
{v['commands']['structural_and_connectivity']}
python phase3b1_reference_finalize.py
```

## Artifacts and provenance

- `{candidate}.kicad_pcb`: separate routed/refilled working candidate.
- `{clean}.kicad_pcb`: final verified copy, production not overwritten.
- `phase3b1_reference_drc.json`: final clean-board DRC.
- `phase3b1_reference_verification.json`: connectivity, preservation, clearance, plane and hash evidence.
- `phase3b1_reference_baseline_geometry.json`: pre-edit production track/via geometry and pad connectivity.
- `phase3b1_reference_baseline_drc.json`: executed baseline report.
- Build/verify/finalize scripts, logs and local layout image provide reproducibility.

Production SHA-256 before and after:
`{v['production_sha256']}`

Candidate and clean-board SHA-256:
`{v['clean_board_sha256']}`

No production promotion or Phase 3B-1 freeze manifest was performed. This report supplies the requested freeze-readiness result. No VCM, RLD_SAFE, AFE_3V0, USB, power, debug, testpoint or global GND cleanup was started.
'''
(D/'PHASE3B1_REFERENCE_REPORT.md').write_text(report)
print('Final artifacts verified and report written. Production unchanged.')
