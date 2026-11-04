# RB-03S — Via / Solder-Mask Audit

Date: 2026-10-11. Board: Rev B V1C, 51.30 × 64.95 mm, after RB-03S (`REVB_RB03S_CAP_DECOUPLING_REPAIR.md`). Nothing committed,
nothing ordered, no manufacturing files. Evidence: `rev-b-xiao/evidence/rb03s/` (`via_audit.json/csv`, `via_mask_disposition.json/csv`,
`images/mask_classes_F.Cu.png`). Tool: `tools/rb03r_via_audit.py` (pcbnew `HitTest` on the true pad shape, independent of KiCad DRC).

## 1. Result

| | RB-03R installed | RB-03S final |
|---|---|---|
| Vias | 200 | 201 |
| Via-in-pad | 0 | **0** |
| Via holes within 0.10 mm of a solder opening | 0 | **0** (minimum hole-to-opening 0.105 mm) |
| Vias that need filling, capping or plugging | 0 | **0** |
| Via-near-pad records (audit radius) | 100 (94 vias) | 52 (47 vias) |
| Vias relocated for mask clearance (this task) | — | 50 (35 by 0.1 mm, 9 by 0.2 mm, 6 by 0.4–2.3 mm) |

Every near-pad via is on **the same net as the pad it is near** (100 of 100 records before, all after): there is no case of a foreign-net
via close to an opening, so a mask failure cannot create a short; it can only cost tenting quality or let solder touch same-net copper.

## 2. Rules used (JLCPCB published capabilities, https://jlcpcb.com/capabilities/pcb-capabilities, read 2026-10-11)

| Rule | Published value | Consequence here |
|---|---|---|
| Solder-mask bridge between openings | 0.10 mm (green, 1 oz) | hole-to-opening ≥ 0.10 mm is kept for **every** via (web over the hole) |
| Opening vs neighbouring traces | "at least 0.09 mm clearance between soldermask openings and neighboring traces" | a via annulus is treated as neighbouring copper: annulus-to-opening ≥ 0.09 mm is "clear" |
| Mask expansion | 1:1 (opening = pad) | openings are the copper outline; no per-pad shrink assumed |
| Tenting / plugging with mask | via filled with mask; **no mask opening on either side; ≤ 0.5 mm** | all 201 vias are 0.30 mm holes, tented front and back (`(tenting (front yes) (back yes))`) |
| Epoxy / copper-paste filled and capped | 0.15–0.55 mm vias; the default only for ≥ 6-layer boards | not used; would be an added process on this 4-layer board (via-in-pad only) |

JLCPCB does not publish a rule for "annulus inside a pad opening" or a minimum hole web for tented vias beyond the 0.10 mm bridge; those
are therefore classified with the 0.10 mm and 0.09 mm numbers above and listed for RB-04 DFM confirmation. Three via processes
are distinguished: **tented** (mask over the via, hole empty; this board), **plugged** (hole filled with mask/ink, no opening on either side;
≤ 0.5 mm; still a mask process) and **filled-and-capped** (epoxy or copper paste, plated over; the process that makes via-in-pad legal; an extra
cost on 4 layers, **not** used).

## 3. Classes

| Class | Definition (all vias are same-net, 0.30 / 0.60 mm, tented) | Action |
|---|---|---|
| **1 Acceptable conventional tented via** | annulus-to-opening ≥ 0.09 mm (hole web ≥ 0.15 mm), or no pad opening within the audit radius | none |
| **2 Requires improved solder-mask clearance** | annulus outside the opening but closer than 0.09 mm (0.00–0.09 mm); hole web ≥ 0.15 mm | move the via 0.01–0.09 mm away, or accept after JLC DFM confirmation |
| **3 Requires relocation** | annulus overlaps the opening (0.006–0.045 mm); hole web 0.105–0.144 mm (≥ 0.10 mm) | move the via ≥ 0.05–0.14 mm away, or accept after JLC DFM confirmation |
| **4 Needs an unsupported / additional process** | hole inside or touching an opening, or a via-in-pad | **none** |

Not every near-pad via is a failure: the 0.10 mm hole web is met for all of them and no class-4 case exists.

## 4. Disposition of the 77 flagged records (RB-03R: 17 tier B + 60 tier A-)

| RB-03R class | → RB-03S class 1 | → class 2 | → class 3 | Records |
|---|---|---|---|---|
| 2 (annulus outside the opening, dam < 0.09 mm) | 42 | 15 | — | 57 |
| 3 (annulus overlapping the opening) | 8 | — | 9 | 17 |
| 1 (already ≥ 0.09 mm) | 3 | — | — | 3 |
| **Total** | **53** | **15** | **9** | **77** |

Plus the new GND via of C6009.2 (class 3, below), which was a 14.3 mm wire and therefore not among the 77: total unresolved after
RB-03S = **15 class-2 + 10 class-3 records**. By distinct via (several records share a via) the final board has 47 vias near an opening:
**26 class 1, 11 class 2, 10 class 3**.

### 4.1 Methods that worked

* local relocation of one via at a time, no rip-up (`rb03r_nudge.py --mask-improve 0.09`): target centre-to-pad-copper
  0.40 mm (0.45 mm for the XIAO, whose openings carry +0.05 mm), stub ≤ 2–3 mm, same layers, DRC and guard after every pass;
* the AFE_3V0 vias of the BAV199 clamps (0.1 mm), four VCM resistor vias (0.1–0.45 mm) and the USB-inhibit strip ties (0.1–0.5 mm) moved;
* SCLK_MCU re-routed with a 0.36 mm via-to-pad gap for the XIAO pad (net 13.3 → 7.7 mm).

### 4.2 Remaining vias that are not class 1 (25 records)

