# EMG Hardware — Curated Integration

This directory is a **selected source snapshot**, not a complete replay of historical PCB experiments. It is intended to bring the useful hardware designs into the `dev` software integration branch without importing hundreds of megabytes of experimental work products.

- Original complete hardware branch: `feature/ads131m04-cost-first`, commit `d096bdf4ba16e59f97d0ab3659c7698dc94781e3`.
- Starting software baseline: `dev`, commit `b73e4929a3ebd49a15e6744824023298561934a5`.
- Source files selected: **149**, uncompressed total **5,720,719 bytes**.
- Full copied-file provenance: [INTEGRATION_MANIFEST.json](INTEGRATION_MANIFEST.json), with original Git blob hashes.

## Retained

1. Rev A KiCad design, schematics, symbol/footprint libraries and engineering notes.
2. Rev A Cost canonical project, accepted Phase 3A and Phase 3B board checkpoints, Phase 3B final DRC/verification and freeze-manifest evidence, important validation scripts and project reports.
3. Rev B XIAO schematic project and companion engineering/manufacturing notes (not a finished PCB build).
4. Top-level EMG architecture, BOM, power, safety, assembly and mounting documentation.

## Intentionally not imported

- `phase3c0_staging/` (852 duplicated staged files, including an unsuccessful USB connector candidate).
- Additional candidate/clean/checkpoint PCB duplicates and exploratory route variants beyond the selected accepted freeze checkpoints.
- Bulk DRC/geometry search JSON, repeated generated SVG/PNG exports, workstation fontconfig cache and `session.jsonl`.
- One-off scratch programs and temporary KiCad local preference files.

**Nothing was deleted from the original hardware branch.** If complete historical trace evidence or a one-off script is needed later, use that archived branch or selectively import the specific file after review. Some retained historical verification scripts may still depend on excluded experimental evidence; their full historical reruns are **not** claimed to work on this trimmed tree.

## Engineering status and warnings

- The Phase 3B freeze evidence records **548 ordinary DRC violations and 92 unconnected pairs**; it does not constitute manufacturing signoff.
- Phase 3C USB connector correction **failed the pre-refill DRC gate**. The trial candidate is excluded; the associated decision and blocker reports are preserved.
- No KiCad CLI opening, netlist/DRC regeneration, electrical safety validation or manufacturing-readiness test was run during Git curation. Treat this branch as a source-history and layout-integrity checkpoint, not as a fabrication release.
- Never copy tracked design files over machine-local untracked `hardware/` data without first backing up and comparing them.
