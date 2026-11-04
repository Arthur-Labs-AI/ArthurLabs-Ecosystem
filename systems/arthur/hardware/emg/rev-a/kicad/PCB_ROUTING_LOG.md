# ARTHUR EMG Rev A — PCB Routing Log

## Routing Pass 1 — Reference / VCAP / RLD + Critical Analog (2026-09-21)

### Pre-route rule enforcement

- `ARTHUR_EMG_RevA.kicad_dru` is a GUI-import sidecar: KiCad 10.0.6 `kicad-cli pcb drc`
  does NOT auto-load it (proven: deliberate inner-layer EMG probe track produced no
  custom-rule hit; bare `(custom_rules)` in `.kicad_pcb` fails to load: "Unknown token").
- Deterministic enforcement channel instead: `net_settings.classes` +
  `netclass_assignments/patterns` (15 classes, 52 nets) in `.kicad_pro` mirrored as
  `net_class` in `.kicad_pcb`, plus board-rule minima. Proven: probe track overlapping
  a foreign pad flags `shorting_items`+`clearance` through the CLI.
- `.dru` header corrected to describe it as the human/GUI-importable source; no DRC
  exclusions anywhere (`drc_exclusions: []`).
- USB diff settings present in class (`0.20/0.20 mm`) but provisional (no fab stackup yet).

### Placement

- `pl_place.py --check`: placement identical before routing; footprint-block hash
  `85489ed448fc2576bdbbf47c953ffa3e` unchanged after routing (106 footprints,
  72 F.Cu / 34 B.Cu). No footprint moved (no ECO).
- PCB md5 after pass: `67b0ff6342f6b42bf8becedee08c1c45` (emitter `emit_p1v`, deterministic).

### Nets routed (this pass only)

| net | endpoints | layers | vias | approx length | DRC |
|---|---|---|---|---|---|
| VREFP_2V4 | U6001-24 → C6001-1 + C6002-1 | F.Cu 7.8 / L3 9.5 / B.Cu 5.7 | 3 | 23.0 mm | 0 shorts; U23-proximity clearance (see deviations) |
| VCAP1 | U6001-28 → C6003-1 | F.Cu 4.9 / L3 9.1 | 2 | 14.0 mm | 0 shorts; R204/VIA proximities (see deviations) |
| VCAP2 | U6001-30 → C6004-1 | F.Cu 2.9 / L3 4.1 | 2 | 7.0 mm | 0 shorts; R303/C301 proximities (see deviations) |
| VCAP3 | U6001-55 → C6005-1 | F.Cu 8.0 / L3 4.7 | 2 | 12.8 mm | 0 shorts; RLD-adjacency proximities (see deviations) |
| VCAP4 | U6001-26 → C6006-1 | F.Cu 8.6 / L3 11.8 | 2 | 20.4 mm | 0 shorts; C6005/C5001 proximities (see deviations) |
| VCM | U6001-60 ↔ U6001-62 (local tie) | F.Cu 4.8 | 0 | 4.8 mm | 0 shorts; U61-adjacency proximity (see deviations) |
| RLDINV | U6001-61 → R5001-2 (+C5001-2 pad-shares R5001 body) | F.Cu 3.4 | 0 | 3.4 mm | 0 shorts; RLDOUT/VCM proximities (see deviations) |
| RLDOUT | U6001-63 → R5001-1 (+C5001-1) local triangle | F.Cu 11.3 (incl. C5001 link) | 0 | 11.3 mm | 0 shorts; RLDINV/VCM proximities (see deviations) |
| GND (ref returns only) | U25/U31/U32 → B.Cu trunks to C6001/C6002 GND pads | F.Cu 8.8 / L3 24.3 / B.Cu 15.6 | 4 | 48.7 mm | 0 shorts; U26-proximity (see deviations) |

Continuity proof (`recover/proof_connectivity.py`, copper-extent union-find): every
routed endpoint pair above joins through copper (single pad-group per completed net).
VCM R_BIAS tails (R103–R404, TP602), RLDOUT R5002-1/TP603, and RLD_SAFE remain
intentionally open (deferred endpoints, see below).

TP603 decision (asked, approved): TP603 left UNROUTED. The ~13 mm RLDOUT→TP603 stub
would cross the analog field; it routes in a later pass under a stub rule.

### Vias used: 15 total

- VREFP: (12.0,25.0), (7.6,16.6), (5.2,19.5)
- GND-ref: (15.55,17.6), (6.0,6.0), (18.1,22.6), (17.0,25.5)
- VCAP1: (15.8,20.3), (12.3,25.9)
- VCAP2: (19.4,22.0), (19.7,26.1)
- VCAP3: (11.0,14.0), (10.5,9.3)
- VCAP4: (14.7,18.2), (11.4,6.9)
- All 0.8/0.4 through vias. No blind/buried/micro vias. No stitching fences yet.

