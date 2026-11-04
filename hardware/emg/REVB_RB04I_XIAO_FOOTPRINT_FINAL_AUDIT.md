# RB-04I — XIAO U1 Footprint Final Audit (read-only)

Date: 2026-10-12. Branch `hardware/emg-rev-b`. **Read-only audit:** the canonical PCB, footprint, schematic and BOM were not modified (project hashes verify); U1 was not regenerated from the library; nothing was ordered, uploaded, sent, committed or pushed.
Tools: `tools/rb04i_u1_compare.py`, `tools/rb04i_keepout_check.py`; evidence `rev-b-xiao/evidence/rb04i/` (`u1_compare.json`, `keepout_check.json`, `keepout_overlay.png/.svg`).

## 1. Result

```
U1 MISMATCH EXPLAINED:                  YES
MISSING KEEP-OUT PURPOSE:               not missing — the 11 keep-out zones embedded in the library footprint exist as identical board-level
                                        rule areas; they keep tracks/vias/pour away from the module's exposed underside pads
                                        (TP1–TP8, pad 25, BAT− GND0, USB shell ovals) and vias out of the module footprint outside the via field
ACTUAL COPPER/GEOMETRY VIOLATIONS:      0
R1b CONSISTENCY:                        PASS (PCB instance = library = Gerber/drill)
FABRICATION CONSEQUENCES:               NONE
WARNING ACCEPTABLE AS DOCUMENTED:       YES
DESIGN CHANGES NEEDED:                  NO
READY FOR SUPPLIER CLARIFICATION & QUOTE: YES
```

## 2. What differs between the installed U1 and the library footprint

Both were transformed into absolute board coordinates (instance at (40.19, 54.3825), rotation 180°) and compared item by item (`u1_compare.json`).

| Class of item | Installed U1 vs library `ARTHUR:XIAO_ESP32S3_HANDSOLDER` |
|---|---|
| Pads (16: 14 castellations, 23 PTH, 23 B.Cu) | **identical**: position, size, drill, layers, mask margin; pad 23 = Ø2.30 land, Ø1.90 drill, margin −0.175 in both |
| F.Fab / F.SilkS / B.Fab / Dwgs.User / Cmts.User lines, rectangles, circles, arcs (36) and texts (6) | **identical** in absolute coordinates (the board instance stores the same shapes, only in a different local order/orientation) |
| **Keep-out zones** | library: **11 embedded**; board instance: **0 embedded**; the board has **11 board-level rule areas with the same names, layers, rules and polygons (maximum corner delta 0.000 mm)** |
| Properties | board: Reference on F.Fab (library: REF** on F.SilkS), Value hidden "XIAO_ESP32S3" (library: visible "XIAO_ESP32S3_HANDSOLDER"), plus the hidden metadata fields MPN/Manufacturer/Spec/Role/Status/JLC_Class/Description/Datasheet (library has none) |
| File-level | board instance carries `uuid`, `path`, `sheetname/sheetfile`, `embedded_fonts no`; library carries `generator`, `version` |

So the warning is **representational**: the instance was created by the placement script with the keep-outs promoted to board level (RB-02), and the properties are the schematic-linked ones. Nothing geometric or electrical differs.

## 3. The keep-out zones

| Zone | Layers | Rules | Tracks / vias found inside | Purpose (RB-00.6 §4, RB-02A D-3) |
|---|---|---|---|---|
| XIAO pads 15-22 underside | F.Cu | tracks not_allowed / vias not_allowed / pour not_allowed | 0 / 0 | module bottom pads TP1–TP8 (MTDI, MTDO, EN, GND, MTMS, MTCK, USB D−, USB D+): exposed copper over bare mask → no host track/via/pour beneath so a scra |
| XIAO USB shell oval S3 (GND) | F.Cu | tracks not_allowed / vias not_allowed / pour allowed | 0 / 0 | four GND through-plated USB-C shell ovals on the module underside: no tracks/vias (a GND pour is allowed) |
| XIAO pad 25 GND window | F.Cu | tracks not_allowed / vias not_allowed / pour not_allowed | 0 / 0 | module pad-25 GND window (exposed GND pour, 2.75 × 2.5 mm) → same |
| XIAO GND0 (BAT-) pad | F.Cu | tracks not_allowed / vias not_allowed / pour not_allowed | 0 / 0 | BAT− (GND0) module pad, +0.5 mm margin: keeps tracks/vias/pours away from the exposed battery-negative pad that sits 0.9 mm from BAT+ |
| XIAO USB shell oval S2 (GND) | F.Cu | tracks not_allowed / vias not_allowed / pour allowed | 0 / 0 | four GND through-plated USB-C shell ovals on the module underside: no tracks/vias (a GND pour is allowed) |
| XIAO USB shell oval S1 (GND) | F.Cu | tracks not_allowed / vias not_allowed / pour allowed | 0 / 0 | four GND through-plated USB-C shell ovals on the module underside: no tracks/vias (a GND pour is allowed) |
| XIAO USB shell oval S4 (GND) | F.Cu | tracks not_allowed / vias not_allowed / pour allowed | 0 / 0 | four GND through-plated USB-C shell ovals on the module underside: no tracks/vias (a GND pour is allowed) |
| XIAO no vias (above via field) | F.Cu, B.Cu, In1.Cu, In2.Cu | tracks allowed / vias not_allowed / pour allowed | 0 / 0 | module outline outside the "via field" (x 57.6–70.2 / y 12–17.2 in the RB-00.6 frame): no vias under the module except the tented via field, to keep s |
| XIAO no vias (below via field) | F.Cu, B.Cu, In1.Cu, In2.Cu | tracks allowed / vias not_allowed / pour allowed | 0 / 0 | module outline outside the "via field" (x 57.6–70.2 / y 12–17.2 in the RB-00.6 frame): no vias under the module except the tented via field, to keep s |
| XIAO no vias (west of via field) | F.Cu, B.Cu, In1.Cu, In2.Cu | tracks allowed / vias not_allowed / pour allowed | 0 / 0 | module outline outside the "via field" (x 57.6–70.2 / y 12–17.2 in the RB-00.6 frame): no vias under the module except the tented via field, to keep s |
| XIAO no vias (east of via field) | F.Cu, B.Cu, In1.Cu, In2.Cu | tracks allowed / vias not_allowed / pour allowed | 0 / 0 | module outline outside the "via field" (x 57.6–70.2 / y 12–17.2 in the RB-00.6 frame): no vias under the module except the tented via field, to keep s |

