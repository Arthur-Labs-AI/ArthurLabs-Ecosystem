# Phase 3B-2 — VCM branch completion

Date: 2026-09-26. Authoritative input: `ARTHUR_EMG_RevA_Cost_Phase3B1_ReferenceClean.kicad_pcb`. Only VCM copper was added. Production was not overwritten, and the Phase 3A production board was not used as the routing base. User-authorized 3B-1 authority supersedes the older continuation-base wording in AGENTS.md.

```text
R5002.1 CONNECTED: YES
U503.5 CONNECTED: YES
U503.10 CONNECTED: YES
U503.12 CONNECTED: YES

VCM COMPLETE FOR PHASE 3B: YES
VCM CONNECTED GROUPS AFTER TASK: 1

NEW COPPER VIOLATIONS: 0
NEW CROSSINGS: 0
NEW SHORTS: 0
DANGLING TRACKS/VIAS: 0 / 0

Phase 1 original geometry modified: NO
Phase 2 modified: NO
Phase 3A modified: NO
Phase 3B-1 modified: NO
pre-existing VCM geometry modified: NO
AFE_3V0 modified: NO
placement modified: NO
board outline modified: NO
RF keepout modified: NO
zone definitions modified: NO

Phase 3B-1 preserved: YES
Phase 3A preserved: YES

In1 GND continuity: PASS
In2 GND continuity: PASS
isolated GND polygons introduced: 0

READY TO FREEZE 3B-2: YES
```

## Added branches

Lengths are newly added track centerline lengths, including their portions within pads. Minimum clearance is the measured copper-edge separation to foreign-net copper across all common copper layers, including each branch's via.

| Endpoint | Attachment point / topology | Track length (mm) | Vias | Track layers | Minimum clearance (mm) |
|---|---|---:|---:|---|---:|
| U503.5 | Existing F.Cu U503.2 VCM pad; independent inside-body branch | 4.150000 | 0 | F.Cu | 0.300000 |
| U503.12 | Existing B.Cu vertical VCM segment at (45.65,19.85) | 5.700000 | 1 | B.Cu, F.Cu | 0.365000 |
| U503.10 | Existing B.Cu VCM trunk junction at (45.65,21.225) | 5.731066 | 1 | B.Cu, F.Cu | 0.365000 |
| R5002.1 | Existing B.Cu VCM trunk junction at (45.65,21.225); separate southeast branch | 4.821688 | 1 | B.Cu, F.Cu | 0.960000 |

Total: **20.402754 mm**, 11 new 0.15 mm track segments, **3 standard through-vias** (0.55 mm diameter, 0.30 mm drill). No pre-existing VCM track or via was split, moved, replaced or optimized. The original 17 VCM track segments and five VCM vias remain unchanged.

U503.5 uses a short zero-via inside-body F.Cu branch from the existing U503.2 pad. Its x=46.75 mm turn clears the intervening U503.3 reference and U503.4 supply pads. The two right-side op-amp inputs have separate lateral B.Cu attachments to the pre-existing vertical VCM authority, with short F.Cu landings from via centers (50.00,19.85) and (50.00,21.15) mm. R5002.1 has its own diagonal/downward B.Cu branch from the original trunk junction, then a short F.Cu landing from (47.00,24.40) mm. The four endpoints are not chained together; no shared new trunk was created.

Zero vias on every endpoint would require extended F.Cu detours or a shared new F.Cu distribution around intervening pins/reference copper. The three ordinary through-vias provide direct independent attachments while preserving the frozen copper. In particular R5002's B.Cu branch passes beneath the frozen F.Cu reference route with both internal GND layers between them; this projection overlap is not a same-layer crossing. All via annuli and drills lie outside component pads, checked against KiCad pad shapes. No via-in-pad, blind/buried via, microvia, special stackup or additional manufacturing process is used. This preserves the standard cost-oriented four-layer process; the assembled-board price was not requoted.

Minimum same-layer separation to the seven frozen clock/SPI/control nets is 2.775 mm. No extended parallel digital adjacency was added. The layout image uses orange for added VCM, purple for existing VCM, pink for frozen 3B-1 reference, green for GND, and dashed lines for B.Cu.

## Verification gates

