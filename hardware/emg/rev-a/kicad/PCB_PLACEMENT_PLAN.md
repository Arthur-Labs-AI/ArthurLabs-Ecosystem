# ARTHUR EMG Rev A - PCB Placement Plan (Audit 3)

Board: 45 x 30 mm, 4-layer (F.Cu / In1.Cu / In2.Cu / B.Cu). Edge.Cuts rect (0,0)-(45,30).
Status: placement planning only. No routing. No copper zones. No Gerbers/BOM/CPL.

Canonical generator: `python3 pl_place.py` (see `PLACEMENT_GENERATOR.md`).
All coordinates live in `pl_rows_a.py` / `pl_rows_b.py` / `pl_place.py::EXTRA_ORDER`.
Never hand-edit the `.kicad_pcb`.

## 1. Footprint census (Audit 3, Phase A)

| Source | Count |
| --- | --- |
| Schematic netlist (sch export netlist) | 92 unique refs |
| Current `.kicad_pcb` | 106 instances, 0 duplicates |
| `pl_rows_a.py` + `pl_rows_b.py` | 106 unique refs |
| `pl_place.py::EXTRA_ORDER` | 14 (subset of the 106, bench coordinates) |

Reference-by-reference diff (schematic vs PCB/rows): the only delta is 14 refs
in PCB+rows absent from the schematic:

- CM101/CM102, CM201/CM202, CM301/CM302, CM401/CM402 - expected DNP 0603
  common-mode filter companions (bench grid east, B.Cu, dnp attr).
- D101/D201/D301/D401 - expected DNP SOT-23 TVS companions (same grid).
- C607B/C608B - expected 0603 0.1u companions (F.Cu, near ADC).

All 14 are expected DNP/helper footprints. Zero missing real components
(SCH-PCB empty), zero duplicates, zero obsolete artifacts.

Resolved: the earlier 116 number exists in no measurement. The compaction
summary line "106 unique refs + 14 EXTRA = 120 instances" was a double-count -
the 14 EXTRA refs are already inside the 106 rows refs (schematic-zone coords
there; canonical bench positions from EXTRA_ORDER). Correct: 92 + 14 = 106.

## 2. Input network geometry (Audit 3, Phase B - chosen)

Per-channel input network (symmetric CH1-CH4): electrode JST -> R_SER pair
(2.2k 0603, rot90) -> C_DIFF (4.7nF 0603, rot0) -> ADS1294; R_BIAS 390k
(rot90) to VCM flanks each channel.

Chosen R_SER row (uniform, narrowed pairs, y=22.0):

| Ref | x | y | rot | Pair center |
| --- | --- | --- | --- | --- |
| R101 / R102 (CH1) | 3.5 / 5.5 | 22.0 | 90 | 4.5 = C101 x |
| R201 / R202 (CH2) | 11.5 / 13.5 | 22.0 | 90 | 12.5 = C201 x |
| R301 / R302 (CH3) | 19.5 / 21.5 | 22.0 | 90 | 20.5 = C301 x |
| R401 / R402 (CH4) | 27.5 / 29.5 | 22.0 | 90 | 28.5 = C401 x |

C_DIFF row unchanged at y=21.2 (pair centers). R_BIAS unchanged at y=20.4.
ADC decoupling (C6003/C6004/C6007/C6008) untouched. Electrode->R_SER ~7 mm;
R_SER->C_DIFF ~0.9 mm centers; pair pitch 2.0 with 0.54 courtyard gap.

## 3. Variants compared (in-project kicad-cli pcb drc evidence)

Baseline: y=22.6 narrowed row, 776 total, 13 R_SER shorting/clearance.

- Variant A (R_SER toward electrode edge): y=21.7 uniform migrates violations
  to the C_DIFF side (0.036 mm gaps); y=24.0 re-collides C6007/C6008 pads.
  REJECTED as a pure move.
- Variant B (rotate R_SER rot0): flat pairs at 2.0 pitch overlap courtyards
  by ~0.96; staggered-flat doubles zone height, breaks diff-path symmetry.
  Nestling C_DIFF rotated between the pair is viable on paper but unproven
  and changes two rows at once. DEFERRED to a visual follow-up.
- Variant C (move ADC decoupling): REJECTED. C6007/C6008 pin distances grow
  2.16/2.37 -> 3.31/3.45 mm at +1.5 y; northern free band blocked by the JST
  courtyard (south edge y=24.25). Decap-row shorts are independent of R_SER
  and must not be fixed by weakening decoupling. No decap moved.
- Variant D-hybrid (SELECTED): y=22.0 narrowed uniform. R_SER electrical
  13 -> 8 (all 4 CH2 clearances + R301-C6008 short fixed). Total 776 -> 772
  (shorting 48->47, clearance 27->23, mask 50->49). CH1/CH4 fully clear.
