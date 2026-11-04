# Draft follow-up — NOT SENT

**NOT RELEASED — PENDING FACTORY APPROVAL**

To: JLCPCB technical/PCBA support — continue the existing correspondence

Subject: Arthur Neuron RevB horizontal-JST RC1 — design-specific review before payment

Hello JLCPCB team,

Thank you for your October 12–13 guidance on the plated component hole, green solder mask, ENIG and potential Economic PCBA eligibility. The attached RC1 files contain our current horizontal-JST revision and supersede the earlier vertical-JST/R1b files.

We request a 51.30 × 64.95 mm, four-layer, 1.6 mm nominal board with ENIG, green mask and white silk: five fabricated boards, with two assembled on the top side and three unassembled. The BOM contains 126 placed references in 28 groups. U1 is factory DNP for later manual assembly; TP1–TP8 are copper test pads. The current board has 191 vias, rather than the 201 in our earlier inquiry. No substitutions are pre-approved.

Please confirm against these files:

1. Your panelization, rails, fiducials, tooling and depaneling plan. Please return a drawing showing clearance to the north-facing electrode headers, east-facing battery header and south USB/module interface, preserving the final board outline.
2. Support for the requested five-fabricated/two-assembled quantity split.
3. Economic PCBA eligibility and stock for all 28 exact MPN/LCSC groups, using COMPONENT_REVIEW_REQUEST.csv quantities. Flag any part requiring Standard service. In particular, confirm X1, SX3M8.192M20F30TNN/C2901557, and supply its exact ordering, land, pin and tape specification. Please request approval before proposing an alternate.
4. The placement preview and supplier-reel polarity: diode/IC pin 1, X1 pin 1 OE, five electrode headers facing north and J1 facing east. The raw KiCad CPL is reference only; use the factory CPL without applying another correction.
5. Any remaining CAM silkscreen or polarity-mark issue. The former 0.09 mm gaps have been corrected; our current geometric minimum is 0.160 mm, so the earlier waiver request is no longer needed.
6. Actual CAM treatment and finished-hole tolerance for U1 pad 23 at board X44.635/Y54.790 mm (Gerber Y−54.790): Ø1.90 mm finished open plated component hole, Ø2.30 mm top land, Ø1.95 mm top mask opening and Ø3.00 mm bottom land/opening. We retained Ø1.95 mm after evaluating the larger-opening recommendation against nearby module BAT− clearance. Do not tent, plug, fill, cover or enlarge it without an Engineering Question and our approval.
7. Any special stencil, reflow or handling restriction for the six S2B-PH-SM4-TB(LF)(SN) headers and the unpopulated XIAO interface. Preserve all JST retention pads and the no-paste manual-solder interface; do not source or place U1.

We intend to select Review Before Payment and Confirm Production File. Please identify which checks can be resolved before payment and provide the eventual CAM files for separate approval before manufacture. These attachments are for review and do not authorize production.

Attachments: RC1 NOT_RELEASED Gerber/drill ZIP, BOM, factory CPL, reference-only raw KiCad CPL, manufacturing remarks, polarity sheet, component review CSV and manufacturing manifest.

Thank you.
