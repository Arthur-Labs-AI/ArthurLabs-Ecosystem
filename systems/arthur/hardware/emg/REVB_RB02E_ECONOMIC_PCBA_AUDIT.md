# RB-02E — JLCPCB Economic PCBA Compatibility Audit

Date: 2026-10-10 (all JLCPCB pages read on this date; each page shows "Last updated Sep 09, 2026").
Board audited: `hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB/ARTHUR_EMG_RevB.kicad_pcb` (placement only, unchanged by RB-02E).
Nothing committed, no routing, no Gerbers, no order.

**Scope of the claim.** This is DESIGN COMPATIBILITY against published JLCPCB rules. It is not FACTORY ACCEPTANCE: JLCPCB's own
DFM/CAM check on an uploaded package is the only thing that confirms that, and that package does not exist yet.

## 1. Official requirements (source of truth)

Status key: **CAPABILITY** = published capability limit; **AS-WRITTEN** = stated as a requirement in JLC's terms; **RECOMMENDED** =
JLC says "recommend/suggest"; **UNKNOWN** = not established by the pages read.
Archived text of every page: `evidence/rb02e/jlc_sources/`.

| # | Topic | Rule (paraphrased) | Status | Official source |
|---|---|---|---|---|
| S1 | Layers | Economic: 2, 4 or 6 layers | CAPABILITY | https://jlcpcb.com/capabilities/pcb-assembly-capabilities |
| S2 | Size | Single PCB 10×10 … 470×500 mm; panel 10×10 … 250×250 mm | CAPABILITY | same |
| S3 | Sides | Economic: single-sided placement (SMT / through-hole). Double-sided placement is a Standard-PCBA feature | CAPABILITY | same |
| S4 | Thickness | Economic 0.8 … 1.6 mm | CAPABILITY | same |
| S5 | Stack-up | Standard stack-up only; special stack-up not supported | CAPABILITY | same |
| S6 | Castellated holes / gold fingers / edge plating | Not supported in Economic | CAPABILITY | same |
| S7 | Edge rails | "Not necessary" for Economic ("Necessary" for Standard) | CAPABILITY | same |
| S8 | Fiducials | "Not necessary" for Economic ("Necessary" for Standard) | CAPABILITY | same |
| S9 | Process edges/tooling holes when ordering | Tooling holes, edge rails and fiducials are required for assembly orders, but if the customer does not supply them JLC adds or modifies them by default | AS-WRITTEN (but JLC supplies them) | https://jlcpcb.com/help/article/Terms-and-Conditions-of-JLCPCB-Assembly-Service (§5 item 5) |
| S10 | Delivery format | Economic: single PCB or panel with mouse bites (no V-cut panel) | CAPABILITY | capabilities page |
| S11 | Shipped rails | Assembled boards are typically shipped with manufacturing rails attached; depanelisation before shipment is an optional "panel removal" service | CAPABILITY / price UNKNOWN | capabilities page FAQ |
| S12 | Body-to-edge | Distance between component bodies and the board edge "must" be ≥ 2.5 mm | AS-WRITTEN, applicability to Economic panels UNKNOWN | https://jlcpcb.com/help/article/Terms-and-Conditions-of-JLCPCB-Assembly-Service (§2 "Notes on DFM" item 3) |
| S13 | Economic edge note | Economic boards are routed out of a panel with ≈ 0.2 mm tolerance; JLC suggests traces and components stay > 0.3 mm from the board edge | RECOMMENDED | https://jlcpcb.com/help/article/pcb-assembly-faqs-part-2 (item 14) |
| S14 | Process edge width | 5 mm process edges, 2 mm tooling holes, 1 mm fiducials 3.85 mm from the panel edge are recommended; components near the edge of the board can collide with the conveyor guide rails | RECOMMENDED | https://jlcpcb.com/help/article/specifications-for-adding-process-edges-and-positioning-holes |
| S15 | Small boards / missing rails | For boards < 70×70 mm or without rails (Standard PCBA) JLC chooses a suitable method for the rail, e.g. mouse bites | AS-WRITTEN | T&C §5 item 14 |
| S16 | Footprint density | Footprints and component gaps must follow IPC-7351B medium or low density; high density not supported | AS-WRITTEN | T&C §2 items 1–2 |
| S17 | Component gaps | Published minimum spacing table (e.g. 0603–0603 / 0603–0805 0.25 mm; QFN 1 mm) | RECOMMENDED, not service-specific | https://jlcpcb.com/help/article/minimum-spacing-for-smd-components |
| S18 | Package / pitch | Economic: min package 0402, min IC pin spacing 0.40 mm, BGA 0.5 mm | CAPABILITY | capabilities page |
| S19 | Order volume | Economic 2 … 50 pcs | CAPABILITY | capabilities page |
| S20 | Finish / colour | Economic: limited options; 4-layer rows appear to be 1.6 mm green HASL or ENIG (the layer column is not present in the page markup, so this is inferred) | CAPABILITY, layer mapping UNKNOWN | capabilities page "PCB Specs for Economic PCB Assembly" |
| S21 | Reflow | Economic oven profile 255 ± 5 °C, not adjustable (Standard 240 ± 5 °C) | CAPABILITY | capabilities page |
| S22 | THT / mixed | THT and mixed SMD+THT supported in Economic and Standard; unused holes are protected from solder | CAPABILITY | capabilities page FAQ |
| S23 | Via in pad | Via-in-pad is accepted but JLC takes no responsibility for the consequences | AS-WRITTEN | T&C §5 item 6 |
| S24 | Per-part eligibility | Each library part page states "PCBA Type: Economic and Standard" or Standard only | CAPABILITY per part | https://jlcpcb.com/partdetail/C160352, /C295747, /C2901557 |
| S25 | Fixtures | Fixture fees are listed for Standard rigid PCBs and flex only; none are listed for Economic | CAPABILITY | https://jlcpcb.com/help/article/pcb-assembly-price |
| S26 | Orientation / polarity | The customer must check placement and polarity in JLC's 2D production file after upload; no machine-checkable orientation rule is published | UNKNOWN (process) | T&C §2 item 6 |
| S27 | Component height / connector body limits for Economic | Not published | UNKNOWN | — |
| S28 | Tab/mouse-bite positions on Economic boards, depanel residue | Not published | UNKNOWN | — |