### Routing rationale (frozen rules applied)

- VREF first: U24 north-exit diagonal → L3 wall-jump (JST-MP/C6007 wall proven
  no-fit in F.Cu) → F.Cu south → B.Cu trunk y=20.3 with dedicated stubs into
  C6001/C6002 VREFP pads; GND companion parallel with dedicated return stubs.
- VCAP1/2/4 north wall (0.5-pitch pad row + C6003/C6004) proven no-fit in F.Cu →
  short F.Cu exits to adjacent L3 vias, L3 transit (empty layer), land at pads.
- VCAP3 all-F.Cu northern corridor (y=14.0) + L3 hop over RLD zone.
- VCM: local U60–U62 tie only; 8× R_BIAS tails deferred to EMG pass (co-route).
- RLD: local triangle U63/R5001/C5001 + RLDINV spur; RLD_SAFE/J5001 deferred.
- L3 used ONLY for documented wall-crossings (frozen-rule justified exception);
  L4 carries no analog; L2 untouched (no cuts).

### Deviations from frozen rules

- L3 transit for VCAP1/2/4 + VREFP/GND-ref (justified above; no F.Cu path exists).
- 20 route-caused proximities (edge gaps 0.04–0.19 vs 0.2 minimum) remain:
  VREFP/U23-U26, VCAP1/R204 + VIA-VIA, VCAP2/R303/C301 + GND-diag,
  VCAP3/RLD, VCAP4/C6005/C5001, VCM/U61, RLDINV/RLDOUT/VCM, GND/VCAP1,
  +1 solder-mask bridge (GND/R204) +1 hole clearance (VCAP4 VIA/C5001).
  Nine isolated geometry attempts (c1, c2, c3-combined, t1, u1, u2, v1, f1, g1)
  were made single-change-at-a-time against the regression guard; each introduced
  equal-or-worse violations and was reverted per protocol (guard logs in session).
  Root causes established: (a) KiCad rot90 footprint convention is
  clockwise-positive — all hand-calcs assuming CCW mirrored rot90 pads (R10x/R20x/
  R30x/R40x/C6004), fixed in `recover/geocheck.py`; (b) DRC reports copper-EDGE
  gaps, so estimates must subtract track half-width + pad extent, not centers;
  (c) the U25/U26-south pocket (x 14.4–15.6, y 21.5–22.4) is at 100% packing —
  GND + VCAP4 + VCAP1 + R202/R204 pads admit no further F.Cu juggling.
  These 20+2 are NOT shorts (0 shorting_items, 0 tracks_crossing) but the gate
  `new real routing clearances = 0` is NOT met → verdict BLOCKED (see below).
  ECO candidate for the next attempt: 0.5 mm placement relief in the pocket
  (R202 or VCAP4-exit corridor) or acceptance with fabrication note.

### DRC before/after

- Before (pre-route): total 617, shorts 0, crossings 0, clearance 14,
  mask-bridge 3, hole 0, unconnected 269.
- After: total 641, shorts 0, crossings 0, clearance 34 (+20), mask-bridge 4 (+1),
  hole 1 (+1), dangling-track warnings +2 (route endpoints at pad edges, benign),
  unconnected 255 (−14 pads joined by copper).
- Guard (`recover/guard_p1.py`): shorts=0 crossings=0 zones=0 → PASS on hard gates.
- Independent geometric verifier (`recover/geocheck.py`, copper extents, CW
  rotation): 7 true overlaps flagged — all 7 are the sub-0.2 pocket proximities
  above measured edge-to-edge (the 'clean' 0/0 checkpoint DRC under-reports
  ordering-dependent proximities; the verifier is authoritative for gaps).
- No DRC exclusions added. Antenna keepout intact (max route x = 19.7 < 30).
- Zones: 0. Segments: 60. Vias: 15.

### Renders

- `recover/render_p1_top.png`, `recover/render_p1_bot.png`: reference region shows
  short local fanout + vias; RF east area empty; B.Cu shows bottom-cap trunks.

### Remaining unrouted (out of scope, verified no copper)

- CH1–CH4 long EMG pairs, SPI/control, USB D+/D−, switching loops, MCU digital,
  SWD, power distribution. RLD_SAFE/J5001, R5002, TP603, VCM tails/TP602 deferred.

---

ROUTING PASS 1: BLOCKED
CRITICAL REFERENCE NETWORKS: INCOMPLETE (connected but 20+2 proximities remain)
READY FOR EMG INPUT ROUTING: NO

## Routing ECO 1 — U25/U26 Pocket Relief (2026-09-21)

