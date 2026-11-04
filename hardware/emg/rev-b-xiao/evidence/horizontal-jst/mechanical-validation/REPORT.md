# Horizontal JST mechanical validation supplement - NOT RELEASED

2026-10-19, Europe/Sofia. Existing branch `codex/revb-horizontal-jst`, HEAD
`98cc84e07fe4cf2791a56baba2cde3e9bb599724`, with the existing uncommitted electrical
ECO preserved. This pass adds analysis, scripts and preview artifacts only.
It does not edit the canonical PCB, schematics, project, libraries, DRC rules,
BOM/CPL, fabrication outputs, or earlier reports.

## Decision

**The current five-connector placement is nominally compatible with separate,
north-facing PHR-2 plugs on the actual board. No PCB resize or component move
is justified by the checks performed here.** This is a nominal geometry result,
not a complete tolerance, plastic/contact mating, finger-access, force or
strain-relief qualification. Final enclosure/harness integration remains a
separate mechanical design task. Manufacturing approval remains blocked.

The user's clarification is authoritative: **61 x 52 mm was an earlier PCB
design target, not an enclosure dimension**. No fixed enclosure dimensions
are assumed. Edge.Cuts directly measures **51.30 x 64.95 mm**, with the existing
1 mm rounded corners, and is preserved byte-for-byte. The length increase
predates this ECO: `hardware/emg/REVB_RB03R_VIA_ELIMINATION.md:125` documents
moving the lower block 2.5 mm south for routing; lines 146-147 document
62.45 -> 64.95 mm. The horizontal JST ECO did not cause this growth.

The project concept in `hardware/emg/REVB_RB02H_COMPACT_FORM_FACTOR_SIGNOFF.md`,
section 2, puts electrode cables north/along the arm, USB south, and strap lugs
on the east/west sides. The user's current concept has an inner electrode
strap and an outer tightening strap. These support a north cable interface
as a concept; **there is no final enclosure CAD against which fit can pass**.

## Evidence and provenance levels

| Level | Meaning here | Examples |
|---|---|---|
| Manufacturer-published nominal/reference | Read directly from JST catalog drawings; not full manufacturing tolerance limits | Header/PHR-2 dimensions below; 9.6 mm mated reference |
| Board-measured | Extracted from this exact PCB and checked programmatically | Positions, lands, pad nets, outline, courtyard gaps |
| Derived nominal | Calculation combining published dimensions and footprint datums | Seated plug registration and 2.85 mm north overhang |
| Engineering proposal/illustration | Starting reservation for enclosure design; must be qualified | 7 mm travel, 0.5 mm clearance, plug Z, cable bends |
| UNVERIFIED | Missing controlled drawing, physical sample or final CAD | Locks/contact engagement, tolerances, handling forces, grip/tool access, strain relief |

Source register: `sources/provenance.json` (URLs, pages, authority and limitations).

Primary JST sources:

