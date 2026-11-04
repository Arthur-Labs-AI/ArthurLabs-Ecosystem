# RB-04D — XIAO ESP32-S3 Plain vs Sense: Final Selection

Date: 2026-10-12. Branch `hardware/emg-rev-b`. Canonical PCB sha256 `111e1cd3d0c9fae1…` (unchanged). **Nothing was modified in the canonical PCB, schematic or BOM; nothing ordered, no manufacturer contacted, nothing committed, pushed or released.**
All PCB experiments ran on scratch copies (`/tmp/rb04d`, tool `tools/rb04d_post_hole_experiment.py`, results `evidence/rb04d/`). No electrical-safety approval and no permission for human electrode use is implied. Builds on `REVB_RB04C_*`.

## 1. Answer first

**Option D — neither module is sufficiently verified; the smallest evidence needed is ONE real Seeed module (a plain, ideally together with a Sense), measured — and the BAT+ post hole should be enlarged on the footprint regardless of the variant.**
Both modules are expected to be mechanically and electrically the same main board for everything Rev B uses, so the likely end state is **Option C (both compatible; buy the cheaper plain)** — but that cannot be proven from documents, and the plain module has no CAD of its own at all.

| Question | Answer |
|---|---|
| Does either module fit with ZERO PCB changes? | Nominally yes (0.000 mm on the footprint). Under the **worst-case stack** the BAT+ post needs a hand-shift of **0.29 mm** (Ø1.0 solder cone) or 0.34 mm (Ø1.1) vs an allowance of 0.20 mm — **neither fits with zero changes by worst-case criteria**; the same for both modules. |
| Smallest safe change | BAT+ post hole **Ø1.40 → Ø1.70, ring Ø1.90 → Ø2.10, mask opening Ø1.45 → Ø1.75** (U1 pad 23 only). Scratch DRC: 0 errors, 0 unconnected, parity 0. |
| Copper routing affected? | No track, via or net changes; one footprint pad grows by 0.1 mm radius, the In1/In2 plane fills re-flow around the hole. |
| Schematic affected? | No (neither module needs a schematic change). |
| Re-verification | Re-run DRC/ERC, RB-04 audit suite, RB-05 Gerber package (new Gerbers, new drill tool 1.70 mm) and mask/via audit. |
| JLC Economic PCBA affected? | No: the hole is not assembled, BOM/CPL unchanged, U1 stays DNP. Fabrication-side only (one drill size change). |
| Enclosure affected? | No. |

## 2. What differs between Plain and Sense (evidence, with its quality)

| Item | Plain (PN 202003751 / SKU 113991114) | Sense (PN 202003753 / SKU 113991115) | Source quality |
|---|---|---|---|
| Main-board CAD published | **none**; Seeed's "plain v1.4 SCH&PCB" archive is byte-identical to the Sense v1.5 archive | Sense v1.5 KiCad PCB + schematic Rev V1.3 (2026-02-10), STEP, DXF | files hashed 2026-10-12 (`evidence/rb04c/sources_sha256_2026-10-12.txt`) — high |
| Is the published file the module's own design? | **No** — mislabelled | **Yes** (title "XIAO ESP32-S3-Sense", file name = PN 202003753) | high |
| Main-board mechanics | assumed identical to Sense main board | reference | Seeed's own *plain* 3D render shows the same outline, castellations, USB-C, U.FL, bottom pads and a populated **B2B connector (J3)**; wiki summary says the base Sense PCB differs by the B2B connector — see caveat | render: high; wiki text: **medium** (fetch tool summaries were inconsistent) |
| B2B connector (DF40C-30DP, top side, far end beside U.FL) | present in the plain render | present; camera/mic/SD expansion board plugs into it | Seeed render. **It is not an additional feature for Sense**; on both modules it sits on the top face, so it has no host-board consequence |
| Expansion board | none | **detachable**; remove by sideways sliding (wiki: vertical prying bends B2B pins). Attached it is ≈ 15 mm tall → unusable under the 17 mm enclosure target | wiki — medium |
| Charge current | 50 mA fast / 3.8 mA trickle | 100 mA fast / 0.9 mA trickle; file R10 = 220 kΩ → 110 mA | wiki + schematic — the only documented electrical difference |
| 5V pad / battery behaviour | "no voltage on the 5V pin on battery" | same | wiki + schematic |
| 3V3 output | "can draw 700 mA" | same | wiki |
| Dimensions | 21 × 17.8 mm | 21 × 17.8 mm (+ expansion height) | wiki; CAD 17.78 × 21.135 |
| PCB thickness, tolerances, finish | **unknown** | **unknown** | no Seeed document |
| Retail revision | unknown (label "v1.4") | unknown (label "v1.5"; file history v1.0 2023 … v1.3 2025-10-21; older lots may still be in the channel) | no Seeed document |
| Price (Seeed shop, 2026-10-12) | **$7.49** | **$13.90** | shop page |
| Other retail | The Pi Hut £7.30; DigiKey ≈ 915 in stock | The Pi Hut £13.50; Mouser 263 in stock (990 on order) | search results — medium |

