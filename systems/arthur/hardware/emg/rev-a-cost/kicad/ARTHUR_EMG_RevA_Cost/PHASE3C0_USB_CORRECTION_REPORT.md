# Phase 3C-0 — USB mechanical / mapping correction implementation

2026-09-27. **FAIL — stopped at the pre-refill DRC gate. No MechanicalClean checkpoint was created.** The authorized correction exists only in an isolated staging project. Production and Phase3B FinalClean remain unchanged at SHA-256 `d7a585e8ae46299215d26c0aa58ea0ca5829d46ce72a45d279290263e94a0005`. All 1076 captured pre-existing project files retain their hashes. No USB or shield routing and no Phase3D work occurred.

## Exact blocker

The complete official USB4105 land pattern violates the unchanged project **0.2500 mm hole-to-copper rule internally**. Its two restored Ø0.65 NPTH holes are only **0.1944 mm** from adjacent GND SMT lands. The shortfall is **0.0556 mm**. This is intrinsic connector geometry and independent of board placement, tab dimensions, frozen routing or zone refill.

| NPTH center mm | Adjacent J3001 pads | Pad centers mm | Actual / required clearance mm |
|---|---|---|---|
| (39.89,0.88) | A1 and B12, GND | (40.2,1.955) | 0.1944 /0.2500 |
| (34.11,0.88) | A12 and B1, GND | (33.8,1.955) | 0.1944 /0.2500 |

These are four new hole-clearance errors. The existing nineteen pads retain exact UUIDs and relative geometry; the restored objects exactly match the pinned official definition. The earlier virtual architecture screen checked connector objects against external obstacles but did not expose this connector-internal NPTH-to-signal-land rule conflict. Actual KiCad DRC now establishes the blocker. No rule exception, pad shrink, hole relocation or alternate footprint was applied.

Pre-refill DRC additionally reports six new hole-to-zone errors and four copper-to-zone errors from stale internal GND fills beneath the relocated/restored NPTH and independent shield pads. These are expected to require clearance refill, but refill was **not executed**: the independent intrinsic error already fails the user's mandatory STOP gate. USB_SHIELD is not assigned to GND, yet its front-row annuli physically overlap saved GND fills before refill. It must not be reported isolated/clean at this stop point.

Two planned resistor-reference labels also fail the **0.8 mm minimum text-height rule** because the accepted cosmetic plan specifies0.6 mm. Additional newly reported silk pairs are recorded separately in diagnostics. No cosmetic repair was attempted after the required gate failure. No changes outside scope were made.

## What was implemented and verified

Created `phase3c0_staging/` as a complete project copy, preserving relative sheet/library structure and all original copied files. A source-hash manifest was captured before copying/editing. The implementation candidate is `phase3c0_staging/ARTHUR_EMG_RevA_Cost_Phase3C0_Candidate.kicad_pcb`. Original files in the source project remain immutable.

- Exactly one S→SH pin-number token in staging ARTHUR.kicad_sym, one corresponding cached symbol token and one J3001 pin-instance token in staging usb_c_interlock.kicad_sch. All symbol/pin UUIDs, wiring, label and passive SHIELD geometry remain. Reversing the three targeted token changes reproduces source bytes. The existing malformed library structure was preserved, not repaired.
- Fresh staging ERC: **0 errors,120 warnings**, with the exact baseline warning identity multiset after project-path normalization. Fresh root XML netlist: sole semantic endpoint delta J3001.S→J3001.SH on USB_SHIELD; derived pinfunction changes SHIELD_S→SHIELD_SH. All other node/net assignments remain identical.
- Existing J3001 container UUID `4eac32d3-2cad-4b39-891f-a7c843e5ad27` preserved. All19 existing pad UUIDs and relative pad/drill geometry preserved. Added exactly fourthSH at(+4.32,+1.075), twoØ0.65 NPTH at(±2.89,−2.605), missing official texts/metadata/model reference. No broad footprint update or schematic relink. Final22 pads:16 signal,4SH on USB_SHIELD,2 unnumberedNPTH net0. All sixteen signal UUID/net assignments retained; no jumper declaration or shield copper added.
- Applied exactly J3001(37,−1.725),180°; U3001(35.6,4.85),90°; R3001(38.6,3.8),0°; R3002(40.6,3.8),0°, allF.Cu. Only their accepted reference/value cosmetics changed.
- Removed only Edge.Cuts rectangle UUID `09039bd1-628a-4c1b-825f-da3134a4fe05`; inserted the eight accepted0.10 mm lines. One closed, non-self-intersecting contour, degree2 at each vertex; no internal contour. Area1989.8 mm², bounding55×40.4, original rectangle retained plus12×5.4 top tab.
- Reopened candidate: **528 tracks and151 vias, zero changed/added/removed**, full parsed object equality. All134 non-USB footprint objects structurally identical. All six zone/RF definitions identical, including saved fill geometry at this pre-refill stop. No original association fields or project/rule definitions changed.
- Fresh rebuilt connectivity: D+4groups/3pairs, D−4/3, CC1 3/2, CC2 3/2, GND31/30, USB_SHIELD4/3. Total **95**, exactly92+3 shield deficit. Physical shield groups are counted by pad UUID, because all four pad numbers are identical. The historical16-pair routing target was not consumed.

## DRC evidence and normalization

Fresh baseline all-severity/all-track DRC: **525 ordinary /92 unconnected**. Correctly configured candidate pre-refill DRC: **562 ordinary /95 unconnected**.

