# RB-02E — Edge Clearance Report

Date: 2026-10-10. Tool: `rev-b-xiao/tools/rb02e_economic_audit.py`; data: `evidence/rb02e/edge_clearance.json|.csv`.
Board outline: 0 … 97 × 0 … 32 mm, 1.0 mm corner radius (corners ignored; measuring to the straight edge is conservative).

## 1. Method

* **Body** = the F.Fab outline of the footprint (KiCad standard library fab outlines are drawn from the manufacturer's body drawing).
  For the JST parts this was cross-checked against the JST datasheet (`ePH.pdf` p.4: B = 7.95 / 7.9 mm) and the LCSC part pages.
* **Courtyard** = F.CrtYd bbox (the keep-clear of the footprint, not the part).
* **Pad** = bounding box of all pads, retention tabs included (the copper that is actually soldered).
* **Overhang** = any of body, pads or courtyard outside the outline. Centre coordinates are never used as the edge distance.
* Rules: 2.5 mm body-to-edge (T&C DFM item 3, as written); 0.3 mm trace/component-to-edge (Economic FAQ item 14, suggested).
* Population: every top-side JLC part whose body, courtyard or pad is within 3 mm of any outline edge = **44 parts**
  (40 near the long edges, 4 near the short edges). The RB-02 "35" list is the subset reproduced by RB-02's C26 criterion
  (courtyard within 3 mm of the long edges, connectors, test points and U1 excluded) and is flagged in the table. The remaining 9
  are the 6 connectors (excluded from C26 by design), C7103/R7108 on the east edge and C503 (west).
* Status: PASS = body ≥ 2.5 mm and copper ≥ 0.3 mm; UNKNOWN = body < 2.5 mm but copper ≥ 0.3 mm (the 2.5 mm note is established
  as text, its applicability to Economic panels is not); FAIL = anything < 0.3 mm.

## 2. Result

| | Count |
|---|---|
| Top-side JLC parts | 126 |
| Within 3 mm of an edge (any metric) | 44 |
| of which on the RB-02 list | 35 (2 PASS, 33 UNKNOWN, 0 FAIL) |
| PASS (body ≥ 2.5 mm and copper ≥ 0.3 mm) | 89 of 126 (7 of the 44 near parts) |
| UNKNOWN (body < 2.5 mm) | 37 |
| FAIL (< 0.3 mm) | **0** |
| Smallest distance of any copper/tail to the edge | 0.50 mm (JST B2B signal tails, south edge) |
| JLC-assembled parts overhanging the outline | **0** (only U1, the DNP module, overhangs by 1.508 mm body / 1.608 mm courtyard — USB-C, intended) |

## 3. All edge-adjacent components

| Ref | RB-02 list | MPN | Footprint | Edge | Centre→edge | Body→edge | Courtyard→edge | Pad→edge | Overhang | 2.5 mm shift | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| J101 | conn. | B2B-PH-SM4-TB(LF)(SN) | JST_PH_B2B-PH-SM4-TB_1x02-1MP_P2.00mm_Vertical | south | 3.75 | 3.00 | 0.00 | 0.50 | no | 0.00 | PASS |
| J201 | conn. | B2B-PH-SM4-TB(LF)(SN) | JST_PH_B2B-PH-SM4-TB_1x02-1MP_P2.00mm_Vertical | south | 3.75 | 3.00 | 0.00 | 0.50 | no | 0.00 | PASS |
| J301 | conn. | B2B-PH-SM4-TB(LF)(SN) | JST_PH_B2B-PH-SM4-TB_1x02-1MP_P2.00mm_Vertical | south | 3.75 | 3.00 | 0.00 | 0.50 | no | 0.00 | PASS |
| J401 | conn. | B2B-PH-SM4-TB(LF)(SN) | JST_PH_B2B-PH-SM4-TB_1x02-1MP_P2.00mm_Vertical | south | 3.75 | 3.00 | 0.00 | 0.50 | no | 0.00 | PASS |
| J5001 | conn. | B2B-PH-SM4-TB(LF)(SN) | JST_PH_B2B-PH-SM4-TB_1x02-1MP_P2.00mm_Vertical | south | 3.75 | 1.23 | 0.00 | 0.50 | no | 1.27 | UNKNOWN |
| J1 | conn. | S2B-PH-SM4-TB(LF)(SN) | JST_PH_S2B-PH-SM4-TB_1x02-1MP_P2.00mm_Horizontal | north | 5.20 | 0.80 | 0.10 | 0.60 | no | 1.70 | UNKNOWN |
| R5003 | yes | generic (Basic, RB-03) | R_0603_1608Metric | west | 1.60 | 1.19 | 0.87 | 1.12 | no | 1.31 | UNKNOWN |
| R7107 | yes | generic (Basic, RB-03) | R_0603_1608Metric | north | 2.10 | 1.69 | 1.12 | 1.38 | no | 0.81 | UNKNOWN |
| R7106 | yes | generic (Basic, RB-03) | R_0603_1608Metric | south | 2.05 | 1.64 | 1.32 | 1.57 | no | 0.86 | UNKNOWN |
| C7103 | — | generic (Basic, RB-03) | C_0603_1608Metric | east | 2.10 | 1.70 | 1.37 | 1.62 | no | 0.80 | UNKNOWN |
| R7108 | — | generic (Basic, RB-03) | R_0603_1608Metric | east | 2.10 | 1.69 | 1.37 | 1.62 | no | 0.81 | UNKNOWN |
| C101 | yes | generic (Basic, RB-03) | C_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| C102 | yes | generic (Basic, RB-03) | C_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| C201 | yes | generic (Basic, RB-03) | C_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| C202 | yes | generic (Basic, RB-03) | C_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| C301 | yes | generic (Basic, RB-03) | C_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| C302 | yes | generic (Basic, RB-03) | C_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| C401 | yes | generic (Basic, RB-03) | C_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| C402 | yes | generic (Basic, RB-03) | C_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| C5001 | yes | generic (Basic, RB-03) | C_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| C5002 | yes | generic (Basic, RB-03) | C_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| R103 | yes | generic (Basic, RB-03) | R_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| R104 | yes | generic (Basic, RB-03) | R_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| R107 | yes | generic (Basic, RB-03) | R_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| R108 | yes | generic (Basic, RB-03) | R_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| R203 | yes | generic (Basic, RB-03) | R_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| R204 | yes | generic (Basic, RB-03) | R_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| R207 | yes | generic (Basic, RB-03) | R_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| R208 | yes | generic (Basic, RB-03) | R_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| R303 | yes | generic (Basic, RB-03) | R_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| R304 | yes | generic (Basic, RB-03) | R_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| R307 | yes | generic (Basic, RB-03) | R_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| R308 | yes | generic (Basic, RB-03) | R_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| R403 | yes | generic (Basic, RB-03) | R_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| R404 | yes | generic (Basic, RB-03) | R_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| R407 | yes | generic (Basic, RB-03) | R_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| R408 | yes | generic (Basic, RB-03) | R_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| R5004 | yes | generic (Basic, RB-03) | R_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| R5005 | yes | generic (Basic, RB-03) | R_0603_1608Metric | north | 3.20 | 2.40 | 1.72 | 1.98 | no | 0.10 | UNKNOWN |
| R4001 | yes | generic (Basic, RB-03) | R_0603_1608Metric | north | 2.80 | 2.39 | 2.07 | 2.33 | no | 0.11 | UNKNOWN |
| R3009 | yes | generic (Basic, RB-03) | R_0603_1608Metric | south | 2.90 | 2.49 | 2.17 | 2.42 | no | 0.01 | UNKNOWN |
| C503 | — | generic (Basic, RB-03) | C_0603_1608Metric | west | 3.00 | 2.60 | 2.27 | 2.52 | no | 0.00 | PASS |
| R7105 | yes | generic (Basic, RB-03) | R_0603_1608Metric | south | 3.60 | 3.19 | 2.87 | 3.12 | no | 0.00 | PASS |
| U4002 | yes | TPS7A2030PDBVR | SOT-23-5 | north | 4.60 | 3.15 | 2.90 | 3.35 | no | 0.00 | PASS |

(Distances in mm; "2.5 mm shift" = inward movement needed for the body to reach 2.5 mm.)

## 4. Components that matter

* **J101, J201, J301, J401** (B2B-PH-SM4-TB, top entry): housing is 7.95 × 5.0 mm at y 24.0–29.0, **3.0 mm** from the south edge — PASS
  on body. The solder tails of pads 1/2 run to y = 31.5, **0.5 mm** from the edge, and the courtyard touches the edge (0.00).
  Those tails are copper under the housing's own footprint, 0.2 mm above the 0.3 mm note. The LCSC overall-depth figure (6.6 mm)
  is consistent with housing + tails and ends inside the board. The mating PHR-2 plug seats from above; it is expected to stay within the housing footprint but its exact outline was not measured.
* **J5001** (same part): body is 1.23 mm from the **west** edge (x = 1.23). UNKNOWN on the 2.5 mm note; 1.28 mm inward shift would
  collide with J101's retention pad (x = 10.4), so the minimum literal fix is a re-pitch of the connector row, not a nudge.
* **J1** (S2B-PH-SM4-TB, side entry, battery): housing 7.9 × 7.6 mm at y 0.8–8.4: **0.8 mm** from the north edge, opening faces the
  north edge (from the footprint geometry: tails to the south, retention tabs to the north), so the battery plug and cable leave the board. The mating plug (not a factory part) therefore overhangs the
  outline. This is the tallest part in the closest position and the single part with a genuine guide-rail question if JLC places
  with the board edge on a rail. 1.7 mm of inward travel would run into the XIAO courtyard (y ≥ 10.36).
* **0603 row at y = 3.2 (24 parts, Zone A north)**: body 2.40 mm from the edge, i.e. 0.10 mm short of 2.5; copper 1.975 mm.
* **R4001** (0.113 mm short), **R3009** (0.013 mm short): same family.
* **R5003** (west, 1.19 mm), **R7106** (south, 1.64 mm), **R7107/R7108/C7103** (north/east, 1.69–1.70 mm): the only 0603s more than
  0.8 mm short.
* **U4002** (SOT-23-5, 3.15 mm), **R7105** (3.19), **C503** (2.60): PASS.

## 5. Minimum adjustments *if* JLC enforces 2.5 mm literally (NOT applied — preserved placement)

| Group | Parts | Inward move | Side effect |
|---|---|---|---|
| North row, Zone A | 24 passives at y 3.2 + R4001 | +0.10 / +0.12 mm in y | none expected (free space to U501/U502 courtyards); re-run RB-02 C07/C24 |
| R3009 | 1 | −0.02 mm in y | none |
| East strip | R7107, R7108, C7103 | ≈ 0.8 mm west | J1 courtyard (x ≤ 93.1) is the neighbour; fits |
| R7106 | 1 | ≈ 0.9 mm north | column E1/E2 spacing to be checked |
| R5003 | 1 | ≈ 1.3 mm east | collides with R5004 (1.6 mm pitch) — row re-pitch |
| J5001 | 1 | ≈ 1.3 mm east | collides with J101 pads — row re-pitch of all five connectors |
| J1 | 1 | ≈ 1.7 mm south | collides with XIAO courtyard — would need the module or J1 re-arranged; not a "small" fix |

Because the applicability is UNKNOWN, none of this is justified yet. The cheapest way to settle it is the JLC DFM/quote check of the
real manufacturing package; a 0.1 mm nudge of the north row can be applied at that point if JLC cites the 2.5 mm note.

## 6. Conclusions

1. No part prevents Economic assembly on a published capability limit.
2. No part is within the 0.3 mm Economic depanelling note.
3. 37 parts are UNKNOWN solely against the 2.5 mm T&C note; 24 of them are 0.10 mm short.
4. J1 is the only structural exception (0.8 mm, tall part, plug leaves the board by design).
