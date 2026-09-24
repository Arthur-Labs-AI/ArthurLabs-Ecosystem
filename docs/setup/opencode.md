# OpenCode setup (OpenRouter provider path)

Sentry runs the OpenCode QA Agent inside the WSL2 Linux runtime. Three
separate concepts apply:

- **Harness**: OpenCode (`opencode` binary, `@qa/harness-opencode`).
- **Provider**: OpenRouter (initial production path).
- **Model**: the exact OpenRouter model id you select.

## 1. Install OpenCode in WSL

Install the `opencode` binary **inside the selected Sentry WSL distro**
(package `opencode-ai`, tested release `1.18.32`; see
`OPENCODE_TESTED_VERSION` in `packages/harness-opencode/src/discovery.ts`).
Verify:

```bash
opencode --version
```

Executable discovery order (no restart needed for changes): explicit
adapter config → `SENTRY_OPENCODE_BINARY` (Settings → Providers →
“OpenCode executable”, pushed into runtime memory) → Sentry-managed
installation (`<dataRoot>/tools/opencode/node_modules/.bin/opencode`)
→ `opencode` on `PATH`. A user-local install under the data root needs
no `PATH` changes, no sudo, and no shell-profile edits. An explicit
override that is broken fails closed (no silent fallback). There is no
fallback model or fake execution: real runs require the real binary.

## 2. Set the provider, model, and credential

Upstream provider (`openrouter` for OpenRouter, `opencode` for OpenCode Zen,
`opencode-go` for the Go subscription gateway):

```bash
SENTRY_OPENCODE_PROVIDER=opencode
```

Model id (examples only — use a currently available id). Sentry composes
the effective OpenCode id as `provider/model`:

```bash
SENTRY_OPENCODE_MODEL=muse-spark-1.3-contributor-free
# effective: opencode/muse-spark-1.3-contributor-free
```

Set the matching provider credential (memory-only in the runtime; never
persisted to SQLite, events, artifacts, or logs):

```bash
# OpenRouter path:
OPENROUTER_API_KEY=<your key>
# OpenCode Zen path:
OPENCODE_API_KEY=<your key>
```

In Sentry Desktop, paste the model id, provider, and key on the Providers
page (encrypted with the OS keychain). The renderer never receives secrets.
OpenRouter uses its native SDK; OpenCode Zen uses the generic
OpenAI-compatible loader — both go through the localhost credential proxy,
so the real key never reaches OpenCode tooling.

No OpenCode account/login is required for the OpenRouter API-key path.

## 3. Verify without spending credit

```bash
qa agent doctor opencode
```

The doctor checks configuration, the `opencode --version` probe, and
credential _presence_. Opening Settings/Environment never performs a paid
LLM request.

## 4. Run

```bash
qa run start <project-id> --mode full --agents opencode --wait
```

## Credential isolation

`OPENROUTER_API_KEY` exists in Sentry runtime host memory — and stops
there. Per run, the adapter starts a localhost auth proxy whose closure
alone holds the key; OpenCode talks to the proxy with a dummy key, and
the proxy swaps in the real credential server-side. There is NO `auth.json`
and NO key in any environment, file, or command line near OpenCode.
The reporting turn runs tool-free. Never place the key in a project
`.env` file. See
[ADR-0014](../adr/0014-opencode-harness-and-provider-separation.md).

## Untrusted projects

The target repository is treated as untrusted data. Model-controlled
shells run inside a bubblewrap mount namespace (scope, sibling
workspaces, data root, and developer HOME hidden; workspace re-bound),
project `.opencode` configuration and plugins are masked to randomized
destinations with verification before launch (fail-closed: any masking
failure aborts the run), your global OpenCode state is never loaded, and
each run gets isolated sessions and an exactly-owned process boundary
(systemd cgroup on Linux; weaker execution elsewhere is development
only). Suppression flags alone do not stop project plugin loading —
masking is mandatory (proven by test). On Linux without systemd +
bubblewrap, production execution is refused (`OPENCODE_SANDBOX_UNAVAILABLE`)
unless `SENTRY_OPENCODE_ALLOW_DIRECT=1` explicitly opts in for dev/test.

## Opt-in live smoke

Deterministic tests never spend credit. A live smoke is opt-in:

```bash
SENTRY_LIVE_OPENCODE=1 OPENROUTER_API_KEY=... SENTRY_OPENCODE_MODEL=... \
  pnpm --filter @qa/harness-opencode test
```

Add `SENTRY_LIVE_OPENCODE_RUN=1` to additionally execute one minimal
headless turn (spends OpenRouter credit).

A zero-credit real-binary suite (local stub provider, no OpenRouter
spend) covers wire format, session continuity, plugin isolation, and
process cleanup wherever the `opencode` binary is installed:

```bash
SENTRY_OPENCODE_STUB_TESTS=1 SENTRY_OPENCODE_BINARY=$(which opencode) \
  pnpm --filter @qa/harness-opencode test
```

## Historical Muse runs

Runs executed before the migration (`stack_muse_main`, Muse Code) remain
listable, viewable, and exportable. They are never rewritten to OpenCode:
old runs stay Muse, new runs use OpenCode.
