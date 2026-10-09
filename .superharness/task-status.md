# Task status — Sentry beta preparation

2026-10-09: candidate implemented and locally verified on
`codex/release-v0.1.0-beta.1`, baseline `9c57e3f`.

Candidate code CI: PASS on df6fd49 (push 37891235154, PR 37891284512), all three
jobs. Fresh real runtime deployment: 18/18 uncached builds, activation,
handshake and clean shutdown PASS. Final receipt-only PR checks precede merge.

Distribution: BLOCKED pending owner PR review and target
acceptance of active-work shutdown/cancellation/maintenance on supported hosts.
See [validation](../docs/releases/v0.1.0-beta.1-validation.md).
No beta tag, public release, or installer is created. Original dirty main
checkout and user-owned Git identity are preserved. `shux contract` unavailable;
protocol records maintained directly in this isolated worktree.
