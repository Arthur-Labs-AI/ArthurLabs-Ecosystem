# Arthur Neuron RevB — JLCPCB pre-order closure

**NOT RELEASED — PENDING FACTORY APPROVAL**

**Verdict: READY FOR JLCPCB REVIEW BEFORE PAYMENT.** This is readiness of the current digital candidate for review. **Actual PCB/PCBA production is NOT APPROVED. Human-contact testing remains prohibited.** Nothing was uploaded, ordered, paid, emailed, committed or pushed.

## Scope and source of truth

Continued on `codex/revb-horizontal-jst`, HEAD `98cc84e07fe4cf2791a56baba2cde3e9bb599724`, preserving the pre-existing uncommitted electrical ECO. Candidate revision **HJ-JLC-RC1-2026-10-19** is an artifact identifier; the underlying board remains RevB. [MANUFACTURING_MANIFEST.json](MANUFACTURING_MANIFEST.json) binds current source and review artifacts by SHA256. The original [independent audit](../FINAL_AUDIT.md), prior manufacturing files and earlier evidence remain intact. This milestone closes digitally actionable manufacturing items; it does not repeat the full electrical audit.

October 12–13JLC responses were supplied by the owner in [REQUEST.md](REQUEST.md). They are incorporated as reported existing manufacturer guidance; original email headers/attachments were not provided or authenticated. No general response is represented as current-file CAM approval. The completeAUD-01…17disposition is [JLCPCB_CONFIRMED_VS_PENDING.md](JLCPCB_CONFIRMED_VS_PENDING.md).

## Implemented minimal corrections

1. **AUD-04 silkscreen:** moved existing passive/X1outline strokes outward to retain their complete shape and readable cues. Small source moves range 0.068–0.104 mm; no stroke was deleted. Increased the eight backside TP silk-circle radii from 0.95 to 0.98 mm. Matching seven local footprint files were updated, and affected library-table descriptions no longer claim unmodified stock. IC/diode pin 1 triangles and X1 pin 1 dot are unchanged.
2. **AUD-08 metadata:** corrected `RC0603FR-0710ML` declarations to ±1%, `CC0603KRX7R9BB104` to 50 V and `CL21A226MAQNNNE` to 25 V in every matching PCB/schematic Spec andDescription. This covers16 placed components (8 bias resistors, 7 decouplers, 1 bulk capacitor), 32 PCB properties and 20 sheet properties. Values, MPNs, LCSC numbers, footprints, connections and positions are unchanged. JLC BOM columns do not include these Spec fields, so the corrected BOM remains equivalent by rows to the preclosure package.
3. **Finish consistency:** changed source `copper_finish` from `HASL(with lead)` to `ENIG`, reflecting JLC's recommendation and the candidate order intent. Stack geometry/copper thicknesses remain unchanged; no plating/impedance/process result is implied.
4. **Review candidate:** regenerated Gerbers/drill/BOM/CPL with explicit NOT_RELEASED filenames, added factory remarks, manual XIAO and polarity instructions, a 28-group component review request and hashes. Current factory CPL conventions remain unchanged pending real factory preview.

No PCB outline resize, copper reroute, component substitution, pad/land edit, mask/paste change, via/drill change, new rule/exclusion, or unrelated electrical change was made. XIAO architecture and all JSTs retain their positions/nets. See [verification/source-invariants.json](verification/source-invariants.json) and [verification/metadata-diff.json](verification/metadata-diff.json).

## Verified results

| Gate | Result | Executed evidence / limitation |
|---|---|---|
|ERC |PASS:0 violations |KiCad10.0.6 `sch erc --severity-all --format json`;[erc.json](verification/erc.json) |
|DRC |PASS errors0;WARNING1 retained |`pcb drc --severity-all --schematic-parity --format json`;[drc.json](verification/drc.json). Only the pre-existingU1library representation warning;0 unconnected,0 parity |
|No electrical/geometry drift |PASS |[source-invariants.json](verification/source-invariants.json): normalizedAST permits only documented silk,exact-MPN Spec/Description andfinish changes. Project/DRCrules/symbol library untouched |
|Fresh electrical partition |PASS |[package-source-checks.json](verification/package-source-checks.json): fresh XMLpinpartition,values, MPNs and footprints equal preclosure |
|Silk source clearances |PASS |[silk-global-source.json](verification/silk-global-source.json):441line/poly/circleprimitives against365same-side mask shapes;none<0.15 mm;minimum0.160007 mm. Roundrect bounds conservative,circles exact. NativeDRCandvisualreview cover text; not a fabrication-registration guarantee |
|BOM/CPL |PASS |28groups/126refs,all Top,exactfresh XMLmapping,coords/rotation arithmetic,U1/TPexclusions;[placement-review.csv](verification/placement-review.csv). Factoryreelzero remainsUNVERIFIED |
|No verticalJST |PASS |FreshXML:fiveelectrodeheaders plus unchangedJ1allhorizontalS2B/C295747;noB2B/C160352 |
|Gerber/drill vs source |PASS |All11members match independent second native exports after datedheaders removed;[fresh-native-export-comparison.json](verification/fresh-native-export-comparison.json). Gerber/source counts: 12 checks PASS;[gerber-source-check.json](verification/gerber-source-check.json) |
|Unchanged fabrication exceptsilk |PASS |[export-vs-preclosure.json](verification/export-vs-preclosure.json):all 4 copper,2mask,paste,drill, outline identical exceptdatedheaders;onlyF/Bsilk differ. BOM/factory CPL/rawCPLrows unchanged |
|Actualboard outline/holes |PASS |51.30×64.95 mm,1mmcornerarcs;191×Ø0.30vias and1×Ø1.90component PTH;192holes,total. Noextra tooling holes in single-board source |
|Current191via mask check |PASS model;CAMpending |[current-mask.json](verification/current-mask.json):169class1,12class2,10class3,0class4;minhole-to-opening0.1009 mm;no bridge<0.10orforeigntrackgap<0.09. Annulus proximity/exposure is distinct fromhole-to-opening;generalJLCguidance is not a current-filewaiver |
|U1warning investigation |PASS representation comparison |[u1-comparison.json](verification/u1-comparison.json):16pads,graphics and11equivalentboardkeepouts unchanged. Warning remains visible;physical fitUNVERIFIED |
|Visual plots |REVIEWED |[closure-layers.png](verification/plots/closure-layers.png),native top/bottomSVG/PNG,copper/mask/paste/outlineplots. Roundedcorners checked in nativeSVG; customGerberrenderer approximatesarcs/corners |
|Priorfilespreserved |PASS |[preservation.json](verification/preservation.json):898pre-existing files checked;only14authorizedsourcefiles changed;all priorreports/packages intact |
|FactoryCAM/panel/placement/stock |UNVERIFIED |Pending actualReview Before Payment/Confirm Production File workflow; noexternal submission performed |
|XIAO physical assembly/bench/safety |UNVERIFIED / HUMAN BLOCKED |Requiresreal module,fixture,finishedboard and separate qualified safety review; unchanged bench-only restriction |

