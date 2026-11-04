# A.R.T.H.U.R EMG Rev B — XIAO Installation Procedure (RB-00.6)

JLC delivers the EMG board fully assembled except U1 (XIAO, DNP). This procedure is the only manual assembly.

## Tools

- Temperature-controlled iron
  - 330 °C (Sn63/Pb37 or SAC with good flux) to 360 °C max (lead-free)
  - chisel tip 1.6–2.4 mm
- No-clean flux (pen or gel)
- 0.5 mm solder
- Solder wick 1.5–2.0 mm
- Fine tweezers
- Multimeter
- IPA + brush
- Optional: Kapton tape, helping hands, 5–10× loupe, bench supply with current limit

**Not needed:** hot plate, reflow oven, hot air, microscope.

**Parts:** 1 × Seeed XIAO ESP32-S3 (plain, *unsoldered-header* version; **headers must not be fitted**), 6 mm of AWG 24 solid tinned copper, the 1S LiPo with PCM.

## Step 0 — Inspect the JLC PCBA (5 min)

1. Visual check: no solder bridges on U6001/U50x, BAV199 orientation (pin 1 GND), J_BAT and electrode connectors seated.
2. **The XIAO pads are clean and flat.** No paste bumps: they should look HASL-flat.
3. **The BAT+ post hole at (68.3, 21.9) is open.** Hold the board to the light; the hole must not be plugged.
4. Resistances with the XIAO **not** fitted. A reading far outside the table means stop and investigate.

| Probe | Expected | Checks |
|---|---|---|
| J_BAT+ ↔ GND | ≥ 1 MΩ (VBAT divider 2 MΩ ∥ LDO leakage) | No VBAT short |
| XIAO pad 14 (5V) ↔ GND | ≈ 4.4 kΩ (4.7 k ∥ 110 k ∥ 250 k) | 4.7 k load fitted |
| AFE_EN (TP6) ↔ GND | ≈ 80–100 kΩ | Fail-safe pull-down fitted |
| XIAO pad 12 (3V3) ↔ GND | > 5 kΩ | No DVDD short |
| Bottom VBAT post pad ↔ J_BAT+ | < 1 Ω | Post pad connected |

5. **Battery polarity:** confirm the LiPo's JST-PH lead is BAT+ on J_BAT pin 1 as silkscreened. JST-PH battery polarity is *not* standardised between vendors.

## Step 1 — Solder the BAT+ post to the XIAO (5 min)

1. Place the XIAO upside down on a clean ESD-safe surface (or in helping hands). Locate BAT+: of the two large rectangular pads, it is the one **farther from the USB-C** (10.9 mm from the far end vs 12.8 mm for GND0; checklist M6/M7).
   - Confirm with a meter: GND0 reads ≈ 0 Ω to the GND castellation (pin 13); BAT+ does not.
2. Flux the pad. Tin **only its centre** with a small amount of solder.
3. Straighten the 6 mm post. Hold it vertical with tweezers on the pad centre, touch the iron to the post/pad junction for 1–2 s, remove the iron, and hold still until solidified.
4. Check:
   - post ⟂ (±10°)
   - cone Ø ≤ 1.1 mm and height ≤ 0.5 mm
   - **no solder on GND0**
   - BAT+ ↔ GND0 on the module reads *not* 0 Ω
5. Clean with IPA.

## Step 2 — Position the XIAO (2 min)

1. Flux all 14 host pads lightly.
2. Lower the XIAO component-side up, **USB-C toward the south board edge**, inserting the post into the plated hole. The post locates the module.
3. The module sits flat on the solder mask:
   - rock test: no wobble
   - USB end flush with the board edge (0 to +0.2 mm inside)
   - equal toe visible on both sides (≥ 1.0 mm each)
4. Optional: Kapton tape across the module top to hold it.

## Step 3 — Tack one corner (pin 14, 5V, south-west)

Load the iron tip with a small solder bead. Touch the toe of pad 14 against the castellation wall for 2–3 s until the fillet wets both.

## Step 4 — Align

Re-check every castellation against its pad centre (±0.2 mm) and the toe symmetry. If misaligned, reheat pad 14 and nudge the module with tweezers.

