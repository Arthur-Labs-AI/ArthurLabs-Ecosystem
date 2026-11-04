# JLCPCB technical inquiry — design "ARTHUR_EMG_RevB" (4-layer, 51.30 × 64.95 mm, 1.6 mm, HASL), draft for approval

Please answer for a 4-layer 1.6 mm JLC04161H-7628 board, 1 oz outer / 0.5 oz inner, 0.30 mm drilled / 0.60 mm pad through vias, default tenting.
Attachments: overview.png (numbered), V01–V22.png (4 × 4 mm crops, F.Cu + F.Mask, the via circled), via_list.csv (coordinates and measured distances).
Gerber / drill / BOM / CPL files are NOT attached to this draft.

**Q1 (10 vias V01–V10).** The via annulus (0.60 mm) overlaps the solder-mask opening of a same-net SMD pad by 0.009–0.049 mm; the via hole edge is
0.101–0.141 mm from the opening. The Gerber mask layer contains no aperture for the via (tented both sides). (a) Will your CAM keep the via covered
(not open or merge it with the pad opening)? (b) Is a 0.10 mm mask web between a pad opening and a tented via hole acceptable, and with what
registration tolerance (the capabilities page gives none)? (c) Do you modify the pad aperture in these cases?

**Q2 (12 vias V11–V22).** The via annulus is outside the opening but 0.000–0.087 mm from it. Your page says "keep at least 0.09 mm clearance between
soldermask openings and neighboring traces". Does this apply to via annuli? What does CAM do when it is not met (shrink the opening, leave it, reject)?

**Q3.** Via 0.30 / 0.60 mm: annular ring 0.15 mm. The PTH row of the capabilities page gives "multilayer 1 oz: recommended 0.20 mm, absolute minimum 0.15 mm".
Is 0.15 mm acceptable for vias on this stack-up, and is there any surcharge or yield reduction? Would 0.25 / 0.60 mm (ring 0.175 mm) change price or lead time
(aspect ratio 1.6 : 0.25)?

**Q4.** For a 4-layer order, what is the default via treatment on the order form when the mask Gerber has no via apertures — tented both sides, and is that
free? Is "plugged" possible for vias that are 0.1–0.3 mm from pad openings (your page requires ≥ 0.35 mm)?

**Q5.** Eight bare 1.5 mm test pads on B.Cu (HASL, no paste) with a tented via 0.08 mm from the opening of two of them (V11, V14): any concern?

**Q6 (assembly, Economic).** Please confirm the rotation convention of your library for: SOT-23 (BAV199, 2N7002), SOT-23-5 (TPS7A2030), TSSOP-14/20,
JST B2B-PH-SM4 / S2B-PH-SM4, SX3M 3225 oscillator; and that the 255 ± 5 °C Economic profile is compatible with those JST connectors.

**Q7.** Board outline: Edge.Cuts line width 0.1 mm gives 51.4 × 65.05 mm in the job file; the centre-line size is 51.30 × 64.95 mm. Which dimension do you use for pricing and for the
2.5 mm body-to-edge note?

Coordinates are KiCad board coordinates in mm (origin top-left, y down).
