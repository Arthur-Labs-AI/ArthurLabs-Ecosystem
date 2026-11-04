# RevB Git preservation and manufacturing package verification

Date: 2026-10-19. Branch: `codex/revb-horizontal-jst`.

**READY FOR JLCPCB REVIEW BEFORE PAYMENT; NOT RELEASED.** This is repository/package closure, not production authorization or human-contact safety approval. No order, payment, external submission, merge or push was performed.

## Engineering commits preserved

- `cb319be9057b6dc3f29eebe2ce7256fce39f56fe` — horizontal JST PCB/schematic/footprint changes, BOM metadata, silkscreen corrections, ENIG project configuration and verification/export tools.
- `5fc29db590e354c53feb4cb83e38dce1886db6a3` — curated mechanical validation, independent audit, JLCPCB closure, source archives, verification results, hash-bound review candidate and binary Git attributes.
- A separate documentation commit contains this report, navigation and post-commit verification. Its SHA is available from Git history; the report does not embed its own commit hash.

The historical manifest's `git_HEAD` (`98cc84e07fe4cf2791a56baba2cde3e9bb599724`) identifies the pre-commit context and explicitly says HEAD alone did not then identify the candidate. We did not rewrite the frozen manifest or review ZIP. **All 27 manifest source hashes and all 91 source/document/verification/package hashes match both current files and Git blobs at `5fc29db590e354c53feb4cb83e38dce1886db6a3`.** The final documentation commit changes no PCB, schematic or candidate package bytes.

## Executed verification

Fresh KiCad 10.0.6 checks and exports ran in `/tmp/arthur-git-final-607r3rge`, using an isolated copy of the authoritative project. The existing immutable audit evidence and candidate were not regenerated in place.

| Gate | Result and evidence |
| --- | --- |
| DRC, all configured severities and schematic parity | PASS for errors/connectivity/parity: 0 errors, 0 unconnected, 0 parity; **1 existing warning**, U1 library footprint mismatch. See [drc.json](drc.json). Existing ignored checks remain recorded; constraints were not weakened. |
| ERC, all configured severities | PASS: 0 violations; [erc.json](erc.json). |
| Existing closure verifier against fresh schematic XML | PASS: unchanged electrical partition and protected source geometry; BOM values/MPNs/footprints match fresh XML; metadata and placement arithmetic correct; no populated vertical JST. [package-source-checks.json](package-source-checks.json), [source-invariants.json](source-invariants.json). |
| Silkscreen source analysis | PASS: minimum conservative mask clearance 0.160007 mm, against 0.15 mm requirement; [silk-global-source.json](silk-global-source.json). |
| Fresh existing `rb05_package.py` export vs current candidate | PASS: all rows of BOM, corrected CPL and reference raw CPL identical. All 11 Gerber/drill ZIP members identical after removing only generation timestamp comments/attributes; geometry and manufacturing commands retained. |
| Manifest, source and committed blobs | PASS: 91 hash-bound files, including 27 authoritative source/library files. |
| Checksums and review bundle | PASS: closure SHA256SUMS, outer review bundle checksum, inner bundled checksums, ZIP CRC and bundled file equality to disk. |
| Gerber/drill inventory | PASS: 4 copper, 2 mask, 2 silk, top paste, outline and drill = 11 members; 192 drill hits (191 vias Ø0.30 mm and one BAT component PTH Ø1.90 mm). |
| NOT_RELEASED and authorization fields | PASS: current candidate directory, main file names and review ZIP retain NOT_RELEASED; manifest production/human-contact/external-submission/order/payment flags remain false. |

Machine-readable combined integrity result: [package-integrity.json](package-integrity.json). Reproduce the read-only check from any working directory with:

```sh
python3 hardware/emg/rev-b-xiao/evidence/git-manufacturing-finalization/verify_package.py
```

Run from repository root for the relative invocation above. An optional argument supplies a fresh `rb05_package.py` export directory for CSV/plot comparisons. The checker compares manifest-bound files to the invoking HEAD, so it also checks later documentation-only commits.

