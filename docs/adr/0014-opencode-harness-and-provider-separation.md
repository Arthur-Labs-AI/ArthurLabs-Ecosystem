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
2. **Integration mechanism.** Sentry drives headless turns
   (`opencode run --pure --model <provider/model> --format json
[--session <id>]` with the prompt on stdin), verified behaviorally
   against the real `opencode-ai@1.18.32` binary plus the tagged source.
   One owned child process per prompt turn (planning / investigation /
   report...), cwd set to the AgentRun's isolated workspace, Sentry-built
   sanitized environment. Session continuity is real: turn 1 creates the
   OpenCode session, its `sessionID` is captured from the JSONL envelopes,
   and later turns pass `--session` (fail-closed if no session exists).
   Sentry and OpenCode IDs are tracked independently. No TUI scraping, no
   shared daemon, no vendor SDK dependency. The exact flags live in
   `packages/harness-opencode/src/client.ts`. Verification is executable:
   real wire fixtures (`tests/fixtures/*.jsonl`, captured from the binary),
   a zero-credit stub-provider suite (`SENTRY_OPENCODE_STUB_TESTS=1`), and
   an opt-in paid live turn (`SENTRY_LIVE_OPENCODE_RUN=1`).
3. **Credential flow.** `OPENROUTER_API_KEY` travels Desktop safeStorage →
   encrypted store → `runtime.configure` (`providers.openRouterApiKey`) → WSL
   runtime process memory. Per AgentRun the adapter builds a disposable
   scope beside (never inside) the agent workspace: `home/`, `config/`,
   `data/opencode/auth.json` (`{"openrouter": {"type": "api",
"key": "..."}}`, mode `0o600`), `state/`, `cache/` — wired via
   `HOME` + `XDG_*_HOME`. Provider auth resolves from that file, so the key
   is in NO child environment. The scope (auth file included) is removed
   when the run settles (run `finally` + adapter `dispose` backstop, with
   retry). The key is never persisted to SQLite, events, artifacts,
   exports, logs, OpenCode config files, or the project workspace.
4. **Secret isolation (layered, verified).** (a) File-based auth: the key
   is in no environment, so inherited tool shells cannot observe it.
   (b) Upstream permission containment: reads outside the project and
   other gated operations are auto-rejected in headless mode (verified:
   `bash cat ../secret` → error state, secret not read). (c) Project
   plugin/config neutralization: the disposable workspace's `.opencode`
   and root `opencode.json[c]` are renamed (readable, undiscoverable)
   before launch — suppression flags alone do NOT stop project plugin
   auto-discovery in 1.18.32 (proven by evil-plugin test), so masking is
   mandatory. (d) Global state neutralization: redirected HOME/XDG keeps
   user plugins/configs/sessions out. (e) Reporting firewall: the
   reporting turn sets `OPENCODE_PERMISSION='{"*":"deny"}'`, which
   removes all tools from the model (verified), plus the adapter-side tool
   firewall as backup. An opt-in evil-plugin suite proves no execution and
   no credential access with the real binary. Known limits: Sentry does not
   mount-isolate OpenCode tools (unlike the Claude worker); containment
   rests on the layers above plus prompt constraints.
5. **Event translation (real wire format).** CLI envelopes
   `{type, timestamp, sessionID, part}` with `part.type` of `text`,
   `tool`, `step-start`, `step-finish`, `reasoning`, or top-level `error`.
   `tool.started`/`tool.completed` are normalized together from one
   terminal observation (documented; timestamps are Sentry observation
   times). Exit codes come ONLY from `state.metadata.exit` (exact, never
   collapsed); failures without codes use `errorPreview`. Usage comes ONLY
   from `step-finish` tokens (absent fields omitted). `reasoning` parts are
   always dropped (the CLI only emits them with `--thinking`, never
   passed). `task` (subagent) tools are forbidden. Exactly one terminal
   event; no open operations at terminalization (protocol validator).
6. **Reasoning privacy.** Internal/thinking traces are discarded; only
   observable execution and product-safe summaries persist.
7. **History.** `stack_muse_main` rows stay decodable; the Muse adapter is no
   longer executable. No migration rewrites old runs to `stack_opencode_main`.
8. **Protocol compatibility.** `runtime.configure` gains `models.opencode`
   - `providers.openRouterApiKey`; `models.muse` is still accepted but
     deprecated and ignored, so new runtimes keep working with old senders.
     Configuration is ephemeral (never persisted), so no data migration
     exists; `RUNTIME_PROTOCOL_VERSION` stays 1 because the transport and
     framing contract is unchanged.
9. **Model composition.** `SENTRY_OPENCODE_PROVIDER` (default
   `openrouter`) + `SENTRY_OPENCODE_MODEL` (e.g. `anthropic/claude-x`)
   compose to the effective `--model` id `openrouter/anthropic/claude-x`
   (OpenCode splits on the first `/`). Already-qualified models pass
   through; double prefixes are impossible by construction. Runtime
   identity persists the effective id plus the provider.
10. **Process ownership.** One owned boundary per turn: systemd transient
    unit (`KillMode=control-group`) when available, else an owned process
    group (POSIX) or PID-tree kill (Windows). Cancellation stops exactly
    the owned boundary (TERM → bounded wait → verify → KILL), never by
    process name.

## Consequences

- New identity `stack_opencode_main`; old Muse runs render under their
  historical label and are not runnable.
- `MUSE_*` CLI error codes remain in the schema as historical values only.
- Live verification requires an explicit opt-in and provider credit.
