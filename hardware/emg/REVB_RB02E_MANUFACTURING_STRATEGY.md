# RB-02E — Manufacturing Strategy (JLCPCB Economic PCBA)

Date: 2026-10-10. Companion to `REVB_RB02E_ECONOMIC_PCBA_AUDIT.md` (rules and sources) and
`REVB_RB02E_EDGE_CLEARANCE_REPORT.md` (per-part distances). Design-compatibility analysis only; no order, no Gerbers.

## 1. Process rails and panelisation (97 × 32 mm, unchanged)

| # | Question | Answer | Basis |
|---|---|---|---|
| 1 | Are process rails mandatory for this design? | **No.** The Economic capability table lists edge rails and fiducials as "not necessary". Nothing in the design triggers a rail requirement on the customer. | S7, S8 |
| 2 | Can JLC add rails automatically? | **Yes.** The assembly terms say tooling holes, rails and fiducials are required for the process, and that JLC adds or modifies them by default when the customer does not provide them. | S9 |
| 3 | Do rails change the final board dimensions? | **No functional change.** Rails belong to the panel, not the board. Boards are delivered either on the panel with mouse bites or as single PCBs routed out by JLC (tolerance ≈ 0.2 mm on the depanel route). The outline tolerance of the single-PCB option is not published as a number for Economic → UNKNOWN. | S10, S11, S13 |
| 4 | Would tabs interfere with connectors or nearby parts? | **UNKNOWN.** Tab/mouse-bite locations on Economic panels are not published. The parts nearest the outline are listed in the edge report: JST tails at 0.5 mm (south), J1 body at 0.8 mm (north), 0603 row copper at 1.975 mm. Mouse-bite stubs leave a small residue on the edge; the south edge also receives the XIAO USB-C overhang after hand assembly. | S28 |
| 5 | Does the placement require a special fixture? | **No published requirement.** Fixture fees are listed only for Standard rigid and flex boards. | S25 |
| 6 | Would panelisation or rail removal add cost? | Panel fee ($8.21) applies "when the number of panelised designs > 1": not applicable (one design). Price of the optional panel-removal service is **UNKNOWN** (not in the fee table). | S11, price page |
| 7 | Could any requirement make Economic unavailable? | Only the list in §2 below; none is present in the placed board. Residual: a library part that turns out to be Standard-only, or a manufacturing-side rejection citing the 2.5 mm note (S12). | §2 |

Permanent rails are **not** added. No evidence requires them.

## 2. Economic versus Standard eligibility

| Trigger for Standard | Present in Rev B? |
|---|---|
| Double-sided placement | No — 126 parts top only; B.Cu has bare pads, no paste |
| Layers other than 2/4/6 | No — 4 |
| Castellated holes / edge plating / gold fingers on the PCB | No |
| Thickness > 1.6 mm | No — 1.6 |
| Special stack-up | No (assumed JLC standard 4-layer) |
| IC pitch < 0.40 mm / package < 0402 | No — 0.65 mm, 0603 |
| Quantity > 50 | No — 2 |
| Part flagged "Standard only" | Not found: 3 known LCSC parts are "Economic and Standard"; the other ICs and passives have no LCSC number yet |
| Finish/colour not offered | Not found; 4-layer 1.6 mm green HASL/ENIG appears offered (layer mapping inferred) |

**STANDARD PCBA REQUIRED: NO** on the evidence available. It is **not yet determinable** for the parts without an LCSC number and
for the 2.5 mm note until JLC processes a real package.

## 3. Cost implications (documented figures only — a real JLC quote is required)

Fee schedule: https://jlcpcb.com/help/article/pcb-assembly-price (last updated Sep 09, 2026, "prices may vary with exchange rate").
Arithmetic below is **not** a quote; parts, bare-PCB fabrication, shipping and tax are excluded.

| Item (Economic) | Documented fee | Rev B quantity | Subtotal |
|---|---|---|---|
| Setup | $8.18 / order | 1 | $8.18 |
| Stencil | $1.53 | 1 | $1.53 |
| Extended-component fee | $3.07 per extended component (interpreted as per unique extended line; per-placement reading is UNKNOWN) | 7 known lines: ADS131M04, TLV9064, TPS7A2030, BAV199, SX3M oscillator, B2B-PH, S2B-PH | $21.49 |
| SMT assembly | $0.0016 / joint | 340 pads × 2 boards = 680 joints | $1.09 |
| Panel fee | $8.21, only if > 1 design | 0 | $0 |
| Packing | free (Economic) | — | $0 |
| Large-size fee | only > 650 cm² | 31 cm² | $0 |
| "Confirm parts placement" | $0.45 (listed; whether charged by default is UNKNOWN) | 1 | $0.45 |
| **Documented subtotal** | | | **$32.29 – $32.74** |

Unconfirmed items that can add cost:

* 21 generic value/package lines (0603 R/C values, 0805 R/C, ferrite bead) are expected to be JLC Basic but are not yet selected.
  Each one that is Extended adds $3.07 → up to +$64.47. Selecting Basic parts at the RB-03 BOM freeze is the main cost lever.
* For comparison, Standard PCBA lists a $25.56 single-side setup, $8.21 stencil and $1.53 feeder loading for **every** line
  (basic and extended) plus a handling-fee rule. With 7 + 21 = 28 lines and 680 joints the same arithmetic gives ≈ $77.7. So if
  many passives turned out Extended, Standard would not be dearer than Economic; with the 7 known extended lines it is not
  competitive. This is arithmetic on published fees, not a recommendation to switch.
