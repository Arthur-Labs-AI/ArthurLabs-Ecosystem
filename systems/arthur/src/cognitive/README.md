# src/cognitive

Cognitive Core. The Cognitive Store is the source of truth; `src/memory` is a
semantic projection of it, never the owner.

**Status:** boundary only. No store, distillation, graph, lineage or recall yet.

## Rules

- May depend on `packages/contracts`, `src/memory` (through `index/` only, once
  it exists), `src/models`, `src/security`, `src/observability`, `src/sessions`.
- Must **not** depend on frozen agentic code (`src/tools/**`, the hybrid tool
  protocol), on `src/sync`, `src/devices` or `apps/**`. If the whole agentic
  layer were disabled, the Cognitive Core must still work.
- Do not force Cognitive Objects into the `memory_items` schema.

Enforced by `tests/architecture/import_boundaries.test.ts`.