- Rejected stagger: CH2/CH3 at y=21.5 + CH1/CH4 at 22.0 scored 15 R_SER
  electrical (clips C_DIFF pads) and breaks symmetry. REVERTED.

Decision order: fewest real shorts (D wins 8 vs 13/15), courtyard collisions
adjudicated structural (section 4), decoupling preserved, symmetry preserved
(uniform row), short paths kept, no assembly impact (0603 rot90 unchanged).

## 4. Known residual (structural, not solved here)

Remaining 8 R_SER violations: CH2/CH3 north pads vs ADS1294 top-row pads
(TEST/3V0/GND at y=23.16) or C608B. Measured geometry (R 0603 world pads
0.95 x 0.8 at +/-0.825; ADC top pads at 0.5 pitch): no (x,y) for 0603 R_SER
pairs simultaneously clears the ADC top row north and the C_DIFF row
(y=21.2) south - the R-C stack needs ~1.9 mm center pitch, the slot holds
~0.8. R_SER<->C_DIFF and R_SER<->U6001 courtyard overlaps are likewise
structural for same-net adjacent 0603s (U6001 courtyard spans
7.85..21.15 / 10.85..24.15), adjudicated benign for placement.

Required follow-up (NOT done here): 0402 R_SER/C_DIFF or nestled rotated
C_DIFF, then re-run this audit. Do not move decoupling to chase the count.

## 5. Verification (this audit)

- `python3 pl_place.py --check` -> identical, exit 0. Regen twice -> cmp clean.
- Footprints 106, 45x30 outline, 4-layer, 8 R_SER coords as tabulated.
- Routes 0, vias 0, copper zones 0.
- DRC 776 -> 772 (R_SER electrical 13 -> 8).
- 16 copper-edge violations pre-date this audit (JST row y=29), unchanged;
  no new board-edge violations introduced.
- Top/bottom renders succeed; ADC/input area visually inspected.

## 6. Audit 4 - Input Network Package ECO (outcome)

Question: does a package-only change (same x/y centers, same nets) clear the
8 residual CH2/CH3 violations? Tested empirically through the deterministic
generator (all DRC in-project, same input: 1 argument(s) expected. 0 provided.
Usage: pcb drc [--help] [--output OUTPUT_FILE] [--define-var KEY=VALUE]... [--format FORMAT] [--all-track-errors] [--schematic-parity] [--units UNITS] [--severity-all] [--severity-error] [--severity-warning] [--severity-exclusions] [--exit-code-violations] [--refill-zones] [--save-board] INPUT_FILE

Runs the Design Rules Check (DRC) on the PCB and creates a report

Positional arguments:
  INPUT_FILE              Input file 

Optional arguments:
  -h, --help              Shows help message and exits 
  -o, --output            Output file [nargs=0..1] [default: ""]
  -D, --define-var        Overrides or adds project variables, can be used multiple times to declare multiple variables.
                          Use in the format of '--define-var key=value' or '-D key=value' [nargs=0..1] [default: {}] [may be repeated]
  --format                Output file format, options: json, report [nargs=0..1] [default: "report"]
  --all-track-errors      Report all errors for each track 
  --schematic-parity      Test for parity between PCB and schematic 
  --units                 Report units; valid options: in, mm, mils [nargs=0..1] [default: "mm"]
  --severity-all          Report all DRC violations, this is equivalent to including all the other severity arguments 
  --severity-error        Report all DRC error level violations, this can be combined with the other severity arguments 
  --severity-warning      Report all DRC warning level violations, this can be combined with the other severity arguments 
  --severity-exclusions   Report all excluded DRC violations, this can be combined with the other severity arguments 
  --exit-code-violations  Return a nonzero exit code if DRC violations exist 
  --refill-zones          Refill zones before running DRC 
  --save-board            Save the board after DRC, must be used with --refill-zones ).

Electrical pre-qualification (first principles + web sources):

- R_SER 2.2k 0402: worst-case 3.0 V across 2.2k = 4.1 mW vs standard 0402
  62.5 mW rating (15x margin); 3 V vs 50 V rating (16x); current 1.36 mA;
  Johnson noise identical (same R); thin-film 0402 has no excess-noise
  concern at these levels. Example family: Yageo RC0402FR-072K2L
  (62.5 mW, 50 V; LCSC C851843 family).
  Sources: https://datasheet.lcsc.com/lcsc/2207261800_YAGEO-RC0402FR-07510RP_C851843.pdf#1#1
  and https://www.yageo.com/upload/media/product/productsearch/datasheet/rchip/PYu-PA0100_2010_51_RoHS_1.pdf#3#2