## Step 5 — Tack the opposite corner (pin 7, D6, north-east)

## Step 6 — Solder the remaining 12 castellations

- Order: west side north → south, then east side.
- **Per joint:** iron on the toe, touching the castellation wall; feed 0.5 mm solder into the junction, not onto the iron; 2–4 s; withdraw along the pad axis.
- **Pin 13 (GND, plane-connected)** may need 4–6 s or +20 °C.
- Re-flow the two tack joints last so all 14 look alike.

## Step 7 — Solder BAT+ from the underside

1. Flip the board onto a soft ESD mat, resting on the XIAO/connector tops.
2. Flux the Ø3.0 bottom pad. Solder post and pad until the barrel fills (3–5 s; thermal-relief pad).
3. Trim the post to ≈ 1.0 mm. Reheat briefly if the trim disturbed the joint.

## Step 8 — Inspect

- Loupe check of all 14 fillets: wetting ≥ 1.0 mm of toe, climbing the wall ≥ ½ of the XIAO PCB thickness.
- **Bridges:** check the 6 adjacent-pin gaps per side (12 total) visually. Clear any with wick + flux.
- Clean the flux with IPA (no-clean residue is acceptable but hides bridges).

## Step 9 — Continuity and short tests (battery disconnected, USB disconnected)

| Test | Expected |
|---|---|
| Each adjacent castellation pair (12 pairs) | Not 0 Ω (they are different nets; GND–3V3–5V pairs show kΩ-range) |
| XIAO top-side castellation ↔ its board net (probe the series R / network pad): D8→R_SCLK, D10→R_MOSI, D9→R_MISO path, D7→R_CS_PU, D1→R_DRDY, D2→R_SYNC_PU, D3→R_EN_S, D0→VBAT divider, 3V3→FB1, 5V→R_VBUSLD, GND→plane | < 1 Ω each |
| 5V (pin 14) ↔ GND | ≈ 4.2 kΩ (now also ∥ XIAO R9 100 k) |
| J_BAT+ ↔ GND | No short: > 1 kΩ and rising while the caps charge (XIAO charger/buck input now in parallel). Record the value |
| J_BAT+ ↔ bottom post pad | < 1 Ω |

## Step 10 — First power-up, **no electrodes connected**

1. Use a bench supply at 3.80 V with a **150 mA current limit** on J_BAT (instead of the LiPo).
2. Expected: the XIAO boots (LED/serial). Supply current 25–80 mA. **If ≈ 0 mA, the BAT+ post path is open** → recheck step 7.
3. Measurements:

   | Node | Expected |
   |---|---|
   | XIAO 3V3 | 3.25–3.40 V |
   | DVDD_F | ≈ 3V3 |
   | 5V pin | < 0.5 V |
   | AFE_EN | < 0.1 V |
   | AFE_3V0 | < 0.1 V (default OFF) |

4. Firmware drives D3 high → AFE_3V0 = 2.955–3.045 V, AFE_EN ≈ 3.0 V.
5. **Inhibit test** (electrodes still disconnected): plug in USB → AFE_3V0 < 0.3 V within 10 ms even with D3 high; unplug → it returns. Reset the XIAO → AFE_3V0 off during reset.
6. Only then connect the LiPo, then electrodes (battery only, USB detached).

## Rework (realistic assessment)

- **Removal:**
  1. Desolder the **BAT+ post from the underside first**: wick the bottom pad, then heat and push the post up.
  2. Then either **hot air** (≈ 350 °C, 60–90 s, nozzle over the module), which is the practical method, or **iron + low-melt alloy** (ChipQuik-type) run along both castellation rows, which works without hot air.
  3. Wicking alone leaves solder in the half-holes and is unlikely to free the module.
- **Hardest joints:** pin 13 GND (plane heat-sinking) and the BAT+ barrel (VBAT pour). Both have thermal relief by design.
- **Board survival:** 1.50 × 2.90 mm HASL pads on 1 oz outer copper with trace (not plane) attachment tolerate **one replacement** with normal care. A second replacement risks lifted toe pads; not planned.
- **Competition policy:** a failed brain means swap to the **second complete Rev B device**. No field rework.