Fresh native commands used `kicad-cli pcb drc --severity-all --schematic-parity --format json`, `kicad-cli sch erc --severity-all --format json` and `kicad-cli sch export netlist --format kicadxml` on the scratch project. `RB05_PROJECT` selected that project for the existing `tools/rb05_package.py`; a scratch copy of `jlcpcb-closure/verify_closure.py` consumed the fresh XML/DRC/ERC. Scratch exports are comparison products and are not additional manufacturing candidates.

## BOM and CPL disposition

Existing candidate files are valid and reused; **no duplicate BOM/CPL created**. Paths are listed in [CURRENT_REVIEW_PACKAGE.md](../../CURRENT_REVIEW_PACKAGE.md).

- 28 BOM groups, 126 distinct factory-assembled references per board; explicit component-review quantity columns total 126 per board / 252 for two assembled boards.
- Six horizontal JST headers: J1, J101, J201, J301, J401, J5001; exact MPN `S2B-PH-SM4-TB(LF)(SN)`, LCSC `C295747`.
- No obsolete vertical JST BOM entries or placements. The unused historical vertical footprint library file remains preserved as source, not a purchased component.
- U1 manual XIAO excluded; TP1–TP8 excluded from purchased/placed components.
- 126 unique top-side CPL entries; reference sets exactly match the BOM. Corrected rotations and coordinates agree with the existing exporter; factory reel/orientation confirmation remains required.
- BOM carries descriptions/values, exact MPNs in Comment, designators, footprints and LCSC identifiers. Quantities derive from the designator lists and are explicit in the existing `COMPONENT_REVIEW_REQUEST.csv`.

## Git scope and whitespace

Initial tracked `git diff --check` and the staged design/tool commit passed. The evidence commit's staged whitespace check reported 33,106 warnings across 33 verbatim source archive, generated SVG and CRLF CSV files; [archival-whitespace.json](archival-whitespace.json) records that result. These bytes were deliberately preserved to retain source fidelity and manifest checksums. This is a recorded whitespace exception, not a claim that the full historical evidence diff passed whitespace checking. Authored finalization files pass `git diff --check`; tracked working-tree scope is clean after committing.

Preserved untracked material is excluded intentionally:

| Path relative to repository | Reason |
| --- | --- |
| `tools/jev-bench/` | Unrelated work. |
| `hardware/emg/rev-b-xiao/evidence/rb02g/variants/` | Earlier what-if PCB variants. |
| `hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB/.history/` | Editor history. |
| `hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB/_restore_backup_2026-10-15T18-53-15-837/` | Recovery backup. |
| `hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB/ARTHUR_EMG_RevB.glb` | Uncurated root export; curated mechanical evidence is already committed. |
| `hardware/emg/rev-b-xiao/quote-package/SUPERSEDED_pre_R1b__DO_NOT_USE/` | Obsolete quote staging. |

Ignored local export logs, preview `.kicad_prl` state and Python bytecode caches remain local. No pre-existing changes were discarded. Curated frozen baselines required by the verification scripts are part of the committed engineering evidence, distinct from automatic recovery backups.

## Remaining gates

UNVERIFIED pending JLCPCB: exact stock/eligibility for all 28 groups, requested Economic assembly and 5/2 quantity split, factory rails/panel plan, CAM/ENIG/BAT-hole interpretation, actual polarity/orientation and final quotation/production-file approval. Existing [closure checklist](../pre-manufacturing-audit/jlcpcb-closure/ORDER_READINESS_CHECKLIST.md) remains authoritative for review questions.

Physical XIAO BAT-post fit, connector mating/removal, enclosure/cable/strain-relief integration, battery and bench validation remain physical prototype work. Connector removal travel of 7 mm remains a design assumption, not a manufacturer-qualified travel. Separate body-contact safety approval remains unverified. The package may enter factory review; fabrication/assembly authorization and use on a person are not granted by this report.