## 3. Independent compatibility comparison against the canonical Rev B board

Because the main-board design file is a single one, the **geometric** result is the same for both (RB-04C overlay):

| Criterion | Result (either module, Sense v1.5 CAD) |
|---|---|
| Outline, 14 castellations, numbering | 17.78 × 21.135; 14/14 at 0.000 mm; D0…D6 (pins 1–7), D7, D8, D9, D10, 3V3, GND, 5V (pins 8–14) |
| BAT+ / BAT− | BAT0 (4.445, 10.160), GND0 (4.445, 8.255) in module (u, v); pitch 1.905; pad 2.032 × 1.016; host hole at BAT0 centre (0.000 mm) |
| Bottom features | 8 TPs, pad-25 window, 4 shell ovals, 2 NPTH; no mask-open host copper under them; nearest foreign copper 0.61 mm (mask-covered) |
| USB-C / U.FL | USB end flush with the board edge, 1.508 mm overhang; U.FL (45.04, 45.54), 1.84 mm from J1 |
| Heights | main board only (B2B ≈ 1.1 mm, USB-C ≈ 3 mm above the module PCB, STEP not authoritative); 17 mm target set by the 6.6 mm JST connectors, not the XIAO |
| Hand-solder access | RB-03S model: 45°/60° clear; 30° toes 12/13 short by 0.13 mm — identical for both |
| Enclosure | identical; **Sense only** with the expansion board removed (attached ≈ 15 mm module) |

**Not shown by CAD for either:** PCB thickness, outline/pad tolerances, finished post geometry, real retail revision. "A nominal CAD match is not a real-world fit" applies equally to both.

## 4. Electrical comparison against the Rev B schematic

Pin mapping (D0 VBAT_SENSE, D1 DRDY, D2 SYNC/RESET, D3 AFE_EN request, D6 USB presence, D7 CS, D8 SCLK, D9 MISO, D10 MOSI, 3V3 → FB1 → DVDD_F, 5V → inhibit divider, BAT+ → VBAT) is identical on both and matches the net list; see `REVB_RB04C_XIAO_ELECTRICAL_MATRIX.md`.

| Topic | Plain | Sense |
|---|---|---|
| Power path (Q1 + D2 + SGM6029 buck) | same circuit per Sense schematic; plain not published | as published |
| Charger / current | SGM40567-4.2 class; ≈ 50 mA per wiki (resistor value not published) | 110 mA (R10 220 kΩ) |
| USB VBUS behaviour, inhibit | 5V pad = raw VBUS; inhibit input valid | same |
| Boot / reset | strapping D2 (GPIO3), UART0 on D6/D7 identical (same ESP32-S3R8) | same |
| Backpower | none found from Rev B into the 5V rail | same |
| Charging a ~0.5 Ah 1S cell | ≈ 0.1 C (slow, safe) | ≈ 0.2 C (fine); cell must be 4.2 V with PCM on either |
| Schematic change needed | **none** | **none** |

The one electrical difference that matters to the user is charge time; neither requires a circuit change. Rev B has no battery protection or reverse-polarity protection under either module (carried from RB-04C).

## 5. BAT+ / BAT− minimum-change study (scratch experiments)

