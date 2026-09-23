# ADR-0014: OpenCode harness and provider separation

## Status

Accepted. Supersedes ADR-0012 (Muse Code SDK adapter boundary) for the active
product; ADR-0012 remains as the historical record of the removed integration.

## Context

Sentry's first QA Agent Stack ran on Muse Code (`@muse-code/sdk`). The
migration replaces it with OpenCode, keeping Sentry's `HarnessAdapter`
abstraction, evidence/trust pipeline, workspace isolation, and historical data
intact.

## Decision

1. **Harness / provider / model stay separate.** OpenCode is the harness
   (`adapterId: 'opencode'`, package `@qa/harness-opencode`). OpenRouter is
   the initial provider. The model is a user-configured OpenRouter model id
   (`SENTRY_OPENCODE_MODEL`). No code assumes `OpenCode == OpenRouter == model`;
   a future OpenCode provider reuses the harness with a new credential path.
2. **Integration mechanism.** Sentry drives the documented headless mode
   (`opencode run --model <id> --format json "<prompt>"`, verified against
   `opencode-ai@1.18.32`, the npm `latest` at migration time, plus
   source-verified auth (`auth.json`), data-path (`XDG_DATA_HOME`), and
   tool-env (`shell.env` inherits process env) behavior. One owned child
   process per prompt turn (planning / investigation / report...), cwd set to
   the AgentRun's isolated workspace, Sentry-built sanitized environment. No
   TUI scraping, no shared daemon, no vendor SDK dependency. The exact flags
   live in `packages/harness-opencode/src/client.ts`; the opt-in live smoke
   (`SENTRY_LIVE_OPENCODE=1`) fails loud if upstream changes them.
3. **Credential flow.** `OPENROUTER_API_KEY` travels Desktop safeStorage →
   encrypted store → `runtime.configure` (`providers.openRouterApiKey`) → WSL
   runtime process memory. Per AgentRun the adapter writes it to a
   Sentry-owned ephemeral `auth.json`
   (`{"openrouter": {"type": "api", "key": "..."}}`, mode `0o600`)
   in a disposable directory BESIDE (never inside) the agent workspace, and
   points the owned `opencode run` children at it via `XDG_DATA_HOME` (which
   OpenCode's global data path honors). The boundary is removed when the run
   settles (run `finally` + adapter `dispose` backstop). The key is never
   persisted to SQLite, events, artifacts, exports, logs, OpenCode config
   files, or the project workspace.
4. **Secret isolation (structural).** Verified against current OpenCode
   source: provider keys resolve from the auth store and reach the model SDK
   as `options.apiKey`, while shell tools inherit the host process
   environment. Since `OPENROUTER_API_KEY` is in NO child environment,
   model-controlled shells cannot observe it — isolation by construction,
   not by filtering. Sentry's allowlist additionally blocks every
   secret-bearing variable (including `OPENCODE_AUTH_CONTENT`) from child
   environments; sentinel tests prove the boundary and its cleanup.
   Remaining reliance: OpenCode's own workspace sandbox for tool file
   scope; Sentry never disables sandboxing and records sandbox restrictions
   as limitations.
5. **Event translation.** Only explicitly recognized tool-call envelopes
   become Sentry `tool.started`/`tool.completed` pairs (fail-closed: unknown
   envelopes contribute bounded text, never tool completions). Exit codes come
   only from explicit structured codes — unknown stays unknown. Exactly one
   terminal event; no open operations at terminalization (protocol validator).
6. **Reasoning privacy.** Internal/thinking traces are discarded; only
   observable execution and product-safe summaries persist.
7. **History.** `stack_muse_main` rows stay decodable; the Muse adapter is no
   longer executable. No migration rewrites old runs to `stack_opencode_main`.
8. **Protocol compatibility.** `runtime.configure` drops `models.muse` and
   gains `models.opencode` + `providers.openRouterApiKey`. Configuration is
   ephemeral (never persisted), so no data migration exists; `RUNTIME_PROTOCOL_VERSION`
   stays 1 because the transport/framing contract is unchanged.

## Consequences

- New identity `stack_opencode_main`; old Muse runs render under their
  historical label and are not runnable.
- `MUSE_*` CLI error codes remain in the schema as historical values only.
- Live verification requires an explicit opt-in and provider credit.
