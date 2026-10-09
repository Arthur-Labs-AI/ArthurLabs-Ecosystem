# Phase 3B-5E — Authorized minimal VCM exception

READY TO USE AS PHASE 3B-5 CONTINUATION BASE: YES

Authoritative input: `ARTHUR_EMG_RevA_Cost_Phase3B4_RLDClean.kicad_pcb`  
Input SHA-256: `14c41b66ab073d8f9e4891cd979d336f404ffbfefe862ff217cee983cd2b3f9a`  
Verified output: `ARTHUR_EMG_RevA_Cost_Phase3B5E_VCMExceptionClean.kicad_pcb`  
Output SHA-256: `38c89f12dec3ad741a90148dd5a72faacc2613daf31cc721dbdca1e9dd2cefa5`

## Applied exception

Removed exactly VCM segment `30a501c9-ab5c-4380-ba9f-44465f57214b`, from (46.75,19.20) to (46.75,21.15). Replaced it with exactly three F.Cu segments, width 0.15 mm:

(46.75,19.20) → (47.50,19.20) → (47.50,21.15) → (46.75,21.15).

Both original endpoints are identical. Old length: 1.95 mm; replacement length: 3.45 mm; length increase: 1.50 mm. Minimum foreign-net track/pad clearance of the replacement: 0.54624 mm. Added vias: 0. No AFE_3V0 copper or supply via was added. No other routing was performed.

## Executed verification

Real KiCad DRC ran on the separate candidate with `--severity-all --all-track-errors --refill-zones --save-board`. The Clean PCB is byte-identical to that saved candidate. A second read-only DRC on Clean produced the delivered `phase3b5e_vcm_exception_drc.json`.

Ordinary DRC violations: 548 → 548. Violation identities match the baseline. Unconnected pairs: 111 → 111. All pad-to-pad connectivity matches the accepted input; all 14 VCM pads remain one connected group. There are zero copper-clearance, crossing, shorting, dangling-track or dangling-via violations in the final DRC. Unrelated baseline violations remain.

Mechanical S-expression comparison proves exactly one original segment removed and three new segments added. All other original tracks, all original vias, footprints and placement, outline, RF keepout, settings, and zone definitions are identical. Phase 1, Phase 2, Phase 3A and its 14 vias, Phase 3B-1, Phase 3B-3, Phase 3B-4, pre-existing VCM, and AFE_3V0 copper are preserved. Phase 3B-2 changes only by the explicitly authorized segment replacement.

Both In1.Cu and In2.Cu GND fills are exactly identical after refill. Each retains one polygon and zero islands. Isolated GND polygons introduced: 0. Protected accepted boards and prior evidence retain their recorded hashes; production remains unchanged.

## U503.4 physical escape re-check

Using the refilled candidate, virtual geometry was tested without adding or saving it to the board:

- F.Cu AFE_3V0 escape: (45.65,20.50) → (46.90,20.50), width 0.40 mm, length 1.25 mm. Minimum foreign track/pad clearance: 0.24 mm.
- Standard through-via candidate: (46.90,20.50), diameter 0.55 mm, drill 0.30 mm. Minimum foreign track/pad clearance across copper layers: 0.25 mm.
- Via annulus overlaps no pad: PASS; no via-in-pad.
- Proposed drill-to-foreign copper clearance: 0.375 mm; drill-to-existing-hole clearance: 2.75 mm.

The local escape and standard via location are feasible. These are physical preflight checks, not completed supply routing. Existing adjacent internal GND reference remains intact; a future placed supply via would require ordinary GND antipad generation during that later task's refill and verification. This exception adds no holes and no fabrication-process complexity: standard four-layer manufacturing remains applicable.

## Final gate

```text
AUTHORIZED VCM EXCEPTION APPLIED: YES
OLD SEGMENT REMOVED: YES
REPLACEMENT PATH CONNECTED: YES
VCM CONNECTIVITY PRESERVED: YES

U503.4 0.40 mm ESCAPE NOW FEASIBLE: YES
STANDARD VIA LOCATION NOW FEASIBLE: YES

NEW COPPER VIOLATIONS: 0
NEW CROSSINGS: 0
NEW SHORTS: 0
DANGLING TRACKS/VIAS: 0/0

ALL NON-AUTHORIZED FROZEN GEOMETRY PRESERVED: YES
In1 GND continuity: PASS
In2 GND continuity: PASS

READY TO USE AS PHASE 3B-5 CONTINUATION BASE: YES
```

Stopped after Phase 3B-5E. AFE_3V0 distribution remains deferred.
