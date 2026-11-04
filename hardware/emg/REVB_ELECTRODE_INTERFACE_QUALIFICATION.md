# A.R.T.H.U.R EMG Rev B — Electrode Interface Qualification

Date: 2026-10-14. Research and engineering-design report only. **No production file (PCB, schematic, BOM, Gerbers, release package) was modified; nothing was ordered, committed or pushed.** The KiCad project was inspected through a scratch copy (netlist exported with `kicad-cli` from the copy, not from the canonical directory).

> **2026-10-14 follow-up:** Part I (below) is the original qualification. **Part II at the end of this file corrects three of its findings and holds the final sourcing decision and BOM.** Where Part I and Part II disagree, Part II governs. Superseded statements in Part I: (1) "stud-to-stud, very probably will not mate"; (2) connectors on the "south"/"long" edge; (3) proposal P1 (assign MP pads to GND).

Legend: **[V]** verified from the actual KiCad netlist/PCB or a manufacturer page fetched on 2026-10-14. **[E]** my calculation or estimate from stated assumptions. **[U]** unverified — must be confirmed before any purchase or design freeze.

**No electrical-safety clearance is implied by this document.** Rev B is an unisolated, battery-powered experimental device. Do not apply electrodes to a person until the independent safety review in §8 is complete.

---

## 0. Executive summary

1. **Option A as listed will very probably not mate.** PLUX 870992018 has a *stud* connector [V: PLUX page: "stud connector", Ø10 mm, 2 mm thick, Ag/AgCl-coated polymer]. SparkFun KIT-19627's snap is described as the point where a biomedical sensor pad is *attached* to the cable's "electrode snap" [V: SparkFun/retailer text] — i.e. the cable end carries a **stud**, onto which a pad's female snap clips. Stud-to-stud does not connect [U: I could not retrieve a photo or drawing; confirm with one sample]. PLUX's own **2-lead electrode cable** (SKU 810121407, €15.00 for 10 cm / €15.25 for 30 cm) has a "standard snap-on socket" for these electrodes but a UC-E6 connector on the other end [V].
2. **The front end is the weak point, not the cable alone.** Rev B has no on-electrode buffer: each electrode lead is a high-impedance (~9.5 MΩ at 50 Hz [E]) node into a TLV9064 follower on the PCB. Any lead length is therefore exposed to mains E-field pickup and motion artefacts, and the passive reference (100 kΩ to VCM, no driven-right-leg) gives only weak common-mode control.
3. **Recommended path:** Option C-hybrid — nine 316L (or A4-class stainless) domed dry contacts, ≈ 10 mm diameter, on a flexible strap; leads as short as the strap allows, **shielded twisted pair per channel** (drain to GND at the PCB end only), and the PLUX/SparkFun parts retained *only* as a short-lead reference set to measure what the PCB does with real skin. Not a purchase list for the whole wristband yet — a **sample-sized** list (§6).
4. **No PCB change is required to start**; a **proposal** (not implemented) to tie the five connector retention pads (MP) to GND would give shields a proper termination (§5.3).
5. **Human use is not authorised** (§8).

---

## 1. Verified hardware (actual KiCad, `ARTHUR_EMG_RevB`, commit be1413a)

### 1.1 Connectors [V]

| Ref | MPN | Footprint | Pin 1 | Pin 2 | MP (retention) | Board position (mm), rot. |
|---|---|---|---|---|---|---|
| J401 | JST B2B-PH-SM4-TB(LF)(SN), LCSC C160352 | JST_PH_B2B-PH-SM4-TB, vertical SMD, P2.00 | `/CH4/ELEC_P` (IN+) | `/CH4/ELEC_N` (IN−) | **no net** | (6.85, 3.75), 180° |
| J301 | same | same | `/CH3/ELEC_P` | `/CH3/ELEC_N` | no net | (16.25, 3.75) |
| J201 | same | same | `/CH2/ELEC_P` | `/CH2/ELEC_N` | no net | (25.65, 3.75) |
| J101 | same | same | `/CH1/ELEC_P` | `/CH1/ELEC_N` | no net | (35.05, 3.75) |
| J5001 | same | same | **NC** (`unconnected-(J5001-Pad1)`) | `/Reference_VCM/RLD_SAFE` | no net | (44.45, 3.75) |

* Pitch 9.40 mm along the south long edge (y = 3.75), all on F.Cu, board 51.30 × 64.95 mm. Free top-side height depends on enclosure (not modelled in the mechanical report).
* The retention pads (MP) are **floating**: a cable shield cannot be terminated through any of the five connectors without a PCB change.
* GND is available on B.Cu test pads TP7 (12.3, 36.95) and TP8 (8.3, 36.95) [V]; TP5 = RLD_SAFE (45.95, 15), TP4 = VCM (48.15, 20).

### 1.2 Input topology per channel (CH1 shown; CH2–4 identical) [V]

```
J101.1 ELEC_P ── R101 10k ── HIZ_P ─┬─ C103 100 pF → GND
                                    ├─ R105 10 MΩ → VCM            (DC bias)
                                    ├─ D101 BAV199 (GND / AFE_3V0 clamp)
                                    └─ TLV9064 (+) follower → BUF_P
                                                  BUF_P ─ C101 2.2 µF ─ ACN_P ─ R103 100k → GND
                                                  ACN_P ─ R107 1k ─ CH1_P ─ (D103 BAV199 clamp, C106 1 nF to GND, C105 10 nF diff) → ADS131M04
J5001.2 RLD_SAFE ── R5002 100k ── VCM   (VCM = TLV9064 U503A buffer of the 100k/100k divider from AFE_3V0, R5005 10k)
```

Derived, [E]: input leg impedance at 50 Hz ≈ 10 MΩ ∥ (100 pF + ~4 pF) ≈ **9.5 MΩ**; 10 k + 100 pF filter corner ≈ 14 kHz (Zel = 100 k) to ≈ 1.5 kHz (Zel = 1 MΩ); high-pass at the ADC 0.72 Hz (2.2 µF/100 k). The reference is **not driven**: no right-leg-drive feedback exists; RLD_SAFE is a 100 kΩ bias tie to VCM (confirmed in the netlist).