* No fee in the schedule is triggered by: double-side, rails, panels (single design), large size, X-ray (no BGA/QFN; ADS131M04 is TSSOP).
* No charge is documented for the 8 bare test pads or the unpopulated plated hole; whether JLC's CAM flags the hole is a factory-acceptance question.
* Extra board area: none; 97 × 32 mm is the placed functional size and rails are not added.
* Unsupported component handling: not found; 3 of 12 package types verified at part-page level.

The two-unit prototype strategy is preserved by the design: no feature requires Standard, and the dominant avoidable cost
is the extended-line count, which is a BOM decision, not a layout decision.

## 4. Recommended strategy

1. **Keep the RB-02 placement.** No evidence of a manufacturing blocker; 0 parts below the Economic 0.3 mm note.
2. **Order as Economic, single side (top), 2 units, "Single PCB" delivery** (panel with mouse bites only if the quote shows it is cheaper).
   Let JLC add tooling/rails/fiducials (the default).
3. **At RB-03 BOM freeze:** pick JLC Basic parts for every generic passive; record LCSC numbers; confirm each part page says
   "Economic and Standard"; confirm 260 °C-class reflow ratings against the fixed 255 ± 5 °C Economic profile.
4. **Factory acceptance, not before RB-05:** upload the real Gerber/BOM/CPL package to JLC's quote/DFM check selecting Economic.
   Specifically look for (a) a citation of the 2.5 mm body-to-edge note, (b) the mouse-bite positions against the south connector
   tails / USB-C side and J1, (c) CPL rotation of X1, J1, U4002, BAV199.
5. **If JLC cites 2.5 mm:** first apply the 0.10–0.12 mm north-row nudge (25 parts); then decide on R5003/R7106/east strip; J1 and
   J5001 need a deliberate layout change and must be reviewed by the owner (see edge report §5). Do not pre-empt this.
6. **BOM/CPL generation rules for RB-05:** export CPL with DNP excluded (`kicad-cli pcb export pos --exclude-dnp`, 126 rows,
   no U1); drop DNP and exclude-from-BOM lines from the JLC BOM; the 8 TP pads are already excluded.
7. **Do not** request THT/wave service, double-side assembly, castellated edges, or special stack-up.

## 5. All unresolved uncertainties

| # | Item | Resolved by |
|---|---|---|
| U1 | Is 2.5 mm body-to-edge enforced for Economic? (37 parts) | JLC DFM/quote check at RB-05 |
| U2 | Mouse-bite/tab positions and depanel residue vs south connectors / USB-C / J1 | same |
| U3 | Outline tolerance of Economic single-PCB delivery | JLC quote notes / capability confirmation |
| U4 | Price of panel removal | real quote |
| U5 | Extended-fee basis (per unique line vs per placement) and "confirm placement" default | real quote |
| U6 | Economic eligibility and LCSC numbers for ICs and generic passives | RB-03 BOM freeze |
| U7 | Reflow 255 ± 5 °C vs each part's rating | RB-03 datasheet check |
| U8 | Economic 4-layer finish/thickness row mapping | order form at RB-05 |
| U9 | CPL rotation/origin of X1, J1, SOT-23 parts | JLC 2D viewer at RB-05 |
| U10 | No published Economic part-height or connector-height limit | JLC support if a quote flags it |

## 6. Final gate

```
JLC ECONOMIC PCBA COMPATIBILITY:  CONDITIONAL
PCB DIMENSIONS:                   97 × 32 mm
PCB LAYERS:                       4
FACTORY SMT ASSEMBLY SIDES:       1
BOTTOM-SIDE FACTORY COMPONENTS:   0
XIAO DNP:                         PASS
MANUAL BAT+ POST:                 COMPATIBLE
EDGE COMPONENTS CHECKED:          35 / 35 (RB-02 list); 44 / 44 total within 3 mm
EDGE CLEARANCE FAILURES:          0
EDGE CLEARANCE UNKNOWNS:          37 (33 on the RB-02 list)
PROCESS RAILS:                    NOT REQUIRED (JLC adds tooling by default)
RAILS CHANGE FUNCTIONAL BOARD:    NO
SPECIAL FIXTURE REQUIRED:         NO (none published for Economic)
ECONOMIC PCBA RESTRICTIONS:       single-side placement; 2/4/6 layers; <=1.6 mm; standard stack-up;
                                  no castellation/edge plating; >=0.4 mm IC pitch; 0402+; 2-50 pcs;
                                  255 +/-5 C fixed reflow; limited finish/colour
EXPECTED ADDITIONAL COSTS:        documented subtotal ~$32.3-32.7 (setup, stencil, 7 extended lines, SMT joints);
                                  +$3.07 per additional Extended line; panel-removal price UNKNOWN; real quote required
STANDARD PCBA REQUIRED:           NO (not yet determinable for parts without LCSC numbers and for the 2.5 mm note)
PLACEMENT CHANGES REQUIRED:       NO
SCHEMATIC UNCHANGED:              YES
ROUTING STARTED:                  NO
MANUFACTURING RELEASE:            NO
RB-02E DECISION:                  CONDITIONAL PASS
READY FOR RB-03 ROUTING:          YES
BLOCKERS:                         none for routing; open items U1-U10 are factory-acceptance items for RB-05
```
