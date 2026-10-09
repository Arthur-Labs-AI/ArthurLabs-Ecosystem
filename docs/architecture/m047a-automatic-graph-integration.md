# M04.7A Automatic Graph Integration — experimental, opt-in

**Status: feature-complete experimental infrastructure. NOT production-validated.** It is OFF by default and is switched on only by the user in Settings → AI & Voice → Automatic Connections (Desktop and Mobile). Schema stays v7. No automatic revisions. No backfill.

## Pipeline (restored multiclass)

`ChangedKnowledge { objectId, previousRevisionId?, currentRevisionId, reason: created | revised | moved }` (`graph/integration.rs`) →
project-local candidate discovery (`graph/discover.rs`, ≤ 12: lexical IDF + consented semantic + 1-hop neighbours + recency floor) →
**Stage A** `propose_for`: propose the best relation kind or none (`graph/prompt.rs`) →
**Stage B** `verify` vote 1 and vote 2 (reversed presentation order) over new proposals + ≤ 8 model relations to revalidate (`graph/verify.rs`, `verify_prompt.rs`) →
deterministic admission and revalidation (`graph/integrate.rs`, `graph/resolve.rs`) →
guarded atomic write (`CaptureStore::apply_integration`).

Budget: ≤ 3 normal provider requests per integration (1 proposal + 2 votes), 0 when nothing is to be done. Contract-invalid outputs may be retried at most `MAX_CONTRACT_RETRIES = 2` times, counted separately (`contract_invalid`, `retry_requests`).

Safety preserved from the binary experiment: direction comes from the ratings and the order sent, never a copied label; user and system relations are never touched (deletes are `WHERE origin='model'` incident to the changed object); authoritative revision plus stale-write guard; project isolation; archived-project safety; idempotence per revision; `depends_on` is removed only on grounded evidence from both votes (dependent plan cancelled, or requirement gone with evidence), one supporting pass keeps it unresolved; no new `depends_on` onto a cancelled dependent; `contradicts` is vetoed when one side obsoletes the other; actionable signals must carry evidence; a failed typed claim is never replaced by `related_to`, and `related_to` is subsumed by any stronger surviving kind.

## Setting

- Commands `get_graph_integration` → `{ enabled, pending }` and `set_graph_integration_enabled(enabled)`; the backend is authoritative, persisted in `graph/integration-settings.json`, default OFF. React reads and writes only through `ArthurClient`.
- Enabling shows: "Experimental: AI-generated connections may be inaccurate. Review important relationships before relying on them." Enabling discards any unfinished (Pending/Failed) ledger entries, so there is no backlog and no backfill; only new objects and meaningful revisions after enabling are integrated.
- Disabling stops scheduling immediately; an integration in flight re-checks the setting just before its write and is skipped with no failure recorded. Existing relations (including `origin=model`) are never deleted by disabling. Capture, Distillation and manual connections are unaffected either way. If the provider is unavailable the work is deferred (uncounted) and never affects Capture or Distillation.
- Save failure: the setter errors and the UI keeps showing the previously saved state.
- Automatic relations are `origin=model`, appear in Connections through the existing `graph-integrated` refresh, and uncertain relations are not promoted.

## Benchmark history (all test-only tooling in `graph/integration_bench.rs`, `integration_tests.rs`, `deepseek_bench.rs`)

- Original multiclass (OpenAI, strict pre-registered labels): precision 0.46 / 0.60, recall 0.36, direction 100%, no hard negatives.
- Hardened multiclass (main set, OpenAI): strict precision .54/.67/.75, semantic .92/1.0/1.0, stale-relation failures 0.
- Binary redesign experiment: strict .50–.58, semantic .69–.75, stale failures 1 per run; better only on Bulgarian holdout recall. It did not beat multiclass, so multiclass was restored and the binary production paths were removed.
- M04.7A.5 acceptance (OpenAI, 1 run each, dep and moot sets): strict and semantic precision 1.000, direction 1.000, no stale, no leakage; `supersedes` missed (recall limit).

## Known limitations

Precision on broad corpora is not proven to the 0.90 gate across runs; recall is conservative (`supersedes`, `extends`, and Bulgarian relations are often missed); results vary between model runs; latency 7–13 s per integration in the background. Treat generated relations as suggestions and review important ones.

Run live tests: `ARTHUR_LIVE_KEY_FILE=<key> cargo test --lib live_ -- --ignored --nocapture` (`ARTHUR_AB_SET`, `ARTHUR_AB_RUNS`, `ARTHUR_AB_PROVIDER`).
