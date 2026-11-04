# RB-03S — ADC CAP Decoupling Repair (C6009)

Date: 2026-10-11. Branch `hardware/emg-rev-b`. Nothing committed or pushed, nothing ordered, no manufacturing release files, RB-04 not
started. Companion: `REVB_RB03S_VIA_MASK_AUDIT.md`. Predecessor: `REVB_RB03R_VIA_ELIMINATION.md` (its installed board had the compromised
C6009 ground wire; this document supersedes that board). Evidence: `rev-b-xiao/evidence/rb03s/`; images `evidence/rb03s/images/`;
the RB-03R board is archived in `rev-b-xiao/archive/rb03r_installed/`.

## 1. Result

| Item | RB-03 run 14 | RB-03R installed | **RB-03S (installed now)** |
|---|---|---|---|
| C6009 | 220 nF, 0603 | 220 nF, 0603 | **220 nF, 0603 (unchanged part and footprint)** |
| C6009 ground connection | via centred in the pad | 0.15 mm F.Cu wire, 14.3 mm, joined to a far GND chain | **0.3 mm-wide stub, 0.3 mm from the pad edge, one ordinary 0.30 / 0.60 mm via at (25.20, 49.10) mm directly to In1** |
| Estimated ground-path inductance (via + stub) | ≈ 0.1 nH | ≈ 6–10 nH | **≈ 0.25 nH** |
| Via-in-pad | 17 | 0 | **0** |
| XIAO iron access (RB-02 C17 / C18) | PASS | **FAIL (R7101)** | **PASS** |
| Board | 51.30 × 62.45 | 51.30 × 64.95 | **51.30 × 64.95 (unchanged)** |
| DRC errors / unconnected / parity | — | 0 / 0 / 0 | **0 / 0 / 0** (1 accepted warning: `lib_footprint_mismatch` U1) |
| ERC | 0 | 0 | **0** |

Placement changes against the RB-03R board (the only two): **C6009 −0.18 mm in x** and **R7101 −0.30 mm in x (back to its RB-02 position)**.
Everything else is unchanged except re-routed copper of the affected nets (AFE_CAP, X1_OUT, SCLK, SCLK_MCU, the C6009 ground tie) and 50 vias
moved 0.1–2.3 mm in the mask pass (see the via audit). Components: 135, 126 SMT on F.Cu, 0 on B.Cu.

## 2. Requirement basis

TI ADS131M04 datasheet SBAS890D (May 2021), read 2026-10-11:

* 10.1 CAP pin behaviour: with DVDD > 2.7 V a **220 nF capacitor from CAP to DGND** is required; the pin is the output of the internal 1.8 V
  core LDO. (DVDD here is 3.0 V.)
* 10.3 decoupling: capacitors "as close to the power-supply pins as possible with low-impedance connections", low-ESL MLCCs; for very
  sensitive systems avoid vias between capacitor and **device pin** (the CAP-pin side here is F.Cu, no via); vias to the ground plane are
  acceptable and multiple vias in parallel lower the inductance; analog and digital ground are joined as close to the device as possible.

The datasheet gives no inductance figure; the acceptance criterion used is "comparable to the other decoupling capacitors of the same
device": C6007 0.6 mm, C6008 0.5 mm, C6010 (X1) 0.5 mm, C4005 0.5 mm, X1 pad 0.4 mm of F.Cu to the ground via. C6009 is now **0.3 mm**
(`gnd_paths.json`).

## 3. Why the RB-03R solution failed and what the real obstruction was

The pad of C6009.2 has X1 to the north, R6001 to the south, R7101 to the east and U6001 to the west, all with touching courtyards.
The two numbers that decided everything:

* RB-02 C17 permits R7101's courtyard no further east than its RB-02 position (a +0.05 mm move already fails; checked 0.05–0.20 mm);
* a 0.60 mm via needs centre ≥ 0.25 mm from its own pad copper (hole web ≥ 0.10 mm) and ≥ 0.20 mm clearance to R7101's pad:
  with C6009 at its RB-02 position the window is 0.11 mm too narrow (pad edge 25.13, R7101 pad edge 25.77).