Pocket mapped with copper extents (geocheck authoritative, CW rotation fixed):
binding gap R204pad2-east (15.925) / R303pad1-west (16.525) = 0.60 < 0.70.

ECO (generator sources only): R303 17.00 → 17.30 (+0.30 x, single component).
E2a (R204 west) tried and reverted (2 new shorts, guard-caught).
Unrouted ECO board: 615 total, 0 shorts, 14 clearances, 73 courtyards,
269 unconnected; double regen byte-identical; input/RF/outline unchanged.
Analog: rigid +0.30 east; CH3 stub −0.27, VCM tail +0.18 (negligible, 390k).

Pass-1 topology (emit_p1v) reapplied unchanged: 60 segments, 15 vias, 0 zones.
Fresh DRC: total 639, shorts 0, crossings 0, clearance 34, mask 4, hole 1,
unconnected 255. Guard PASS on hard gates.
Route adaptation attempts in the relieved corridor (f2, f3, f4 single-changes)
each failed guard (collisions with VCAP1 feed/VIA1) and were reverted; the 20
proximities persist (translated with R303), so the clearance gate is not met.
TP603/R5002/VCM-tails remain deferred; scope intact (no out-of-pass copper);
keepout intact (max x 19.7); renders `recover/render_eco_top|bot.png`.

ROUTING ECO 1: PASS
ROUTING PASS 1: BLOCKED
CRITICAL REFERENCE NETWORKS: INCOMPLETE
READY FOR EMG INPUT ROUTING: NO

## Audit 14 — Critical Analog Pocket Re-layout + Pass 1B (2026-09-21)

Stackup: 1.6 mm FROZEN (file envelope = order target; USB provisional/forbidden).
Keepout: Raytac Spec Ver.L §2.3/§2.2 — 10.5x3.8 mm no-ground each layer +
1.6x1.2 mm top cutout; dimensions FROZEN, KiCad rule_area objects pending
(no Pass-1 copper near RF). Evidence files preserved untouched.
Pocket map: `audit14/pocket_map.py` (copper extents, CW rotation).
Floorplan search: cluster-E, C2, C3, C4, R303-rot0 all REJECTED with DRC
evidence (shorts/courtyard each); WINNER C1 = E3 solo (R303 +0.30 east).
Placement: E3 proven (615 total, 0 shorts, deterministic double regen).
Pass 1B routing: p1v topology on E3 board — 60 segments, 15 vias, 0 zones;
VREFP ~23.0/3, VCAP1 ~14.0/2, VCAP2 ~7.0/2, VCAP3 ~12.8/2, VCAP4 ~20.4/2
(same lengths: corridor exploitation needs VCAP1-feed redesign, blocked by
unmoved R204; no detour improvement claimed). Fresh DRC: total 639,
shorts 0, crossings 0, clearance 34 (+20 vs 14), mask 4 (+1), hole 1 (+1),
unconnected 255. Guard PASS on hard gates. TP603/R5002/VCM-tails deferred.
Renders: `audit14/render_1b_top|bot.png`. Scope intact; keepout intact.

PHYSICAL STACKUP: FROZEN
RF KEEPOUT: FROZEN + DOCUMENTED (physical rule_area objects pending)
CRITICAL ANALOG FLOORPLAN: PASS
CRITICAL ANALOG ROUTING: BLOCKED (20 proximities persist)
PCB AUDIT 14: BLOCKED
READY FOR EMG INPUT ROUTING: NO

## Audit 15 — VCAP1 Feed Redesign + RF Keepout Implementation (2026-09-21)

RF keepout: IMPLEMENTED + VERIFIED (4 rule_areas, spec dimensions, probe-hit,
0 real flags). Stackup 1.6 mm reaffirmed (file envelope = order target).
Evidence preserved untouched. New workspace `audit15/`.
Pocket co-design: 16-combo grid + candidates C2/C3/C4/rot0 (all rejected with
DRC evidence: VREFP-collision, courtyard, 4-shorts, short+courtyard).
F1 (R204 -0.25) won placement (614/0/73, gap 1.15) but route adaptation into
it failed guard (pocket-ladder unmasking); reverted to E3-solo + p1v routing.
Final: 60/15/0copper (+4 keepouts), shorts 0, crossings 0, clearance +20,
mask +1, hole +1, unconnected 255. Route lengths unchanged from Audit 14
(VREFP 23.0/3, VCAP1 14.0/2, VCAP2 7.0/2, VCAP3 12.8/2, VCAP4 20.4/2) —
no material improvement achieved; detour ratios unimproved.
TP603/R5002/VCM-tails deferred; scope/keepout/renders verified.

PCB AUDIT 15: BLOCKED
RF KEEPOUT IMPLEMENTATION: PASS
CRITICAL ANALOG ROUTING: BLOCKED
READY FOR EMG INPUT ROUTING: NO