### 1.3 Constraints that follow
* A shield must go to **GND** (low impedance) at the PCB end. Tying it to RLD_SAFE puts it on a 100 kΩ node that the body can drive; tying it to an electrode defeats the shield. Neither is automatically correct.
* VCM (1.5 V) is a bias, not a quiet reference: never use it as a shield drive without a buffered, characterised guard design (not in Rev B).
* The 10 k series + clamp protect ADC/follower inputs; they do not provide patient isolation.

---

## 2. Option comparison matrix

| Criterion | A — Off-the-shelf snap (PLUX + SparkFun + Adafruit) | B — Shielded cable solution | C — Custom dry 316L strap assembly |
|---|---|---|---|
| Mechanical compatibility | **Likely stud↔stud mismatch** [U]; PLUX's own snap-socket cable exists (€15/lead pair, UC-E6 end must be cut) [V] | Cable only; electrode end is whatever you terminate (snap socket, stud, solder lug) | Designed in: contacts crimp/solder to the lead away from skin |
| Cable construction | SparkFun lead ≈ 9 cm [V, retailer]; gauge/shield not published [U]; Adafruit 261: 26 AWG, 100 mm, JST female on one end, bare on other [V] | e.g. Alpha Wire 3302 (28 AWG, 2C, shielded; 68 pF/ft conductor-to-shield [V]); Tensility 30-02415 (28 AWG 2C, spiral shield, 3.10 mm) [V via search; datasheet not retrieved] | Short flying leads or FPC; shielded where > 50 mm |
| Shield strategy | none (unshielded 26 AWG pairs, solder joint) | possible; drain to GND needs a pad (TP7/TP8 by hand) or the proposed MP-to-GND ECO | same as B, or none if ≤ 40 mm |
| Skin contact | Ag/AgCl, Ø10 mm, usable with/without gel; dry use on hair-bearing forearm is marginal [E] | depends on electrode | stainless dry contacts: high but stable impedance if pressure-controlled |
| Cost, one band | €12.50 + €13.22 + €3.96 ≈ €29.7 + shipping (user's quote) | cable per metre unknown at retail; reel pricing seen at $508.81/100 ft (Alpha 3302 SL005) — **too high** [V]; cut-length via Farnell/element14 [U] | est. €15–40 for nine contacts + hardware [U] |
| Reusability/cleaning | good, 10 pcs | n/a | best (no pads, wipeable) |
| Assembly effort | 9 solder joints + heat-shrink; fragile | 5 shielded pairs, termination of drain | highest (fixture/strap design), most repeatable |
| Expected electrical result | worst: unshielded hi-Z leads, small contact area | good if electrode contact is good | best control of contact and lead length |
| Overall | **Not recommended as specified** | acceptable cable choice for any electrode option | **Recommended** direction, staged with samples |

---

## 3. Mechanical architecture (concept)

**Principle:** the PCB is a rigid module (51.3 × 65 mm) on the dorsal forearm; the nine contacts are on a flexible strap around the proximal-to-mid forearm; leads run flat along the strap.

* **Contacts:** 8 signal + 1 reference, ≈ Ø8–10 mm domed 316L, replaceable (screw/push-in), each on a compliant backing (closed-cell foam or silicone ≈ 1–2 mm) so pressure is controlled by the strap and not by the module.
* **Geometry (starting values, to be validated on forearms):**
  * Pair spacing 20 mm centre-to-centre along the muscle fibre direction (SENIAM-type; matches published dry-contact work using Ø10 mm / 20 mm stainless [V: arXiv 2009.02575]). Smaller spacing (12–15 mm) increases selectivity and reduces CM-susceptible area but lowers amplitude; to be decided by experiment [U].
  * Four pairs equally distributed around the circumference at the proximal third (circumference ≈ 22–27 cm [U — measure the target users]) → pair pitch ≈ 55–65 mm.
  * Reference: on a bony/electrically quiet site (ulnar border or dorsal wrist) [U], on the strap, ≥ 30 mm from the nearest signal contact.
* **Lead routing:** each pair leaves its two contacts as a twisted pair toward the module edge; leads are glued/stitched to the strap with a 10–15 mm service loop at the module end; strain relief = lead clamped to the strap, not to the JST housing.
* **Module side:** five JST-PH cables exit the south edge (J401…J5001, pitch 9.4 mm); cable bundle bends at ≥ 5× cable OD; connector latch secured by the enclosure lid.
* **Retention:** strap tension via elastic + hook-and-loop; contact pressure target 1–3 kPa (band ≈ 5–15 N/m) [U — experimental].
* **Needs physical forearm measurement:** circumference range, muscle belly locations, contact impedance vs. pressure, spacing, motion of the module.

---

## 4. Signal-integrity analysis (estimates; no measurements exist)

Assumptions: T = 305 K, band 20–450 Hz (430 Hz), Zel per dry electrode 100 kΩ–2 MΩ at 100 Hz [E; literature quotes > 100 kΩ to few MΩ, stable pressure reduces mismatch], front-end input leg 9.5 MΩ.

### 4.1 Thermal noise of electrode impedance [E]
| Zel (per electrode) | Per electrode | Differential pair |
|---|---|---|
| 20 kΩ (wet) | 0.38 µVrms | 0.54 µVrms |
| 100 kΩ | 0.85 | 1.20 |
| 500 kΩ | 1.90 | 2.69 |
| 1 MΩ | 2.69 | 3.81 |
| 2 MΩ | 3.81 | 5.38 |
The AFE itself (≈ 0.6 µVrms front-end + ADC 0.77–1.2 µVrms at gain 16–32) is smaller than the dry-electrode term above ≈ 100 kΩ. **Contact impedance, not the ADC, sets the noise floor.** Surface EMG is mV-scale during contraction, so µV-level noise is acceptable for gesture recognition, but not the limiting factor — interference and artefact are.

### 4.2 Common-mode to differential conversion (mains) [E]
CM→DM ≈ ΔZ / |Zin| with |Zin| ≈ 9.5 MΩ:
| Zel | mismatch | conversion | for 100 mV CM at 50 Hz |
|---|---|---|---|
| 100 kΩ | 50 % | −45.6 dB | 0.53 mV |
| 500 kΩ | 50 % | −31.6 dB | 2.6 mV |
| 1 MΩ | 50 % | −25.6 dB | 5.3 mV |
| 1 MΩ | 100 % | −19.6 dB | 10.5 mV |
ADC full scale at gain 16 is ≈ ±150 mV differential. Mains CM of 100 mV is realistic near wiring [U]. **A mismatched dry pair can place several mV of 50 Hz on top of 100 µV–few mV EMG**; firmware notch + wide headroom is needed, and good, equal, stable contact is essential.
Reference effect: device-to-earth coupling ≈ 30 pF → |Z| ≈ 100 MΩ at 50 Hz; a 1.1 MΩ reference path lets the device track the body within ≈ 1 % [E]. A poor/lost reference raises CM seen by the followers: the reference electrode is a **reliability-critical** contact — consider a larger area for it (≥ Ø15 mm) [proposal].

### 4.3 Cable capacitance and loading [E]
10 MΩ bias dominates; added cable capacitance of 22–67 pF per leg (Alpha 3302: 68 pF/ft ≈ 223 pF/m to shield, for 0.1–0.3 m) moves |Zin| only from 9.5 to ≈ 9.2 MΩ at 50 Hz — negligible. With Zel = 1 MΩ the low-pass corner is ≈ 1.5 kHz; with 2 MΩ and 200 pF it falls to ≈ 380 Hz (just inside the band): keep total leg capacitance < 150 pF. Cable capacitance is **not** the problem; **pickup and triboelectric/motion noise** are.

### 4.4 Pickup, shielding, motion artefact
* Unshielded twisted pair, short (< 50 mm), mechanically fixed: pickup is mostly common-mode, converted by imbalance as in §4.2; twisting minimises loop area for magnetic pickup. [E/qualitative]
* A grounded shield intercepts the E-field on the hi-Z leads; its benefit increases with length (> 80–100 mm) and mains proximity. At Rev B's 9.5 MΩ node the shield is **meaningfully advantageous for leads ≥ ~100 mm**; below ~40 mm the strap/enclosure design matters more. Quantitative gain depends on the environment and must be measured (§7).
* The shield capacitance to the inner conductors is a grounded capacitance on a hi-Z node (≈ 22–67 pF): acceptable per §4.3.
* Motion artefact: dominated by the electrode–skin half-cell/pressure variation; cable flexing adds triboelectric charge (low-noise cable, strain relief, no sliding). Active (buffered) electrodes would solve both — **this is the smallest effective change** if measured results are poor (proposal only, §5.3).
* BLE/Wi-Fi coupling: 2.4 GHz rectification at hi-Z nodes mitigated by the 10 k + 100 pF filter and the TLV9064 internal EMI filter; unshielded long leads act as antennas; the antenna corridor is east of the module, away from the south-edge connectors. Measure with the antenna in the enclosure [U].

**Conclusion on shielding:** a short (≤ 40–50 mm), well-secured, twisted unshielded pair *may* be sufficient for a first prototype; for leads that must span ≥ 100 mm (typical for a strap-around-the-forearm layout) use shielded twisted pair. Shielding does not repair unequal contact impedance.

---

## 5. Recommended design

### 5.1 Selected approach
1. **Stage 1 (sample purchase, no commitment):** verify mating of one PLUX electrode with (a) SparkFun reference lead, (b) PLUX 2-lead cable (10 cm). The first is expected to fail; the second is the vendor-intended pairing.
2. **Stage 2:** build one strap with nine stainless contacts and shielded leads (Option C + B cable), measure noise and CM pickup with non-human loads (§7) before any further design.
3. **Stage 3 (after independent safety review only):** human trials.

### 5.2 Wiring concept (five JST-PH interfaces)
```
 Contact pair 1 ── twisted pair (shielded) ── PH-2 housing ── J101: pin1 = IN+ (CH1_P)   pin2 = IN− (CH1_N)
 Contact pair 2 ── twisted pair (shielded) ── PH-2 housing ── J201: pin1 = IN+          pin2 = IN−
 Contact pair 3 ── twisted pair (shielded) ── PH-2 housing ── J301: pin1 = IN+          pin2 = IN−
 Contact pair 4 ── twisted pair (shielded) ── PH-2 housing ── J401: pin1 = IN+          pin2 = IN−
 Reference contact ── single lead (shielded) ── PH-2 housing ── J5001: pin2 = RLD_SAFE   pin1 = NC (leave empty, no wire)
 Shield drains: connected only at the PCB end, to GND (TP7/TP8 by hand-wire; or MP pads if the ECO is later approved). NEVER at the electrode end, NEVER to pin 1/2, VCM or RLD_SAFE.
```
Keep consistent channel polarity (pin 1 = distal/proximal consistently across all four pairs).

### 5.3 Proposals (not implemented — require approval)
| # | Proposal | Reason | Size of change |
|---|---|---|---|
| P1 | Connect the five MP pads of J101–J401/J5001 to GND | shield termination without hand-wiring TP7/TP8 | net assignment of five pads + stitching |
| P2 | If measured motion/pickup is poor: move the follower (and 10 k/100 pF) onto a small electrode-side flex (active electrode), keeping the same JST interface | removes hi-Z cable | new flex PCB; main board unchanged |
| P3 | Reference electrode area ≥ Ø15 mm (strap side only) | reference reliability | no PCB change |

---

## 6. Purchasing research — minimal, sample-first

Prices as stated on the pages at the time of research, ex-shipping; Bulgaria shipping and VAT not verified except where noted. **Nothing has been ordered.**

| # | Item | Qty (sample) | MPN / SKU | Source | Price | Status |
|---|---|---|---|---|---|---|
| 1 | PLUX Non-gelled Reusable Ag/AgCl (pack 10) | 1 pack (9 + 1 spare; or buy fewer if a smaller pack exists [U]) | SKU 870992018 | [PLUX](https://www.pluxbiosignals.com/products/non-gelled-reusable-ag-agcl-pack-10) | €12.50 | Stud connector, Ø10 mm, 2 mm [V] |
| 2 | PLUX 2-Lead Electrode Cable, 10 cm | 1 (sample) | SKU 810121407 | [PLUX](https://www.pluxbiosignals.com/collections/accessories/products/2-lead-electrode-cable) | €15.00 | Snap-on socket one end, UC-E6 other end [V]; mating with item 1 expected but not stated [U] |
| 3 | SparkFun MyoWare 2.0 Reference Cable (10 pack) | 1 pack **only if** a single lead cannot be sourced; otherwise skip | KIT-19627 | [SparkFun](https://www.sparkfun.com/myoware-2-0-reference-cable-10-pack.html) | $10.95 (SparkFun); your quote €13.22 (DigiKey) | ≈ 9 cm [V, retailer]; snap type, wire and shield **unconfirmed** [U] |
| 4 | Adafruit 261 JST-PH 2-pin cable, 100 mm | 5 | ADA261 | [Adafruit](https://www.adafruit.com/product/261) | $0.75 each | 26 AWG, JST female one end, bare other [V]; unshielded |
| 5 | Shielded 28 AWG 2-conductor cable (for B/C) | 1–2 m, cut length | Alpha Wire 3302 (68 pF/ft shield cap [V]); alt. Tensility 30-02415 [V by search] | [element14/Farnell listing](https://nz.element14.com/alpha-wire/3302/cable-shielded-28awg-2core-per/dp/1619698) | **not retrieved** (page timed out); full spool seen at $508.81 [V] | Do not buy a spool; cut length only; [U] |
| 6 | JST PHR-2 housing + SPH-002T-P0.5S contacts + crimper (alt. to Adafruit 261) | 6 + 12 | PHR-2 / SPH-002T-P0.5S (30–24 AWG) | JST datasheet via [Farnell](https://www.farnell.com/cad/4768140.pdf) | not retrieved | [V part numbers] |
| 7 | 316L/A4 stainless domed contacts, Ø8–10 mm | 9 + 3 | **no verified part** | to be chosen after sample test | — | [U] — do not order yet |
| 8 | Heat-shrink Ø1–2 mm, solder, flux, multimeter | ~0.5 m | generic | any | — | assembly material |

**Stage-1 sample cost (items 1, 2, 4 ×5):** ≈ €12.50 + €15.00 + €3.50 ≈ **€31** + shipping; items 5–7 are deferred until the mating and bench results are known. DigiKey shipping to Bulgaria was quoted in your list as €25 under €75 [not independently verified]; PLUX/Adafruit shipping to Bulgaria **not verified**.

---

## 7. Validation plan (no custom test PCB, non-human only)

Rule set for every step: battery only; **no USB, no charger, no mains-powered instrument connected to the DUT while any electrode lead is present**; scope/DMM battery-powered or isolated; test sources floating.

**V0 — mechanical/continuity (unpowered):** each of the five cables: pin-to-pin continuity, pin-to-shield isolation (> 100 MΩ, tested at ≤ 50 V DC), no short between pin 1/pin 2; J5001 pin 1 verified unconnected; shield continuous end-to-end; pull test (≥ 10 N) of each lead at strap clamp and at the housing.
**V1 — PCB bring-up without electrodes:** AFE_3V0 = 3.0 V, VCM = 1.5 V, TP7/TP8 GND; ADC internal test signal and input-shorted noise (firmware per the firmware audit).
**V2 — dummy skin:** 8 resistors (100 kΩ, 470 kΩ, 1 MΩ, 2.2 MΩ) in 22 nF‖ network per electrode on a perfboard (non-human load) with deliberate 0/20/50/100 % mismatch; record noise (20–450 Hz) and 50 Hz amplitude, with/without shield, with/without reference resistor (100 kΩ–1 MΩ to GND-referenced "body" node).
**V3 — injected signals:** battery-powered function generator through 1 kΩ/1 kΩ attenuator (differential 100 µV–1 mV at 50–300 Hz; common-mode 100 mV at 50 Hz); measure CMRR vs. mismatch; compare with §4.2.
**V4 — channel consistency:** same signal to all four channels, gain/phase spread < 1 dB/2°.
**V5 — reference behaviour:** vary reference resistance 100 kΩ → open; record CM pickup and saturation; verify recovery.
**V6 — motion/pickup:** cables flexed on a rig with dummy loads (no skin); mains E-field exposure near an extension lead (unconnected to the DUT).
**V7 — radio:** BLE streaming on/off (Wi-Fi off), compare noise spectrum; antenna in the enclosure.
**V8 — insulation/exposure review:** inspect exposed copper (BAT+ post, TP pads, USB-C), required rigid insulating barrier; document.
Pass criteria to define before testing: noise ≤ target at Zel = 500 kΩ, CM→DM within §4.2 estimates ±6 dB, no saturation with 100 mV CM at 50 Hz and gain 16.

---

## 8. Safety gates

* Unisolated: battery negative is common to everything on the board including USB shield; there is no isolation barrier. Rev A's rule stands: **no electrodes on a person while USB (or a charger) is attached**; the hardware AFE inhibit is defense-in-depth only.
* Gate G1: this document + bench results (V0–V8) reviewed.
* Gate G2: **independent electrical safety review** (battery protection, fault currents through 10 k series, leakage, enclosure creepage/clearance, exposed contacts, charging inhibition).
* Gate G3: written approval before any human electrode contact.
* No human use before G2 and G3. Exposed contacts (BAT+ post, test pads, XIAO USB-C) require a rigid insulating enclosure barrier (not yet designed).

---

## 9. Unresolved risks and decisions requiring approval

| # | Item | Needed from you |
|---|---|---|
| 1 | Stud↔snap mismatch of Option A parts | approve one-sample test (items 1–2), not the full kit |
| 2 | Option C contact part number/material source | decide after bench test; approve sourcing search |
| 3 | P1 (MP→GND) / P2 (active electrode flex) | decision after V2–V3 results |
| 4 | Electrode spacing/diameter | forearm trials after G2 |
| 5 | Reference site and size | measurement after G2 |
| 6 | Rev B front-end CM handling without DRL | accept firmware notch + headroom, or later revision |
| 7 | Nickel/skin compatibility of 316L for long wear | material documentation + wear test |
| 8 | Shipping/VAT to Bulgaria | not verified |
| 9 | Safety review scope and reviewer | decide who performs G2 |

## 10. Sources
* PLUX non-gelled electrode: https://www.pluxbiosignals.com/products/non-gelled-reusable-ag-agcl-pack-10
* PLUX 2-lead electrode cable: https://www.pluxbiosignals.com/collections/accessories/products/2-lead-electrode-cable
* SparkFun MyoWare 2.0 reference cable: https://www.sparkfun.com/myoware-2-0-reference-cable-10-pack.html
* Adafruit JST-PH cable 261: https://www.adafruit.com/product/261
* Alpha Wire 3302 SL005 listing: https://audiovideoelectric.com/products/alpha-wire-3302-sl005-multi-conductor-cables-28awg-2c-shield-100ft-spool-slate
* Low-cost active dry-contact sEMG sensor (Ø10 mm / 20 mm stainless, > 100 kΩ contact impedance): https://arxiv.org/pdf/2009.02575
* JST PH datasheet via Farnell: https://www.farnell.com/cad/4768140.pdf
* Internal: `REVB_INTERFACE_SPEC.md`, `REVB_ARCHITECTURE_PROPOSAL.md`, `REVB_POWER_ARCHITECTURE.md`, KiCad `ARTHUR_EMG_RevB` (netlist exported from a scratch copy).


---
---

# PART II — Corrections and final sourcing (2026-10-14)

Same legend: **[V]** verified from the netlist/PCB file or a manufacturer/retailer page fetched or returned in search on 2026-10-14; **[E]** estimate/calculation; **[U]** unverified. Retailer pages for SOS electronic and Bürklin returned HTTP 403 to my fetches, so their prices below come from search-result snippets and are marked **[V-snippet]**. Nothing was ordered, no production file changed.

## II.1 Corrections to Part I

### A. PLUX ↔ SparkFun snap gender — my Part I inference was wrong
* **What Part I said:** the SparkFun lead "carries a stud, so stud-to-stud, will not mate". That was an inference from the phrase "place a pad into the electrode snap", and it ran the wrong way.
* **What the evidence shows:**
  * The standard ECG/EMG pad carries the **male stud** (4.0 mm stud tip is the compatibility dimension on the electrode; the lead wire carries a spring-loaded **female socket**) [V: Med-Linket snap-geometry guide].
  * The MyoWare 2.0 sensor's *input electrode* snaps are **female**; its power/output snaps are male [V: SparkFun MyoWare 2.0 documentation as returned by search]. The reference cable replaces the sensor's own (female) reference snap, and SparkFun says a pad is attached to its "electrode snap" and that the sensor has a reference "socket" [V].
  * PLUX 870992018 has a "stud connector" [V], i.e. it is a pad-style male stud.
* **Verdict:** compatibility is now **probable (female socket on the SparkFun lead ↔ male stud on the PLUX electrode)**, **not confirmed**. Nobody publishes the PLUX stud diameter or the SparkFun socket drawing [U]. The Part I statement is withdrawn.
* **Not resolved by documents:** stud diameter (4.0 mm vs 3.5 mm legacy — a 4.0 mm stud will not engage a 3.5 mm socket [V: Med-Linket]); retention force; lead wire gauge/strand count of CAB-19244 (SparkFun does not publish it) [U].
* **Cheapest resolution:** buy the PLUX pack (required anyway) and **one** SparkFun CAB-19244 ($1.25 [V: SparkFun product page]) and push them together; check retention by hand and continuity with a DMM. Fallbacks if it fails: PLUX's own 2-lead cable (SKU 810121407, €15.00, "standard snap-on socket" [V]; UC-E6 end cut off) or OpenBCI snap cables (female snap, 26 AWG, 10 × 0.5/1.0/1.5 m for $74.99 [V]; too expensive for one band).
* **BOM consequence:** SparkFun stays in the BOM as a **sample-validation item**, not as a verified item.

### B. JST retention (MP) pads and shielding — P1 withdrawn
* The mating housing (PHR-2) is plastic; the MP pads only anchor the receptacle's metal retention tabs to the PCB. Assigning them to GND would **not** create any path to a cable shield; shield continuity would need a separate contact that the 2-pin PH system does not have [V: netlist — only pins 1 and 2 are electrical]. **P1 is withdrawn.** The PCB stays untouched.
* Strategies compared:

| Strategy | Works without PCB change? | Electrical effect | Mechanical/practical disadvantages |
|---|---|---|---|
| S1 — separate drain wires from each shield to a single GND **star** wire soldered to TP7/TP8 (B.Cu, GND, (12.3, 36.95)/(8.3, 36.95)) [V] | **Yes**, hand-soldered | shield at PCB GND at one point (no loops); the drain stub itself is unshielded: ≈ 35–50 mm run from the connector strip at y ≈ 3.75 to y ≈ 37 [E] | 5 extra wires; a 1.5 mm test pad as the only anchor — needs enclosure-side strain relief; pads are on the **back** side next to the battery pocket (RB-02H: south-biased pocket) so assembly order matters; adds bulk at the connector strip |
| S2 — external shield-termination point (foil/lug on the enclosure) | Needs a GND bond to the PCB anyway; the only accessible GND points are the same TP7/TP8, J1 pin 2 (battery −) or XIAO GND castellation (hand-soldered module pad) | same as S1 plus an extra joint | extra part and joint without benefit; using J1 pin 2 would put shield current on the battery return — rejected |
| S3 — a different cable arrangement (e.g. one multi-pair cable with overall shield, drain to one pad) | Yes | single shield for all pairs; fewer drains | rounder, thicker harness (4×2×0.14 LiYCY TP is 6.2 mm OD [V: STEX24 snippet]); inflexible on a strap |
| S4 — short unshielded twisted pairs, no shield | Yes | no shield; relies on twist, length and mechanical fixing | pickup scales with length (§II.6); acceptable only where leads are short |

* **Recommendation:** build the first harness as **S4 for leads ≤ ~60 mm** and prepare **S1** as an A/B variant for longer leads, decided by bench data (§II.6). Do not use the shield drain to touch RLD_SAFE/VCM.

### C. Connector position and orientation (re-verified from the KiCad file)
* Positions [V: ARTHUR_EMG_RevB.kicad_pcb, F.Cu, rotation 180°]:

| Ref | Origin (x, y) mm | Pin 1 (x, y) | Pin 2 (x, y) | Pad size | MP pads (x, y) |
|---|---|---|---|---|---|
| J401 | (6.85, 3.75) | (7.85, 3.25) | (5.85, 3.25) | 1.0 × 5.5 | (10.25, 5.50), (3.45, 5.50) |
| J301 | (16.25, 3.75) | — | — | — | — |
| J201 | (25.65, 3.75) | — | — | — | — |
| J101 | (35.05, 3.75) | (36.05, 3.25) | (34.05, 3.25) | 1.0 × 5.5 | (38.45, 5.50), (31.65, 5.50) |
| J5001 | (44.45, 3.75) | (45.45, 3.25) | (43.45, 3.25) | 1.0 × 5.5 | (47.85, 5.50), (41.05, 5.50) |

* **Edge:** KiCad y increases downward, so y ≈ 3.75 is the **top/north edge** as the RB-02H sign-off also states ("all five on the north edge"). Part I wrongly said "south". The row runs along x over the **51.3 mm dimension**, i.e. on the **short end edge**, not a long edge. The module's long axis (64.95 mm, N–S) lies along the arm, so cables leave **along the arm** (RB-02H). USB-C is on the south edge, opposite [V: RB-02H].
* **Pin pitch 2.0 mm; connector pitch 9.40 mm.** Signal pads span y ≈ 0.5…6.0 mm, i.e. start 0.5 mm from the board edge [V].
* **Insertion direction:** the B2B-PH-SM4-TB is a **top-entry** receptacle: the plug goes in perpendicular to the board (from +Z), the wires leave the plug **upwards** and are then bent toward the edge/along the arm. RB-02H uses 8.6 mm mated height + ~4 mm bend allowance = ≈ 16.6 mm stack over the strip [V: sign-off; bend allowance is its assumption].
* **Pin mapping, re-checked directly in the netlist [V]:** J101/J201/J301/J401 pin 1 = `/CHn/ELEC_P`, pin 2 = `/CHn/ELEC_N`; J5001 pin 1 = `unconnected-(J5001-Pad1)` (NC), pin 2 = `/Reference_VCM/RLD_SAFE`. MP pads have no net.
* **Cable-exit path:** nothing is placed between the strip and the board edge in the footprints; the cables exit over y = 0. Clearances to the enclosure wall (and the height of the retained plugs) are an enclosure decision and are **not modelled** [U].

## II.2 Dry metal contacts — sourcing result

| Candidate | Maker / MPN | Material / size | Termination | Price | Documentation | Verdict |
|---|---|---|---|---|---|---|
| **PLUX Non-gelled Reusable Ag/AgCl** | PLUX Biosignals, SKU 870992018 [V] | Ag/AgCl-coated polymer; Ø10 mm, 2 mm thick; plastic rim (optional) [V] | male stud [V; diameter unpublished] | €12.50 / 10 = **€1.25 each** [V] | "usable with or without gel, reusable" [V] | **Best purchasable candidate.** Not 316L. Dry-contact performance on hairy forearm skin unknown [U]; regulatory/biocompatibility documents not found [U] |
| Natus 6030-TP EMG disc electrodes | Natus, 6030-TP [V via PartsSource] | 10 mm stainless steel discs, twisted leads | lead wires with touch-proof connectors | $138.42 [V] | medical product | Real stainless dry-style EMG discs, but not strap-integrable and **≈ $138 per unit**; not affordable for 4–5 pairs |
| Mill-Max 0985 spring-loaded pin | Mill-Max, family 0985 [V]; **I will not give a full MPN** (configuration not verified) | gold over nickel, 15 g initial / 50 g working force, 2 A [V] | solder cup/PCB mount | not retrieved | no skin-contact documentation [V by absence] | Provides *compliance* only; gold-plated pogo pins are not documented as electrodes. Possible experiment, not a recommendation |
| 316L domed contact with rear screw/stud | **none found** | — | — | — | — | **Sourcing blocker: no commercially verified, affordable 316L dry EMG contact located.** Generic stainless hardware is not a validated skin-contact electrode |
| OpenBCI Dryode | OpenBCI | Ø20 mm, 3.2–5.2 kΩ | snap | — | discontinued [V] | not available |

* **Exact recommended contact:** PLUX 870992018 (Ag/AgCl polymer) used dry, as a *replaceable stud contact*; it supplies the male stud, the compliant rim and a rear connector at €1.25.
* **Unresolved questions:** dry impedance and stability against hair/skin; nickel/Ag allergy statements; whether the optional rim helps; cleaning/lifetime (AgCl loses chloride/oxidises with dry use [E]).
* **Sourcing blocker report:** the 316L request is documented as *not satisfiable from verified products at this time*. Next action if stainless is mandatory: contact a medical-electrode OEM for a 10 mm 316L button with a 4 mm stud (not done; no purchase).

## II.3 Cable solution

| Option | Product (verified) | Gauge / construction | Cost | Comment |
|---|---|---|---|---|
| Prewired JST-PH pigtails | **Adafruit 261**, JST PH 2-pin female + bare, 100 mm [V] | 26 AWG, tinned, AWM 1007, red/black parallel [V] | $0.75 each [V] ($3.75 for 5) | no crimp tool; adds one solder joint per lead and two parallel wires that you twist yourself |
| Direct JST crimp | **JST PHR-2** housing + **SPH-002T-P0.5S** contacts (0.05–0.22 mm² ≈ 30–24 AWG, insulation OD 0.9–1.5 mm) [V: Farnell/JST] | on the SparkFun/own lead wire | PHR-2 ≈ €0.042 (50+), SPH-002T-P0.5S ≈ €0.021 (100+) [V-snippet: SOS electronic]; ≈ €0.083 per 2-pin connector; **tool not priced [U]** | no extra solder joint; needs wire within the contact's range and a crimp tool (≈ tens of euros [U]) |
| Thin unshielded twisted pair | own wire (26–30 AWG) or the leads above | — | negligible | recommended where leads are short |
| Thin shielded cable by the metre | **Bürklin 94F300 LIYCY 2×0.14 mm²**, grey, OD 3.9 mm [V-snippet] | PVC, shielded, 250 V | **€1.0234/m at the 10 m tier** (single-metre pricing not seen) [V-snippet] | 3.9 mm × 5 is bulky; not twisted; use only if the bench demands it |
| Industrial reels | Alpha Wire 3302 SL005 28 AWG 2C, OD ≈ 3.1 mm; $508.81/100 ft spool [V] | braided shield, 68 pF/ft shield [V] | — | rejected for cost |

* **Direct crimp vs. soldered pigtails (engineering judgement, not a reliability measurement):** crimping removes one solder joint and the stiff wicked-solder zone at each lead, which is the usual failure point under flex; it costs ≈ €0.08 per connector but needs a tool. For one prototype, pigtails are cheaper (no tool); for repeat builds, crimp is cheaper and more repeatable.
* **Capacitance/bandwidth:** negligible (Part I §4.3). **Triboelectric noise:** low-noise shielded cable is not needed at ≤ 100 mm if the leads are fixed to the strap [E].
* **Shield termination feasibility:** only S1 (§II.1.B) without a PCB change.

## II.4 Strap assembly (assumption-labelled)

Board 51.30 × 64.95 mm [V]; all nine contacts are off-board.

```
 Exploded (left = skin side)                           [E] stack at a contact: ≈ 8–9 mm
 ┌ skin ┐
 │ PLUX disc, Ø10 × 2 mm, stud through strap hole
 │ strap layer A: 25–30 mm elastic webbing + hook/loop (Ø4.5 mm hole)
 │ closed-cell foam backing 1.5–2 mm (compliance)          [U: pressure 1–3 kPa target]
 │ female snap socket on the lead (SparkFun) – clamps the stud, strap and foam sandwiched
 │ strap layer B: cover tape / thin silicone sleeve over lead, solder joints potted or heat-shrunk
 └ lead (twisted pair) runs flat on layer B → module
```
* **Module:** PCB in a rigid insulating enclosure on the dorsal forearm, long axis along the arm; five JST plugs on the north end, leads leave **along the arm** (north) in a single 5-lead flat bundle ≈ 6–8 mm wide [E]; USB-C at the south end (opposite) [V].
* **Contact map (starting assumption, all [U]):** four bipolar pairs at 90° spacing around the proximal third of the forearm, each pair 20 mm apart **along the fibre direction**; REF on the ulnar border/bony site. Arc length module→volar pair ≈ 125 mm at 250 mm circumference [E] → lead lengths: dorsal-adjacent pairs 40–60 mm, lateral 80–100 mm, volar 130–150 mm.
* **Fasteners:** none beyond the snap stud/socket (the electrode is replaceable by pulling it off the socket); strain relief = lead clamped/stitched to the strap 10–15 mm from the electrode and a 10 mm service loop at the module; heat-shrink with adhesive lining on every solder joint [U: item to choose].
* **Strap:** elastic webbing with hook-and-loop closure (generic; no verified supplier or price) [U].
* **Insulation:** no exposed PCB copper toward the skin (BAT+ post/Ø3.0 VBAT pad on B.Cu, test pads, USB-C shell, castellations) — rigid enclosure with ≥ 1.5 mm wall under the board [E: requirement, from RB-02H §1.5].
* **Needs measurement before freezing:** forearm circumference range and breadth; muscle-belly positions; spacing 12 vs 20 mm; contact pressure vs impedance; snap retention force; module height vs strap sag.

## II.5 Final BOM — one wristband

Currency: SparkFun/Adafruit prices in USD as listed; roughly ≈ 0.9 EUR/USD **[assumption]**. Shipping and VAT excluded (Bulgaria VAT 20 % and carrier fees not verified).

**A. Verified, ready to order** (product exists, price/URL seen; mating of the full chain is still B):

| # | Item | MPN / SKU | Qty | Unit | Subtotal | URL |
|---|---|---|---|---|---|---|
| A1 | PLUX Non-gelled Reusable Ag/AgCl, pack of 10 | 870992018 | 1 (9 + 1 spare) | €12.50 | **€12.50** | https://www.pluxbiosignals.com/products/non-gelled-reusable-ag-agcl-pack-10 |
| A2 | Adafruit JST PH 2-pin cable, female, 100 mm | ADA261 | 5 | $0.75 | **$3.75** | https://www.adafruit.com/product/261 |

**B. Needs sample validation:**

| # | Item | MPN / SKU | Qty | Unit | Subtotal | Question → cheapest test |
|---|---|---|---|---|---|---|
| B1 | SparkFun MyoWare 2.0 Reference Cable (single, sample) | CAB-19244 | 1 | $1.25 | $1.25 | Does its socket retain the PLUX stud, and what is its wire gauge? → push-fit + DMM, 5 minutes |
| B2 | …then, if B1 passes: MyoWare 2.0 Reference Cable 10-pack | KIT-19627 | 1 | $10.95 | $10.95 | https://www.sparkfun.com/myoware-2-0-reference-cable-10-pack.html |
| B2' | …or fallback: PLUX 2-lead electrode cable, 10 cm | 810121407 | 5 | €15.00 | €75.00 | https://www.pluxbiosignals.com/collections/accessories/products/2-lead-electrode-cable |

(One cable that mates covers the question; shipping may exceed part cost — ordering B1 together with B2 once is a judgement call for you.)

**C. Optional (specific benefit only):**

| # | Item | MPN | Qty | Price | Benefit |
|---|---|---|---|---|---|
| C1 | JST PHR-2 housing + SPH-002T-P0.5S contacts | PHR-2 / SPH-002T-P0.5S | 6 / 12 | ≈ €0.25 + €0.25 [V-snippet] | removes the pigtail joint; needs a crimp tool [U] |
| C2 | Shielded cable, 1 m | Bürklin 94F300 | 1 m | ≈ €1.02/m (10 m tier) [V-snippet] | only for the S1/shielded A/B variant |
| C3 | Adhesive-lined heat-shrink Ø1.5–3 mm, soft solder, flux, DMM | generic | — | [U] | strain relief and joint isolation |
| C4 | Elastic webbing + hook-and-loop + closed-cell foam | generic | — | [U] | the strap itself |

**Estimated cost, one band (A + B2, ex shipping/VAT):** €12.50 + ≈ €9.9 (KIT-19627) + ≈ €3.4 (5 × Adafruit) ≈ **€26**; + strap/foam/heat-shrink ≈ €5–10 [U] → **≈ €31–36**. With crimp instead of Adafruit pigtails: ≈ −€3 + tool [U].

## II.6 Technical verification for the TLV9064 front end

Re-derived from the netlist [V]: leg impedance ≈ 9.5 MΩ at 50 Hz (10 MΩ ∥ ~104 pF), 10 kΩ + 100 pF + BAV199 clamps, followers on the PCB, reference 100 kΩ to VCM with no drive.

**Pickup scaling by lead length** [E; the coupling constant is an assumption and must be calibrated by the bench]:
Assume ambient 50 Hz field 10 V/m, coupling ≈ 0.02 pF/cm of lead to the field source over a 1 m reference gap (≈ 0.63 nA/cm), node impedance ≈ 1 MΩ (electrode + bias path), differential fraction 5 % for a twisted pair and 20 % for parallel wires, shield attenuation ≈ −26 dB.

| Lead | CM current | CM on one leg | DM, twisted | DM, parallel | DM, shielded twisted |
|---|---|---|---|---|---|
| 30 mm | 1.9 nA | 1.9 mV | 0.09 mV | 0.38 mV | ≈ 5 µV |
| 50 mm | 3.2 nA | 3.2 mV | 0.16 mV | 0.63 mV | ≈ 8 µV |
| 100 mm | 6.3 nA | 6.3 mV | 0.32 mV | 1.3 mV | ≈ 16 µV |
| 200 mm | 12.6 nA | 12.6 mV | 0.63 mV | 2.5 mV | ≈ 32 µV |

Read this as **scaling, not a prediction**: pickup grows linearly with length; 50 Hz at 0.1–0.6 mV differential is removable by a digital notch but consumes ADC headroom (±150 mV at gain 16 is not at risk); the larger terms are the body CM through imbalance (Part I §4.2) and artefact. Electrode impedance imbalance and contact-pressure variation act on the body CM and the half-cell; they are **not** improved by shielding. Cable capacitance (≈ 22–67 pF/leg) is irrelevant (Part I §4.3). Motion artefact: dominated by pressure/contact variation, not the cable, provided leads are fixed to the strap [E]. RF: 2.4 GHz rectification at the hi-Z node is the same risk with any lead; length ≥ 100 mm acts as an antenna — measure with the antenna in the enclosure [U].

**Suitability verdict [E]:** short (≤ 60 mm) twisted unshielded pairs are adequate for first bench validation; leads of 100–200 mm are the cases where a shield (S1) may matter — decide from data.

**Battery-only non-human bench plan (extends Part I §7):**
1. Continuity/insulation/pull per lead (DMM, no power).
2. Dummy-electrode network (resistor + 22 nF per leg) on a perf board, with mismatch 0/20/50/100 %.
3. Floating battery-powered signal source: 100 µV–1 mV differential and 100 mV CM at 50 Hz; leads of 30/50/100/200 mm, twisted/parallel/shielded.
4. Measure 20–450 Hz RMS, 50 Hz amplitude, CMRR; BLE on/off; antenna in enclosure.
5. Reference resistance sweep 100 kΩ → open.
6. Flex/pull cycling of leads without skin.
No mains-referenced instrument is connected to the DUT while electrode leads are attached; USB and charger are disconnected for every step involving leads.

## II.7 Final decision

**Build:** nine **PLUX 870992018** electrodes used dry on a flexible strap, each clipped into a **female snap socket lead** (SparkFun CAB-19244/KIT-19627 *pending the 5-minute fit check*), leads twisted per pair into **JST-PH 2-pin plugs** (Adafruit 261 pigtails for the first build), **unshielded and ≤ ~60 mm where the layout allows**, with the S1 shield-drain variant prepared for the 100–200 mm leads. REF uses J5001 pin 2 only; pin 1 stays unwired.
**Buy first (≈ €26 + shipping/VAT):** A1, A2, B1 (and B2 if B1 passes).
**Why this and not custom 316L:** no verified purchasable 316L dry EMG contact exists in the research; the PLUX electrode is the cheapest verified skin-contact stud part; the cable chain is the cheapest, and every unverified link has a ≤ €10 test.

## II.8 Remaining blockers
| # | Blocker | Owner |
|---|---|---|
| 1 | PLUX stud ↔ SparkFun socket fit and retention | sample test |
| 2 | 316L dry contact — no verified product; needs OEM inquiry | decision |
| 3 | Dry-contact impedance/stability on forearm | after safety gate |
| 4 | Shield S1 vs S4 decision | bench data |
| 5 | Strap materials/suppliers, crimp tool pricing, Bulgarian shipping/VAT | not researched |
| 6 | Enclosure insulation, exposed BAT+ post/pads | enclosure design |
| 7 | **Independent electrical safety review and written approval before any human electrode use** | you |

### Sources (Part II)
* https://www.pluxbiosignals.com/products/non-gelled-reusable-ag-agcl-pack-10
* https://www.pluxbiosignals.com/collections/accessories/products/2-lead-electrode-cable
* https://www.sparkfun.com/products/19244 · https://www.sparkfun.com/myoware-2-0-reference-cable-10-pack.html · https://learn.sparkfun.com/tutorials/getting-started-with-the-myoware-20-muscle-sensor-ecosystem/myoware-20-muscle-sensor
* https://www.adafruit.com/product/261
* https://med-linket-corp.com/blogs/ecg-electrodes/4mm-snap-ecg-electrodes-guide
* https://shop.openbci.com/products/emg-ecg-snap-electrode-cables
* https://www.partssource.com/parts/natus-medical/6030TP
* https://www.mouser.in/new/mill-max/mill-max-0985-receptacle/
* https://www.buerklin.com/en/control-cable-shielded/p/94f300 (snippet)
* https://soselectronic.com/en-pl/products/jst/phr-2-66229 (snippet) · https://www.farnell.com/cad/4768140.pdf
* Alpha Wire 3302 SL005: https://audiovideoelectric.com/products/alpha-wire-3302-sl005-multi-conductor-cables-28awg-2c-shield-100ft-spool-slate