| Category | Baseline | Candidate |
|---|---:|---:|
| copper_edge_clearance | 3 | 3 |
| clearance | 0 | 4 |
| hole_clearance | 0 | 10 |
| silk_overlap | 199 | 199 |
| silk_over_copper | 199 | 199 |
| lib_footprint_issues | 57 | 57 |
| lib_footprint_mismatch | 55 | 55 |
| silk_edge_clearance | 12 | 10 |
| text_height | 0 | 2 |
| nonmirrored_text_on_back_layer | 0 | 23 |

The23 serialized back-text warnings match the accepted Phase3B freeze verification identities exactly; they are recorded separately from introduced geometry failures. The three baseline copper-edge errors remain at identical unchanged offending pads/clearances; their Edge.Cuts UUID changed because the authorized rectangle was replaced by lines. Normalization maps that contour representation change to the same boundary identity. **New copper-edge errors:0.** Two old silk-edge items disappear with corrected USB geometry.

A strict UUID/category/description multiset diff additionally reports21 new/21 removed silk-overlap pairs and22 new/22 removed silk-over-copper pairs. Raw identities are retained in `phase3c0_usb_failure_diagnostics.json`. Several newly reported pairs involve unchanged unrelated objects; their source geometry is structurally equal, so a report identity difference alone is not proof of an introduced geometry defect. No unrelated object was altered to address them. The conclusive14 copper/hole errors and2 text-height warnings already fail the gate, regardless of ordinary totals or reporting differences.

An initial diagnostic DRC ran without candidate-name .kicad_pro/.kicad_dru sidecars and used default constraints, reporting768 ordinary items including199 false-context track-width errors. Its report is retained as `phase3c0_usb_candidate_initial_missing_sidecars_drc.json`, explicitly **not the qualification run**. Byte-identical copies of the accepted sidecars were then supplied under the candidate basename, and DRC was rerun. This corrected tool configuration only; no rule or PCB change was made between those runs. The required pre-refill evidence is the562-item run.

## Saved-candidate mechanical/process measurements

Actual accepted placements and mechanical centers remeasured from the saved candidate:

- PCB Edge marker endpoints(32,−5.4) and(42,−5.4); all sixteen signal pad centers y=1.955.
- FourSH centers(32.68,1.38),(41.32,1.38),(32.68,−2.8),(41.32,−2.8); NPTH centers(34.11,0.88),(39.89,0.88).
- Conservative USB4105 copper-to-actual-stepped-edge minimum **1.18 mm** and hole-to-edge **1.38 mm**, exceeding0.50/0.25 edge requirements. These are connector mounting minima, not whole-board minima; the three existing non-USB copper-edge violations remain.
- No new physical body/courtyard component interference for the four moved parts against fixed components or one another. The hole-to-adjacent-land errors are electrically/manufacturing distinct from body/courtyard collision.
- Four copper layers and four moved parts onF-side. Four ordinary plated oval shell slots, two ordinaryNPTH holes, zero added vias, all151 existing vias ordinarythrough. No HDI/microvia/blind/buried/newvia-in-pad construction introduced. This is a process-preservation statement, **not fabrication approval**, because the0.25 rule is violated. Historical frozen via/pad overlaps remain a later audit. Cost target20–25EUR is not a quote.

## Stop state and unexecuted gates

**Stopped after pre-refill DRC.** No zone refill or save after refill; no independent post-refill DRC; no new In1/In2 plane topology or GND-island/core proof. Those gates are UNVERIFIED rather than claimed passing. Existing saved connectivity still has31GND groups, but that is not a post-refill topology qualification. No MechanicalClean was created and no production promotion occurred.

The requested refilled/final DRC files were not fabricated: they do not exist because their runs were prohibited by the STOP gate. Required correction report and verification JSON bind the failed candidate and executed evidence instead. Resolving the intrinsic manufacturer-land-pattern/project-rule incompatibility needs a separately authorized decision; this task did not grant a rule exception or permission to alter official lands/holes. The failed candidate should not be used as a routing/freeze base.

## Final report

```text
SCHEMATIC S->SH: PASS
NETLIST EXACT DELTA: PASS

J3001 COMPLETE OFFICIAL GEOMETRY: PASS
J3001 PAD COUNT: 22
SH PADS ON USB_SHIELD: 4
NPTH ON NET0: 2

EDGE.CUTS TAB: PASS
BOARD AREA: 1989.8 mm²
BOARD BBOX: 55 x 40.4 mm

J3001 PLACEMENT: PASS
U3001 PLACEMENT: PASS
R3001 PLACEMENT: PASS
R3002 PLACEMENT: PASS

FROZEN TRACKS CHANGED: 0
FROZEN VIAS CHANGED: 0
NON-USB FOOTPRINTS CHANGED: 0

PRE-REFILL UNCONNECTED: 95
POST-REFILL UNCONNECTED: NOT RUN — STOP gate

USB_SHIELD GROUPS: 4
USB_SHIELD DEFICIT: 3
USB_SHIELD->GND CONTACT: YES — physical overlap with stale pre-refill GND fills; no GND net assignment

NEW COPPER VIOLATIONS: 4 — stale-fill clearances
NEW HOLE VIOLATIONS: 10 — 4 intrinsic pad/NPTH, 6 stale-fill
NEW EDGE VIOLATIONS: 0
NEW SHORTS: 0 reported
DANGLING TRACKS/VIAS: 0/0 reported

In1 GND: UNVERIFIED after refill (not run)
In2 GND: UNVERIFIED after refill (not run)
GND ISLANDS: UNVERIFIED after refill

MIN COPPER-EDGE: 1.18 mm — USB4105 mounting
MIN HOLE-EDGE: 1.38 mm — USB4105 mounting

STANDARD FOUR-LAYER PROCESS PRESERVED: YES — construction only, not manufacturing release

PHASE 3C-0 READY TO FREEZE: NO
PHASE 3C ROUTING STARTED: NO
PHASE 3D STARTED: NO
```