- C_DIFF 4.7 nF C0G preserved in every variant (never X7R). 0402 C0G option
  exists (Murata GRM1555C1H472 50 V C0G);
  see https://www.tme.eu/en/details/grm1885c1h472ja01d/mlcc-smd-capacitors/murata/ .
- Assembly: JLCPCB supports 0402 R/C assembly (basic/extended parts);
  SMD spacing rules require ~0.2-0.3 mm gaps - the measured gaps below are
  judged against 0.2 mm.
  See https://jlcpcb.com/help/article/minimum-spacing-for-smd-components
  and https://www.schemalyzer.com/en/blog/manufacturing/jlcpcb/jlcpcb-assembly-guide .
  Stock availability explicitly NOT used for correctness (order-time check).
- Hand rework: 0402 needs fine tip + magnification; harder than 0603.
  Documented trade-off, not a blocker (primary path is JLCPCB assembly).

Authoritative geometry: official KiCad footprints
/ (kicad-footprint-generator,
IPC-7351 nominal) vendored into 
(3D model reference stripped; placement uses pads/silk/courtyard only).
Measured: 0402 pads (0.54 x 0.64 at +/-0.51); courtyard 1.86 x 0.94
(x-half 0.93, y-half 0.47); body 1.0 x 0.5. Generator gained a gated
local-library splice ( + net-tag injection) used
ONLY when rows name a footprint the reference lacks - current output is
byte-identical to the Audit-3 winner ( exit 0).

Variant results (baseline Audit-3 winner: 772 total, R_SER electrical 8):

- Variant 1 (R_SER 0603 -> 0402, same centers): 805 total; R_SER
  electrical 8 -> 18 (new R302-C608B and TP118 proximities; smaller pads
  but same x-driven ADC overlap). REJECTED.
- Variant 2 (C_DIFF rot90 nested at channel centers, R_SER 0603): 779
  total; related electrical 15 -> 20 (rotated C pads hit ADC side pads
  20/21 and U7001-GND). REJECTED, reverted.
- Variant 3 (0402 R_SER + rot90 C_DIFF combined): 802 total; related
  electrical 15 -> 21. REJECTED, reverted.
- Analytical proof: the R-C stack needs ~1.9 mm center pitch for 0.2 mm
  copper gaps; the slot holds ~0.8 mm at fixed x. No package keeps same-x
  rows: 0402 south pad still lands <=0.37 mm (centers) from C_DIFF pads
  while the north pad clears ADC, and vice versa. Package alone cannot fix
  an x-driven + pitch-driven collision.

Winner: KEEP the Audit-3 0603 geometry (R_SER y=22.0 narrowed, C_DIFF
rot0 y=21.2). No package change, no decoupling move. All ECO test edits
reverted; rows/PCB byte-identical to Audit-3 state (verified by 
and  against the pre-ECO snapshot; final DRC 772 exact-match, 0 fixed
/ 0 new vs Audit-3 close).

Courtyard accounting (proven numbers, not blanket benign):

- 0402 courtyard 1.86 x 0.94 vs 0603 1.46 x 2.96 (rot90): 0402 saves 1.01
  mm per side in y but the R-C pitch deficit (~1.1 mm) exceeds the saving.
- R_SER<->C_DIFF courtyard overlap is structural for same-channel 0603
  pairs (pair pitch 2.0 vs combined courtyard widths); copper gaps are the
  binding constraint and are reported exactly (8 residual, section 4).
- U6001 courtyard (7.85..21.15 / 10.85..24.15) envelops the whole input
  zone by design (TQFP-64 courtyard + placement tolerance); overlap with
  input passives carries no placement-tolerance risk beyond the copper
  clearances already counted. Placement tolerance assumed +/-0.05 mm
  (JLCPCB assembly); body-to-body nominal gaps: R_SER pair internals 0.54
  (courtyard) / larger copper; R_SER-to-C_DIFF copper per DRC exact deltas.
- KiCad courtyard conservatism: IPC-7351 nominal courtyards include
  assembly-tolerance + courtyard-excess margins beyond body + placement
  tolerance; with 0402/0603 bodies the excess is ~0.2-0.4 mm per side,
  which is why courtyard flags persist after copper clears. Treated as
  advisory for same-channel same-net pairs; copper short/clearance = binding.

Rework/manufacturing trade-off: no change shipped, so no new trade-off.
Had 0402 won, the cost would have been harder hand rework (fine tip +
magnification) for identical electrical performance and JLCPCB compatibility.