RB-03R solved the window with R7101 +0.30 mm. That cost C17 and left the pad connected only through a long wire because two **router
heuristics** (not DRC rules) hid the remaining legal cells: a 0.7 mm via exclusion around the cut edge of the In2 GND zone (x = 25.5 mm)
and a 0.35 mm "keep GND vias away from GND pad rectangles" margin. Both are now router parameters (`in2_edge_margin`,
`gnd_rect_margin`), set to −0.02 mm (annulus kept to the pour edge) and 0.25 mm (= the own-pad via gap) only for this ground via. **No DRC
rule, netclass, custom rule or clearance was relaxed**; `guard check` and the canary DRC pass.

## 4. Options evaluated, in the requested order

| # | Option | Result | Ground path (est.) | Verdict |
|---|---|---|---|---|
| 1 | Reposition X1 and/or R6001 locally, keep 0603 | R6001 ±0.1 / +0.3 mm: courtyard conflict (C6009 / R6002). X1 +0.3 mm in x: DVDD_F cannot be re-routed, X1.2 via becomes an offender. X1 −0.3 mm in x: courtyard conflict with U6001. X1 −0.3 mm in y: ties C6009.2 by a **2.6 mm, 0.15 mm** wire to an existing GND via at (24.1, 46.6) (no via near the pad) | ≈ 1.2 nH | works but 9× longer than option 2 and 0.15 mm wide, moves the oscillator; **not chosen** (`option1_attempts.txt`) |
| 2 | Reposition C6009 / nearby noncritical parts, same electrical topology | **C6009 −0.18 mm** (courtyard to U6001 0.005 mm), **R7101 back to RB-02**; GND via at (25.20, 49.10), stub 0.30 mm wide | **≈ 0.25 nH** | **chosen** |
| 3 | 0402 220 nF X7R | **not tested: not necessary.** Would need (not done): DC-bias derating at 1.8 V and 3 V (X7R 0402 typically loses > 50 % at 4–6 V rated, to be taken from the vendor curve), ≥ 6.3 V rating, ±10 % tolerance, −55…125 °C, an LCSC basic/extended line, JLC Economic eligibility, and a BOM / footprint change | — | rejected on manufacturing-risk grounds: needs a new part qualification and BOM change for no benefit over option 2 |

Lowest manufacturing risk = option 2: same LCSC part, same footprint, 0.18 mm placement change, no new via process, Economic
PCBA unchanged.

## 5. C6009 ground connection (final)

* via (25.20, 49.10) mm, 0.30 mm drill / 0.60 mm pad, F.Cu–B.Cu through In1 (GND plane, 0.2104 mm below the pad) and In2 (GND zone);
  centre-to-pad-copper 0.262 mm; hole-to-mask-opening **0.112 mm**; annulus overlaps the opening by 0.038 mm (class 3 in the via audit,
  same net, tented). **No via-in-pad, no hole touching a solder opening**; the hole web is above JLC's published 0.10 mm.
* stub: 0.30 mm wide, 0.3 mm long edge-to-via-centre (≈ 0.5 mm from pad centre), F.Cu; no other layer.
* C6009.1 (CAP side): AFE_CAP net 2.7 mm total (2.9 mm before), F.Cu only, no via, 2.0 mm pad-to-pin (RB-02 C23 PASS).
* the old 14.3 mm wire is gone (no dangling GND copper: components with < 2 anchors pruned, none left).

### 5.1 Before / after, with the method

| | Path pad → ground via | Width | Estimated L |
|---|---|---|---|
| RB-03 run 14 | via in the pad | — | ≈ 0.1 nH (via barrel to In1 0.085 nH + pad) |
| RB-03R installed | 14.3 mm | 0.15 mm | 14.3 mm × 0.44 nH/mm + 0.09 nH ≈ **6.4 nH** (7–10 nH if the meander and current crowding are counted) |
| **RB-03S** | **0.3 mm (≈ 0.5 mm from the pad centre)** | **0.30 mm** | 0.5 mm × 0.335 nH/mm + 0.085 nH ≈ **0.25 nH** |

