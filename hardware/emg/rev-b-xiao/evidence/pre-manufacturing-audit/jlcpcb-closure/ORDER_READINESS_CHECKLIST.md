# Order gates — HJ-JLC-RC1

**NOT RELEASED — PENDING FACTORY APPROVAL**

## Prepared for review (executed PASS)

- [x] Current51.30×64.95 mm horizontal-JST board selected; obsolete packages excluded by manifest.
- [x] Only authorized silk/metadata/finish changes; connectivity,values, MPNs,pads,mask,drill, outline,stack geometry and placements preserved.
- [x] ERC0 violations; DRC0 errors,1 pre-existing U1 warning;0 unconnected;0 parity issues. No rule/exclusion weakened or added.
- [x] Independent source silk check: 441 primitives, 365 mask shapes; no gap<0.15 mm; smallestconservativegap0.160007 mm. X1dot and diode/ICpin1polygons unchanged.
- [x] Fresh native Gerber/drill comparison matches all11packagemembers except datedheaders. All4copper,mask,paste,drill, outline unchanged from preclosure.
- [x] BOM28groups/126refs and topCPL126refs verified;U1andTP1–8excluded;fiveelectrode+onebatteryhorizontalJST;noverticalJSTleft.
- [x] Source/library BATPTH geometry preserved:Ø1.90hole,Ø2.30top land,Ø1.95topopening,Ø3.00bottom land/opening.
- [x] Current191via mask geometry rechecked; prior22near-maskcase classes documented,notblanketCAMapproval.
- [x] Native top/bottom and copper/mask/paste plots visually reviewed.
- [x] ENIG requested and reflected in source finish metadata;greenmask/whitesilk order intent recorded.
- [x] Follow-up draft and manual assembly/polarity notes prepared;no email/order/upload/payment performed.

## User's Review Before Payment submission (not performed)

- [ ] Select only the RC1files named in MANUFACTURING_MANIFEST.json;verifyhashes.
- [ ] Request5fabricated/2assembled top-side boards and obtain actual support/quantity confirmation.
- [ ] Request Economic PCBA subject toexact28groupeligibility;review Standard alternatives/quote beforeapproval.
- [ ] Enable Review Before Payment. Enable Confirm Production File as a separate manufacturing gate. Review service timing:finalCAMmay arrive afterpayment.
- [ ] Supply manufacturing remarks,polarity table,componentreviewCSV and missingX1spec request.
- [ ] Obtain panel/rails/fiducials/tooling/depanel plan withoutfinalboard outlinechange.
- [ ] Approve exact BOMmanufacturer/MPN/LCSC/stock and substitutions(if any) individually. No automatic alternate is authorized.
- [ ] Check factory placement preview against actualpin1/netcoordinates, includingall JSTs,X1and16BAV199diodes.
- [ ] Obtain explicitBATcomponent-hole/open-mask/finished-tolerance treatment;any change needsEQandcustomerapproval.
- [ ] Review final quote and revision. Approved awaiting-payment orders may be locked against edits; do not approve obsoletefiles.

## Actual production authorization — NOT APPROVED

- [ ] Download factory's actual production Gerbers/drill/panel files;comparecopper/netfeatures,all layers,finish/stack,outline,mask,paste andBATpost.
- [ ] Resolve everyEQ,geometrychange,shortage,polarity orCAMissue. If factoryfiles differ,produce a newhashmanifest and relevantverification; do not reuseRC1signoff blindly.
- [ ] Explicitownerapproval of exactfactoryfiles,placement,quote and limitedbenchprototypepurpose before production authorization.

## After manufacture / before human contact

- [ ] Inspect physical finishedboards and qualifyrealXIAOmodule/post/jig beforeassembly andcellpower.
- [ ] Follow the independent audit's bench-only bring-up with simulatedelectrodes,currentlimitedsupplies and definedacceptancecriteria.
- [ ] Qualifybattery/PCM,polarity,charging,current/thermal andharness/strainrelief.
- [ ] Complete qualified independent body-contact electrical safety assessment and requiredphysical/fault/material tests.
- [ ] Human contact remains prohibited until that separate gate is closed. Factory approval cannot close it;USB/charging/body contactrestriction remains mandatory.

**Decision:** READY FOR JLCPCB REVIEW BEFORE PAYMENT. This means the digital candidate is ready to be submitted for review, not that a review/order has been submitted,paid,approved or authorized for production.