| Gate | Result | Evidence |
|---|---|---|
| Accepted 3B-1 baseline | PASS | SHA matches accepted 3B-1 verification; executed baseline DRC: 548 ordinary violations / 119 unconnected pairs |
| All VCM endpoints | PASS | KiCad connected-pad components: five groups before, one group after; all 14 VCM pads in the same group |
| Non-VCM connectivity | PASS | Every other net's pad groups and connected zone identities are unchanged |
| Refilled candidate DRC delta | PASS | Zero new copper violation identities; no crossings, shorts, dangling tracks or vias |
| Structural preservation | PASS | All top-level original objects compared; all 441 existing segments, 134 existing vias and 138 footprints unchanged; only 11 VCM segments and 3 VCM vias added |
| Phase 3A | PASS | All 14 original Phase 3A vias preserved; all seven freeze-manifest file hashes match |
| Phase 3B-1 | PASS | All reference/GND copper unchanged; accepted input hash unchanged; connectivity unchanged |
| Zone definitions, RF keepout, outline, setup | PASS | Parsed definitions and non-copper geometry unchanged; generated fill polygons excluded from definition comparison |
| In1/In2 GND | PASS | Each retains one filled polygon and zero islands after refill; GND pad connectivity unchanged |
| Local GND reference | PASS | Sampled new track projections every ≤0.02 mm: all samples outside intentional VCM-via antipads lie on the adjacent GND plane |
| Via-in-pad exclusion | PASS | Exact KiCad annulus-to-pad shape collision check on every new via |
| Final clean artifact | PASS | Byte-identical to refilled candidate; independently reran DRC with identical copied project/rule sidecars |
| Visual copper review | PASS | Inspected `phase3b2_vcm_layout.png` generated from KiCad geometry |

The existing zones use 0.50 mm clearance. The new 0.55 mm signal vias therefore create ordinary 0.775 mm-radius GND antipads. The local-reference projection check excludes these required signal-via openings (plus 0.001 mm numerical tolerance), rather than claiming GND exists through the signal vias. They do not split either plane or introduce islands. F.Cu branches reference In1, and B.Cu branches reference In2. Derived fills were regenerated only in the separate candidate.

Final DRC: **548 ordinary violations, 115 unconnected pairs**. The four eliminated pairs are VCM's four isolated groups. All ordinary category totals match the executed 3B-1 baseline; the three existing copper-edge violation identities are unchanged. Baseline silk/library/text warnings and unrelated airwires were left untouched. This is 3B-2 readiness, not global manufacturing completion.

Executed commands (all exited 0; DRC exit 0 means a report was generated):

```bash
kicad-cli pcb drc --severity-all --all-track-errors --format json --output phase3b2_vcm_baseline_drc.json ARTHUR_EMG_RevA_Cost_Phase3B1_ReferenceClean.kicad_pcb
kicad-cli pcb drc --severity-all --all-track-errors --refill-zones --save-board --format json --output phase3b2_vcm_candidate_drc.json ARTHUR_EMG_RevA_Cost_Phase3B2_VCMCandidate.kicad_pcb
/usr/bin/python3 phase3b2_vcm_verify.py
kicad-cli pcb drc --severity-all --all-track-errors --format json --output phase3b2_vcm_drc.json ARTHUR_EMG_RevA_Cost_Phase3B2_VCMClean.kicad_pcb
python phase3b2_vcm_finalize.py
```

## Artifacts and hashes

- `ARTHUR_EMG_RevA_Cost_Phase3B2_VCMCandidate.kicad_pcb`: routed/refilled working candidate.
- `ARTHUR_EMG_RevA_Cost_Phase3B2_VCMClean.kicad_pcb`: final verified candidate.
- `phase3b2_vcm_drc.json`: final clean-board DRC.
- `phase3b2_vcm_verification.json`: structural, electrical, clearance and plane evidence, branch coordinates/UUIDs and gate results.
- `phase3b2_vcm_baseline_geometry.json`, baseline/candidate DRC reports, build/verify/finalize scripts, logs and the copper overview provide reproducibility.
- Both candidate filenames have copied, unchanged `.kicad_pro` and `.kicad_dru` sidecars for the existing board rules.

Accepted 3B-1 input SHA-256 before and after:
`5295afc4a4c899316713449917e2a8c3c54242ff632f37e0c90eaa1b62547d78`

Final candidate SHA-256:
`ed9d6cb2585d4d489f24de7d32d563635ada8b9a182cd1bbc7e7acd9e98d55b4`

Production SHA-256 remains:
`7a7a70d78e1e191e13251e24b882b7eeb3df1153912a4168850515c8ac8201f9`

Stopped after 3B-2. No U503 B/C/D feedback, RLD_SAFE, AFE_3V0, other net, global GND cleanup, production promotion or later phase was performed. Freeze readiness is reported; no new freeze manifest was written.
