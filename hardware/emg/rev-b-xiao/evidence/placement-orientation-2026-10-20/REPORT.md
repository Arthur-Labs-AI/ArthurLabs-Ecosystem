# JST placement orientation investigation — NOT RELEASED

2026-10-20, Europe/Sofia. Branch `hardware/revb-horizontal-jst`; unchanged HEAD `6ffc4cdfbab20e75a0479d48282f053992091eb5`. All correction work is deliberately **uncommitted**. No upload, order, payment, assembly approval, production authorization, merge or push performed. Body-contact approval remains separate and unapproved.

**Disposition: RC1 orientation is on hold. RC2 is an offline correction candidate, BLOCKED pending the user's private JLCPCB preview screenshots.** The five-header 180° candidate is supported by independent numbered-pad geometry; the actual factory 2D/3D mapping is not verified. J1 is retained at 270° in the main CPL, but independently suspect; a separate 90° J1 test alternative is provided. Do not approve assembly using either candidate until that is resolved.

## Findings and limits

The user reports that five north-edge mouths appear inward/south in the private JLCPCB 3D preview with CPL 0°. That session was not accessible here; this report does not claim to have observed or corrected it. The user will upload the CPL and provide screenshots.

The root of the discrepancy is a historical exporter rule, inherited from a community correction table: **all footprints matching `^JST_PH_S` receive +180°**. For the five KiCad 180° connectors this produces factory CPL 0°. The earlier verifier repeated that same formula, so a passing arithmetic check was not independent orientation evidence. The earlier reports already marked reel/preview approval unverified; their prior readiness statement must not override this new hold.

Independent evidence obtained in this pass:

1. Current [official JST PH catalog](https://www.jst-mfg.com/product/pdf/eng/ePH.pdf), archived in [sources](sources/JST_PH_current_2026-10-20.pdf). Page 2 specifies the SMT mounting-surface view and No.1 circuit; page 4 identifies S2B-PH-SM4-TB as **side-entry**, not the B2B top-entry variant. Width 7.90 mm, pitch 2.00 mm, housing height 5.50 mm, main body depth 6.00 mm. Published land dimensions are nominal/reference, not a tape/reel rotation definition.
2. All six installed header land patterns exactly match the vendored horizontal footprint: pin 1 local (-1,-2.85), pin 2 (+1,-2.85), signal lands 1.00×3.50 mm; MP lands at (±3.35,+2.90), 1.50×3.40 mm. Local mating opening is +Y. The catalog mounting view puts No.1 on the left at this unrotated pose; its side-entry geometry agrees with the library. [mechanical-proofs.json](mechanical-proofs.json) records actual installed pad coordinates and nets.
3. JLCPCB's public [C295747 exact-part page](https://jlcpcb.com/partdetail/Jst-S2B_PH_SM4_TB_LFSN/C295747) exposes its EasyEDA land pattern: pins 1/2 above the housing, 1 left and 2 right, retention terminals 3/4 below. This matches KiCad's unrotated signal-pin ordering, rather than requiring a 180° offset. Archived [SVG](sources/JLC_C295747_footprint.svg) and [browser screenshot](sources/JLC_C295747_footprint.jpg) preserve the independent observation. JLC calls retention terminals 3/4 where KiCad uses MP; these must not be mistaken for extra signal connections.
4. Public footprint SVGs for all seven exact LCSC part groups were obtained through their browser-visible library views. A numbered-pad fit determines angular agreement independently of the exporter. It removes translation and uses the SVG's 0.254 mm coordinate units; it does **not** qualify the placement origin, land dimensions, stencil, factory model or reel setup. Different libraries' land sizes/spacing can produce small residuals even at the correct angle. Results for all 29 oriented/polarized placements: [CSV](polarized-orientation-review.csv), [all-pad coordinates/nets and angle residuals](polarized-pad-analysis.json).
5. [JLCPCB's documented convention](https://jlcpcb.com/help/article/pcb-assembly-faqs-part-2) allows the EDA and factory zero poses to differ and relates zero to packaging orientation. Its preview red dot is an orientation marker, **not a guaranteed pin-1 indicator**. A public EasyEDA land pattern is useful corroboration, not proof that a private 3D model uses the same zero. No controlled factory C295747 reel/model-zero confirmation was available.

No footprint/layout error was established. All **27 authoritative project, PCB, schematic, symbol and library hashes remain identical to RC1**. No DRC settings or unrelated electronics changed.

## Before/after rotations

Angles are degrees, top-side view. X east; board Y south. NORTH = decreasing board Y. Raw KiCad CPL is reference-only; it must not replace the entire factory CPL because the other package corrections remain necessary.

| Ref | PCB / raw KiCad CPL | RC1 factory CPL | RC2 main factory CPL | Separate J1 test CPL | Required physical result |
| --- | ---: | ---: | ---: | ---: | --- |
| J101 | 180 | 0 | **180** | 180 | Opening north |
| J201 | 180 | 0 | **180** | 180 | Opening north |
| J301 | 180 | 0 | **180** | 180 | Opening north |
| J401 | 180 | 0 | **180** | 180 | Opening north |
| J5001 | 180 | 0 | **180** | 180 | Opening north |
| J1 | 90 | 270 | **270, unchanged — HOLD** | **90, test only** | Opening east; pin 1 VBAT, pin 2 GND |

The main candidate changes exactly five Rotation fields; all coordinates, sides, other 121 placements and J1 are identical to RC1. The J1 alternative differs from the main candidate in **only J1 Rotation: 270→90**. It is not an approved replacement and does not silently modify the primary file. Independent public numbered-pad geometry selects 90° for J1, so leaving it unchanged must not be interpreted as validating 270°.

- Main preview CPL: [RC2 NOT_RELEASED CPL](NOT_RELEASED_PENDING_PREVIEW_VERIFICATION/ARTHUR_Neuron_RevB_HJ_JLC_RC2_NOT_RELEASED_CPL.csv).
- Alternative only if testing the independently flagged J1 mismatch: [J1 90° TEST_ONLY NOT_RELEASED CPL](ALTERNATE_J1_TEST_ONLY/ARTHUR_Neuron_RevB_HJ_JLC_RC2_J1_90_TEST_ONLY_NOT_RELEASED_CPL.csv).
- [Main package](NOT_RELEASED_PENDING_PREVIEW_VERIFICATION/), [new manifest](MANUFACTURING_MANIFEST.json), [review-only ZIP](HJ_JLC_RC2_ORIENTATION_REVIEW_NOT_RELEASED.zip).

BOM remains 28 groups / 126 assembled refs, six horizontal headers C295747, no obsolete vertical JST entries, U1 manual/DNP and TP1–TP8 excluded. BOM and raw CPL bytes are reused without changing component identifiers. Fresh exports confirm all 11 Gerber/drill members identical apart from generation timestamps; the existing Gerber ZIP bytes are reused. All RC1 files, reports, bundles and original hashes remain intact. RC2 manifest, checksums and bundle are newly generated for the candidate, rather than falsely reusing RC1 hashes for a modified CPL.

## Confirm openings AND solder lands in the private preview

Use the main corrected CPL first. Confirm JLC actually re-imported it: the selected rows must display J101/J201/J301/J401/J5001 = 180°. Reopening a stale 3D page, or retaining per-part manual overrides from an earlier import, is not evidence that this file was applied. Do not advance through assembly approval or production confirmation.

1. Set a top view with board NORTH at the top (north connector row at Y=0 edge; USB side south). Identify J401→J301→J201→J101→J5001 from west to east. A rotated camera alone can make cardinal directions ambiguous.
2. In 3D, view from outside the north edge looking south: the **actual two-contact mating cavities** must be visible from the exterior. The solid rear wall and two signal solder tails belong on the south/interior side. A pin-1 dot, a generic block or a plug/wire model alone cannot establish this.
3. In 2D, enable copper/paste/solder lands and component terminals. For each header, the two electrical tails must land at **Y=8.00 mm**, pin 1 at origin X+1.00 (east), pin 2 at origin X−1.00 (west). The two retention tabs must land at **Y=2.25 mm**, X=origin±3.35. Check all four terminals. A mouth pointing north with tails or retention tabs displaced onto the wrong lands is a **FAIL**; it may indicate a bad 3D model or placement origin rather than a different PCB orientation.
4. Compare actual header case width 7.90 mm, nominal entry-face midpoint Y=0.75 mm and 5.50 mm height against the rendered body. Local/foreign models may use different origins; no unverified X/Y shift was introduced here. Numbered-tail alignment takes priority over body silhouette alone.
5. Check J101/J201/J301/J401 pin 1 = ELEC_P and pin 2 = ELEC_N for the correct channel. J5001 pin 1 is intentionally NC, pin 2 RLD_SAFE; do not swap this reference lead. MP/3/4 are retention features on isolated nets, not signal pins or ground.
6. Check J1 separately from above and from the east edge. Its mouth must face EAST. Pin 1 must land at board (41.55,39.30) mm on VBAT, pin 2 at (41.55,37.30) mm on GND; both signal tails west, retention tabs east. If 270° is wrong, use the separate J1-90° CPL test and repeat **all** checks. Battery cable color/key does not guarantee polarity.
7. Provide one overall north-oriented top screenshot, a close 3D north-edge cavity view, 2D four-terminal registration with a selected header's angle visible, and east-facing J1 with its selected angle and pad-1/net evidence. If 2D and 3D disagree, stop and require factory model/pin confirmation; do not rotate real hardware just to make a cosmetic model look correct.

Required origins (board mm): J401 (6.85,5.15), J301 (16.25,5.15), J201 (25.65,5.15), J101 (35.05,5.15), J5001 (44.45,5.15). J1 (44.40,38.30). The [derived 2D guide](north-jst-orientation.png) is explicitly not a factory preview or controlled manufacturer CAD model.

## Other polarized/oriented components

| Group | Count | Retained CPL | Offline result / factory check |
| --- | ---: | --- | --- |
| D101/D102, D201/D202, D301/D302, D401/D402 | 8 | 0 | C40919 BAV199 numbered-pad orientation agrees with public library. Pin 1 GND, pin 2 AFE_3V0, pin 3 HIZ leg. |
| D103/D104, D203/D204, D303/D304, D403/D404 | 8 | 180 | Same library agreement. Pin 1 GND, pin 3 ADC leg, pin 2 NC. Dual-series diode: no generic single-diode cathode-stripe rule. |
| Q3001 | 1 | 180 | C8545 pad ordering agrees; pin 1 gate, pin 2 GND/source, pin 3 AFE_EN/drain. |
| U501/U502/U503 | 3 | 90 | C779410 TLV9064 pad ordering agrees; verify pin-1 marking, pin 4 V+, pin 11 V−. |
| U4002 | 1 | 180 | C963429 TPS7A2030P pad ordering agrees; 1 IN, 2 GND, 3 EN, 4 NC, 5 OUT. Retain exact P variant. |
| U6001 | 1 | 270 | C2862562 ADS131M04 pad ordering agrees; 1 AVDD, 2 AGND, 19 DGND, 20 DVDD; verify analog P/N sequence. |
| X1 | 1 | 180 | C2901557 public pad ordering agrees; 1 OE/Tri-State, 2 GND, 3 OUT, 4 VDD. Exact selected manufacturer marking/reel information still requires confirmation. |
| J101/J201/J301/J401/J5001 | 5 | 0→180 candidate | Independent 2D supports correction; private 3D unverified. |
| J1 | 1 | 270 retained; 90 alternative | Additional mismatch found; no assembly approval until resolved. |

Total 29. Every numbered pad and its current PCB net are recorded in the JSON, rather than checking only a rendered dot. No polarized capacitor is in the purchased BOM (ceramic MLCCs); resistors, inductors/ferrites are not electrically polarized. U1 is outside factory placement and remains a separate manual-installation check. Exact physical package markings and private preview mapping remain UNVERIFIED for all groups, even where public 2D angular agreement passes.

## Local 3D evidence

The footprint references a KiCad STEP under `${KICAD10_3DMODEL_DIR}`, but that variable is unset and the referenced connector model was not located in installed/system/user KiCad model locations. The available root GLB is an older board/layer export (six meshes; no 5.50 mm header geometry), not a qualified connector assembly. The curated board-only GLB and `.wrl` connector envelopes are explicitly simplified nominal bounds with no qualified mating cavity, terminal numbering or reel orientation. They cannot independently certify a JLCPCB zero angle. [Inspection record](local-3d-model-inspection.json). No missing manufacturer model was invented or substituted.

## Executed verification and reproducibility

- Prior RC1 hash verifier: PASS before edits and retained byte-for-byte after candidate generation.
- Regression: original correction logic reproduces **0 instead of 180** for all five headers; new tests failed before the fix and pass after it. [Before](regression-before.txt), [after](regression-after.txt). Four tests cover five north headers, unchanged J1, all other 121 legacy rows and rejection of a stale footprint/pose for the exception.
- Exporter now uses a reference-specific, exact-footprint/180°-pose guarded correction. Existing SOT23/TSSOP/SOIC corrections and J1 behavior are retained. This candidate policy is explicitly pending factory preview.
- Fresh `rb05_package.py` export: 28 BOM groups / 126 CPL refs. Builder checks that the complete real exporter output differs from RC1 only in the five intended Rotation cells; no test expectation was relaxed to hide a difference.
- Fresh native KiCad 10.0.6 DRC: **0 errors, 1 existing U1 library-mismatch warning, 0 unconnected and 0 schematic parity**; [drc.json](drc.json). Fresh ERC: 0 violations; [erc.json](erc.json). Ran in scratch; no canonical PCB/project changes or rule weakening.
- New manifest/bundle/checksum integrity is verified after the final build. Earlier historical checks still apply to frozen RC1 and are not evidence that its orientation is now correct.

Commands from repository root:

```sh
python3 -m unittest discover -s hardware/emg/rev-b-xiao/tools -p test_jlc_rotations.py
python3 hardware/emg/rev-b-xiao/tools/audit_factory_orientation.py
python3 hardware/emg/rev-b-xiao/tools/draw_jst_orientation.py
python3 hardware/emg/rev-b-xiao/tools/rb05_package.py <new-scratch-directory> <fresh-export-directory>
python3 hardware/emg/rev-b-xiao/tools/build_orientation_candidate.py <fresh-export-directory>
```

The builder verifies authoritative source hashes, full CSV membership/coordinate invariants and normalized fresh Gerber equivalence, then writes RC2 only. Browser-visible SVGs are archived evidence; the audit uses them offline. No code can verify a private preview screenshot not yet supplied.

Remaining blocker: **user screenshots must demonstrate correct cavities, pad/pin mapping and J1 orientation, followed by factory confirmation.** Until then RC2 is a candidate, not verified placement or production-ready output. Prior unrelated/untracked work remains untouched; no staging or commits were made.