An intermediate run found8newTP/library warnings after the radius edit; the matching localTPfootprint was corrected and fullDRCrerun. The first result is retained as `verification/drc-first-iteration.json`; finalDRCreturns to the single pre-existingU1warning. No violation was ignored or weakened. Existing ignored categories and zero native silk-clearance setting were preserved; the independent0.15mmsilk check supplies the factory-specific check that nativeDRCalone did not provide.

Unused historical library definitions, if present, are preserved; none is installed or selected in the current BOM/CPL. Verification concerns actual current components rather than deleting historical files.

## BAT post and XIAO disposition

**RetainØ1.95top mask.** Current source/library/export geometry remainsØ1.90finished hole,Ø2.30top land,Ø3.00bottom land/opening at(44.635,54.790)mm;topnominal annulus0.20 mm. JLC's supplied general acceptance is sufficient to support a review submission, not manufacture. Require anopen platedCOMPONENThole,negative top maskmargin andbackside solderland preserved;noautomatictent/plug/fill/enlargement.

The2.00mmrecommendation was evaluated,not applied blindly. It reduces nominalintrusion by0.025 mm per side while exposing0.025mmmoreVBATtowardmodule BAT−. Under the old sensitivity assumptions it still does not guarantee absence ofmasklip. Detailedcomparison andphysicalunknowns are in[BAT_POST_ASSESSMENT.md](BAT_POST_ASSESSMENT.md). The old0.087mmshift statement is a one-axis result; this supplement additionally examines acombined two-axis sensitivity. No physical fit or tolerancequalification is claimed.

## Candidate package and remaining factory questions

Use only [NOT_RELEASED_PENDING_FACTORY_APPROVAL/](NOT_RELEASED_PENDING_FACTORY_APPROVAL/) and files selected in the manifest. Mainnames begin `ARTHUR_Neuron_RevB_HJ_JLC_RC1_NOT_RELEASED_`. InternalGerbermembers retainKiCadlayer names;the10Gerbers+1drillzipcontainsnofakepaneloutlineortooling. RawCPLis reference only. U1isfactoryDNP;manualassembly instructions are proposed and unqualified,not manufacturer-approved workinstructions.

Request4layers,1.6mmnominal,ENIG,greenmask/whitesilk and5fabricated/2topassembled. Economiceligibility and thatquantitysplit remain unconfirmed. Source dielectrics0.2104/1.065/0.2104 mm andouter35 µm/inner15.2µmcopper are recorded designintent;factory must return compatibleactualstack/tolerances. Do not claim standardEconomicstackexactlymatches thesevalues.

Onlyremainingquestions are drafted in[JLCPCB_FOLLOWUP_EMAIL.md](JLCPCB_FOLLOWUP_EMAIL.md):actualpanel/rails/fiducials/depanelplan;5/2quantity;exact28groupeligibility/stockandX1spec;reel/placement/polarity preview;anyremainingCAMsilkissue;actualBATposttreatment;JSTstencil/handling andmanualinterfacepreservation. Generalquestionsaboutannulusminimum,1:1mask,ENIGrecommendation andavailabilityofReview Before Payment are not repeated.

Current official guidance distinguishes prepaymentreview from subsequentproduction-filepreparation. Use bothReview Before PaymentandConfirm Production File;do notassume thatpayment orcostapproval closes theactual CAMgate. Download/comparefinal production files and resolve EQ before authorization. No email was sent.

## Decision and limits

**READY FOR JLCPCB REVIEW BEFORE PAYMENT.** All digitally actionable corrections necessary to prepare this review candidate are implemented and verified. Remainingfactory questions are appropriate to that review;they are not hiddenunverifieddesignchanges.

**NOT APPROVED FOR ACTUAL PCB/PCBA PRODUCTION.** Factorypanel/CAM,exact parts,placements,quote and owner approval remain open. Physicalmodule/postqualification,bench bring-up,battery/harness/enclosuretests remain outstanding. Human-contact testing is prohibited pending separatequalified electrical safety assessment andrequired physical validations. Factory approvalcannotestablishbody-contact safety.