Requirements that could force Standard PCBA (from S1–S6, S18–S21): double-sided placement, layers other than 2/4/6,
castellated or edge-plated holes, thickness > 1.6 mm, special stack-up, IC pitch < 0.40 mm, package < 0402, quantity
> 50, unavailable finish/colour combination, or a part whose library page lists Standard only.

## 2. Rev B against those rules

| Rule | Rev B | Result |
|---|---|---|
| S1 layers | 4 copper layers (In1/In2 planes) | PASS |
| S2 size | 97.00 × 32.00 mm single board, unchanged | PASS |
| S3 sides | 126 JLC-assembled parts, **all on F.Cu**; 0 on B.Cu | PASS |
| S4 thickness | model stack-up sums to 1.606 mm (nominal 1.6) | PASS (confirm "1.6" in order form) |
| S5 stack-up | JLC04161H-7628-style 4-layer, no impedance control, no special material | PASS (assumed standard) |
| S6 castellation/edge plating | none on the PCB (the XIAO castellations belong to the module). The only drilled hole is the Ø1.4 plated BAT+ post hole, 10 mm inside the board | PASS |
| S8/S9 rails/fiducials/tooling | none added; JLC adds by default | PASS |
| S12/S13 edge distances | see `REVB_RB02E_EDGE_CLEARANCE_REPORT.md`: 0 parts < 0.3 mm; 37 of 126 parts have body < 2.5 mm | CONDITIONAL / UNKNOWN |
| S16 density | 0603/0805 passives, TSSOP 0.65 mm, SOT-23, JST; courtyards do not overlap (RB-02 C07); min IC pitch 0.65 mm | PASS (IPC medium/low density assumed for KiCad standard libraries) |
| S18 package/pitch | smallest package 0603; finest pitch 0.65 mm | PASS |
| S19 quantity | 2 units | PASS |
| S21 reflow 255 °C | part ratings not yet confirmed (generic passives not frozen; ICs expected 260 °C class) | UNKNOWN until BOM freeze |
| S22 THT | 0 THT parts for JLC | PASS |
| S24 library eligibility | C160352 (B2B-PH), C295747 (S2B-PH), C2901557 (SX3M oscillator): "Economic and Standard". ADS131M04, TLV9064, TPS7A2030, BAV199 and the generic passives have no LCSC number in the frozen BOM yet | PASS for 3, UNKNOWN for the rest |
| S25 fixtures | none required by any published rule | PASS |

### 2.1 Specific audit questions

| Question | Finding |
|---|---|
| All JLC-assembled parts on top | YES: 126/126 on F.Cu |
| Any part needing bottom-side automated assembly | NO. B.Cu carries only TP1–TP8 bare pads and the U1 BAT+ post pad (Ø3.0, B.Mask only) |
| Paste on any bottom pad | NO pad has B.Paste |
| XIAO DNP and excluded from placement data | YES: U1 has `dnp`; `kicad-cli pcb export pos --exclude-dnp` yields 126 rows and no U1. U1's castellation pads have mask but no paste, so the stencil carries no U1 apertures |
| TPs not in BOM/CPL | YES: TP1–TP8 carry `exclude_from_pos_files exclude_from_bom` |
| BAT+ post manual after factory assembly | COMPATIBLE: the hole is plated, open, unpopulated; the AWG24 post is fitted with an iron after delivery. JLC wave/THT service is not requested, and a bare plated hole is not an Economic restriction |
| Hidden reflow during customer assembly | NO: the XIAO is hand-soldered (14 castellations + post). The module is not reflowed |
| THT from JLC | NONE (U1 is the only footprint with a through-hole pad and it is DNP) |
| Connector classification | J101–J401, J5001: JST B2B-PH-SM4-TB(LF)(SN), top-entry, SMT, LCSC C160352. J1: JST S2B-PH-SM4-TB(LF)(SN), side-entry, SMT, C295747. Both "SMT Assembly; Economic and Standard; MSL 1" |
| Unsupported Economic process | NONE found |