Remaining blockers (unchanged from section 4, plus ECO note): 8 R_SER
copper violations (CH2/CH3); the R-C rows need ~1.9 mm pitch the slot
cannot give at fixed x - next lever is x-nestling C_DIFF between R_SER
pads (paper-viable, DRC-worse as tested at center) or 0402 + southern
channel shift as a routed-layout study, NOT a same-center ECO. Decoupling
stays at its pins.

## 7. Audit 5 - Input Topology (BLOCKED for pure placement)

Analog rule applied: R_SER forms the RC anti-alias with C_DIFF at the ADC
inputs; the R-C-ADC loop must stay tight at the ADC (TI ADS129x EVM
practice). R_SER near the electrode connectors would lengthen the sensitive
high-Z node and is rejected on analog grounds before geometry.

Variant results (same DRC harness, related = R_SER/C_DIFF shorting+clearance):

- Variant A (R_SER upstream y=22.0 -> 24.5, symmetric): related 15 -> 17;
  north pads collide with the C6003/C6004/C6007/C6008 decap row. REJECTED +
  reverted. Upstream also violates the analog rule.
- Variant B (R_SER to bottom side): generator has no mirror path - emitted
  bottom instances keep F.Cu pads/silk at identical x/y, so DRC reads them
  as top-layer shorts (invalid test, 760 with unchanged electrics). A mirror
  helper exists (/) but wiring it in
  changes all existing bottom parts; a trial mirror raised total 772 -> 978
  (mirrored bottom pads vs top copper at shared x/y). Correct bottom-side
  needs x/y relocation off the top copper + double-sided assembly cost +
  via planning (no vias allowed this pass) + longer ADC loop. NOT implemented;
  evaluated honestly as cost-negative for this local conflict.
- Variant C (rigid ADC-cluster move/rotation): proven futile by construction
  - intra-cluster shorts translate with the cluster; north blocked by JST
  courtyard (south edge y=24.25), south by the power zone, rotation breaks
  CH symmetry and decoupling pin proximity. NOT placed.
- Extra topology probes: C_DIFF south to 20.2 (related 15 -> 14, C hits ADC
  east pads, reverted); C_DIFF to 20.0 all channels (15 -> 24, C hits
  R_BIAS/TP/ADC-east, reverted); x-spread/narrow of pairs (futile: ADC top
  pads at 0.5 pitch always within 0.25 in x; only y-separation works and the
  slot is 0.8 vs 1.9 needed). All reverted; rows pristine.

Exit criterion (0 real R_SER shorts + 0 real R_SER clearance) NOT met by any
pure-placement variant: BLOCKED.

Required architectural change (one of): (a) 0402 R_SER (or R_SER+C_DIFF)
COMBINED with x/y relocation off the top-copper collision columns (package
substitution was banned this pass, Audit 4 covered same-center only);
(b) bottom-side R_SER with true mirrored footprints at relocated x/y plus
accepted double-sided assembly + via plan; (c) input-network resectoring
(e.g. C_DIFF between R_SER pads in x with re-tuned values/positions) with
schematic-aware review. Decoupling stays at ADC pins in all options.

State: baseline restored byte-identical (rows pristine,  exit 0,
DRC 772, renders top+bottom succeed, 106 fp / 45x30 / 0 routes / 0 vias /
0 zones). No placement change shipped in Audit 5.

## 8. Audit 6 - Relocated 0402 R_SER Geometry (PASS)

Systematic DRC-scored grid search over 0402 R_SER x/y/rotation plus supporting
moves (R_BIAS row, C_DIFF, movable TPs, C608B EXTRA). Baseline Audit-5: 772
total, 8 true R_SER electrical violations.

Winner (all through canonical inputs, single-sided top assembly preserved):

- R_SER: 0402 (, 2.2k 1%) rot0 in a south lane:
  CH1 (3.5/5.5, 20.6), CH2 (11.5/13.3, 20.6), CH3 R301 (18.2, 20.6) +
  R302 (22.5, 20.0), CH4 unchanged 0603 rot90 @22.0 (was already clean).
- C_DIFF: C101 (4.5, 21.8), C201 (12.8, 21.5), C301 (21.0, 22.6), C401
  unchanged (28.5, 21.2). C0G/4.7 nF unchanged.
- R_BIAS row rot0 @19.3 (CH1/2/3) except CH4 unchanged; R304 (23.5, 19.0).
- TP111 (1.8, 21.5), TP112 (5.8, 18.8) relocated off the input corridor.
- C608B EXTRA stays (23.5, 21.7); decoupling untouched at ADC pins.

Quantified asymmetry (not hidden): CH2 R202 x=13.3 (-0.2 off pair center),
CH3 R301 x=18.2/R302 x=22.5 (split pair around ADC-east pads), CH3 C301
north-east (21.0, 22.6), CH4 keeps 0603 (clean zone, no ECO needed there).
R->C->ADC loops stay compact and ADC-side (electrode->R ~8-9 mm south-lane
routing, R->C <=1.5 mm, C->ADC <=2.5 mm worst CH3).

