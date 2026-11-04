# Review of d85ca84

Owner requested a review of the other AI's completion. Reviewed the full product
diff from 1251a7d to d85ca849c03f2ae4b1d757d11d83d1ba11c45e86 and callers/tests.
No product edits, deployment, commits or provider runs were performed in this review.

## Important: shell success still permits false coverage passes

`packages/evidence-pipeline/src/depth.ts:65` excludes pipelines and only a small
subset of commands following semicolons. The successful exit of the overall shell
still does not establish successful execution of its tests. Reproduction against
the built helper returns `passed` for each of:

```text
node -e "process.exit(1)"; pwd
node -e "process.exit(1)"
pwd
/usr/bin/grep guard src/file.ts
```

The middle example is one multiline shell operation. The third example is a
source-only inspection using an absolute executable path. Each operation had an
observed exitCode 0 and a check claiming complete coverage. The first command was
also executed in WSL: its test subprocess fails but the shell exits 0 after pwd.
The first two therefore mask test failure; the third bypasses the inspection
filter. This undermines the central claim that unsupported passes are downgraded.
Use an explicit trusted executable-check outcome or conservatively classify
ambiguous shell scripts/inspection as inconclusive; add these negative fixtures.
This is an important correctness issue, not a demonstrated sandbox escape.

## Operational gap: new runtime not activated

At review time, `wsl -d Ubuntu -- readlink
/home/merte/.local/share/sentry/runtime/current` returned `1.0.2-1251a7d`.
The fixes in d85ca84 consequently are not selected by the current runtime link.
Build/deploy/hello verification and reopening the application are still required
before a normal app-based comparison can validate these changes.

## What works / limits

The commit implements cache discovery and read-only shared cache installation
with private copied dependency bytes; prepares a validated report before optional
review; caps that review; reserves finalization time; skips unchanged report
rewrites; and corrects the hard-deadline diagnostic. Findings/evidence are emitted
once in tested fallback paths. No demonstrated new data-loss write path or
isolation bypass was found in this diff.

The report checkpoint remains an in-memory object until final evidence/finding
submission. A host crash before submission can lose it. The development document
explicitly discloses this limitation; it is not durable crash recovery. No paid
same-snapshot comparison has established improved model accuracy.

## Executed verification

| Check                                                  | Result                                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Evidence-pipeline suite                                | PASS, 73 tests                                                                                                                 |
| DeepSeek harness suite                                 | PASS, 62 tests                                                                                                                 |
| Claude/GLM harness suite                               | PASS, 102 tests, 12 existing skips                                                                                             |
| OpenCode suite, initial parallel run                   | FAIL, existing PATH probe 5s timeout and EPERM fixture cleanup                                                                 |
| Full OpenCode suite, rerun with one worker             | PASS, 125 tests, 8 existing skips; no expectations/deadlines changed                                                           |
| Engine preparation + closure suites, one worker        | PASS, 18 tests                                                                                                                 |
| Real WSL preparation sandbox with populated pnpm store | PASS, both ready; private dependency bytes, lifecycle-hook suppression, original/peer/network isolation and owned cancellation |
| Negative coverage reproductions above                  | FAIL: false passes reproduced                                                                                                  |
| Paid model comparison / activated d85 runtime          | UNVERIFIED                                                                                                                     |

Commands: pnpm filtered package `test` for the four harness/evidence packages;
OpenCode `exec vitest run --maxWorkers=1 --minWorkers=1`; engine `exec vitest run
tests/workspace-preparation.test.ts tests/closure.test.ts --maxWorkers=1
--minWorkers=1`; WSL smoke with
`SENTRY_SANDBOX_SMOKE_STORE=/home/merte/.local/share/pnpm/store`.
Local logs are under ignored `.tmp-sentry-test-fixtures/review-d85-*`.
`shux contract` is unavailable; direct protocol receipts were updated.
