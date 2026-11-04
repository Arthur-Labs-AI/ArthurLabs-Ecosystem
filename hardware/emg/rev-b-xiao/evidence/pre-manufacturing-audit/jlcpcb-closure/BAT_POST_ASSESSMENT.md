# XIAO BAT-post disposition

**NOT RELEASED — PENDING FACTORY APPROVAL**

**Decision: retain the existing architecture and Ø1.95 mm top mask opening.** No demonstrated copper/drill/mask defect justifies an automatic change. Supplied JLC guidance supports general manufacturability; specific CAM and physical assembly remain unapproved.

Current source/library/Gerber agree:U1pad23,VBAT,center(44.635,54.790)mm;Ø1.90finishedPTH;Ø2.30top/innerlands;top mask margin−0.175givesØ1.95opening;overlappingØ3.00B.Cu/B.MaskSMDland provides backside solder area. The bottom mask is the union ofØ1.95PTH andØ3.00SMDopenings. Nominal component annulus=(2.30−1.90)/2=0.20 mm, matching the supplied recommendation. These are file dimensions, not as-manufactured measurements.

| Top opening | Radial opening beyond nominal hole | Mask covering top land radially | Nominal opening-edge gap to module GND0 | Legacy lip sensitivity* |
|---|---:|---:|---:|---:|
|Ø1.95 mm(current)|0.025 mm|0.175 mm|0.422 mm|0.165 mm|
|Ø2.00 mm(candidate)|0.050 mm|0.150 mm|0.397 mm|0.140 mm|
|Ø2.05 mm(reference)|0.075 mm|0.125 mm|0.372 mm|0.115 mm|

*Sensitivity only: historical hole+0.13diameter,holeposition±0.075,maskregistration±0.05 mm assumptions. They are not a newly confirmed contract. A2.00opening does not eliminate every possible mask lip in that model. It exposes0.025 mm more radialVBAT towardBAT−for0.025 mm less nominal intrusion. Any adjustment therefore needs actual CAM justification, not just a general preference.

The nominal host copper-ring gap to module GND0is0.247 mm; it is distinct from the opening-edge gap. Neither is an electrical safety clearance certification. Manufacturer production compensation is the factory's task; do not enlarge the designer's drill to compensate manually. Require the factory to preserve the negative top mask margin, open plated component hole, bottom land and electrical plane clearances. RaiseEQif exact rendering would classify/tent/plug/fill the hole or change a mask opening. No factory instruction to silently enlarge the mask is issued.

## Tolerance investigation

Earlier RB-04F/J reports assume aØ1.0 mm solder cone and total0.497 mm error per axis from handpost placement,module registration,hole position,host registration and datum terms. With a1.82 mm assumedminimum finished hole, cone radial clearance is0.410 mm. The often-quoted0.087 mm required module shift is **a one-axis result**, not a complete two-axis registration proof.

An additional2D sensitivity check using the earlier allowed shift rectangle(u±0.513,v±0.150 mm) gives a minimum residual0.347 mm at the simultaneous per-axis corner, leaving0.063 mm radial clearance. One feasible limiting shift is approximately(u0.279,v0.150 mm); it must be checked against real castellation overlap and assembly access, not mistaken for an approved assembly tolerance. No new contradiction proves the PCB must change under those assumptions, but the model is contingent on unpublished module tolerances and an unbuilt solder/jig process. No statistical yield or worst-case physicalPASS is claimed. See [verification/bat-post-assessment.json](verification/bat-post-assessment.json).

The current Seeed “plainv1.4” document supplied through its resource page is Sense-labelled, as documented in the independent audit. Existing CAD locates BAT0/GND0 and the14 castellations consistently, but does not establish retail module lot, underside height/flatness, pad registration, cone repeatability or handling life. The old report's strong assertions that debris/solder bridging is not credible or that fatigue is negligible are not adopted as physical qualifications here.

## Physical checks that remain mandatory before module assembly/operation

- Measure the actual selected headerless plainmodule, BAT±pads,castellations,USB/U.FL and underside protrusions; record its exact revision.
- Use an unpowered dummy fixture/post to establish allowable cone/post size, tilt,module shift,toe overlap,seating and accessible backside fillet. Do not force a nominal fit.
- Inspect the actual finished hole/plating and mask lip/registration on received boards; reject tented/plugged/filled/obstructed holes. Check with a controlled gauge appropriate to the factory-confirmed finished tolerance.
- Microscope-inspect BAT0-toGND0beforeseating and inspect backside fillet/clearances afterward; verify no hard short and correct continuity before current-limited bench power. No battery or USB during soldering.
- Qualify joint fatigue,USBsupport and cable/strap strain relief. The post is an electrical link, not a locator or structural support. No body contact is authorized.

These requirements belong to a bench-assembly qualification and separate safety process; they do not prevent sending current digital files for factory review.