Independent check (own geometry on `ARTHUR_EMG_RevB.kicad_pcb`): **0 F.Cu tracks, 0 vias, 0 copper-pour polygons** inside any of the 11 areas; no pad of another part intersects them; KiCad DRC reports 0 keep-out violations. Overlay: `evidence/rb04i/keepout_overlay.png`.

## 4. Special regions

| Region | Finding |
|---|---|
| **BAT+ land / BAT− keep-out** | The only copper inside the GND0 keep-out and the "no vias (below via field)" area is U1 pad 23 itself (Ø2.30 PTH land and the B.Cu Ø3.0 pad); pads are "allowed" in both zones. Under R1b the land's edge is **0.247 mm** from the GND0 pad edge and enters the 0.5 mm margin band by **0.253 mm** (the original Ø1.90 ring did so by 0.053 mm). This is the documented RB-04F trade-off, not a rule violation; air-gap numbers (exposed copper ≥ 0.235 mm) are in RB-04F |
| **Module underside** | no mask-open host copper under the module; nearest foreign copper to any exposed module pad ≥ 0.61 mm (USB_PRESENT track to shell oval S3, outside the +0.5 mm margin), all mask-covered (RB-04C) |
| **U.FL / antenna** | the library has **no** copper restriction for the U.FL or antenna region — only comments (F.Fab U.FL box, Cmts.User "U.FL cable corridor (east)", Dwgs.User plug overmold): all identical in the installed instance. Host F.Cu within a 4 × 4 mm box at the U.FL: VBAT 0.5 mm track and AFE_EN_REQ 0.2 mm track; no vias. They are DC/slow signals below a connector whose RF path is inside the module; the U.FL cable corridor and antenna placement remain an **enclosure** task, not a PCB rule |
| 14 castellations / USB shell / pad-25 | geometry identical to the library; mask margin +0.05 on host pads; no keep-out applies |

## 5. R1b consistency across sources

| Source | Drill | Land (F.Cu / inner) | Mask opening | B.Cu pad |
|---|---|---|---|---|
| Installed PCB U1 pad 23 | 1.90 | 2.30 | 1.95 (margin −0.175) | 3.00 |
| Library footprint (`.kicad_mod`) | 1.90 | 2.30 | 1.95 (margin −0.175) | 3.00 |
| Gerber / drill (staging package; re-exported after RB-04H) | T2 Ø1.90 at (44.635, −54.790) | flash Ø2.30 on F.Cu, In1, In2 | F.Mask / B.Mask flash Ø1.95 | Ø3.00 with Ø3.00 mask |
| Position / net | (44.635, 54.790) / VBAT in all three | | | |

PASS: no value differs between the three sources.

## 6. Can the warning be accepted as documented?

Yes. The warning compares an *instance* with its *library definition*; the definition's only content absent from the instance is the set of 11 keep-out areas, which are present on the board as identical rule areas and are enforced by KiCad DRC (and by my independent check). The remaining differences are text/property presentation and metadata. Consequences:
* **Fabrication:** none — rule areas and F.Fab/Dwgs/Cmts text are not exported; silkscreen text is identical (Gerbers verified).
* **Electrical / RF / mechanical:** none; no restriction is violated; the U.FL/antenna region has no library restriction.
* **Maintenance risk (documentation only):** the keep-outs no longer move with U1. Any future change of U1's position must move the 11 board-level areas with it (they are named `XIAO …`); the frozen design needs no action. An "Update footprint from library" operation would rewrite the instance and add a second set of the same areas, so it is excluded by the freeze.
Suggested wording for the project record: "U1 `lib_footprint_mismatch` accepted since RB-02: instance flattened; 11 library keep-out zones exist as identical board-level rule areas; verified RB-04I."

## 7. Supplier clarification and quote

The U1 warning does not affect any item in the JLC or Seeed inquiries. The quote-only package (R1b, RB-04H) remains valid. Ready for supplier clarification and a preliminary quote: **YES**; ready to order: **NO** (JLC/Seeed confirmations and a physical module are pending).
