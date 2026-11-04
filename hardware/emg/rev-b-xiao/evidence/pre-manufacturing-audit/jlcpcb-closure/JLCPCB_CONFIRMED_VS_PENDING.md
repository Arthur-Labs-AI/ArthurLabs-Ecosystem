# JLCPCB guidance and remaining approval gates

**NOT RELEASED — PENDING FACTORY APPROVAL** · HJ-JLC-RC1 · 2026-10-19

The October 12–13 responses below were supplied by the owner in [REQUEST.md](REQUEST.md). They are accepted as existing manufacturer guidance for this task. Original email headers/attachments were not supplied or independently authenticated. This supplement does not replace or edit [FINAL_AUDIT.md](../FINAL_AUDIT.md). General acceptance is not approval of the current CAM files.

| Topic | Existing written guidance, as supplied | Current evidence / disposition | Remaining question |
|---|---|---|---|
| Special component PTH | Ø1.90 finished hole/Ø2.30 top/Ø3.00 bottom generally acceptable for standard4-layer; designer specifies finished size and factory compensates tool | PARTIALLY ADDRESSED: unchanged source and exported component drill; top annulus0.20 mm | Design-specific CAM acceptance, finished-hole tolerance and open plated treatment |
| Top mask opening | Ø1.95 accepted generally; aboutØ2.0 or greater preferred where feasible; smaller-than-hole opening may be treated as tented/plugged | PARTIALLY ADDRESSED: keepØ1.95; enlarging trades mask intrusion for more exposedVBAT near module BAT−; see BAT_POST_ASSESSMENT.md | Preserve actual geometry or raiseEQ before any change; never tent/plug/fill this component hole |
| Pad/mask ratio |1:1 manufacture supported | CLOSED for general capability, not specificCAM | No repeat general question |
| Annulus |Via minimum0.075 mm per side; component PTH recommended≥0.20 mm | Current component PTH0.20 mm nominal; current vias0.15 mm nominal | Finished registration/annulus in actual CAM, not another general minimum inquiry |
| Green mask/nearby vias |≥0.1 mm generally acceptable;22 earlier proximity cases generally acceptable; minor annulus exposure possible;EQ if required | PARTIALLY ADDRESSED: current191vias rechecked,169class1/12class2/10class3,0class4; minhole-to-opening0.1009 mm. Mask/copper/drill unchanged by closure | Acceptance of current files, particularly shared/open mask areas; earlier201via count does not establish current-file approval |
| Finish |ENIG recommended | CLOSED as design/order-intent choice: source copper_finish updated fromHASL(with lead) toENIG; requestedENIG | Actual quoted stack/finish andCAM still require review |
| Economic PCBA |Potentially compatible; component-specific restrictions possible | FACTORY CONFIRMATION REQUIRED for28exact groups; no substitution authorized | Exact eligibility/stock, particularlyX1; permittedservice/quantity combination |
|5fabricated/2assembled |Not definitively confirmed | FACTORY CONFIRMATION REQUIRED | Confirm that exact split, including bare versus assembled delivery counts |
| Price |Generated after upload/options | FACTORY CONFIRMATION REQUIRED | Final reviewed quote; no estimated price invented |
| Review Before Payment |Supported | CLOSED as workflow availability, not completed review | User must select correct option and inspect review result; nothing uploaded here |
| Confirm Production File |Recommended | CLOSED as selected review control, not finalCAM acceptance | Download and independently compare actual production files before authorization |

Current official[JLC Review Before Payment guidance](https://jlcpcb.com/help/article/review-before-payment-service-for-pcba-orders), updatedSeptember23,2026, distinguishes prepayment BOM/CPL/cost review from production preparation after payment. It states stock reservation is time-limited and approved awaiting-payment orders cannot be modified. The[production-file confirmation guide](https://jlcpcb.com/help/article/how-to-confirm-the-production-file) describes a separate CAM-file review after payment. Therefore **Review Before Payment does not by itself prove the eventual production CAM is accepted**. Maintain the second approval gate before manufacture. These recent pages supersede contradictory olderFAQ wording about PCBA review availability; no new general support question is needed.

The[official C295747 page](https://jlcpcb.com/partdetail/280164-S2B_PH_SM4_TB_LF_SN/C295747) identifies the exact JST header and lists Economic and Standard. It is catalog evidence, not confirmation that12headers for2boards are reserved. All28 groups, with required quantities, are listed in [COMPONENT_REVIEW_REQUEST.csv](COMPONENT_REVIEW_REQUEST.csv).

## Disposition of every independent-audit finding

CLOSED below applies only to the specified documentary/digital subproblem; no factory or safety approval is implied.

| Finding | Status | Evidence / remaining gate |
|---|---|---|
|AUD-01 non-isolated body interface |OPEN — requires correction/qualified safety disposition before human use |Unchanged; JLC process guidance cannot close electrical safety |
|AUD-02 current limiting/faults |OPEN — requires qualified safety disposition |Unchanged protection topology; dummy-load/fault testing required |
|AUD-03 panel/rails/tooling |FACTORY CONFIRMATION REQUIRED |ExistingEconomic guidance reduces uncertainty; actual51.30×64.95panel/rail/depanel plan unresolved |
|AUD-04 silk clearance |CLOSED — verified by available digital evidence |441source silk primitives checked against365mask shapes; no line/poly/circle gap<0.15 mm; minimum0.160007 mm. Pin1polygons/X1dot preserved; new native plots inspected |
|AUD-05 factory rotation |FACTORY CONFIRMATION REQUIRED |126CPL transforms unchanged and verified; exact reel/preview approval not obtained |
|AUD-06 XIAO post |PARTIALLY ADDRESSED |Manufacturing geometry nominally acceptable per supplied guidance; actual CAM gate remains and physical module/jig qualification REQUIRED |
|AUD-07 sourcing |FACTORY CONFIRMATION REQUIRED |28group exact BOM verified; X1controlled exact spec and actual stock/service eligibility remain open |
|AUD-08 metadata |CLOSED — verified by available evidence |1%10M,50V100 nF,25V22 uF corrected in every matching PCB/schematic instance; values/MPNs unchanged |
|AUD-09 interlock margins |PHYSICAL VALIDATION REQUIRED |ExactJSCJ gate margin must be measured; no circuit change in this task |
|AUD-10 ADC transient limits |PHYSICAL VALIDATION REQUIRED |Capture ramps/shutdown/USB transitions before acquisition qualification |
|AUD-11 bandwidth/noise |PHYSICAL VALIDATION REQUIRED |Actual source/filter/PGA/ODR measurements remain pending |
|AUD-12 battery/charger |PHYSICAL VALIDATION REQUIRED |Protectedcell,polarity,charger/current/thermal tests before cell/body use |
|AUD-13 harness/strain relief |PHYSICAL VALIDATION REQUIRED |RealPHR2fit,removal,cable bend/loads and enclosure remain unqualified;7 mm travel is assumption |
|AUD-14 BAV199 suffix |CLOSED — manufacturer identity evidence retained |ExactBAV199,215 remains; no generic suffix stripping, no checker suppression. HistoricalD06failure stays in independent audit |
|AUD-15 U1 library warning |CLOSED for current geometry explanation |Rechecked16pads and11board keepouts; warning still visible, not disabled. Does not qualify module fit |
|AUD-16 obsolete packages |CLOSED for this review candidate |Hash manifest selectsRC1only and explicitly excludes prior vertical-JST/R1b/quote packages; old files retained |
|AUD-17 RF/return integrity |PHYSICAL VALIDATION REQUIRED |Bench-only clock/SPI/radio/noise tests remain in original audit |