With a 0603 220 nF MLCC ESL of ≈ 0.7 nH (typical, not from a datasheet of the part used) the series resonance moves from ≈ 4 MHz
(RB-03R) to ≈ 11 MHz (RB-03S). The decoupled signal is the 1.8 V core LDO output of a converter clocked at 8.192 MHz (fCLKIN) so the
second case keeps the capacitor effective across the first harmonics.

**Limitations of the estimates.** (a) Microstrip inductance per length uses Hammerstad's closed form for a 0.15–0.30 mm track at h =
0.2104 mm over the In1 plane (εr 4.4) and treats the return as a uniform plane under the track; (b) the via inductance is the Johnson
single-via formula to the nearest plane only (the real return uses In1 and In2 together and is lower); (c) current spreading in the plane,
the pad itself, the via-to-plane transition and mutual inductance with the neighbouring vias are not modelled; (d) the plane under the
RB-03R meander is not uniform; (e) the stack-up thickness is the nominal JLC04161H-7628 value, not measured; (f) no field solver, no
measurement. Treat both numbers as ±50 % and as ordering evidence (the change is a factor ≈ 25), not as a result to design to.

## 6. Nearby routing re-validated

Only the affected nets were re-routed (strict router, no relaxed via fallback): AFE_CAP, X1_OUT, SCLK, SCLK_MCU and the ground tie of
C6009 plus the mask-pass relocations (via audit).

| Net | RB-03 run 14 | RB-03R | **RB-03S** | Notes |
|---|---|---|---|---|
| X1_OUT (X1 pad → R6001) | 4.7 mm, 0 vias, F.Cu | 4.7 | **4.3 mm**, 0 vias, F.Cu | requirement ≤ 5 mm |
| ADC_CLKIN (R6001 → CLKIN) | 9.6 mm, 2 vias (B.Cu hop) | 9.8 | **9.8 mm**, 2 vias | unchanged since RB-03; 5.4 mm from hi-Z/buffered copper |
| AFE_CAP (C6009.1 → CAP pin 18) | 2.9 mm | 2.9 | **2.7 mm** | F.Cu |
| DVDD_F | 45.2 mm, 6 vias | 42.1 | **42.1 mm**, 6 vias | unchanged routing, C6008 1.5 mm and C6010 3.3 mm from their pins |
| SCLK | 17.4 mm | 12.9 | **12.6 mm** | |
| SCLK_MCU (U1.9 → R7101) | 7.3 mm | 12.1 mm (+2.2 mm via detour) | **7.7 mm** | re-routed with a 0.36 mm XIAO-pad via gap |
| MISO / MOSI | 7.6 / 12.4 | 9.0 / 11.9 | 9.0 / 11.9 | |

Clock spacing (edge to edge, same layer): X1_OUT to nearest other signal 0.49 mm (AFE_CAP), 0.75 mm (DVDD_F); ADC_CLKIN 0.35 mm to AFE_CAP,
0.45 mm to MOSI and DVDD_F, 0.70 mm to SCLK. **These are unchanged from RB-03**; the board rule for SPI vs buffered nets is 1.0 mm and for
SPI vs hi-Z 2.0 mm (both met: 25 mm hi-Z, ADC input runs ≥ 2.1 mm). The 0.35–0.45 mm clock-to-SPI/AFE_CAP spacing is an RB-04 review item;
no frequency-domain claim is made. Oscillator decoupling: C6010 100 nF, 3.3 mm from X1 VDD (RB-02 C23 PASS), unchanged part and position.

Power and ground continuity: In1 one solid plane (3057 mm², 0 holes), In2 two zones tied through the plane (2313 mm²); return-path
coverage 100 % for every analog, SPI, control and supply class except 96 % of PWR_VBAT under the BAT+ post keep-out (as before). Copper
drop from `rb03r_power.py`: AFE_3V0 2.0 mV at 13.8 mA (datasheet-bounded), DVDD_F 0.54 mV at 11.4 mA, VBAT 7.5 mV at a 0.5 A system
estimate. 71 SMD ground pads: median 0.97 mm to a ground via, 11 pads > 2 mm, 5 > 3 mm; copper paths > 2 mm: 5 pads (R7106.2 5.3 mm, R3004.2
4.6 mm are the longest, both 0.2–0.3 mm wide, not CAP-pin parts).

