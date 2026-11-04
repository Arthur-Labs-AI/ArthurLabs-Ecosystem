# RB-04A — Cost Analysis (two units, JLCPCB Economic PCBA)

Date: 2026-10-11 (RB-04B revision). **Estimate, not a quotation.** No JLC calculator output, no order, no upload. Sources: JLCPCB assembly price page ("last updated September 9, 2026"),
LCSC retail price tiers on the part pages (RB-04A BOM candidates), fees from RB-04. The JLC PCB-fabrication calculator is dynamic and was not retrievable.

## 1. Summary (USD, two assembled boards)

| Block | Low | High | Basis |
|---|---|---|---|
| Components (29 lines, 252 placements) | **19.36** | **34.48** | low = exact quantity at the tier price that applies at 2×qty; high = buy rounded up to each line's first price tier (50–100 pcs on passives). FB1 priced as Murata C19330 |
| Assembly: setup | 8.18 | 8.18 | JLC page, per order |
| Assembly: stencil | 1.53 | 1.53 | per order |
| Assembly: SMT joints | 1.09 | 1.09 | 340 joints × 2 boards × $0.0016 |
| Assembly: confirm placement | 0.45 | 0.45 | listed; whether charged by default is unknown |
| Assembly: feeder loading | 36.84 | 85.96 | $3.07 per Extended line: **12 lines confirmed Extended**; up to **28** if all 16 "not stated" lines are Extended |
| **Assembly subtotal** | **48.09** | **97.21** | |
| **Parts + assembly** | **67.45** | **131.69** | |
| PCB fabrication (4 layer, 51.3 × 65.0 mm) | **OPEN** | **OPEN** | JLC calculator not retrievable; not guessed |
| Shipping, customs, VAT / taxes | **OPEN** | **OPEN** | depends on destination and carrier |
| XIAO ESP32-S3 module (retail, hand-soldered) | **OPEN** | **OPEN** | Seeed retail price not retrieved this session |

**Estimated two-unit cost (parts + assembly only): about $67 – $132** (RB-04B BOM; was $64–$128), of which the feeder fees ($37 – $86) are the dominant, still uncertain term. Fabrication, shipping, taxes and the XIAO are not included.

## 2. Where the uncertainty is

* **Extended lines (feeder $3.07 each).** Confirmed Extended by the page: C43922, C76599, C1636, C59782, C40919, C19330, C295747, C160352, C98220, C779410, C2862562, C2901557 (12). Basic by the page: C14663. Not stated (16): C14858, C45783, C160828, C19702,
  C8545, C25803, C114606, C21190, C23162, C137705, C149504, C23140, C22775, C22807, C22935, C963429. Many common Uniroyal 0603 resistors are normally Basic parts, but **this was not confirmed** and is not assumed.
* **Cheapest legitimate levers** (none changes values, dielectric or footprint): (1) Uniroyal 10 k C25804 (Basic) instead of Yageo C98220 once it is in stock → −$3.07; (2) Samsung CL10B104KB8NNNC vs C14663 is the opposite (+$3.07) so keep C14663;
  (3) the 2.2 µF line is now the exact-spec Extended FH C43922 (no cheaper compliant option exists);
  (3b) FB1: Sunlord C1002 (Basic) instead of Murata C19330 → −$3.07, but zero electrical margin and unknown stock; (4) 10 nF C0G and 1 nF C0G are two separate Extended lines that cannot be merged (different values).
* **Quantity effects.** Passive lines are priced at 100+ tiers when bought in 100s; at two boards the exact-quantity price is only reachable if JLC sells cut quantities (usually a minimum purchase / attrition applies — not stated on the page).
* **Part prices at JLC** are LCSC list prices plus nothing; JLC's BOM tool shows its own price and may differ.
* **PCB fabrication** for a 4-layer 51.3 × 65 mm board is not in this estimate; JLC quotes it by quantity (usually ≥ 5 pcs), so the two assembled boards will typically come with three further bare boards.

## 3. Per-line parts cost (need quantity, two units)

| LCSC | Placements | Need qty | Unit | Cost | Class (page) |
|---|---|---|---|---|---|
| C43922 | 8 | 16 | 0.0271 | 0.43 | Extended Parts |
| C14858 | 8 | 16 | 0.0087 | 0.14 | not stated on page |
| C76599 | 4 | 8 | 0.0460 | 0.37 | Extended Parts |
| C1636 | 8 | 16 | 0.0083 | 0.13 | Extended Parts |
| C45783 | 1 | 2 | 0.2227 | 0.45 | not stated on page |
| C59782 | 5 | 10 | 0.0212 | 0.21 | Extended Parts |
| C14663 | 7 | 14 | 0.0141 | 0.20 | Basic (page) |
| C160828 | 1 | 2 | 0.0154 | 0.03 | not stated on page |
| C19702 | 1 | 2 | 0.0308 | 0.06 | not stated on page |
| C40919 | 16 | 32 | 0.0429 | 1.37 | Extended Parts |
| C19330 | 1 | 2 | 0.0128 | 0.03 | Extended |
| C295747 | 1 | 2 | 0.2387 | 0.48 | Extended (per project field, page lists  |
| C160352 | 5 | 10 | 0.2165 | 2.17 | Extended (per project field, page lists  |
| C8545 | 1 | 2 | 0.0179 | 0.04 | not stated on page |
| C98220 | 12 | 24 | 0.0034 | 0.08 | Extended Parts |
| C25803 | 14 | 28 | 0.0031 | 0.09 | not stated on page |
| C114606 | 8 | 16 | 0.0050 | 0.08 | not stated on page |
| C21190 | 8 | 16 | 0.0026 | 0.04 | not stated on page |
| C23162 | 1 | 2 | 0.0028 | 0.01 | not stated on page |
| C137705 | 1 | 2 | 0.0077 | 0.02 | not stated on page |
| C149504 | 1 | 2 | 0.0060 | 0.01 | not stated on page |
| C23140 | 4 | 8 | 0.0025 | 0.02 | not stated on page |
| C22775 | 1 | 2 | 0.0032 | 0.01 | not stated on page |
| C22807 | 1 | 2 | 0.0045 | 0.01 | not stated on page |
| C22935 | 2 | 4 | 0.0020 | 0.01 | not stated on page |
| C963429 | 1 | 2 | 0.2332 | 0.47 | not stated on page (page: Economic and S |
| C779410 | 3 | 6 | 0.3927 | 2.36 | Extended |
| C2862562 | 1 | 2 | 4.6900 | 9.38 | Extended |
| C2901557 | 1 | 2 | 0.3482 | 0.70 | Extended (per project field) |

Reproduce: `python3 hardware/emg/rev-b-xiao/tools/rb04a_cost.py` → `evidence/rb04a/cost_model.json`.

## 4. Not included / not claimed

Fabrication, engineering fee, shipping, taxes, XIAO module, spares, hand-soldering consumables, enclosure; any statement about JLC's acceptance or lead time; any Promotional/Preferred discount (none seen).
