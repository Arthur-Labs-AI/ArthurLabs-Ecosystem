# Task status — Sentry beta preparation

2026-10-09: candidate implemented and locally verified on
`codex/release-v0.1.0-beta.1`, baseline `9c57e3f`.

Candidate code CI: PASS on df6fd49 (push 37891235154, PR 37891284512), all three
jobs. Fresh real runtime deployment: 18/18 uncached builds, activation,
handshake and clean shutdown PASS. Final receipt-only PR checks precede merge.

Validation/owner acceptance: COMPLETE WITH DOCUMENTED LIMITATIONS. On
2026-10-09 the owner confirmed 3/3 on both machines and authorized release.
Prepare the annotated beta tag and draft pre-release after merge CI passes.
Manual candidate cancellation/maintenance scenarios remain independently
unverified and are disclosed in the release notes. GitHub tag/release receipts
are the source of truth for publication status; no installer is produced.
See [validation](../docs/releases/v0.1.0-beta.1-validation.md).
Original dirty main checkout and user-owned Git identity are preserved. `shux contract` unavailable;
protocol records maintained directly in this isolated worktree.
