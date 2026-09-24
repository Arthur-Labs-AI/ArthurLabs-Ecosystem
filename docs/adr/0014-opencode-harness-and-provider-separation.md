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
   and later turns pass `--session`, with every later turn verifying the
   returned sessionID equals the expected one (`OPENCODE_SESSION_MISMATCH`
   otherwise — never silently switching conversations). Sentry and
   OpenCode IDs are tracked independently. No TUI scraping, no
   shared daemon, no vendor SDK dependency. The exact flags live in
   `packages/harness-opencode/src/client.ts`. Verification is executable:
   real wire fixtures (`tests/fixtures/*.jsonl`, captured from the binary),
   a zero-credit stub-provider suite (`SENTRY_OPENCODE_STUB_TESTS=1`), and
   an opt-in paid live turn (`SENTRY_LIVE_OPENCODE_RUN=1`).
3. **Credential flow (no credential near OpenCode).** `OPENROUTER_API_KEY`
   travels Desktop safeStorage → encrypted store → `runtime.configure`
   (`providers.openRouterApiKey`) → WSL runtime process memory — and stops
   there. Per AgentRun the adapter starts a localhost auth proxy whose
   closure alone holds the key; OpenCode is configured with the NATIVE
   OpenRouter SDK redirected at the proxy (`baseURL`, dummy apiKey), so
   the proxy swaps in the real `Authorization` server-side and relays
   (model allowlist, loopback-only, per-run port, no body logging). There
   is NO `auth.json` and NO key in any environment, file, or command line
   near OpenCode: stealing files, scraping environments, or reading
   OpenCode config yields at most the dummy. The proxy dies with the run
   (run `finally` + adapter `dispose` backstop). The key is never
   persisted to SQLite, events, artifacts, exports, logs, OpenCode config
   files, or the project workspace.
4. **Filesystem isolation (OS-enforced for shells).** Model-controlled
   shells run through a Sentry-owned wrapper (`shell` config) that enters
   a bubblewrap mount namespace per invocation: scope, workspace parent
   (Sentry data root, siblings), and developer HOME become empty tmpfs;
   workspace and scope home are re-bound; per-run private `/tmp` is
   bound. Verified live with the real binary (theft/discovery/evil-npm
   suites). (a) In-process file tools cannot be namespaced (same process
   as the host): they are contained by explicit deny rules plus upstream
   ask-to-reject — and can only ever observe the dummy credential.
   (b) Project plugin/config neutralization: workspace `.opencode` /
   root `opencode.json[c]` are masked to randomized destinations with
   lstat verification, fail-closed
   (`OPENCODE_PROJECT_CONFIG_ISOLATION_FAILED`); collisions, symlinks,
   and failures abort before launch. Suppression flags alone do NOT stop
   project plugin auto-discovery in 1.18.32 (proven by evil-plugin test).
   (c) Global state: redirected HOME/XDG per run. (d) Reporting firewall:
   the reporting turn sets `OPENCODE_PERMISSION='{"*":"deny"}'`,
   which removes all tools upstream (verified), plus the adapter-side
   tool firewall as backup. Known limits: in-process reads of
   NON-credential paths rest on permission layers; /proc-based memory
   reads are out of scope (same as all local harnesses).
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
    unit (`KillMode=control-group`, explicit `--setenv` of the sanitized
    env only — never raw `process.env`) when available on Linux, otherwise
    the run is refused unless `SENTRY_OPENCODE_ALLOW_DIRECT=1` explicitly
    opts into weaker execution (dev/test). Fallback elsewhere is an owned
    process group (POSIX) or PID-tree kill (Windows, dev only).
    Cancellation stops exactly the owned boundary (TERM → bounded wait →
    verify → KILL), never by process name; `setsid`-escaped descendants
    still die under the cgroup (proven by test on Linux). One unit per
    turn (not per AgentRun): turns are sequential anyway, and per-turn
    units keep ownership, environment (reporting deny), and cleanup
    precisely scoped.
11. **Version policy.** The wire parser and security assumptions are
    verified against one tested release (`OPENCODE_TESTED_VERSION`). Any
    other version degrades the doctor and is refused at preflight unless
    `SENTRY_OPENCODE_ALLOW_UNTESTED_VERSION=1` explicitly allows it
    (dev/test). Warnings alone never bypass the wire/security contract.
12. **Sandbox readiness.** The doctor probes containment prerequisites
    (functional bubblewrap namespace, systemd user manager, masking
    primitive) without spending credit; readiness is `unavailable` when
    masking is broken and degraded when isolation pieces are missing.
    The adapter preflight blocks production Linux execution unless the
    full boundary is present.

## Consequences

- New identity `stack_opencode_main`; old Muse runs render under their
  historical label and are not runnable.
- `MUSE_*` CLI error codes remain in the schema as historical values only.
- Live verification requires an explicit opt-in and provider credit.
