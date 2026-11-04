# Orientation investigation checkpoint — NOT RELEASED

2026-10-20, Europe/Sofia. The user explicitly requested “first commit” after supplying and identifying screenshots as the old/pre-correction preview. This authorizes preservation in Git before corrected-preview verification; it does not authorize assembly, production, payment, upload or human-contact use.

The investigation report and RC2 manifest/bundle are snapshots created before this checkpoint, referencing source HEAD `6ffc4cdfbab20e75a0479d48282f053992091eb5` and then-uncommitted work. Their bytes and hashes are preserved. The checkpoint commit records those files, source correction, tests, diagrams, archived exact-part library evidence and the subsequent user-preview evidence. Its SHA is obtained from Git history; no circular self-hash is embedded.

Current status: **BLOCKED pending corrected JLCPCB preview**. The five north-edge headers use 180 degrees in RC2. J1 remains 270 degrees in the primary candidate; the separate J1-90-degree alternative remains a test candidate. The old screenshots corroborate the inward five-header mouths, but do not verify either corrected file. See `user-preview-01/REVIEW.md` and its hashed image provenance.

Pre-commit checks executed:

- Four rotation regression tests: PASS, including unchanged J1 and the other 121 placements.
- All 27 authoritative design/library hashes: unchanged.
- Candidate CSVs, tool/evidence/source hashes, SHA256SUMS, review ZIP CRC and inner/outer hashes: PASS.
- Preview-verification, production and human-contact approval flags: false.
- Staged `git diff --check`: 499 trailing-whitespace warnings in seven generated/reused CRLF CSV files. These are preserved verbatim for hash integrity. Authored code and Markdown have no reported whitespace violations. No constraints or checks were weakened to remove these warnings.

The PCB, schematics and existing RC1 candidate remain unchanged. No unrelated work, editor history, recovery backups, caches, root GLB export, old PCB variants or superseded quote staging are included. Nothing is pushed or merged by this checkpoint.
