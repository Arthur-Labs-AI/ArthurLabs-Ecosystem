# Proposed manual XIAO process — qualification required

**NOT RELEASED — PENDING FACTORY APPROVAL** · bench-only

Factory boundary: populate126SMTreferences on top. Do not source/placeU1. TP1–TP8 are bare copper test points, not components. U1's14 castellationlands and BATpost interface have noF.Paste. Keep all pad,mask and plating features,including backsideØ3.00land. No hand soldering is requested from JLCPCB unless separately agreed.

This is an editable prototype process proposal, not a physically validated work instruction. Use the exact selected headerless plainXIAO(PN202003751; verify actualmodule/revision) and protect its RF/USBinterface from mechanical force. Current externalCAD does not certify the delivered module dimensions.

1. With all power,USB and battery disconnected, inspect the bare host and actualmodule under a microscope. Measure finishedØ1.90PTH against confirmed factory tolerance, mask opening, plating and absence of plugs/debris. Identify moduleBAT0/GND0from actualmodule documentation and continuity, not appearance alone.
2. Trial fit with an insulated dummy post and a supported unpowered fixture. Record module seating/flatness,toe overlap and necessary lateral shift. Reject force-fitting, rocking, poor overlap or underside contact. Qualify a fixture before relying on the historical tolerance model.
3. Proposed conductor is approximatelyØ0.51 mm(AWG24solid copper), measured before use. Historical proposed process pre-solders a cone≤Ø1.0×0.4 mm to moduleBAT0, then lowers it into the open hostPTH. This cone size and solder quantity require physical qualification; they are not Seeed/JLC approved dimensions. Gauge the actual cone, inspectBAT0-toGND0forbridges and confirm unpowered continuity before seating.
4. Hold the module in its supported alignment; tack opposed castellations, verify seating and polarity, then finishall14 castellationjoints. Solder the backside post to theØ3.00land with controlled heat and a visible concave fillet. Do not intentionally fill the hole or flood solder toward the concealed module pads. The module-side joint must have been inspected before it becomes concealed.
5. Inspect both sides, flux cleanliness and absence of conductive debris. VerifyVBATcontinuity fromJ1.1toU1.23, ground throughU1.13, correct5 V/3V3mapping, and absence of a hardVBAT-GNDshort. Expected resistance readings include module circuitry and capacitors; do not use a universal arbitrary resistance threshold.
6. First power from a current-limited bench source with no cell and no body contact. Follow the independent audit's bring-up plan; validate interlock,clock/ADC,charging separately. Failed fit, continuity, abnormal current or temperature stops progression.
7. Provide enclosure support at the USBend and independent cable/battery/strap strain relief. The BATpost must not serve as a structural locator, USBload support or cable anchor. Thermal/mechanical fatigue qualification remains physical work.

Rework of the hiddenmodulejoint, solder cone repeatability and exactmodule pad tolerances remain open. If the process cannot be made repeatable, stop and authorize a separately reviewed mechanical ECO; no architecture change is hidden in this candidate.
