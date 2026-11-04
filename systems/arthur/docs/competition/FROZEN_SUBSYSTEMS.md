# Frozen subsystems

**Scope:** John Atanasov tournament / A.R.T.H.U.R. Cognitive Runtime v1.
**Source:** Cognitive Runtime Repo Structure, sections 12-14 and 18.

> Existing tests must remain green, but no new functionality is added to frozen
> subsystems unless the Cognitive Runtime genuinely requires it.

Frozen code is **not deleted, moved or refactored**. It stays where it is and
receives regression fixes only.

## Frozen (feature-level)

| Area | Location | Notes |
| --- | --- | --- |
| Tool framework, application launching/control, filesystem, browser and Git tools, approval/execution lifecycle | `src/tools/**` | Regression fixes only. |
| Remote tool execution over the hybrid runtime | `src/runtime/hybrid/tools/**`, `src/runtime/hybrid/lan/tool_*.ts` | The rest of `src/runtime/hybrid` is reusable. |
| Local model platform expansion, generic agentic routing expansion | `src/runtime/` | Freeze is per feature, not per folder. |
| New local STT/TTS, local voice model installation, desktop-only voice infrastructure | `src/voice/`, `src/runtime/local-models/` | Existing voice contracts and cloud providers are reusable. |
| Generic autonomous agent functionality | n/a | Returns later as **Arthur Actions** on top of the Cognitive Runtime. |

## Not frozen (reuse through explicit boundaries)

`src/models`, `src/sessions`, `src/memory` (becomes a semantic projection of the
Cognitive Store, not its owner), `src/security`, `src/observability`, the
ArthurNode/NodeRegistry/provider concepts in `src/runtime`, and the cloud
provider and voice contracts.

## Where new work goes

| Feature | Not here | Here |
| --- | --- | --- |
| Home Node sync | `src/runtime/hybrid/**` | `src/sync/` |
| EMG | a generic Arthur tool | `src/devices/emg/` |
| Ideas, tasks, decisions | `memory_items` as the authoritative model | `src/cognitive/store/` |
| Voice/text/EMG input | feeding the Cognitive Store directly | `src/capture/` |
| Product UI | `apps/cli`, `apps/api` | `apps/arthur/` |

## Enforcement

`tests/architecture/import_boundaries.test.ts` encodes these rules as
dependency checks, so a violation fails `npm test`:

- frozen code does not import `src/capture`, `src/cognitive`, `src/sync`,
  `src/devices` or `packages/`;
- the new domains do not import frozen agentic code;
- `src/cognitive` works without the agentic layer;
- the Arthur UI reaches Arthur only through `ArthurClient`.

Changing a frozen subsystem because a Cognitive Runtime feature needs it is
allowed. Note the reason in the commit message.