## 3. Assembly inventory (machine-readable: `evidence/rb02e/assembly_inventory.json|.csv`)

| Package | Side | Method | Qty | Refs |
|---|---|---|---|---|
| R_0603_1608Metric | top | SMT reflow | 52 | R101, R102, R103, R104, R105, R106, R107, R108, R201, R202, R203, R204, … (+40) |
| C_0603_1608Metric | top | SMT reflow | 42 | C101, C102, C103, C104, C105, C106, C107, C201, C202, C203, C204, C205, … (+30) |
| SOT-23 | top | SMT reflow | 17 | D101, D102, D103, D104, D201, D202, D203, D204, D301, D302, D303, D304, … (+5) |
| TestPoint_Pad_D1.5mm | bottom | bare copper pad | 8 | TP1, TP2, TP3, TP4, TP5, TP6, TP7, TP8 |
| JST_PH_B2B-PH-SM4-TB_1x02-1MP_P2.00mm_Vertical | top | SMT reflow | 5 | J101, J201, J301, J401, J5001 |
| TSSOP-14_4.4x5mm_P0.65mm | top | SMT reflow | 3 | U501, U502, U503 |
| C_0805_2012Metric | top | SMT reflow | 1 | C4007 |
| L_0603_1608Metric | top | SMT reflow | 1 | FB1 |
| JST_PH_S2B-PH-SM4-TB_1x02-1MP_P2.00mm_Horizontal | top | SMT reflow | 1 | J1 |
| R_0805_2012Metric | top | SMT reflow | 1 | R5002 |
| XIAO_ESP32S3_HANDSOLDER | top | DNP | 1 | U1 |
| SOT-23-5 | top | SMT reflow | 1 | U4002 |
| TSSOP-20_4.4x6.5mm_P0.65mm | top | SMT reflow | 1 | U6001 |
| OSC_SCTF_SX3M_SMD3225-4P | top | SMT reflow | 1 | X1 |

Columns in the CSV: ref, value, MPN, LCSC, JLC class, footprint, package, side, layer, pad types, attributes,
excluded-from-pos/BOM, dnp, assembly method, JLC-assembled, x, y, rotation. 135 footprints = 126 JLC SMT + 1 DNP module + 8 bare pads.

## 4. Feasibility notes

* Paste/stencil: single top stencil. SCTF oscillator has paste on all pads; passives/ICs use KiCad standard paste. The XIAO castellation pads and the TP pads have no paste, so no accidental deposits.
* Orientation: SOT-23 BAV199 clamps and the SOT-23-5 LDO have a polarity defined by the footprint; CPL rotation conventions differ per manufacturer and must be checked against JLC's 2D viewer after upload (S26). Known residual from RB-01R: X1 CPL rotation check.
* Heights: tallest JLC parts are J101–J401/J5001 (JST) and J1; no published Economic height limit (S27).
* The XIAO USB-C receptacle overhangs the south edge by 1.5 mm after hand assembly; this is the customer's module, not a factory part, but see tab/mouse-bite note S28 in the strategy report.

## 5. Unresolved uncertainties

1. Whether JLC enforces the 2.5 mm body-to-edge note (S12) on Economic boards that JLC panelises itself (S7, S13). 37 parts depend on this.
2. Mouse-bite/tab position and stub height on the Economic single-PCB delivery (S28) versus connector tails at 0.5 mm from the south edge and the module's USB-C overhang.
3. Layer-to-row mapping of the Economic finish/thickness table (S20).
4. LCSC numbers, Economic eligibility and 255 °C reflow ratings for the ICs and generic passives (RB-03 BOM freeze).
5. Whether the fee table's "Extended components" fee is charged per unique extended line or per placement (cost section of the strategy report).
6. CPL rotation/origin for X1 and the JST parts after upload.

## 6. Verdict

**JLC ECONOMIC PCBA COMPATIBILITY: CONDITIONAL.** Every hard capability limit passes and no Standard-only trigger is present. The
condition is S12: 37 top-side parts have bodies closer than 2.5 mm to the board edge, and JLC's published text does not say that
this note is waived for Economic. Their copper is ≥ 0.5 mm from the edge, so the Economic-specific note (S13) is met by all parts.
Placement is preserved. Reproduce with `bash hardware/emg/rev-b-xiao/tools/run_rb02e_checks.sh <outdir>`.