Position (x, y mm), net, pad, annulus-to-opening (− = overlap), hole-to-opening, class, change:

| Via | Net | Pad | Annulus to opening | Hole to opening | Class | Status |
|---|---|---|---|---|---|---|
| 49.4, 58.0 | `/SYNC_RESET_N` | U1.3 | -0.045 | 0.105 | 3 | unchanged |
| 24.1, 54.5 | `/DRDY_N` | R6003.2 | -0.038 | 0.112 | 3 | unchanged |
| 31.7, 16.5 | `/VCM` | R106.1 | -0.023 | 0.127 | 3 | unchanged |
| 36.4, 16.5 | `/VCM` | R105.1 | -0.023 | 0.127 | 3 | unchanged |
| 23.0, 56.4 | `DVDD_F` | R7104.1 | -0.023 | 0.127 | 3 | unchanged |
| 26.3, 59.3 | `DVDD_F` | C7102.1 | -0.023 | 0.127 | 3 | unchanged |
| 28.5, 56.7 | `DVDD_F` | FB1.2 | -0.023 | 0.127 | 3 | unchanged |
| 11.1, 53.2 | `/CH3_P` | C306.1 | -0.023 | 0.127 | 3 | unchanged |
| 30.3, 55.5 | `/XIAO_Brain_Interface/MOSI_MCU` | U1.11 | -0.006 | 0.144 | 3 | unchanged |
| 28.7, 37.8 | `/Analog_Power_Interlock/AFE_EN` | Q3001.3 | +0.001 | 0.151 | 2 | unchanged |
| 22.4, 60.7 | `/XIAO_Brain_Interface/USB_PRESENT` | R7106.1 | +0.009 | 0.159 | 2 | unchanged |
| 11.1, 49.9 | `/CH2_N` | C207.1 | +0.016 | 0.166 | 2 | unchanged |
| 11.1, 48.4 | `/CH1_N` | C107.1 | +0.016 | 0.166 | 2 | unchanged |
| 14.3, 18.7 | `GND` | C304.2 | +0.028 | 0.178 | 2 | unchanged |
| 11.1, 49.9 | `/CH2_N` | D204.3 | +0.028 | 0.178 | 2 | unchanged |
| 23.0, 56.4 | `DVDD_F` | R7103.1 | +0.028 | 0.178 | 2 | unchanged |
| 26.3, 59.3 | `DVDD_F` | C7101.1 | +0.028 | 0.178 | 2 | unchanged |
| 26.8, 54.6 | `/XIAO_Brain_Interface/MOSI_MCU` | R7102.1 | +0.028 | 0.178 | 2 | unchanged |
| 11.1, 53.2 | `/CH3_P` | D303.3 | +0.028 | 0.178 | 2 | unchanged |
| 30.3, 48.2 | `/XIAO_Brain_Interface/SCLK_MCU` | U1.9 | +0.033 | 0.183 | 2 | relocated 2.30 mm |
| 14.6, 20.1 | `/CH3/BUF_N` | U502.7 | +0.052 | 0.202 | 2 | unchanged |
| 34.5, 39.7 | `GND` | R7108.2 | +0.079 | 0.229 | 2 | unchanged |
| 7.2, 36.7 | `GND` | TP8.1 | +0.083 | 0.233 | 2 | unchanged |
| 13.4, 36.7 | `GND` | TP7.1 | +0.083 | 0.233 | 2 | unchanged |
| 25.2, 49.1 | `GND` | C6009.2 | -0.038 | 0.112 | 3 | new in RB-03S (the C6009 ground via) |

Why they remain: each sits between two courtyard-touching 0603 parts or between a pad and an X1/U1/TLV9064 pad, where the nearest
legal cell for a 0.60 mm via (0.20 mm clearance to foreign copper, 0.25 mm to own-pad copper, In2 cut-edge margin, hi-Z 0.40 mm band)
is the present one; `rb03r_nudge.py` found no relocation within 2 mm. The hole web is 0.105–0.23 mm in every case.

## 5. Risk judgement, honestly

* Class 2 (15 records): the dam between opening and tented annulus is below JLC's 0.09 mm neighbour figure but positive. Expected effect: JLC
  CAM may adjust the opening or the dam; **no electrical risk** (same net), hole stays tented. I would accept these after the RB-04
  DFM upload shows no complaint.
* Class 3 (10 records): the annulus intrudes ≤ 0.045 mm into the opening, so a sliver of same-net via copper is exposed to solder; the hole
  web is ≥ 0.105 mm (JLC minimum 0.10 mm). Risk: slightly irregular solder fillet; wicking into the hole is not expected with the hole
  covered by mask, but a web at the process minimum has no margin for registration error (JLC's registration tolerance is not
  published in the capability page). These are the vias to show JLC in the DFM review and, if flagged, to fix by a 0.05–0.14 mm
  placement change of the neighbouring pad's part. That was not possible with the tools used without moving parts that touch their
  neighbours' courtyards (R7103/R7104/C7101/C7102 column) or the XIAO castellation pads (U1.3, U1.11), where `rb03r_nudge.py` found no legal cell within 2 mm.
* No class-4 via. No via processing beyond standard tenting is required or requested.

## 6. Reproduction

```
bash hardware/emg/rev-b-xiao/tools/rb03r_verify.sh <board.kicad_pcb> <evidence dir> --fill
python3 hardware/emg/rev-b-xiao/tools/rb03r_nudge.py --pcb <board> --out <out> --via-audit <via_audit.json> --mask-improve 0.09 --rounds 1 --radius 2.0 --slack 0.0 --spi-cap 3.0 --gnd-cap 3.0
```

`rb03s_summary.py <evidence dir>` prints the FAIL records and DRC lines. The classification table is `via_mask_disposition.csv`.