* Current [PH catalog](https://www.jst.com/wp-content/uploads/2025/06/ePH.pdf),
  the existing `../JST_PH_datasheet.pdf`: page 2 SMT land/mated drawings;
  page 3 PHR-2; page 4 S2B-PH-SM4-TB. Relevant pages are rendered in `sources/`.
* [Older PH catalog](https://www.jst.com/wp-content/uploads/2021/08/ePH-new.pdf),
  copied to `sources/JST_PH_2021_catalog.pdf`: page 3 explicitly labels
  reinforcement extension 1.6 and tail reference 2.6 mm.
* [JST controlled CAD/drawing request](https://www.jst-mfg.com/product/index.php?doc=2&filename=S2B-PH-SM4-TB.zip&series=199&type=10).
  It states email delivery since April 2025 and asks for company/contact data.
  It also says CAD is simplified and does not guarantee actual shape/specification.
* The PH handling-manual link requests CHM-1-105 / CHM-1-2201 through that same
  email workflow. Those controlled documents were not available in this task.

No manufacturer STEP was obtained or substituted. The 3D models below are
explicitly **catalog-sized bounds**, not accurate latch/cavity/contact models.
The older conservative images and report are preserved; this supplement
supersedes their rough seating and resistor-gap assumptions.

## Header and mating housing dimensions

| Parameter | Nominal mm | Source / qualification |
|---|---:|---|
| Header | S2B-PH-SM4-TB(LF)(SN) | Same target MPN on all five; PCB fields checked |
| Pin pitch | 2.00 | JST catalog / PCB lands |
| Header width | 7.90 | Current catalog p4, 2-circuit row |
| Main header depth, along insertion axis | 6.00 | Current p4 / older p3 side view |
| Header height above PCB | 5.50 | Current p4 |
| Tail extension | (2.60) | Reference dimension, not a tolerance bound |
| Rear reinforcement extension | 1.60 | Older p3; explains 7.60 mm full F.Fab extent |
| Housing | PHR-2 | JST mating PH family |
| Housing width | 5.80 | Current p3, 2-circuit row |
| Housing length along mating axis | 6.85 | Current p3; vertical in the unmated housing drawing, axial after 90-degree rotation |
| Housing thickness after rotation | 4.50 | Current p3 side view |
| Mated axial reference | (9.60) | Current p2 assembly side view; not a guaranteed maximum |
| Candidate standard contact | SPH-002T-P0.5S | Current p2; do not silently substitute low-insertion-force -P0.5L |

Signal lands on each PCB connector are 1.00 x 3.50 mm, at local X +/-1.00,
Y -2.85; MP lands 1.50 x 3.40 at X +/-3.35, Y +2.90. All were checked directly
on all five footprints. The catalog signal pattern specifies pitch 2 +/-0.05,
width >=1, length 3.4 +/-0.1 mm: the current 3.50 length is its upper nominal
limit. The target is the existing vendored KiCad horizontal footprint also
used by J1. Retention pads remain on their isolated MP nets, not electrode nets.
This is not a solder stencil or controlled footprint tolerance signoff.

## Per-connector actual board measurements

X increases east, Y increases south. The top/north edge is Y=0. Z=0 below refers
to the top PCB mounting plane. All five have a PCB rotation of 180 degrees;
local +Y entry maps to north / decreasing board Y. Signal pin 1 is east.

| Ref | Origin X,Y | Entry-face Y | Derived seated wire-exit Y | Copper-to-edge minimum | Nearest courtyard gap |
|---|---|---:|---:|---:|---|
| J401 | 6.85,5.15 | +0.75 | -2.85 | 0.55 | 0.12 to R401/R402 |
| J301 | 16.25,5.15 | +0.75 | -2.85 | 0.55 | 0.12 to R301/R302 |
| J201 | 25.65,5.15 | +0.75 | -2.85 | 0.55 | 0.12 to R201/R202 |
| J101 | 35.05,5.15 | +0.75 | -2.85 | 0.55 | 0.12 to R101/R102 |
| J5001 | 44.45,5.15 | +0.75 | -2.85 | 0.55 | 0.20 to J101; 0.27 to R5002 |

**Correction to earlier rough figures:** the actual channel resistor courtyard
north edge is Y=10.37, so 10.37 - 10.25 = **0.12 mm**, not 0.15. R5002's
courtyard north edge is Y=10.52, so 10.52 - 10.25 = **0.27 mm**, not 0.10.
Courtyard distances are polygon centreline distances, not plastic or solder
joint gaps. No original report/file was overwritten to hide these corrections.

For each adjacent connector pair (J401/J301, J301/J201, J201/J101, J101/J5001):

| Quantity | Nominal mm | Calculation |
|---|---:|---|
| Centre spacing | 9.40 | Actual board X difference |
| Header body-to-body lateral gap | 1.50 | 9.40 - 7.90 |
| Plug-to-plug lateral gap | 3.60 | 9.40 - 5.80 |
| Plug-to-neighbour header lateral gap | 2.55 | 9.40 - 5.80/2 - 7.90/2 |
| Minimum connector courtyard gap | 0.20 | Actual polygons |

The nominal plugs and proposed northward withdrawal sweeps do not overlap
neighbouring headers. 1,420 sampled adjacent-header checks (71 positions per
plug, 4 neighbours) and 630 conservative checks of swept XY bounds against
other front courtyard bounding boxes passed. The latter also rules out
nominal interference with the other placed components' courtyard projections.
**Own-header nesting is deliberately excluded** because plugs belong inside
that header; the catalog does not provide the detailed cavity/lock/contact
geometry needed to prove that motion. These are not physical mating tests or
worst-case tolerance proofs.

## Seated position, insertion and removal

The earlier full-housing-outside-the-opening illustration overestimated the
seated north protrusion. A nominal assembly reconstruction is more useful:

1. The main header rear wall at local Y=-1.60 and entry at +4.40 are 6.00 mm
   apart. At this footprint rotation they map to board Y=+6.75 and +0.75.
2. Register the catalog's (9.60) mated length to that rear wall: the wire end
   of the housing lies at **Y=6.75-9.60=-2.85 mm**.
3. The 6.85 mm housing spans **Y=-2.85..+4.00**. Its calculated axial overlap
   with the header is **3.25 mm**. This overlap is a derivation; it is **not** a
   JST minimum disengagement stroke or contact-wipe specification.
4. A **proposed 7.00 mm service translation** north puts the housing at
   **Y=-9.85..-3.00**. Its nearest tip then lies 3.75 mm beyond the entry face.
   This is a conservative design reservation pending actual parts/handling data.

The assumed plug lower face Z=0.50 and upper face Z=5.00 are illustrative
registration. The header's nominal 5.50 mm maximum height is catalog data.
A native KiCad 3D preview places these bounds at all five actual locations;
it does not prove keyed engagement, lock deflection or contact geometry.

**Insertion/removal access requirements for the enclosure task:**

* Prefer service with the lid open or provide a hatch that passes a complete
  housing and the chosen gripping tool. A cable-only hole cannot pass a PHR-2.
* Maintain a straight approach along -Y/+Y; do not require prying against the
  PCB or sideways tilting through neighbouring connectors.
* Grip the housing with qualified access; conductors are not an unplug handle.
  The 1.50 mm header and 3.60 mm housing gaps are not a finger-access approval.
  A top approach may work but the chosen hand/tool must be evaluated with all
  neighbouring plugs installed.
* If internal axial service is desired, reserve the proposed travel to Y=-9.85
  plus the chosen tool/assembly clearance. Opening the shell may supply this
  temporary service volume instead; it need not dictate overall case size.
* Clamp release or a validated service loop must allow plug movement without
  loading crimps. Simultaneous withdrawal shown in 3D is a space illustration,
  not a requirement for the assembly sequence.

## Interface reservations for separate enclosure CAD

These are local keepout/clearance proposals, **not an assumed fixed enclosure**.
Every margin needs a tolerance budget including header, housing, SMT placement,
PCB edge, shell process, latch movement, and cable assembly tolerances.

| Interface | Nominal location / proposed reservation |
|---|---|
| Header row (main bodies) | X=2.90..48.40, Y=+0.75..+6.75, Z up to 5.50; use full footprint/F.Fab/lands for mounting ears/tails |
| Seated plug row | X=3.95..47.35, Y=-2.85..+4.00; nominal plug Z=0.50..5.00 is an assumption |
| Full-row proposed 7 mm swept plug volume | X=3.95..47.35, Y=-9.85..+4.00; same assumed Z |
| Trial rigid-part clearance | 0.50 around catalog bounds; engineering starting value, not a qualified tolerance |
| Trial ceiling at header row | Z >=6.00 above PCB (5.50 + 0.50), before tool-access allowance |
| Seated plug inside a continuous north wall | Wall inner face Y <=-3.35 (-2.85 - 0.50), before wire/grommet allowance |
| Housing-sized individual service opening | Trial 6.80 wide x 5.50 high (=5.80/4.50 + 2x0.50), before tolerance, lock/tool and grommet design |
| Cable-only opening | Size to the real harness OD, jacket/heatshrink and grommet; cannot be derived from AWG alone |
| Other board interfaces | Keep USB south and J1/U.FL east-side access; support/insulate the board and existing skin-side exposed pads/post separately |

The X/Y reservations cover rectangular bounds, not a proposed final shell
shape. No lugs, screws, posts, sealing lips or clamp locations are approved.
The current PCB outline is an input to the mechanical designer, not a variable
being optimized to the older PCB target.

## Cable route and strain-relief requirements

An earlier user shortlist in the chat **Дебелина на кабела** included Adafruit
261 (five leads). The [supplier's current product page](https://www.adafruit.com/product/261)
specifies 100 mm, genuine JST PH and AWM 1007 26AWG wire. It does **not** provide
actual insulation OD, minimum bend radius, finished-bundle dimensions, or the
complete approved electrode-harness construction. Treat it as a candidate,
not a new approved harness BOM. The PH catalog's 0.8..1.5 mm contact-compatible
insulation range is not a measurement of that purchased lead.

Route each lead north from the plug, provide a straight section before any
bend, then transition toward the inner electrode strap through rounded,
protected exits. The outer tightening strap must transmit load to shell/lugs,
not through the wires, connector body, MP solder tabs, or PCB.

`02-side-and-bend-section` illustrates 5 mm of straight wire followed by a
90-degree turn down toward the strap. Its 1.50 mm OD and R=3,5,8 mm centreline
radii are **illustrative variables**, not manufacturer-qualified limits.
For these examples the northmost cable surface is respectively Y=-11.60,
-13.60,-16.60 mm. Formula: Y_min = -2.85 - straight_length - R - OD/2.
Add grommet and shell clearances separately. These drawings show why the
wire/strain-relief zone, not just the 2.85 mm seated overhang, can control
packaging. They do not require a particular enclosure size or bend direction.

The enclosure/harness task must supply:

* A shell-mounted, insulated clamp/saddle or grommet appropriate to the actual
  lead construction; preferably individually identified channels. A shared
  clamp needs a measured bundle model, not five squeezed plugs.
* A compliant slack/service section between strain relief and each housing.
  Ensure the clamp can be released for service if it otherwise blocks the
  proposed withdrawal. Bend away from crimp exits, connector ears and sharp
  printed edges. Do not prescribe clamping squeeze from conductor AWG.
* A load path: **inner strap/electrode lead -> strain relief -> shell**, with
  the **outer tightening strap -> shell/lugs** independently. Motion and snags
  must not become connector peel loads. The current board has no newly added
  strain-relief hardware or approved force rating.
* Harness identification and insulation: four bipolar pairs plus the single
  reference electrode; J5001 pin 1 remains NC. If a two-wire housing is used
  there, secure/insulate the unused conductor; do not repurpose it mechanically
  as an exposed termination or connect it to shield/GND.

## Verification gates and remaining work

| Gate | Result | Evidence / scope |
|---|---|---|
| Actual outline, five identities/lands/orientations, nominal clearance checks | PASS | `measurements.json`, `connector-clearances.csv`; 8 assertions |
| Nominal withdrawal vs adjacent header bounds | PASS | 1,420 checks; own-header nesting excluded |
| Swept housing vs other front courtyard bounds | PASS | 630 conservative XY comparisons |
| Checker fault-injection | PASS | `checker-mutations.json`, 4/4 bad width/rotation/part/outline cases rejected |
| Fresh native KiCad DRC / schematic parity | PASS within known warning | 0 errors, 0 unconnected, 0 parity; same single U1 footprint mismatch as electrical ECO, `drc.json` |
| Prior file/source/output preservation | PASS | `preservation-and-drc-check.json`; all recorded pre-existing design/evidence files retain hashes |
| 2D and 3D evidence generation/visual review | PASS | PNG/SVGs, native KiCad renders and preview copies; dimensions-based bounds only |
| Manufacturer tolerance and exact PHR-2/header mating geometry | UNVERIFIED | Obtain controlled drawings/CAD/handling requirements; catalog-only registration is provisional |
| Actual insertion/removal, grip, force and lifetime | UNVERIFIED | Physical sample test with all five neighbours installed and chosen service tool |
| Cable bend, flex life, clamping and strain relief | UNVERIFIED | Final harness sample, material/OD/radius, risk-derived loads/cycles, and test fixture needed |
| Final enclosure / inner-outer strap integration | UNVERIFIED / separate task | No final CAD; use this report as local interface input |
| Electrical body-contact safety/manufacturing approval | UNVERIFIED | Independent review required; existing NOT RELEASED warning stands |

Before manufacturing approval, obtain and record the following concrete results:

1. **Component/document control:** controlled S2B-PH-SM4-TB and PHR-2 drawings,
   tolerances and applicable PH handling data; confirm suffix/revision, contact
   and approved harness build. Recheck the source-to-footprint datum mapping,
   3.25 mm inferred overlap and assumed plug Z registration.
2. **Fit coupon / real board:** populate all five headers with final harnesses.
   Measure header dimensions, actual seated wire exit/height and full release
   travel. Check adjacent plugs in every service position. Insert fully without
   bottoming on a wall or trapped wire. Record pictures, dimensions and lot IDs.
3. **Service access:** with representative top/hatch geometry and neighbours
   connected, demonstrate housing grip, straight removal/reinsertion, channel
   identification and clamp release without prying or pulling conductors.
4. **Load and flex qualification:** define acceptance forces, directions and
   cycle counts from the actual strap/snags/use requirements and connector/wire
   data. On a non-body fixture apply those loads to the strain-relieved harness;
   inspect for housing/crimp slip, insulation cuts, joint/PCB damage and changes
   to continuity/contact resistance. None of these tests ran here; no numerical
   force, lifetime or fatigue claim is made.
5. **Enclosure integration:** create the real lid/base, standoffs/insulating
   partition, grommets/clamps and inner/outer strap load paths. Check measured
   maximum-tolerance assemblies and full motion in CAD and on a prototype.
   Preserve J1, USB, antenna/U.FL and protected skin-side clearances.
6. **Manufacturing and safety review:** confirm pick-and-place/nozzle/reflow and
   solder inspection access for this dense row, factory rotation/DFM, and the
   independent isolation/protective/charging-versus-wearing safety review.

**Changes required now:** none to the PCB have been established by this nominal
check. The required design work is enclosure/harness strain relief, access and
qualification above. If tests expose a true clearance failure, first adjust the
separate lid/hatch/cable route; any connector relocation would be a new reviewed
PCB ECO with rerouting and DRC. No rule relaxation is proposed.

No production readiness, safety certification or safe-to-wear claim is made.
The existing operating restriction against electrodes on the body while USB
is connected remains; no galvanic isolation is claimed.

## Artifacts and reproduction

* `01-mating-sweep-plan.svg/.png`: all five real footprint projections, pads,
  actual neighbouring F.Fab parts, nominal seated/removed housing positions.
* `02-side-and-bend-section.svg/.png`: seated/reference dimension derivation,
  proposed withdrawal and illustrative cable-bend sensitivity.
* `03-enclosure-interface.svg/.png`: actual outline dimensions and interface
  reservations; explicitly no fixed enclosure size.
* `04-seated-3d-labelled.svg/.png`, `05-withdrawn-3d-labelled.svg/.png`: labelled
  native KiCad renders; raw render PNGs are retained. Other component models
  are unavailable, so this is not a full populated-board 3D collision check.
* `previews/seated/` and `previews/withdrawn/`: portable preview-only boards plus
  relative `nominal-bounds.wrl` models; **NOT_BOARD_SOURCE_DO_NOT_FAB**.
  They are not manufacturing source and must not replace the canonical PCB.
* `previews/board-only.glb`: native KiCad board-body-only export for future
  reference. Outer copper/coating and components are omitted: its body Z
  extent is 1.5162 mm, not a new overall board thickness requirement. General
  board thickness remains nominal 1.60 mm; use the project stackup and actual
  manufacturing thickness/tolerance for the full mechanical stack.
* `measurements.json`: all dimensions, per-ref positions/lands, datum
  calculations, assumptions, checks and limitations; `sources/provenance.json`
  separates sources and design assumptions.

From repository root (all writes below are to new evidence/scratch locations):

```bash
python3 hardware/emg/rev-b-xiao/tools/horizontal_jst_mechanical.py \
  --pcb hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB/ARTHUR_EMG_RevB.kicad_pcb \
  --out /tmp/new-mechanical-evidence
kicad-cli pcb render --width 1800 --height 1250 --rotate '35,0,15' \
  --zoom 0.73 --background opaque -o /tmp/seated.png \
  /tmp/new-mechanical-evidence/previews/seated/NOT_BOARD_SOURCE_DO_NOT_FAB.kicad_pcb
```

For DRC, copy the complete project, including vendored libraries and library
tables, to scratch and run `kicad-cli pcb drc --format json --severity-all
--schematic-parity -o /tmp/drc.json /tmp/project/ARTHUR_EMG_RevB.kicad_pcb`.
Do not save/modify the canonical PCB merely to regenerate mechanical evidence.
