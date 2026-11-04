# Phase A2: Complete Sentry import

The Sentry `main` branch is imported, with its full Git history, into
`systems/sentry/`. This is a source and history import only. **Runtime
integration with Nexus is NOT implemented in Phase A2**, and A.R.T.H.U.R. is not
imported. Sentry stays an independent local-first QA system with its own
package manager, database, harness adapters, permission model and sandboxing.

## References

| Reference | Value |
| --- | --- |
| Sentry upstream `main` | `2ea1b86da020fa07766635153943506d78b371ed` (imported with the Claude co-author trailer removed from one commit message; imported tip `f4e2d2a007a6d15725602d30aeb5949524bf5ee7`, all trees identical, imported commit SHAs differ from upstream) |
| Sentry `main` seen during planning | `2cd64d4fb5cf5be1384b3b7907e94a7c381ddfa9` (superseded; the fetched tip is what was imported) |
| Ecosystem base `main` | `b9c71ce6699bd32c2d3491c243194e10bc72b7b0` |
| Local backup branch `backup/pre-sentry-import-main` | `b592ff5c81c81e3b78993c0c8825d297575c8294` |
| Subtree merge commit | `db3623dac79161777900b961db8c514a49c55edf` |
| Sentry tree (`HEAD:systems/sentry` = source `main^{tree}`) | `7fa4bd4de00d3241c458df8f13d8649984a65d31` |
| Preserved `website/` tree | `183eb22fb792a9623cf566beea5953ef42ba98e9` |
| Preserved `systems/nexus/` tree | `87cfb42fdcf8236951239505c179609667b5e10b` |
| Preserved `docs/` tree before this report | `5092d7c8d4dd5b804157cbbfd26b564ff40c1f65` |
| Preserved root `README.md` blob | `95878bb03b2f5d6726bf58bfcd2987acc1e7b2d9` |

Nexus was confirmed present in the latest destination `main`
(`systems/nexus`, imported in PR #2).

## Import strategy

```bash
git branch backup/pre-sentry-import-main main
git checkout -b integration/sentry main
git remote add sentry-src https://github.com/Mert1026/Sentry.git
git remote set-url --push sentry-src DISABLED      # fetch-only
git fetch sentry-src main
git subtree add --prefix=systems/sentry sentry-src main \
  -m "Import Sentry with full history into systems/sentry"   # no --squash
```

The result is a two-parent merge: parent 1 is the destination `main`
(`b592ff5`), parent 2 is the Sentry tip (`2ea1b86`). No squash commit and no
history rewrite. The original Sentry repository was not modified.

## Preflight audit

- **Branches/tags:** source has `main`, `dev` and several feature branches.
  Only `main` was imported. Tags `v0.1.0-beta.1`, `v1.0.0`, `v1.0.1`, `v1.0.2`
  and `v1.1.0-beta.1` exist in the source and are **not** imported (tags are
  not fetched; commits they point at on `main` are reachable).
- **Submodules / LFS:** none tracked (`git ls-tree` shows no gitlinks; no LFS
  pointers).
- **Binaries / artifacts:** the largest tracked files are a 927 KB run export
  JSON (`sentry-run_*.json`, synthetic project IDs), `pnpm-lock.yaml` (701 KB),
  a 404 KB GIF (three copies) and a 400 KB `.icns`. No `.exe`, `.dll`, archives,
  databases, logs, `.env*` files, `node_modules`, `.turbo` or `.pnpm-store`
  entries are tracked on `main`. The local-only `.env*` files in the author's
  working directory are untracked and were not imported.
- **Secret scan of the full `main` history:** no gitleaks/trufflehog available,
  so a regex pattern search over every commit's patch was used (OpenAI-style
  `sk-`, GitHub `ghp_`/`github_pat_`, AWS `AKIA`, Google `AIza`, Slack `xox`,
  private-key PEM headers, bearer tokens) plus a file-name scan for key/env
  files. Every match is an obviously synthetic test fixture
  (`sk-fake-secret-for-test`, `sk-test-fake-secret`, `sk-live-secret-value`,
  `sk-or-test-12345678`, `sk-phase5-surface-alpha-001`,
  `sk-sentry-phase5-redaction-synthetic-only-001`, `sk-compactvirtualdisk`,
  `Bearer faketoken1234567890abcdef`) used by redaction/secret-surface tests.
  No real credentials found. This was a pattern scan, not a verified-entropy
  scanner; a dedicated scanner run in CI is recommended.
