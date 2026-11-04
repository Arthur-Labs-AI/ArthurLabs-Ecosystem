# A.R.T.H.U.R EMG Rev B (R1b) — ODB++ package for European PCB/PCBA quotations

Generated 2026-10-13 from the frozen canonical KiCad 10.0.6 PCB (`ARTHUR_EMG_RevB.kicad_pcb`, sha256 `7fda8d9c6fa568d703dfdf91c5fbd35bc0b9001164543d38d661ca0690ae75a9`) with the native exporter
(`kicad-cli pcb export odb --compression zip --units mm --precision 6`). **For quotation and manufacturability review only — not a production order, no production authorization and no
electrical-safety certification is implied.** Independent of the JLCPCB Gerber release (verified equivalent, `verification/odb_verification.json`, 29/29 checks).

| File | Content | SHA-256 |
|---|---|---|
| `ARTHUR_EMG_RevB_R1b_ODB++.zip` | ODB++ v8.1 job tree, units mm, 6-decimals, job name `job` (KiCad default) | `646b826a673767f4caf1013e9e154b4d72df1900097c045c84594ee4cbb9c139` |
| `companion/ARTHUR_EMG_RevB_R1b_RELEASE_BOM.csv` | byte copy of the audited BOM (29 lines, 126 designators; MPN is part of the "Comment" column, LCSC column is JLC-specific) | `ac2d234318184a4ed69228982aec58050bd4d2bb5bb4b3bddd6fdb9a7a9fac6c` |
| `companion/ARTHUR_EMG_RevB_R1b_RELEASE_CPL.csv` | byte copy of the audited placement list (126 rows, Top; community rotation offsets applied — see note 5) | `25cc5c409678bbb30a507cd4de650295625d35f588ed11179d53f1c20e9ff653` |

## Board

| Item | Value |
|---|---|
| Layers / thickness | 4 copper, 1.6 mm (stack-up JLC04161H-7628: 35 µm / 0.2104 / 15 µm / 1.065 core / 15 µm / 0.2104 / 35 µm; masks 10 µm) — ODB matrix lists the layers, thickness is design data |
| Outline | **51.30 × 64.95 mm**, 1 mm corner radius, origin top-left (ODB y negative) |
| Drill | **201 × Ø0.30 mm** plated vias (tented, no mask apertures) + **1 × Ø1.90 mm plated component hole**; no NPTH, no slots, no castellations |
| Finish / copper | not carried in ODB++: ENIG intended (HASL-with-lead in the KiCad metadata is superseded); 1 oz outer, 0.5 oz inner; green mask, white silkscreen |
| Via covering | all 201 vias tented both sides; there is no mask aperture on any via |

## BAT+ plated component hole — U1 pad 23 (X 44.635 mm, Y 54.790 mm; ODB Y −54.790)

**OPEN — NOT TENTED, PLUGGED OR FILLED.** Ø1.90 mm plated through-hole (ODB tool type PLATED), Ø2.30 mm land on F.Cu/In1/In2/B.Cu (0.20 mm annular ring), Ø1.95 mm solder-mask opening on top,
Ø1.95 and Ø3.00 mm openings on the bottom (bare Ø3.00 mm B.Cu land), no solder paste. It receives a hand-fitted Ø0.5 mm copper post; it must stay fully open, plated and solderable.
If your CAM would treat it as a via, change its mask opening, or plug/fill it, please stop and ask before production.

## Assembly data

| Item | Value |
|---|---|
| SMT placements | **126, top side only** (ODB `COMP_+_TOP`, mount type SMD) |
| Bottom side | **no SMT**; `COMP_+_BOT` lists only TP1–TP8, bare Ø1.5 mm test pads on B.Cu, mount type "other" (0) — not components to place |
| U1 (Seeed XIAO ESP32-S3) | present in `COMP_+_TOP` as mount type THMT with the ODB **`.no_pop` (do-not-populate)** attribute; hand-soldered after assembly; not in BOM/CPL |
| TP1–TP8 | not in BOM/CPL; ODB carries them as bottom "other" items **without** a `.no_pop` flag (KiCad has no per-attribute export for "exclude from BOM") — treat as non-assembly items |
| BOM data inside ODB | each component carries MPN, Manufacturer, LCSC, Value, Spec, Role, JLC_Class, BOM_Status, Datasheet as `PRP` properties; this is not a formal BOM table — use the companion BOM |

## Notes for the quotation

1. Hole/mask relation of the BAT+ hole (opening 1.95 mm, drill 1.90 mm) is deliberate; JLCPCB-specific CAM wording does not apply to your process — please state your own rule and tolerance.
2. Annular ring of the component hole is 0.20 mm nominal; vias are 0.30/0.60 mm (ring 0.15 mm); 22 vias have mask dams below 0.10 mm to a neighbouring pad opening — please advise if you need them adjusted.
3. Parts are specified by MPN (companion BOM "Comment" column); LCSC numbers are JLC-only. Alternates are welcome if value/tolerance/dielectric/voltage are equal or better (X7R must stay X7R, C0G C0G).
4. Surface-mount fine-pitch parts: TSSOP-14/20 0.65 mm, 0603 passives, SOT-23; JST PH connectors (vertical and side-entry) and one SMD oscillator; top-side reflow only.
5. Rotation convention: ODB++ component angles are clockwise-positive (ODB = 360° − KiCad for every part; verified). The companion CPL uses KiCad angles plus JLC-community offsets (+180° SOT-23, +270° TSSOP, +180° side-entry JST) — for your own library use the ODB angles or the raw KiCad CPL (not in this folder; ask).
6. Unresolved before an order: mask registration and ring acceptance at the chosen supplier, physical XIAO module tolerances (not available from Seeed), BOM stock and alternates, 5-board prototype quantity with 2 assembled.

## Verification summary (`verification/odb_verification.json`)

Four copper layers · outline 51.30 × 64.95 · 201 Ø0.30 holes equal the audited Excellon positions · one Ø1.90 plated hole at U1 pad 23 · Ø2.30 land on F.Cu/In1/In2/B.Cu, Ø3.00 B.Cu land · Ø1.95 F.Mask opening ·
no paste/mask feature covering the hole · 126 top SMD placements = audited CPL (position and angle) · MPN/LCSC equal the audited BOM · U1 `.no_pop` · TP1–TP8 absent from BOM/CPL · net of the hole = VBAT.