## 7. XIAO hand-solder access

* RB-02 **C17** (no courtyard within 1.5 mm west of the toe ends) **PASS**; **C18** (1.5–4.0 mm: ≤ 1.2 mm tall) **PASS**; C19, C29, C30 PASS.
  R7101 is back at its RB-02 position (courtyard right edge exactly at the limit; +0.05 mm fails).
* Iron-body model (`tools/rb03s_iron_access.py`, assumptions in the file header; **model, not a vendor figure**): the iron's lower surface
  leaves the toe end at 30 / 45 / 60° elevation; a part blocks if its height exceeds d·tan θ and its courtyard is within the body's lateral
  half width 1.0 + 0.10·s mm. Result for all 14 toes: **45° and 60°: no blocked toe (worst margin +0.57 mm, C7101 0.95 mm tall at
  1.52 mm); 30°: toes 12 and 13 short by 0.13 mm (FB1 / C7101 at 1.52 mm)**. Interpretation: PASS for the usual 35–45° approach; a very
  flat 30° tip would touch FB1/C7101 on toes 12/13. This is a RB-02 placement fact unchanged by RB-03S; RB-03R's R7101 was the only
  tip-band violation (toe 9, 1.22 mm).

## 8. Verification (final installed board)

| Check | Result |
|---|---|
| KiCad DRC (`--schematic-parity --severity-all`, project rules + 10 custom rules) | 0 errors, 1 warning (`lib_footprint_mismatch` U1, accepted since RB-02), 0 unconnected, 0 parity |
| KiCad ERC | 0 violations |
| Independent netlist / placement audit (`rb02g_check.py`, 30 checks) | 27 PASS; FAIL C06 (board size, compares to the RB-00.6 estimate; unchanged), CONDITIONAL C26 (JLC rails, 71 parts within 3 mm of the long edges, unchanged); C01–C05 (135 refs, 364 pad-net checks, 0 mismatch) PASS |
| Via-to-pad / mask audit | via-in-pad 0, hole-to-opening min 0.105 mm, see the via audit |
| Netclass / rule regression | guard check PASS (14 classes, 34 patterns, 90 nets, 10 critical rules); canary 11/11 negative fire, 3/3 positive silent; guard self-test 9/9 mutations detected |
| TLV9064 exemption purity | 0 foreign non-GND nets inside the three rule rectangles |
| XIAO mechanical (C10–C19, C29, C30) | PASS |
| Economic PCBA | assembly side: 126 top, 0 bottom, XIAO DNP; edge audit 126 PASS / 9 N/A (U1, TP1–TP8); min pad-to-edge 0.5 mm |
| Ground plane continuity | In1 1 outline, 0 holes; In2 1 outline, 0 holes |
| Rev A / frozen RB-01R schematic | untouched (no schematic or Rev A file written in this task) |

### 8.1 Canonical project file incident

At the end of RB-03R the canonical `ARTHUR_EMG_RevB.kicad_pro` had been re-serialised by pcbnew (hash `babc896c…`, 20.0 kB) although the
final hash check of RB-03R had read `e4119969…`; the cause was one of my own tools loading a board inside the project directory. The
netclass table, patterns, severities and design rules were intact (guard check passed on the damaged file) and the `.kicad_dru` was
byte-identical (`21c0e803…`). The scratch copy of the original `.kicad_pro` was no longer available, so the file was **regenerated with
the project's own generator `rb02_write_project.py` from the committed HEAD stub**: hash `69d9d2a1…`. The guard check, canary and DRC pass
with it; `rb03r_verify.sh` now also fails if the canonical files change during a run, and `rb03r_safe.safe_pcb` covers every pcbnew
loader and `rb03r_crop.py`. A `.history/` directory and lock files created by pcbnew were removed.

