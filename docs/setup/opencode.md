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

If the binary is not on `PATH`, set `SENTRY_OPENCODE_BINARY` to the
executable. There is no fallback model or fake execution: real runs require
the real binary.

## 2. Set the model and credential

Set an exact OpenRouter model id (examples only — use a currently available
id):

```bash
SENTRY_OPENCODE_MODEL=anthropic/claude-opus-4-6
```

Set the provider credential (memory-only in the runtime; never persisted to
SQLite, events, artifacts, or logs):

```bash
OPENROUTER_API_KEY=<your key>
```

In Sentry Desktop, paste the key on the Providers page (encrypted with the OS
keychain) and set the model id there. The renderer never receives the secret.

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

`OPENROUTER_API_KEY` exists in Sentry runtime host memory and, per run, in
one Sentry-owned ephemeral `auth.json` beside the agent workspace (removed
when the run settles). It is in NO child process environment: OpenCode
reads provider auth from that file, so model-controlled tool/shell
executions — which inherit the host process environment — cannot observe
the credential. Never place the key in a project `.env` file. See
[ADR-0014](../adr/0014-opencode-harness-and-provider-separation.md).

## Opt-in live smoke

Deterministic tests never spend credit. A live smoke is opt-in:

```bash
SENTRY_LIVE_OPENCODE=1 OPENROUTER_API_KEY=... SENTRY_OPENCODE_MODEL=... \
  pnpm --filter @qa/harness-opencode test
```

Add `SENTRY_LIVE_OPENCODE_RUN=1` to additionally execute one minimal
headless turn (spends OpenRouter credit).

## Historical Muse runs

Runs executed before the migration (`stack_muse_main`, Muse Code) remain
listable, viewable, and exportable. They are never rewritten to OpenCode:
old runs stay Muse, new runs use OpenCode.
