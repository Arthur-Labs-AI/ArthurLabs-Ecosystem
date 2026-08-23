# Phase 1 Codex Audit Amendment — Change Evidence

## Scope
Implemented every BLOCKER, HIGH, and MEDIUM audit finding only. No Phase 2 feature was added. Existing ModelGateway/provider, Harness adapter, and shared core-service boundaries remain intact.

## Primary implementation files
- src/sessions/store.ts, src/sessions/models.ts: transactional approval/idempotency state machines, migration serialization, constraints, contention handling, persistence sanitization.
- src/core/conversation/service.ts, validation.ts: globally request-bound idempotency, pre-replay mode validation, atomic finalization, provider-agnostic secret boundary.
- src/tools/orchestrator.ts, execution.ts, registry.ts, contracts.ts, adapters/harness_stub.ts: complete approval binding, immutable registry, secured facade, HMAC/external idempotency contract, unknown-outcome fail-closed behavior.
- src/security/redaction.ts, sanitize.ts: recursive secret-like-key and cross-boundary sanitization.
- src/models/providers/deepseek.ts: strict nested/usage validation and byte/content/tool limits.
- src/app.ts: wires the sanitizer into persistence without exposing tool internals.
- docs/architecture/phase1-decisions.md: records amended Phase 1 security decisions.

## Proving tests
- tests/integration/audit_regressions.test.ts: crash-after-external-write restart, deleted session, risk binding, execution/mode race, global idempotency collision, crashed request, transaction rollback, store/tool/error secrets, forged/high-risk execution, immutable registry.
- tests/integration/security.test.ts: approval/request concurrency, complete approval binding, Personal/Business isolation, secret boundaries, transaction behavior, public-surface checks.
- tests/integration/store.test.ts: restart, migration idempotency, four-worker migration startup, constraints.
- tests/integration/api.test.ts: approval/rejection endpoints and secret-safe HTTP responses.
- tests/unit/deepseek_provider.test.ts: retry/auth/timeout/strict malformed-response/usage/size tests.
- tests/unit/approval_token.test.ts and redaction.test.ts: restart-stable external operation id and structured secret keys.

## Deterministic results
Final aih-verify: typecheck PASS, build PASS, test PASS, integration PASS. npm test: 103 passed, 0 failed, 1 optional live test skipped. SQLite integration stress: 5 consecutive PASS iterations.
