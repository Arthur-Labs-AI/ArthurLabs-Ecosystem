# Deferred Release Gate: P7-LIVE-ACCEPTANCE

Status: DEFERRED — provider budgets unavailable (explicit user decision).
Not FAILED. Not PASSED. No live IDs are recorded here because the runs were
never executed; inventing them is forbidden.

Production provider acceptance deferred. Before any future public/general
release, these live gates must be completed:

1. FULL Muse/DeepSeek/GLM 3/3 (real production run → Merger v2 → Verifier v3).
2. TARGETED Muse/DeepSeek/GLM 3/3 (TargetSpec persisted, same snapshot,
   merge → verify → ingest).
3. update→RETEST production workflow (revision A → developer fix → revision
   B → RetestSpec v2 → child run → assessment → IssueEvent).
4. Live cross-process cancel proof (optional but recommended): CLI B cancels
   a real owned run; owner settles; workspaces cleaned; lock released.

Phase 8 (Desktop UI) must initially use fake harnesses, deterministic
fixture runs, existing historical real runs, and seeded demo data — never
provider tokens for UI screens. Phase 8 must consume the frozen Stable-Core
contracts without redesigning them.
