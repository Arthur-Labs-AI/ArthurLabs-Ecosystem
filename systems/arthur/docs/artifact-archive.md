# A.R.T.H.U.R. — archived engineering and benchmark artifacts

Archived on **2026-11-04**. The reference snapshot is branch
[`archive/pre-cleanup-2026-11-04`](https://github.com/Kaloyan3D/A.R.T.H.U.R/tree/archive/pre-cleanup-2026-11-04), created from
`dev` commit `67f19e08f40a11f58ff0b8f2f7de23286ee08289` before cleanup. Preserve this branch.

## Removed from active dev tree (NOT deleted from Git history)

- `hardware/emg/rev-b-xiao/archive/**` — 12 historical KiCad snapshots/metadata files across development iterations (~10.30 MB of Git blobs).
- `hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB/_restore_backup_2026-10-15T18-53-15-837/**` — temporary board recovery copy (~1.17 MB).
- `tools/jev-bench/results/**/raw-*.json` — 23 generated response datasets (~4.53 MB). Summary reports, frozen thresholds/policies, benchmark code, ledgers and corpora are still available on `dev`.

## Restore archived files as needed

```bash
git fetch origin archive/pre-cleanup-2026-11-04
# Examples (replace path with any archived path):
git restore --source=origin/archive/pre-cleanup-2026-11-04 -- hardware/emg/rev-b-xiao/archive/
git restore --source=origin/archive/pre-cleanup-2026-11-04 -- tools/jev-bench/results/p1b/raw-jev-cons.json
```

If the restored files match ignored patterns, force-add only after review; most tasks should keep them local. Historical benchmark re-scoring that needs raw datasets must restore those fixtures first.

## What remains in dev

The active `kicad/ARTHUR_EMG_RevB/` source design, its footprints and schematics,
`manufacturing-release/` and `quote-package/` materials, `evidence/` and required
verification/baseline artifacts, all software code and the JEV benchmark source,
corpora, frozen configuration and summary reports.
No fabrication sign-off, safety approval or hardware readiness status is changed.

**Git storage note:** This is a non-destructive working-tree cleanup. Old commits,
PR #4 diffs and the archive branch still contain the original blobs. Therefore
this does *not* shrink historical packfiles or retroactively reduce PR #4's lines.
Actual Git LFS migration/garbage collection would need a separately coordinated
history rewrite across all clones and branches.
