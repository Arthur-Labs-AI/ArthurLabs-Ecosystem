# src/capture

Input primitive. Text, voice and EMG all terminate at one `Capture` object.

**Status:** boundary only. No service, queue or sources exist yet.

## Rules

- May depend on `packages/contracts`, and on shared infrastructure that is not
  frozen (`src/models`, `src/security`, `src/observability`).
- Must **not** depend on `src/cognitive`, `src/sync`, `src/devices` or frozen
  agentic code. No input source manipulates the Cognitive Store or Graph
  (Repo Structure, Rule 3).

Enforced by `tests/architecture/import_boundaries.test.ts`.