Verification:  exit 0; double regen byte-identical and installed
matches; DRC 772 -> 725 with R_SER-zone shorting+clearance 15 -> 0 and
shorts 0; 106 fp; 45x30; routes 0 / vias 0 / zones 0; top+bottom renders
succeed; ADC/input area visually inspected. Exit criterion met: 0 real
R_SER shorts and 0 real R_SER copper-clearance violations.

Rejected along the way (measured): north-lane 0402 (R-rel 10-12, ADC
shorts persist), south-lane same-x (rel 25-39, R_BIAS/TP collisions),
uniform recipe x4 (rel 22, CH3-east/C@21.4 asymmetry tax), C-south alone
(rel 14-24). Bottom-side and resectoring not needed.

## 9. Audit 7 - Global Cleanup + Placement Freeze (CONDITIONAL PASS)

Baseline Audit-6 PASS: 725 total. Freeze: 681 total (-44).
Generator:  exit 0; double regen byte-identical + installed matches.
106 fp; 45x30; 4-layer; routes 0 / vias 0 / zones 0; top+bottom renders succeed.

Moves shipped (all via canonical inputs): R5001 unstack (13.5,8.0)->(13.5,9.5)
fixes 4 RLD shorts; C4001 (14.0->15.0) + C4002 (13.0->12.0) fixes C4001-C4002
short; USB row R3002 (41.0->41.5, kept) + R3004 (42.5->43.0, kept off edge)
converts CC2/VBUS shorts to 0.05 clearances; R103 (2.3->1.9 rot90@20.4) +
R104 (6.7->7.1 rot90@20.4) + TP112 (3.4,19.8)->(6.3,21.1) clears CH1-west;
C608B (21.5->24.0,21.7) clears last input clearance; battery rect shrunk
x 43->40 off antenna keepout (placement object only).

Final DRC by class (A-I): A shorts 27 / B clearance 21 / C courtyard 75 /
D edge 16 (11 electrode-edge intentional + 5 J2001 incl. MP overhang) /
E mask 29 / F silk 424 / G unrouted-items 268 (expected, non-blocking) /
H lib 88 (stock libs absent on Linux + TP/0402 local mismatch, environment) /
I other: PTH-in-courtyard 2. Input-zone: 0 shorts / 0 clearance. U4001
intra-package 0.10 gaps adjudicated footprint artifact (DSK 0.5-pitch pads).

Judgment: input network PASS; support zones improved (net electrical down);
remaining 27 shorts are decap-row/power/USB/refcap pre-existing crowding
that routing-stage copper (and DNP/NC resolution) must absorb - documented
as routing blockers, not placement blockers. Edge: electrode connectors
intentional; J2001 MP overhang (pads to y=-1.45) is a documented mechanical
blocker (move north re-tested: trades for 7 copper shorts). RF: module
orientation kept, keepout by construction + battery rect exclusion; antenna
faces +X edge. Zoning: electrode->RC->ADC->buffers->module preserved;
switching power north-west of ADC; USB far east. Decoupling: ADC decaps at
pins (untouched); bulk power decaps distance-tolerant; C4004 position
flagged for routing review. Test: west TP column + bottom TPs + SWD J8001
accessible; battery region TBD vs enclosure (unresolved). Connectors:
USB/J2001/electrode/RLD mating directions verified by edge analysis. Mfg:
mixed 0402 (CH1-3 R_SER) / 0603 (CH4) intentional, recorded for BOM.

PLACEMENT FREEZE: CONDITIONAL PASS (input/support zones frozen; decap-row
and power/USB residual shorts transfer to routing stage with placement
positions frozen; J2001 MP overhang is the single mechanical blocker).

## 10. Audit 8 - Electrical Blocker Closure (CONDITIONAL PASS)

Full blocker table (27 shorts + 21 clearances with coords) built from fresh
DRC; every item classified. Audit-8 fixes (canonical inputs): R404 rot0
(30.5,21.5) + R5002 (33.0->34.0) clears VCM-USB pair; U4002 (29.2->28.4)
clears LDO-R3003; R5001 unstack kept; charger spread (C4001->15.0,
C4002->12.0, C4003->13.5,4.6) kept; USB stagger (R3002@41.5, R3004@43.0,9.2)
kept; G1 support shifts kept. J2001 stays (MP overhang documented below).

Final: 677 total (725->677). Input-zone 0/0. A shorts 22 / B clearance 22 /
C courtyard 76 (structural) / D edge 16 (11 intentional + 5 J2001-MP) /
E mask 25 / F silk 426 / G unrouted 268 / H lib 88 (environment) / PTH 2.

