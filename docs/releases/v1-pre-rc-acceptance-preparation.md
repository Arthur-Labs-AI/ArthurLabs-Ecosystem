# Phase 5 final corrections and acceptance preparation

Final executed implementation evidence: [automated receipt](v1-pre-rc-automated-receipt.md)
records exact SHA/tree, CI, real WSL 8/8 trust, full-suite 1214/16, disclosed
Windows failures/retests and both downloaded CI archive checksums. Any subsequent
documentation-head artifacts keep their own source SHA in the PR final receipt.

2026-10-13. Branch `fix/v1-pre-rc-acceptance-preparation`, PR to dev.
Phase 6 is NOT AUTHORIZED. The PR's final candidate receipt and engineering
handoff record the exact committed SHA/tree, final workflow conclusions,
artifact identities and archive SHA256s after the committed source is built.
Do not substitute a moving branch name for that receipt.

## Inspected baseline

- Primary checkout: local main `9c57e3f78164c45c35316ae7bf2fe45fa4b0f132`.
  Owner changes in handoff/ledger, DeepSeek adapter/errors/tests, CLI schema
  and untracked PROJECT_GUIDE.md preserved. Work uses an isolated worktree.
- Fetched origin/main `4fd2be9fa3b17370841dbb1d2f0422a2150c62d8`, origin/dev
  `c1d2d58a8ce4c12cb1199950f7611ad6360f8203`. No open PRs at inspection.
