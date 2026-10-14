# Native CachyOS: investigate large-project import timeout and post-timeout state

Status: **OPEN — DEFERRED NATIVE LINUX DEVELOPMENT**. The owner selected Windows
v1 first on October 14, 2026 and explicitly declined GitHub Issues for this task.
This repository record is the dedicated tracker; preserve it on
`feature/native-linux-support` after the scope PR is owner-merged.

## Observed behavior and attribution

The owner reported a `projects.add` timeout importing a roughly 1 GB GitHub
project on native CachyOS, with a connected runtime. Exact affected Desktop/
runtime source, archive identity, included workload and root cause were not fully
established. See the [Phase 6.1 investigation](v1-phase-6-1-rc-cut-verification.md#follow-up-large-project-import-timeout)
and [PR #22](https://github.com/Mert1026/Sentry/pull/22). Native exact-RC smoke
and native G10-R remain unverified; earlier owner-reported functionality remains
historical evidence, not a retrospective PASS for this case.

The selected RC implementation already permits a 600,000 ms Desktop import
request. Expiration of that wait does not necessarily cancel runtime work.
Increasing the deadline without diagnosis or relaxing copy/hash checks is not a fix.

Historical Windows GUI imports succeeded with 813 included files / 120,370,663
bytes in about 32.5 seconds and 11.3 seconds. Direct WSL ProjectManager probes
with an included 1 GiB asset passed on Node 22 and 26. These do not establish
the result of the affected native workload or the full large Windows GUI path.
The [Phase 6.2 receipt](v1-phase-6-2-windows-transition.md) records the bounded
comparable Windows packaged-GUI evaluation separately.

## Safe investigation

1. Record exact archive SHA256, full Desktop/runtime SHA/version/protocol, host,
   filesystem type and available storage; use a disposable non-sensitive fixture.
2. Measure included file/byte counts, nesting and exclusions. Compare source
   files, generated/vendor content, symlinks and cross-filesystem behavior without
   exposing private file contents or personal paths.
3. Record import start, UI responsiveness, request terminal outcome and runtime
   liveness. Inspect safe managed-copy progress, staging size, resource use and
   persisted revision/material state. A DB row alone is not a successful import.
4. On timeout, do not launch another import while the original might be active.
   Observe whether copy/hash/persistence progresses; do not corrupt the data root
   or force-stop unrelated processes. Preserve failed-attempt evidence.
5. Classify slow successful work, UI timeout followed by successful persistence,
   a stalled operation, filesystem failure, database failure, resource exhaustion
   or unresolved cause. Do not infer the category solely from timeout text.

## Regression and acceptance criteria

- Reproduce with exact attributable source and a bounded synthetic fixture near
  1 GiB included data, meaningful source-file count, nesting and explicit exclusions.
- Preserve immutable managed-copy and hash/material integrity; terminal outcome
  and post-timeout state must be truthful and avoid duplicate in-flight imports.
- Demonstrate responsive UI, automatic project-list refresh, complete persisted
  revision, reopen/history and graceful shutdown on the native target.
- Add a failing regression before any narrow correction; retain all existing
  filesystem/security assertions. Verify the shared Windows/WSL path too.
- No paid provider calls are required. Do not attach private projects, personal
  paths, credentials, credential stores, databases or raw provider responses.

This unresolved native report is no longer automatically a Windows release
blocker. Its cause is not assumed native-specific: a comparable reproducible
Windows/shared failure is a Windows blocker and requires a separate focused fix
PR with regression coverage before release authorization.