Remaining 22 shorts classified REAL pre-existing crowding (decap row 9,
charger 4, USB 2, refcap 3, NC-pad 3, R104-C6001 1): copper overlaps that
predate Audit 6 and cannot move without degrading decoupling, connector
mechanics, or schematic-aware resectoring. NC-pad overlaps involve
unconnected nets (routing-stage net-tie decision). No new placement-caused
shorts introduced (verified by exact A5-baseline diff per cluster).

J2001 verdict: MP pads (local y -1.75, size 1.6x3) at instance y=1.8 extend
to y=-1.45, off-board. Moving north proven to trade 5 edge violations for
7 copper shorts (tested y=2.8 and 3.3). Footprint is stock JST vertical
(board-edge type); MP overhang is a documented mechanical blocker requiring
enclosure/edge-cutout review at routing stage. All 5 J2001 edge violations
reclassified as documented-intentional pending that review.

PLACEMENT FREEZE: CONDITIONAL PASS (same conditions as Audit 7 + Audit-8
blocker table; input/support/USB-LDO/RLD zones frozen at zero new shorts).

## 11. Audit 9 - Final Electrical Closure (BLOCKED with exhausted placement scope)

44 residuals individually tabled with coords (S01-S22 shorts, C23-C44
clearances). Audit-9 fixes: C6006 (13.5,8.0)->(15.0,6.5) clears stacked-cap
pair (2 shorts -> 1 clearance); R404 rot0 (30.5,21.5) + R5002 (33.0->34.0)
clears VCM-USB pair; U4002 (29.2->28.4) clears LDO-R3003; USB stagger
(R3002@41.5, R3004@43.0,9.2) clears VBUS short; C4003-NE kept (J2001 fix,
cost 1 C4006 adjacency).

Final: 672 total (677->672). Input-zone 0/0. A shorts 20 / B clearance 23 /
C courtyard 75 / D edge 16 / E mask 23 / F silk 425 / H lib 88 / PTH 2.
Shorts 27->20 across Audits 8-9; every fixed item DRC-proven, zero new
placement shorts (exact-diff per cluster).

Remaining 20 shorts classification: decap row 8 (REAL pre-existing crowding
vs ADC pads; moving decaps degrades decoupling or hits JST band - proven by
spread/north/stagger probes), charger 4 (J2001 tall-pad wall; J2001 move
cascades - proven), refcap 2 + R104-C6001 1 (pre-existing VREF cluster),
NC-pad 3 (unconnected nets, routing-stage net-tie), C4006-C4003 1 (Audit-8
cascade cost of J2001 fix), C2002-TP601 + U2001-C2003 (charger-belt adjacency).
U4001 intra-package 0.10 gaps: FOOTPRINT_INTERNAL_FALSE_POSITIVE (DSK
0.5-pitch pads by construction). J3001-SH vs DNP grid (0.00): mechanical
shield pads vs test companions (INTENTIONAL_MECHANICAL_PAD). U7001 pad56
[<no net>] vs C7002: mechanical pad (INTENTIONAL_MECHANICAL_PAD).

J2001 verdict: VALID_EDGE_CONNECTOR_GEOMETRY. MP pads (local +-4.4,-1.75,
size 1.6x3) extend to y=-1.45 by stock-JST vertical design; side-entry mating
requires edge placement; north moves proven to cascade into 7 copper shorts.
Enclosure must allow the overhang (mechanical blocker, electrically valid).

PLACEMENT FREEZE: BLOCKED (20 pre-existing copper shorts remain; placement
scope exhausted - every movable cluster probed with DRC evidence; residuals
require routing-stage copper, package/footprint ECO, or schematic-aware
resectoring. Zero place-fixable shorts left unaddressed.)

## 12. Audit 10 - Pre-Routing Electrical ECO (BLOCKED with 3 remaining)

Shorts 20 -> 3 (total 672 -> 635). Input-zone 0/0 throughout. Package ECOs:
C6004 0805->0603 (schematic compliance), C6007/C6008 0805->0603 (1uF,
electrically equivalent) with cluster resectoring (C6003 15.5,25.0 +
C6004r90 18.6,25.0 + C6007 9.2,24.5 + C6008 20.8,24.5) fixing all 3 NC
shorts + 9 decap shorts (NC pins verified truly floating, stay isolated).
Placement: charger stack (C4001/C4002/U2001), TP601 micro-NE, all prior
wins retained. NC decision: NO net-ties (isolation required). Schematic
diff: NONE. ERC stable (51 pre-existing warnings).

