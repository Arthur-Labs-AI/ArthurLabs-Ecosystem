# A.R.T.H.U.R EMG Rev B — XIAO Mechanical Checklist (RB-00.6)

Zero-cost physical validation: no test PCB. **All "before order" items must pass before the RB-03 Gerber order.** Record the measured values in the table.

## A. Print verification — [XIAO_MOUNTING_1TO1.pdf](XIAO_MOUNTING_1TO1.pdf) page 1 (**[RB-02]** or the CAD-derived [XIAO_RB02A_CAD_1TO1.pdf](XIAO_RB02A_CAD_1TO1.pdf), which has the same P1–P3 scale references)

| # | Check | Pass criterion | Result |
|---|---|---|---|
| P1 | Printed at "Actual size / 100 %" (no fit-to-page) | Printer dialog confirmed | |
| P2 | Ruler 0–150 mm measured with steel rule/caliper | 150.0 ± 0.5 mm | |
| P3 | 50 × 50 mm square, both axes | 50.0 ± 0.3 mm each | |
| P4 | Board outline | 75.0 × 32.0 ± 0.3 mm | |

## B. Real-part measurements (caliper), **one module is sufficient [RB-02A decision]; needed before the Gerber order, not before placement**

| # | Feature | Expected (Seeed data) | Module 1 | Module 2 |
|---|---|---|---|---|
| M1 | Width across castellation edges | 17.78 ± 0.15 | | |
| M2 | Length (USB end to far end, excl. USB-C overhang) | **21.135** ± 0.15 [RB-02, D-1] | | |
| M3 | USB-C overhang past the module end | 1.51 ± 0.2 | | |
| M4 | **XIAO PCB thickness** (sets fillet height) | record (expect 1.0–1.2) | | |
| M5 | Castellation pitch over 6 pitches (pin 1 → pin 7) | 15.24 ± 0.10 | | |
| M6 | BAT+ pad centre from the far end / from the D0–D6 edge | **10.975** / 4.445 ± 0.15 [RB-02, D-7] (10.160 from the USB edge) | | |
| M7 | BAT− (GND0) centre, same references | **12.880** / 4.445 ± 0.15 [RB-02, D-7] (8.255 from the USB edge) | | |
| M8 | U.FL centre from the far end / from the D0–D6 edge | **1.729** / 4.039 ± 0.3 [RB-02, D-7] | | |
| M9 | Underside flatness (straight edge): no components, no protrusions > 0.1 mm | flat | | |
| M10 | Board revision silk / label; **B2B connector is expected to be POPULATED on the plain module [RB-02, D-6]**; 470 nH inductor present | record | | |
| M11 | **[RB-02, D-3]** Four USB-C shell THT ovals visible on the underside (GND, 1.78 × 0.89) at 4.57 / 13.21 mm from the D0–D6 edge, 1.08 / 5.27 mm from the USB edge | present / absent | | |
| M12 | **[RB-02, D-2]** Castellation copper width along the edge (caliper on one pad) | 1.63 ± 0.1 | | |

## C. Paper fit check (real XIAO on the 1:1 print)

| # | Check | Pass criterion | Result |
|---|---|---|---|
| F1 | USB-end edge on the south board-edge line | ± 0.2 mm | |
| F2 | Every castellation centred on its grey pad | ± 0.2 mm, all 14 | |
| F3 | Visible grey toe on **both** long sides | ≥ 1.0 mm each side, every pad | |
| F4 | BAT+ pad (flip the module to mark its position on the print, or use M6) over the red hole | Hole centre within the pad | |
| F5 | GND0 not over the red hole ring | ≥ 0.3 mm clear | |
| F6 | U.FL within the magenta square | yes | |
| F7 | Iron access: a 2.4 mm chisel tip reaches every toe at 30–45° without touching the drawn neighbours | yes, 14/14 | |

## D. Enclosure and handling (before order, on the CAD model or paper)

| # | Check | Pass criterion |
|---|---|---|
| E1 | USB-C mouth aligned with a south-wall cutout; the wall supports the receptacle rim (takes plug force off the castellations) | Receptacle flush ±0.3 with the inside wall |
| E2 | A mated USB-C plug overmold (≈ 12.4 × 6.5 mm) clears the enclosure and the board | No contact |
| E3 | Antenna cable path: U.FL → east, antenna element at the east/north-east end, ≥ 30 mm from J101–J5001 | Measured |
| E4 | Battery lead from J_BAT (north edge) to the cell pocket; no crossing over Zones A–C | Route drawn |
| E5 | Electrode cables exit the south wall west of x = 39 mm; USB-C at x ≈ 64 mm (≥ 20 mm apart), and labelled "no electrodes when USB connected" | Yes |
| E6 | Stack height: board 1.6 + XIAO (M4) + XIAO top parts; tallest parts are the vertical JST-PH electrode connectors | Recorded, fits the lid |
| E7 | Lid rib or pad lightly restrains the XIAO top (optional) without pressing the RF shield/antenna | ≤ 0.2 mm preload |

## E. Design-rule gates (RB-02/RB-03)

| # | Gate |
|---|---|
| G1 | `ARTHUR:XIAO_ESP32S3_HANDSOLDER` copper = Mounting Spec §2/§3 exactly; no F.Paste on the 14 pads |
| G2 | The XIAO is DNP / excluded from the JLC BOM and CPL |
| G3 | Scripted via-in-SMD-pad check = 0. No via inside the module outline except the via field and the BAT+ post hole |
| G4 | F.Cu keep-outs under exposed module pads 15–22, 25 and GND0 are present and DRC-enforced |
| G5 | Height bands west of the toes respected (none < 1.5 mm; ≤ 1.2 mm tall within 1.5–4.0 mm) |
| G6 | Module USB end at the board edge 0…+0.2 mm; copper-to-edge ≥ 0.5 mm elsewhere (east toes 0.92) |
| G7 | Re-generate the 1:1 drawing from the final PCB coordinates (`tools/rb02a_make_1to1.py`) and repeat sections A and C before ordering |
