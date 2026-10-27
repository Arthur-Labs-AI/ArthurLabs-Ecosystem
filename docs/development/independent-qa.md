# Independent QA depth workflow

Production runs keep one writable workspace and one provider session per agent.
No peer plans, reports, files or sessions are shared. The coordinator now prepares
each copy before model execution. After investigation it prepares a valid
checkpoint report, then optionally challenges and refines that report in the same
session under a bounded budget. Existing direct adapter callers
without the coordinator's versioned policy retain their previous contract.

## Workspace preparation

The initial implementation supports projects with an exact `pnpm@x.y.z` pin and
`pnpm-lock.yaml`. The matching pnpm package must already be installed. Corepack
downloads, network installs, lifecycle scripts and pnpmfile hooks are disabled.
The store seed is mounted read-only. Only the needed installed package files are
copied into each workspace with `--offline --frozen-lockfile --ignore-scripts
--ignore-pnpmfile --package-import-method=copy`. The multi-GB cache is not copied
per agent. Writable node_modules are never shared. Preparation runs in the OS sandbox, without a
host fallback. HOME uses private tmpfs with explicit workspace/toolchain binds;
the sandbox still proves that real HOME and unbound peers are inaccessible.

The runtime automatically discovers existing pnpm caches under its own
`dataRoot/cache/pnpm` and the normal Linux/XDG pnpm store location. Discovery uses
known paths only, not a scan of HOME. The selected path is frozen for all workers
of the run. An optional `SENTRY_QA_CACHE_SEED` **in the Linux runtime process environment**
overrides discovery with an operator-provisioned, frozen pnpm store root. This is the root supplied to pnpm's
`--store-dir`, not its nested version directory. A cache can be populated by an
explicit operator dependency-fetch operation before the QA run; the application
does not automatically fetch packages. Do not put credentials, source trees or
mutable unrelated runtime state in that directory, and do not modify it during a
run. Windows host environment variables alone do not configure an already-running
Linux runtime process.

Without an available cache, or for an unsupported/unpinned project, source review
continues with a visible limitation. A missing/incorrect toolchain does not cause
the agent to choose another version. An unsuccessful offline install causes the
coordinator to recreate only that disposable workspace before source review.
Infrastructure/isolation failures stop that worker. Native dependencies whose
build scripts are required can remain unavailable and must be reported honestly.

New imports exclude `*.tsbuildinfo` in source selection. Frozen v2 hash exclusions
are unchanged, preserving old revision integrity. Old compiler caches are removed
only from disposable workspaces; baseline provenance remains the frozen snapshot.

## Investigation and reporting

The common challenge instruction asks each agent to trace real callers and input
validation, actively seek counterarguments and reproduce significant candidates
through actual code when safe. A copied function proves only its isolated example.
Zero findings is valid. Tool observations from the challenge remain in the same
authoritative operation ledger. No provider-specific sandbox/auth workarounds were
removed; GLM's existing transport and report repair safeguards remain in place.

Each frozen planned check must appear exactly once in the report under its exact
name. `not_run` and `inconclusive` require details. A claimed pass also requires
`coverage: complete` and `operationKeys` pointing to observed, successful
executable checks. Read/grep/count operations and shell pipelines masking failure
are not accepted as executable coverage. Unsupported or explicitly partial passes
are downgraded to inconclusive without discarding useful findings. Structural failures use the
existing bounded report correction, not another investigation or paid run.
The model can still reason incorrectly; this validation does not certify semantic
truth or production reachability.

The UI separates process completion from analysis coverage and labels evidence as
behavior reproduced, source-supported or unconfirmed. These are proof labels,
not automatic severity or production exposure judgments. Old runs without depth
receipts have unknown coverage. Limited preparation, skipped validation or blocked
checks produce partial coverage. Preparation receipts are retained in run events.

## Budgets, cancellation and rollback

The coordinator freezes policy before launching the workers. Preparation and model
phases share the worker deadline. A validated report is held as a checkpoint
before optional validation. Validation gets at most two minutes and cannot start
unless at least five minutes remain for finalization plus a useful validation
window. Optional re-reporting stops before the absolute deadline to leave cleanup
time. If validation or refinement fails, the owned client is closed and the
checkpoint facts are retained with a partial-analysis warning. Cleanup failure
marks the worker failed after retaining its checkpoint facts. This does not
guarantee that a failed primary investigation or initial report can produce output.
The absolute deadline and normal
cancellation remain authoritative. No automatic replacement conversation or
paid investigation retry is introduced. Already persisted events remain available
if a session fails. Cleanup continues when adapter disposal rejects.

The checkpoint is held by the running adapter until final facts are submitted;
it is not a crash-recovery journal. A host crash before submission can still lose
that report. If validation explicitly reports that nothing changed, the adapter
uses the checkpoint directly instead of paying for another full serialization.

`SENTRY_QA_DEPTH=0` in the runtime environment disables the new workflow for future
runs. Already started runs retain their frozen policy. This flag does not undo
safe cleanup or source-selection fixes and requires no SQLite migration.

## Verification

Run the existing lint, type, format, package build and unit/integration gates.
The focused suites include depth guidance/coverage, all three real adapter phase
paths (enabled, legacy, low-budget, review failure, refinement failure and unchanged review), private preparation, old revision integrity,
failed-install reset, disposal failure and UI proof labels.

On Linux/WSL with a working user systemd manager, run:

```sh
pnpm --filter @qa/run-engine test:preparation-sandbox
```

This runs actual offline pnpm preparation on private fixtures, verifies that
postinstall scripts do not execute, checks original/peer file and host loopback
network isolation, exercises independent dependency writes, and cancels a running
owned sandbox unit. It never calls model providers. CI runs it in the existing
sandbox-capable lane; restricted runners must keep this gate marked unverified.

To additionally test a cached registry package (zod) with actual copied package
bytes, set `SENTRY_SANDBOX_SMOKE_STORE` to a populated pnpm store root for this
smoke command. The store stays read-only; the smoke verifies distinct installed
file inodes/link counts across private workspaces.

A paid same-snapshot comparison of the three configured models remains a separate
quality acceptance check. Passing scripted adapter tests establishes orchestration
and contracts, not improved model accuracy on real projects.