## 9. Reproduction

```
python3 hardware/emg/rev-b-xiao/tools/rb03s_repair.py --pcb <RB-03R board> --out <out> --move R7101:-0.3:0 C6009:-0.18:0 \
        --pad C6009.2 --in2-margin -0.02 --gnd-rect-margin 0.25 --also-reroute /ADC/X1_OUT
python3 hardware/emg/rev-b-xiao/tools/rb03r_nudge.py --pcb <out> --out <out2> --via-audit <via_audit.json> --spi-cap 8      # U1.9 case
python3 hardware/emg/rev-b-xiao/tools/rb03r_routenet.py --pcb <out2> --out <out3> --rip --gap 0.36 --nets /XIAO_Brain_Interface/SCLK_MCU
python3 hardware/emg/rev-b-xiao/tools/rb03r_nudge.py --pcb <out3> --out <out4> --via-audit <via_audit.json> --mask-improve 0.09 --rounds 1 --radius 2.0 --slack 0.0 --spi-cap 3.0 --gnd-cap 3.0
bash hardware/emg/rev-b-xiao/tools/rb03r_verify.sh <out4> <evidence dir> --fill
```

The unfilled intermediate boards are archived: `archive/rb03r_installed/` (input) and `archive/rb03r_chain/rb03s_unfilled_t10.kicad_pcb` (output
before zone fill). The router is deterministic only up to UUIDs; counts reproduce.

## 10. Open items

1. JLC DFM confirmation of the 25 class-2/3 via records (via audit) in RB-04, including C6009's 0.038 mm annulus overlap.
2. 30° iron approach at toes 12/13 (FB1 / C7101 at 1.52 mm) — placement fact from RB-02.
3. ADC_CLKIN runs 0.35–0.45 mm from AFE_CAP / MOSI over ~2 mm; no SI evidence either way.
4. The generated `.kicad_pro` differs from the previous file in serialization; re-baseline is not needed (guard compares the substantive fields).
5. Nothing is experimentally verified (no measurement of CAP-pin noise, no 4-wire inductance measurement).

## 11. Final gate

```
C6009 PACKAGE:                    0603 (unchanged), 220 nF
C6009 GROUND PATH LENGTH:         0.3 mm (RB-03R: 14.3 mm)
C6009 GROUND CONNECTION:          one ordinary 0.30/0.60 mm via at (25.20, 49.10) to In1, 0.30 mm-wide stub; est. 0.25 nH (RB-03R 6-10 nH)
C6009 DECOUPLING:                 PASS (CONDITIONAL on RB-04 DFM for the 0.038 mm annulus overlap of its via; estimates unmeasured)

XIAO IRON ACCESS:                 PASS (C17/C18 PASS; 45-60 deg model PASS; 30 deg: toes 12-13 short by 0.13 mm)
CLOCK ROUTING:                    PASS (X1_OUT 4.3 mm, 0 vias; ADC_CLKIN 9.8 mm; spacing unchanged from RB-03)

VIA-IN-PAD:                       0
VIA HOLES TOUCHING SMD PADS:      0
UNRESOLVED MASK RISKS:            25 records / 21 vias (10 annulus overlaps an opening <= 0.045 mm; 15 records below the 0.09 mm
                                  neighbour clearance); 0 hole risks; 0 vias needing fill/cap/plug

PCB DIMENSIONS:                   51.30 x 64.95 mm (unchanged)
UNCONNECTED NETS:                 0
DRC ERRORS:                       0
ERC ERRORS:                       0

JLC ECONOMIC PCBA:                CONDITIONAL (process rails added by JLC; open items U1-U10 and the via/mask DFM items)

READY FOR RB-04:                  YES

MANUFACTURING RELEASE:            NO

BLOCKERS:                         none for starting RB-04; RB-04 must settle the 25 class-2/3 via records with JLC, the 0.15 mm via
                                  annulus, and re-confirm the regenerated .kicad_pro
```