- **Personal paths:** `.superharness/handoff.md` and `.superharness/task-status.md`
  contain local Windows paths of the author (for example
  `C:/Users/merte/...`). These are workflow notes in Sentry's own history, not
  credentials; they are preserved as source content.
- **License:** MIT, "Copyright (c) 2026 Mert_1026", preserved at
  `systems/sentry/LICENSE`. Third-party dependency licenses (Electron,
  npm packages) were **not** audited individually; redistribution of the
  packaged desktop app would need a separate third-party notices review.
- **Security docs:** `systems/sentry/docs/security/V1_THREAT_MODEL.md` and
  `wsl-maintenance.md` are preserved unchanged.
- **Workspace:** pnpm 9.12.3 (`packageManager`), Node `>=22` (`.nvmrc` 22),
  `pnpm-workspace.yaml` with `apps/*` (cli, desktop, runtime) and `packages/*`
  (15 packages including harness-opencode, harness-deepseek,
  harness-claude-code, snapshot-engine, workspace-factory, persistence),
  Turborepo. Sentry has its own `pnpm-lock.yaml`; there is no root workspace
  in the ecosystem, so nothing is combined.
- **Path assumptions:** Sentry targets Windows 11 x64 with WSL2 for the Linux
  sandbox (bubblewrap). It does not depend on being at the Git root of the
  repository for the commands exercised below; all were run from
  `systems/sentry/` inside the monorepo checkout. Git-root auto-detection
  inside Sentry's *product* behaviour (QA of user projects) operates on the
  user's project, not on this repo, and was not exercised end to end.
- **Workflows:** Sentry's `.github/workflows/{ci,distribution,native-distribution}.yml`
  now live at `systems/sentry/.github/workflows/`. GitHub does not execute
  workflows outside the repository root `.github/workflows/`, so they are
  inert historical source content here.

## Integrity validation

| Check | Result |
| --- | --- |
| `HEAD:systems/sentry` tree == source `main^{tree}` | identical (`7fa4bd4d…`) |
| Source commits reachable from HEAD | 587 of 587 (`git rev-list sentry-src/main ^HEAD` is empty; `merge-base --is-ancestor` true) |
| Tracked files | 789 in source, 789 in `systems/sentry` |
| Missing files (`--diff-filter=D` vs base `main`) | 0 |
| Modes | one executable (`sentry`, `100755`) preserved; all others `100644` |
| Merge parents | 2: `b9c71ce…` (dest main) and `f4e2d2a…` (Sentry main, trailer removed) |
| Squash / synthetic import | none |
| `website/` tree vs baseline | identical |
| `systems/nexus/` tree vs baseline | identical |
| Files changed outside `systems/sentry/` by the import | 0 |
| `.env`, `node_modules`, logs, caches in the diff | none |

## Build and test validation

Hosts: Windows 11 (Node v24.13.1, pnpm 9.12.3) and WSL2 Ubuntu (Node
v22.23.2, pnpm 9.12.3, `bwrap` present). Dependencies installed with
`pnpm install --frozen-lockfile`. The Windows host runs Node 24, not the
source-pinned Node 22 (`.nvmrc`); the Ubuntu run uses Node 22.

| Check | Environment | Result |
| --- | --- | --- |
| `pnpm run repository:check` | Windows | pass |
| `pnpm run format:check` | Windows | pass |
| `pnpm run lint` | Windows | pass (18/18 tasks) |
| `pnpm run typecheck` | Windows | pass (33/33 tasks) |
| `pnpm run build` | Windows | pass (18/18 tasks) |
| `pnpm run build` | WSL Ubuntu (copy in WSL native FS) | pass (18/18 tasks) |
| `pnpm run distribution:test` | Windows | pass (exit 0) |
| `turbo run test` (default concurrency) | Windows | **fail**: `@qa/snapshot-engine` 5 s timeout, then turbo aborted (see below) |
| `turbo run test --continue --concurrency=2` | Windows | 35/36 tasks; `@qa/runtime` 2 failures (5 s timeout, `EBUSY`); desktop 69 files passed, 1 skipped |
| `@qa/snapshot-engine` tests, run alone | Windows | pass (4/4) |
| `@qa/runtime` tests, run alone (monorepo) | Windows | pass (89 passed, 1 skipped) |
| `@qa/runtime` tests, run alone (standalone source) | Windows | pass (89 passed, 1 skipped) |
| `turbo run test --continue --concurrency=2` | WSL Ubuntu | **pass, 36/36 tasks** |

