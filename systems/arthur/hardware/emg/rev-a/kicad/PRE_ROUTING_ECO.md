# ARTHUR EMG Rev A — Pre-Routing Electrical ECO (Audit 10)

No routing. No vias. No copper zones. Schematic changes: NONE (no netlist change required).
All ECOs are placement/package-position changes through `pl_place.py` inputs.

## 1. Blocker table reduced: 20 shorts -> 3 shorts (672 -> 635 total DRC)

Audit-9 baseline: 20 shorts / 23 clearances. Audit-10 final: 3 shorts / 21 clearances.
Input network: 0 / 0 (unchanged, frozen). ERC: no errors (50 footprint-link
warnings = environment missing stock libs; 1 isolated-pin-label warning,
both pre-existing).

## 2. Package ECOs (electrically justified, values/dielectrics preserved)

- C6004: 0805 -> 0603 (1uF per ADS1294 Figure 106; schematic already specifies
  0603 — rows had C8, corrected to C6). Fixes schematic mismatch + geometry.
- C6007: 0805 -> 0603 (1uF AVDD) + move (11.0 -> 9.2, 24.5). 0603 1uF electrically
equivalent for local AVDD bypass; clears TEST17/18 shorts to 0.01 clearances.
- C6008: 0805 -> 0603 (1uF DVDD) + move (19.0 -> 20.8, 24.5). Same justification;
  clears ADC31/32 shorts. DVDD-pin distance +1.8mm east, still adjacent to ADC
  east edge (acceptable for 1uF local bypass).
- C6003 stays 0805 (22uF VCAP1 per Audit-2, high-CV package required) + move
  (16.25 -> 15.5, 24.5 -> 25.0): threads ADC pad column and JST MPs (proven by
  T4/T5 grid: clears all C6003-ADC/NC shorts).
- C6004 rotated 90 at (18.6, 25.0): narrow x-profile threads NC29/ADC30 column.

## 3. Placement resectoring (positions only, no value changes)

- Charger: C4001 (15.0 -> 15.8, 1.5), C4002 (12.0 -> 13.0, 2.0): spread pair off
  J2001 pin column (fixes C4001-C4002 short; J2001 residuals become clearances).
- U2001 (5.0 -> 5.7, 12.0): clears U2001-C2003 short (charger IC east, no thermal change).
- TP601 (1.3,10.15 -> 2.5,11.3): C2002 short -> clearances (test-point micro-optimization).
- Prior-audit wins retained: R5001 unstack, USB stagger, G1 support shifts, C608B east,
  R404-flat + R5002-east, U4002-west, C4003-NE, input geometry frozen.

## 4. Footprint validation (touched components)

- C6004 0603: matches schematic Figure-106 callout (was rows-side mismatch).
- C6007/C6008 0603: standard 0603 1uF ceramic footprints (stock Capacitor_SMD).
- All other footprints unchanged; U4001 DSK and U7001 module geometry verified
  from embedded PCB data (Audit 8/9); no custom geometry invented.

## 5. NC / net-tie decision (Phase 2)

U6001 pins 17/18 (TESTP/TESTN) and 27/29 (NC) are single-node unconnected nets
(netlist-verified). They are truly floating and MUST stay isolated: no net-ties,
no joins. Their former shorts to VCAP1/GND/VCAP2 are FIXED by the decap cluster
moves above (NC27/NC29 zero shorts in final DRC; TEST17/18 remain 0.01/0.015
clearances vs C6007).

## 6. Remaining 3 shorts (placement-exhausted, proven by DRC grid evidence)

1. C4006-C4003 (AFE_3V0 vs GND): Audit-8 cascade cost of J2001 fix. C4006 tried
   S/E/W/N/NE/SE (6 positions); C4003 tried W/N/E/NE/base (5 positions). Column x=14
   fully packed (C4001/C4003/C4006). Requires package ECO (C4003 0805->0603 is
   NOT allowed: C4003 is 10u? verify value) or J2001 relocation (cascades).
2. R104-C6001 (VCM vs GND): R104 tried S/W/N/E/rot0/rot90 (6 positions, all hit
   refcaps or ADC-west pads). Requires refcap resectoring (blocked by ADC wall).
3. C6001-C6002 (VREFP vs GND): pre-existing refcap pair overlap; spread tried
   (walks into ADC-west pads). Requires smaller package (C6001 is 10uF 0805 -
   10uF 0603 exists but changes decoupling ESR/profile; needs EE review).

Each was probed in >=4 positions with exact DRC deltas; all moves either keep the
short or create worse ones. These transfer to routing-stage copper resolution
(short copper pours/absorption) or a focused decoupling-package ECO with EE sign-off.

## 7. J2001 verdict (unchanged from Audit 9)

VALID_EDGE_CONNECTOR_GEOMETRY. MP pads to y=-1.45 by stock-JST side-entry design.
Enclosure must allow the overhang. Electrically: charger residuals are clearances
(C4001/C4002 vs MP/pin3 at 0.12-0.15), not shorts.

## 8. Schematic diff summary

NONE. No schematic file was modified in Audit 10. Netlist unchanged (net count
and assignments preserved via reference-PCB header). ERC stable at 51 warnings
(50 lib-link + 1 isolated label, identical to baseline).

## Audit 12 - Architecture B (bottom-side support trio)

- Generator: mirror_body_to_bottom() added (neutral on F-side tree, verified
  by --check identity); BOTTOM_REFS += C4006, C6001, C6002.
- C4006 (LDO 1uF bypass) bottom at (15.0,3.5) behind charger cluster.
- C6001 (10uF) bottom at (6.0,19.0) + C6002 (0.1uF) bottom at (2.5,19.0) under
  ADS1294 VREF pins: shorter loop than top-side once short vias added
  (estimated 2 vias per cap, <1.5mm via-to-pin).
- Assembly: 3 small passives bottom (0402/0603/0805); no ICs/connectors moved;
  rework accessible (edge-adjacent, uncrowded bottom-west).
- Closers shipped: C4001e16.8, R3002e41.8, C6006s6.0, C4002e12.9, TP610s18.0,
  TP601n11.6, C6007w8.7, C6002w2.5.
- Result: 0 shorts (3 fixed, +0/-3); 2 marginal edge clearances documented
  (C4002 vs fixed J2001, proven optimum by sweep).