Remaining 3 (all placement-exhausted with >=4 probes each): C4006-C4003
(cascade cost), R104-C6001 (hemmed), C6001-C6002 (pre-existing refcap).
J2001: VALID_EDGE_CONNECTOR_GEOMETRY (unchanged).

PRE-ROUTING ELECTRICAL ECO: BLOCKED (3 pre-existing/cascade shorts remain;
zero place-fixable shorts left unaddressed; transfer to routing/package ECO).

## 13. Audit 11 - Final Three Blockers (BLOCKED with 3 remaining)

Electrical roles reconstructed from schematic: C4003 10uF 0805 (TI typical
buck bulk), C4006 1uF 0603 (TPS7A20 minimum), R104 390k 0603 (R_BIAS),
C6001 10uF 0805 + C6002 0.1uF 0603 (parallel VREFP bulk+HF per Fig 106).
Package ECO ruled out: C4003/C6001 must stay 0805 (10uF), C4006/C6002/R104
already minimal. Only placement resectoring available.

Blocker 1 (C4006-C4003, dx=0.225/dy=0.5): N/S/E/W/micro probes all fail
(U4001 wall east, C4001 column south, J2001 wall west, C4005 north).
Charger-column deadlock proven with DRC evidence per direction.
Blockers 2-3 (R104/C6001/C6002 coupled): R104 all 6 positions fail (refcap
E/W, ADC N, rot0 variants); refcap spread walks into ADC-west pads;
parallel-cap stacking fails both axes (pad halves exceed pitch).
Net topology confirms C6001/C6002 parallel VREFP-GND pair (bulk+HF).

Final: 635 total (677->635 across Audit 10-11 effort span), 3 shorts,
input 0/0, ERC stable (51 pre-existing warnings), deterministic PASS,
renders succeed. The 3 remaining shorts each resisted >=4 DRC-evidenced
placement probes in all directions.

PRE-ROUTING ELECTRICAL ECO: BLOCKED (3 shorts require routing copper pours
to absorb, decoupling-package ECO with EE sign-off (C6001 10uF 0603 +
C4003 10uF 0603 derating review), or schematic-aware resectoring.)

## 14. Audit 12 - Board-Fit Architecture (ARCHITECTURE B SELECTED)

Phase 0: 21 clearances triaged - 4 mechanical (J3001-SH, U7001-p56),
7 footprint-internal (U4001 DSK), 10 REAL placement adjacencies.
Arch A (47x30): charger/refcap spreads work but C4006 hemmed top-side
(U4001/J2001/C4001/C4005 walls proven); outline growth alone cannot free
the charger column. REJECTED (area cost, no full closure).
Arch B (45x30 + bottom C4006/C6001/C6002): generator gained neutral
mirror_body_to_bottom(); bottom trio verified +3/-0 electrically.
C6001/C6002 sit under VREF pins (shorter loop); C4006 behind charger.
Closers: C4001e, R3002e, C6006s, C4002e, TP610s, TP601n, C6007w, C6002w.
Final: 617 total, 0 shorts, input 0/0. REAL clearances: 2 marginal
(C4002-pin3 0.175 / C4002-MP 0.198 vs 0.2 rule) - proven optimum by
x-sweep (west->short, east->short); DOCUMENTED_EDGE_GEOMETRY vs fixed
J2001. No hybrid needed.

ARCHITECTURE B SELECTED - SELECTIVE BOTTOM-SIDE SUPPORT
PRE-ROUTING ELECTRICAL ECO: PASS (0 shorts; 2 marginal edge clearances documented)
PLACEMENT FREEZE: PASS
READY FOR STACKUP + ROUTING-RULE FREEZE

## 15. Routing ECO 1 - U25/U26 Pocket Relief (R303 +0.30 mm east)

Pocket (geocheck copper extents, CW rotation): U-row north pads y[22.425,23.9]
(0.2 inter-pad gaps); R204 row y[18.825,19.775]; R303 column x[16.525,17.475]
y[19.175,21.625]. Binding gap R204pad2-east (15.925) / R303pad1-west (16.525):
0.60 < 0.70 (0.3 track + 2x0.2 clearance) - proven no-fit, blocking VCAP2 south
transit and VCAP1 feed margins.

ECO searched in generator sources only (no hand-edits): E2a (R204 -0.30 west)
TRIED then REVERTED (moved R204pad2 into GND south run + VCAP4 west-jog:
2 new shorts, guard-caught). E3 (R303 +0.30 east) ACCEPTED.

ECO: R303 (R_BIAS 390k, CH3_P/VCM) 17.00 -> 17.30 (+0.30 x, `pl_rows_a.py`).
Single component, deterministic (`pl_place.py` double regen byte-identical,
`--check` identical). Unrouted ECO board: 615 total (617 baseline -2),
0 shorts, 14 clearances, 73 courtyards, 269 unconnected. Input geometry
(R_SER/C_DIFF/JST/ADC), RF keepout, 45x30 outline unchanged.