Stack basis (RB-04C §4): post-on-pad ±0.25, module pad registration ±0.10 (assumed), JLC hole position ±0.075, datum 0.022 → post-axis-to-hole error **0.447 mm** linear (0.28 RSS); finished hole −0.08/+0.13; castellation rule: shift ≤ 0.20 mm keeps toe ≥ 1.0 mm and copper overlap ≥ 1.0 mm. The VBAT ring sits under the module next to the GND0 pad (BAT−).

| Option | Hole / ring / mask | Shift needed, cone Ø1.0 / Ø1.1 / Ø1.2 (mm) | Ring edge → GND0 pad edge, nominal / at a 0.20 mm shift | Scratch DRC | Verdict |
|---|---|---|---|---|---|
| **V0 current** | 1.40 / 1.90 / 1.45 | 0.287 / 0.337 / 0.387 | 0.447 / 0.247 | 0 err | cone fits only if the module is shifted 0.09–0.19 mm beyond the 0.20 allowance (toe 0.91 / 0.86 / 0.81 mm); **fails worst case** |
| V0 + jig (post-on-pad ±0.15) | unchanged | 0.187 / 0.237 / 0.287 | same | — | meets Ø1.0 only; relies on an unbuilt jig/process: **not accepted as the primary fix** |
| V1 | 1.60 / 2.00 / 1.65 | 0.187 / 0.237 / 0.287 | 0.397 / 0.197 | 0 err, 0 unconn. | Ø1.0 cone only |
| **V2 (recommended)** | **1.70 / 2.10 / 1.75** | **0.137 / 0.187 / 0.237** | **0.347 / 0.147** | **0 err, 0 unconn., parity 0** | meets the procedure limit (Ø ≤ 1.1) inside the 0.20 mm allowance; ring annulus 0.20 mm (JLC "recommended") |
| V3 | 1.80 / 2.20 / 1.85 | 0.087 / 0.137 / 0.187 | 0.297 / 0.097 | 0 err | more margin, thinner BAT− gap; not needed |

**BAT− without relying on solder mask:** in V2 the ring edge stays ≥ 0.147 mm (air gap in plan view) from the GND0 pad edge at the maximum allowed shift; the mask is a second barrier, not the only one. In the current V0 the gap at the *worst-case cone-fit shift* (0.29 mm) is 0.157 mm — the problem is not BAT− but that the required shift exceeds the toe rule.
Cone-to-GND0 edge ≥ 0.59 mm for a Ø1.1 cone at the pad's limit (unchanged).

**Alternatives rejected:** (a) shrinking the cone to Ø0.8 — a 0.145 mm fillet on a 1.0 mm-high pad is a weak BAT+ joint; (b) an oval slot — only helps along the pad's long axis, the critical axis is across the 1.016 mm height; (c) reflow-style pad (no post) — requires hot plate/paste, outside the hand-solder concept; (d) bottom-fed joint through the hole (no pre-formed cone) — possible, untested capillary fill across 1.6 mm with 0.45 mm gap, keep as a trial item.

**Both variants:** the BAT pad geometry is the same, so one footprint change serves Plain and Sense. The change does **not** depend on which module is bought.

## 6. Cost and sourcing (two prototypes)

| Item | Plain | Sense |
|---|---|---|
| Module price (Seeed shop) | $7.49 | $13.90 |
| Two modules | **$14.98** | **$27.80** (+ $12.82) |
| Availability | in stock (shop; DigiKey ≈ 915) | in stock (shop; Mouser 263 + backorder) |
| Extra parts | none (6 mm AWG24 post, solder) | none; expansion board is unused waste; removal tool = none |
| Rework risk | — | expansion board removal can bend B2B pins (cosmetic, no effect on Rev B) |
| PCB redesign cost (V2 hole change) | same for both: footprint edit + 1 fill/DRC/export cycle (no routing work) | same |
| Soldering difficulty | identical | identical |

Shipping/tax not included. A reference unit of each costs **$21.39** before shipping — the cheapest way to close the identity question.

## 7. Final comparison table