WSL skip counts (reported by vitest, not counted as passes): harness-opencode 8
of 201, harness-claude-code 7 of 125, desktop 34 of 540. Skips are
platform- or live-service-gated tests (Windows-only WSL maintenance tests,
live-provider tests). Which individual tests were skipped and why was not
audited line by line.

### Baseline comparison for the Windows failures

The intermittent failures occurred only under full parallel `turbo` load on
Windows:

- `@qa/snapshot-engine` "produces stable order and content hashes for many
  files": `Test timed out in 5000ms` (took 5109 ms).
- `@qa/runtime` "PATH opencode is not blocked for executable-not-found" and
  "preserves a real project-lock rejection…": timeouts of ~8 s against a 5 s
  limit, and `EBUSY: resource busy or locked, unlink …\sentry.db` (Windows file
  lock on a temp SQLite file).

Each of those suites passes when run on its own, in the monorepo and in a
pinned standalone checkout of `2ea1b86` (same 89 passed / 1 skipped for
runtime), and the whole suite passes 36/36 on Linux. Classification:
**environment limitation** (Windows load/file-lock timing), not an integration
regression. The one full-parallel Windows `turbo run test` was **not** repeated
against the standalone checkout, so the claim that the upstream also fails
under the same full load is **unverified**; the evidence is that isolated
standalone and isolated monorepo results are identical. No test assertion,
timeout, sandbox or permission was changed.

### Not covered

- The Electron desktop app was not launched or packaged. Desktop *unit and
  integration tests* ran (506 passed in WSL; 69 files on Windows).
- `distribution:build` (installer packaging) was not run. The packaged runtime
  assumptions are therefore **unverified**.
- Live harness calls (OpenCode, DeepSeek, Claude Code/GLM) need real provider
  credentials and were not run.
- macOS was not tested and is not a supported target for the full product.

### Existing ArthurLabs components

- `website`: `npm ci`, `npm run build` (Next.js, success) and `npm run typecheck`
  succeed after the import. Playwright e2e was not run.
- Nexus: tree hash identical to the baseline; its test suite was not re-run.
- No new files appear outside `systems/sentry/` and this report. Build outputs
  were gitignored and `git status` stayed clean.

## Security boundaries

No credentials, permission policies, databases, model registries or execution
controllers were shared or merged. Sentry keeps its immutable-snapshot and
isolated-workspace design; no shared writable workspace was introduced between
Sentry and Nexus; no Sentry or Nexus code was edited. Nexus Native does not
replace any Sentry harness adapter.

## Remaining risks

1. Sentry's `.superharness/` and `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` agent files
   now sit under `systems/sentry/`. Agent tooling that searches upward from the
   repo root may pick up unexpected instructions; they are scoped to that
   subdirectory by convention only.
2. `CLAUDE.md` in the subtree refers to `shux contract`, which is a Sentry-local
   workflow convention.
3. The secret scan was regex-based. Run a dedicated scanner in CI.
4. Third-party dependency licenses and the Electron redistribution terms were
   not audited.
5. Windows full-parallel test timing is flaky (see above); CI should use
   `--concurrency=2` or run on Linux.
6. Tags were not imported. Upstream release tags can be added separately if the
   ecosystem wants them.
7. Sentry's own CI is inert here; the ecosystem has no CI for `systems/sentry`.

## Future subtree synchronization

Merge the PR with a **regular merge commit** (not squash or rebase) so the 587
Sentry commits stay reachable. To pull later upstream changes:

```bash
git remote add sentry-src https://github.com/Mert1026/Sentry.git
git remote set-url --push sentry-src DISABLED
git fetch sentry-src main
git subtree pull --prefix=systems/sentry sentry-src main \
  -m "Sync Sentry upstream into systems/sentry"
```

Do not use `--squash` on a later pull, since the original import was unsquashed.
Prefer making changes upstream in the Sentry repository and syncing here.

## Not implemented

Phase A2 does not connect Sentry to Nexus, share state or credentials, or
import A.R.T.H.U.R. Any future integration should use explicit, versioned
interfaces and controlled handoffs.

## Note: history message edit

One upstream commit message had a `Co-Authored-By: Claude` trailer. It was
removed (message only) before the import, so imported commit SHAs differ from
upstream and a later `git subtree pull` will not find a common ancestor.
Apply the same trailer removal to new upstream commits before pulling.