Analog distances: rigid +0.30 east translation; CH3 stub to C301/R301 network
-0.27 (shorter); VCM tail to U62 +0.18. Negligible for 390k bias (<1 kHz).
Corridor relief: R204pad2-east/R303pad1-west 0.60 -> 0.90 (fits 0.3 + margins).

ROUTING ECO 1: PASS (placement relief proven, 0 shorts, deterministic).

## 16. Audit 14 - Critical Analog Pocket Re-layout + Constraint Freeze

Phase 1A (stackup): file `(general (thickness 1.6))` is the CAD envelope;
`setup.stackup` dielectric target 1.0 mm FR4 is the manufacturing target.
DECISION: Rev A orders standard JLCPCB-class 4-layer 1.6 mm (pro defaults,
1 oz outer / 0.5 oz inner assumed); 1.0 mm was an aspirational note, NOT the
order target. USB impedance geometry stays PROVISIONAL; USB routing forbidden.
PHYSICAL STACKUP: FROZEN (1.6 mm).

Phase 1B (antenna keepout): authoritative Raytac MDBT50Q-1MV2 Spec Ver.L
(raytac.com download index_id=43, section 2.3 p.11 + 2.2 p.9 figures):
No-Ground-Pad Area 10.5 mm x 3.8 mm at the antenna end, required in EACH
layer, plus 1.6 x 1.2 mm top-layer no-ground cutout; module at board edge.
KiCad stock footprint carries only silk/drawings keepout text (no rule_area).
Physical `rule_area` keepout objects on F.Cu/In1.Cu/In2.Cu/B.Cu: REQUIRED as
follow-up implementation before routing near RF (none in Pass-1 scope;
max route x = 19.7, keepout east x > 30). RF KEEPOUT: dimensions FROZEN +
documented; physical KiCad objects PENDING (no Pass-1 copper approaches).

Phase 2 (pocket map): exact copper/body extents tabulated in audit workspace
(`audit14/pocket_map.py`); CW rotation honored. Binding gap R204pad2-east
(15.925)/R303pad1-west (16.525) = 0.60 < 0.70.

Phases 4-7 (candidates, all granularity-legal, proven by regen+DRC):
- E-cluster (R203/R204 -0.5, R303 +0.5): REJECTED (3 shorts, R203 into U6001
  west column; court 74).
- C2 (E3 + C6003 -0.5 west): REJECTED (C6003pad1 into VREFP exit wall;
  1 short + 1 crossing, guard-caught).
- C3 (R303 +0.50): REJECTED (courtyard collision, court 74).
- C4 (C6003 -1.0 south): REJECTED (4 shorts into U-row).
- R303 rot0: REJECTED (1 short, court 75).
- WINNER: C1 = E3 solo (R303 +0.30 east, corridor 0.60 -> 0.90): 615 total,
  0 shorts, 73 courtyards, deterministic. R_BIAS 390k paths +/-0.3 mm negligible.

CRITICAL ANALOG FLOORPLAN: PASS (relief proven; corridor exploitation remains
follow-up: VCAP1-feed co-redesign blocked by unmoved R204).

## 17. Audit 15 - VCAP1 Feed Co-design + RF Keepout Implementation

Keepout: 4 rule_area zones (F.Cu/In1.Cu/In2.Cu/B.Cu), rect x[40.2,45.0]
y[9.75,20.25] (spec 10.5x3.8 each-layer no-ground, module U7001 at
(36.25,15.0,-90) antenna-east derivation), tracks/vias/copperpour banned,
footprints+pads allowed. Probe-verified (planted track+via flagged
items_not_allowed); zero flags on real copper. Text-inserted (pcbnew Save
rewrites header/nets - never use for edits). Regen drops zones by design
(re-apply post-regen); `--check` diff is copper-only otherwise.

Co-design grid (R204 x {14.2..14.95} x R303 x {17.0..17.8}, 16 combos,
0-short rows only): winner F1 = R204 -0.25 (14.45) + R303 +0.30 kept
(17.30): 614 total (best), 0 shorts, court 73, corridor gap 1.15.
Electrical: R_BIAS 390k rigid shifts (R204 CH2 stub +0.25?, VCM tails
shorten); input R_SER/C_DIFF untouched. Reroute of GND/VCAP1 into the
widened corridor failed guard (pocket ladder unmasking); reverted.
Kept: E3-solo placement (R303 +0.30) + p1v routing (0/0).

AUDIT 15 PLACEMENT: E3 stands (F1 corridor unusable without GND rework).