| Criterion | Plain | Sense |
|---|---|---|
| Exact geometry verified | **No** (no plain CAD; indirect evidence only) | **Design file yes** (file = PN); retail revision and real part **no** |
| PCB modifications required | 1: BAT+ hole 1.70 / 2.10 / 1.75 (worst-case criterion) | same 1 |
| Schematic modifications required | none | none |
| BAT+ compatibility | CONDITIONAL until V2 + one measured sample | CONDITIONAL until V2 + one measured sample |
| BAT− clearance | ≥ 0.147 mm air gap at max allowed shift (V2); mask second barrier | same |
| Soldering difficulty | moderate (post cone, 14 castellations) | same; extra step to detach the expansion board first |
| Enclosure compatibility | PASS/CONDITIONAL as RB-04C (17 mm set by connectors) | same, **only with the expansion board removed** |
| Price per module | $7.49 | $13.90 |
| Risks | plain-module revision/geometry unproven; slow 50 mA charge | higher price; B2B pin bend on removal; retail revision unproven; charge 110 mA (needs cell ≥ ~0.25 Ah at 0.5 C) |
| Physical validation required | **Yes**: thickness, outline, pad positions, charger R10, boot behaviour | **Yes**: same list |

## 8. Final recommendation

**Option D now, converging on Option C:**

1. **Do not choose Sense merely because its CAD was used, and do not assume the plain module matches it.** The evidence for plain = Sense mechanics is (i) one published file under both names, (ii) Seeed's own plain render, (iii) the wiki's statement of the same board. That is strong circumstantial evidence, not a guarantee.
2. **Cheapest resolution (about $21 + shipping, or a written Seeed answer):** obtain one plain and one Sense module and measure them against `REVB_RB04C_XIAO_COMPATIBILITY_AUDIT.md` §7 (thickness, outline, castellation and BAT pad positions, charger resistor, boot states). If both match within ±0.1 mm, **buy the plain** (Option C: $6.41 cheaper per module, no expansion-board step). If the plain deviates, use Sense (design file = PN) with the expansion removed.
3. **Apply the one PCB change (V2) before any manufacturing order**, independently of the module, as the worst-case stack requires it.

### Required PCB changes (complete list)

| # | Change | Object | Impact |
|---|---|---|---|
| R1 | U1 pad "23" (PTH): drill 1.40 → **1.70 mm**, copper size 1.90 → **2.10 mm**, mask margin −0.225 → **−0.175 mm** (mask opening 1.75 mm). B.Cu Ø3.0 pad, net, position **unchanged** | `XIAO_ESP32S3_HANDSOLDER` footprint / PCB | re-fill In1/In2, re-run DRC/ERC, RB-04 audit suite, RB-05 package (new drill file with 1.70 mm tool), JLC inquiry update (one drill-size line) |
| — | No other PCB, schematic, BOM, CPL or routing change | — | Economic PCBA, enclosure unaffected |

Mandatory *non*-PCB items: install-procedure cone limit Ø ≤ 1.0 mm target / 1.1 mm max stays; add a go/no-go gauge for the cone; the first-article dry-fit (RB-04C §7).

### What cannot be resolved without a real sample

PCB thickness; true outline and pad tolerances; whether the retail plain's BAT0/GND0 pad finish, size and position equal the Sense file; the real charger resistor/current; boot behaviour on D2/D6/D7; the achievable post cone and joint strength; the real iron-access feel at 30°. None of these can be closed from Seeed's published files.

```
SELECTION:                       OPTION D (neither verified) → expected Option C after one sample
PLAIN EXACT GEOMETRY VERIFIED:   NO
SENSE EXACT GEOMETRY VERIFIED:   DESIGN FILE YES / RETAIL PART NO
ZERO-CHANGE FIT (WORST CASE):    NO for both (BAT+ cone needs 0.29 mm shift vs 0.20 allowed)
PCB CHANGES REQUIRED:            1 (BAT+ hole 1.70 / ring 2.10 / mask 1.75), same for both
SCHEMATIC / BOM CHANGES:         NONE
JLC ECONOMIC PCBA:               UNAFFECTED
PHYSICAL SAMPLE REQUIRED:        YES
```