- [PR #13 post-merge CI](https://github.com/Mert1026/Sentry/actions/runs/38358392945)
  completed/success at that dev SHA, all three required jobs success.
- Immutable beta tag object `e92e3be8d2de21ce5c22508c15de3c08f02cb77a`, peeled
  commit `0e5c10cfa80f6385ebfc88a7306b38ce8a12ce38`; prerelease published
  October 9, release ID 407599249, no assets. No beta mutation performed.
- shux contract attempted first, but executable unavailable. Existing harness
  profile/status/ledger/handoff read; status maintained directly. Explicit task
  authorization supplies implementation/PR scope; no new approval gate inferred.

## Corrections and reproduction

**Unreadable errors:** only the scrubber was guarded. Eight deterministic
cases threw from code/message getters, nested message access, Proxy get/has/
getPrototypeOf traps and revoked Proxy access. One guarded mapping operation
now returns the fixed Desktop operation failed message, retaining a code only
after successful validation. Existing normal/nested errors, malformed codes,
redaction and 1000-character limits remain covered.

**IPC fidelity:** all four existing real registered-handler tests now pass
separate event/payload arguments. Added projects:get proves required-payload
forwarding, exactly one registration and unchanged success envelope; a decoy
project ID in the event cannot satisfy an invalid payload. Production IPC unchanged.

**Related fatal-screen defect:** index rendered classifyBootFailure's capped
text without the redaction claimed in earlier documentation. A synthetic boot
rejection reached actual BrowserWindow.loadURL HTML with a known environment
credential intact. Capping before scrubbing also retained a partial secret at
the cap boundary. Fatal classification now uses the shared scrub-before-cap
mapper, with the existing exact-value main-process scrubber supplied by index.
This reads known environment secrets hydrated by bootstrap; it does not load,
write or migrate a store again. Throwing scrubbers fall back safely; metadata
access is guarded and structured native/WSL guidance preserved. This synthetic
boundary defect is not evidence of an actual supported-provider key leak.

Before fix: 9 failed / 27 passed in expanded redaction/lifecycle tests (eight
access failures and fatal reflection). After fix: focused redaction/boot/
lifecycle 44/44 PASS. The first test invocation needed a dependency build;
unresolved shared-package errors were setup, not defect reproduction. An
unsupported newer Vitest matcher was corrected before the defect receipt.
No existing assertion/test was removed or weakened.

Production files changed: apps/desktop/src/main/desktop-command-router.ts,
boot-failure.ts and index.ts. No changes to provider behavior/pins, runtime
transport/protocol, schema, QA orchestration/retries, history/evidence/retests,
update channels, distribution tooling or version. IPC/CLI envelopes and valid
codes are unchanged. Fatal screen's internal malformed/uncoded code now uses
the common DESKTOP_ERROR fallback; it is not a client protocol change.

## Focused production review

| Surface                   | Evidence and disposition                                                                                                                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| desktop-command-router.ts | Whole mapping guarded; fixed fallback; validated codes; scrub before cap. All prior redaction regressions retained.                                                                                                                |
| desktop-service.ts        | Sync throws and async rejections share configured mapper; success passes through, no retries.                                                                                                                                      |
| ipc.ts                    | Actual Electron listener catches awaited dispatch and supplies hooks.redactErrorText. Payload tests exercise actual registration.                                                                                                  |
| cli-server.ts             | Dispatch catch uses configured redactor; real wire regression retained. OS listen/parser failures have bounded diagnostics; no provider credential source demonstrated there.                                                      |
| bootstrap.ts              | Configuration-push warning receives sanitized service errors and scrubs again, fixed fallback/200-character cap. Runtime-start diagnostics are scrubbed at fatal render.                                                           |
| index.ts                  | Service scrubber wired to IPC/broker; fatal HTML now scrubs known environment values before truncation. Shutdown/credential diagnostic failures use fixed messages. Distro/binary-control errors carry non-secret OS/config paths. |
| provider-credentials.ts   | Exact memory/environment known values, >=8-character policy, encrypted storage and strict diagnostics unchanged.                                                                                                                   |
| boot-failure.ts           | Common mapper and guarded host metadata; structured native/WSL classification remains covered.                                                                                                                                     |

No other actionable correctness, data-loss, concurrency or security blocker
was reproduced in this bounded change. Short-value scrubbing and theoretical
hostile coercion in upstream internal boot constructors remain existing
limitations without a demonstrated supported-provider leak. No unrelated
rewrite is proposed. Fake enc: fixtures do not establish OS crypto acceptance.

## Executed local verification

These checks used the corrected production tree before commit; final receipt
ties it to the committed SHA and CI. Raw local logs remain ignored pre-rc-*.log.

| Gate                                      | Host             | Result                                                                                  |
| ----------------------------------------- | ---------------- | --------------------------------------------------------------------------------------- |
| frozen install / repository:check         | Windows          | PASS; lockfile unchanged                                                                |
| lint / typecheck / build                  | Windows          | PASS; baseline build used Turbo cache, packaging forces committed-input rebuild         |
| focused regressions                       | Windows          | PASS 44/44                                                                              |
| full Desktop serial min/maxWorkers=1      | Windows          | PASS 378, 2 platform skips, 48 files                                                    |
| pnpm test                                 | Windows          | FAIL six verification-trust cases; systemd user tools unavailable plus EBUSY DB cleanup |
| isolated serial verification-trust        | Windows          | FAIL same six, 2 pass; native systemd unavailable                                       |
| distribution:test                         | Windows          | PASS command; platform skips are not acceptance                                         |
| launcher logic/smoke/behavior/IO/shutdown | Windows          | PASS fixtures; no WSL installation inferred                                             |
| PowerShell distribution maintenance       | Windows          | PASS idle/failed-stop/busy/successful-stop fixtures                                     |
| Native CachyOS / clean Windows            | Physical hosts   | ENVIRONMENT UNAVAILABLE                                                                 |
| Funded providers                          | Owner-controlled | OWNER ACCEPTANCE REQUIRED; no calls                                                     |

Format initially failed only on this task's temporary PowerShell JSON receipt;
it was moved to an ignored .log. Final tracked-document formatting/hygiene and
exact-SHA WSL/CI/distribution results belong to the final candidate receipt.

An independently launched Desktop suite failed desktop RPC adapter > pushes
runtime configuration after credential save: EPERM renaming a temporary
models.json while another full test process used the same default temporary
preferences path. It passes in the serial Desktop suite. Service/credential
production files are unchanged. Preserve the concurrent failure; it is not a
green full-suite result. Avoid overlapping test processes sharing this fixture.

Windows trust failures reproduce independently and are not waived. Sandbox,
runtime and agent source subtrees are unchanged from approved dev. Fresh
exact-candidate real-mount WSL tests are still required; historical 8/8 receipts
alone do not qualify a new candidate. Hosted capability fallback is UNVERIFIED
for real mounts. Final receipt must report fresh tests/failures/retests, exact CI
and both unsigned archives before handing over the testing package.

## Remaining separate gates

Implementation is regression-backed; owner review/integration remains.
Automated verification is scoped to the final receipt; native Windows trust
remains failed/capability unavailable, never relabelled PASS. Physical acceptance
uses the [runbook](v1-owner-acceptance.md), [results template](v1-owner-acceptance-results.md)
and [v1 checklist](V1_ACCEPTANCE_CHECKLIST.md). After owner integration, verify
actual merge identity/tree/post-merge CI and selected-SHA artifact provenance.
No self-merge, release branch, tag, version bump or publication is authorized.
