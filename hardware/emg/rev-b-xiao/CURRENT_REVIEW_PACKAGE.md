# Arthur Neuron RevB — current manufacturing review candidate

Status: **READY FOR JLCPCB REVIEW BEFORE PAYMENT — NOT RELEASED.** Production authorization and human-contact safety approval remain separate and unapproved. No order, payment or external submission was performed during Git finalization.

Use the existing HJ-JLC-RC1 package in [NOT_RELEASED_PENDING_FACTORY_APPROVAL](evidence/pre-manufacturing-audit/jlcpcb-closure/NOT_RELEASED_PENDING_FACTORY_APPROVAL/). Earlier horizontal-JST exports and earlier quote packages are historical evidence, not the current review candidate.

| Review input | Current file |
| --- | --- |
| JLCPCB BOM | [ARTHUR_Neuron_RevB_HJ_JLC_RC1_NOT_RELEASED_BOM.csv](evidence/pre-manufacturing-audit/jlcpcb-closure/NOT_RELEASED_PENDING_FACTORY_APPROVAL/ARTHUR_Neuron_RevB_HJ_JLC_RC1_NOT_RELEASED_BOM.csv) |
| Explicit quantities and exact MPNs | [COMPONENT_REVIEW_REQUEST.csv](evidence/pre-manufacturing-audit/jlcpcb-closure/NOT_RELEASED_PENDING_FACTORY_APPROVAL/COMPONENT_REVIEW_REQUEST.csv) |
| Placement file to submit for review | [ARTHUR_Neuron_RevB_HJ_JLC_RC1_NOT_RELEASED_CPL.csv](evidence/pre-manufacturing-audit/jlcpcb-closure/NOT_RELEASED_PENDING_FACTORY_APPROVAL/ARTHUR_Neuron_RevB_HJ_JLC_RC1_NOT_RELEASED_CPL.csv) |
| Fabrication geometry | [ARTHUR_Neuron_RevB_HJ_JLC_RC1_NOT_RELEASED_Gerbers.zip](evidence/pre-manufacturing-audit/jlcpcb-closure/NOT_RELEASED_PENDING_FACTORY_APPROVAL/ARTHUR_Neuron_RevB_HJ_JLC_RC1_NOT_RELEASED_Gerbers.zip) |
| Review bundle | [HJ_JLC_RC1_REVIEW_BUNDLE_NOT_RELEASED.zip](evidence/pre-manufacturing-audit/jlcpcb-closure/HJ_JLC_RC1_REVIEW_BUNDLE_NOT_RELEASED.zip) |
| Source/artifact hashes and review settings | [MANUFACTURING_MANIFEST.json](evidence/pre-manufacturing-audit/jlcpcb-closure/MANUFACTURING_MANIFEST.json) |
| Final Git/package verification | [REPORT.md](evidence/git-manufacturing-finalization/REPORT.md) |

The BOM contains 28 groups and 126 factory-assembled references per board, including six `S2B-PH-SM4-TB(LF)(SN)` horizontal JST-PH connectors, LCSC `C295747`. U1 XIAO is manual/DNP for factory assembly; TP1–TP8 are copper features and excluded from purchased components. The CPL has 126 unique top-side placements. No component identifiers were invented or substituted.

The existing BOM's four columns are `Comment`, `Designator`, `Footprint`, and `LCSC Part #`. These meet the [JLCPCB KiCad BOM instructions](https://jlcpcb.com/help/article/how-to-generate-the-bom-and-centroid-file-from-kicad). Comment includes value and exact MPN. Per-board quantities follow from each designator list; the existing component-review CSV also explicitly lists quantities per board and for two assembled boards. Both files were verified and reused without generating duplicate BOMs. The raw KiCad-rotation CPL is reference-only; use the corrected CPL linked above for factory placement review.

The 51.30 × 64.95 mm outline is preserved. ENIG, the open BAT component hole, manual XIAO installation, polarity review, panel/rail arrangements and requested 5 fabricated / 2 assembled split require the existing [closure instructions](evidence/pre-manufacturing-audit/jlcpcb-closure/CLOSURE_REPORT.md) and [order-readiness checklist](evidence/pre-manufacturing-audit/jlcpcb-closure/ORDER_READINESS_CHECKLIST.md). Stock, service eligibility, factory CAM and actual placement orientation still require factory confirmation. Physical fit, bench validation, final enclosure integration and separate body-contact testing remain outside review-file approval.

The frozen manifest records the pre-commit HEAD at package creation. Its 27 source hashes and artifact hashes match the committed files. The finalization report binds those unchanged bytes to the subsequent engineering commits; historical reports and bundled hashes were preserved verbatim.
