# A.R.T.H.U.R import report (Phase A3)

A.R.T.H.U.R is imported into `systems/arthur/` with full, non-squashed Git
history. The website, Nexus and Sentry trees are byte-identical to the baseline.

## References

| Item | Value |
| --- | --- |
| Destination baseline (`main`) | `c97975b90501b90e7d6c0cf11ceeb7031549d9a5` (local backup tag `backup/pre-arthur-import-main`) |
| Source selected | Kaloyan3D/A.R.T.H.U.R `main`, history-sanitized `55fe6bd2705389944c24e25e82c38b77f498ff86` |
| Same source before sanitizing | `8a4a6bb815d0950b2e625b52f0c8fb0f82c55690` (identical tree) |
| Source tree (equals `systems/arthur`) | `4631a8a0680b6b05adc7a05cda80895fd01147c6` |
| Subtree merge commit | `3b0fe023d257153e570cb35a3c92e0f48f1f3277` |
| `website/` tree | `183eb22fb792a9623cf566beea5953ef42ba98e9` (unchanged) |
| `systems/nexus` tree | `87cfb42fdcf8236951239505c179609667b5e10b` (unchanged) |
| `systems/sentry` tree | `7fa4bd4de00d3241c458df8f13d8649984a65d31` (unchanged) |

## Source selection

`main` was chosen. Ahead counts against `main` at audit time:

| Branch | Ahead of main | Note |
| --- | --- | --- |
| `dev` (`e9cebc6`) | 0 | `main` is `dev` plus the merge commit (PR #7) |
| `feature/nodes-integration` | 0 | fully merged |
| `feature/cognitive-runtime-v1` | 0 | fully merged |
| `fix/phase3-voice-hardening` | 0 | fully merged |
| `feature/phase3-tool-runtime` | 6 | EMG Rev A hardware checkpoints only; deliberately not imported |

The source also contains `hardware/` (EMG board design, about 1,255 files),
`packages/`, and a Tauri app (`apps/arthur/src-tauri`, Rust) in addition to the
Node/TypeScript core. All of it is imported as one tree. The source has no
submodules and no Git LFS.

## Security finding and history sanitizing

A DeepSeek-format API key (`sk-` plus 32 hex characters) was committed to
`.env.example` in source commit `ebad24a` (2026-08-23) and blanked in `20e4dc0`
(2026-09-04). It was reachable from every branch and three tags. It is not in
any branch tip.

Actions taken:

- Rewrote a mirror of the source with `git filter-repo --replace-text`
  (`regex:sk-[0-9a-f]{32}==>REDACTED_DEEPSEEK_KEY`). A search of the full
  rewritten history finds zero matches. Branch-tip trees are identical before
  and after the rewrite (`main` tree `4631a8a0...`); only commit SHAs differ.
- Imported from the sanitized mirror, so the key is not in this monorepo's
  history (`git log -S` finds zero matches).
- The key must still be revoked at DeepSeek; the rewrite does not do that.

Open dependency: at the time of this PR the sanitized history had not been
force-pushed to `Kaloyan3D/A.R.T.H.U.R`. Upstream `main` is still `8a4a6bb`.
Until upstream is rewritten, `55fe6bd` exists only in a local sanitized mirror,
and `git subtree pull` from the current upstream would reintroduce the key.

Other audit results:

- No `.env` was ever tracked; `.env.example` holds placeholders.
- Other `sk-`, `ghp_` and private-key strings are fake values in redaction tests.
- Three small WAV files are tracked in `tests/fixtures/wake/`. Their content was
  not reviewed. No other audio, database or model files were found by name.
- Large blobs: an `.ai-harness/state/tasks.json` of about 14 MB (history only,
  removed in `7c85bd8`, content not reviewed), KiCad session logs, a GLB model,
  PDF datasheets, and hardware Gerber/ODB++ zip files.
- The scan was regex-only. gitleaks and trufflehog were not available.

## Licensing

`package.json` declares `UNLICENSED`. It is preserved unchanged. No project-wide
licence was added, and third-party licences were not audited in this phase.

## Git commands

```bash
git tag backup/pre-arthur-import-main origin/main
git checkout -b integration/arthur origin/main
git remote add arthur <sanitized-mirror>   # fetch-only
git remote set-url --push arthur DISABLED
git fetch arthur main --no-tags
git config core.longpaths true             # required on Windows, see below
git subtree add --prefix=systems/arthur arthur main \
  -m "Import A.R.T.H.U.R with full history into systems/arthur"   # no --squash
```

## Integrity verification

- `HEAD:systems/arthur` tree equals source tree `4631a8a0...`.
- Path, mode and blob listings of all 2,556 files are identical, including 15
  executable files. The source has no symlinks.
- Source `55fe6bd` is an ancestor of the merge. 178 source commits are reachable;
  179 new commits including the merge.
- The merge has the destination baseline and the source tip as its two parents.
- `website/`, `systems/nexus` and `systems/sentry` trees equal the baseline trees.
- No path outside `systems/arthur/` changed in the import (only this report is added).

## Build and test results

Node v24.13.1, npm 11.8.0, Windows 11. Run from `systems/arthur/`.

| Command | Result |
| --- | --- |
| `npm ci` | passed |
| `npm run typecheck` | passed |
| `npm run build` | passed |
| `npm test` | 1723 tests: 1689 passed, 16 failed, 18 skipped |

The suite covers unit, integration, contract and architecture tests, including
FakeProvider, SQLite initialization, Personal/Business memory separation,
approval-required tool behavior and deterministic voice state-machine tests. No
paid model calls and no microphone were used.

Smoke checks with `ARTHUR_MODEL_PROVIDER=fake`: the CLI `--help` runs; the HTTP
API starts on 127.0.0.1 and `/health` returns `ok`; the three SQLite databases
are created.

### Source-versus-import comparison

The same `npm test` was run on a standalone checkout of `55fe6bd` (identical
tree): 1723 tests, 1690 passed, 15 failed.

| Failure | Classification |
| --- | --- |
| 15 tests in `cli_data_paths`, `local_model_paths_provenance`, `cli_lazy_db`, `sc04_linux`, `voice_cli_tool` and related (POSIX path and XDG assertions, plus the F16 and F30 end-to-end cases) | Existing upstream failures on Windows; identical in the standalone source |
| `HR-01: git tools unaffected (git.status ...)` | Import-specific. The test sets the repo path to `.` and the git validator (`src/tools/git/repository_validator.ts`) requires `rev-parse --show-toplevel` to equal that path. Nested under `systems/arthur/`, the top level is the monorepo root, so `git.status` fails. It fails closed (no unintended access). The subtree was left unmodified. |

The 15 shared failures are attributed to Windows-versus-POSIX path expectations
from the assertion text only; they were not re-run on Linux, so that cause is
unverified.

## Monorepo compatibility

- No root workspace, shared dependency tree, merged databases or shared secrets.
- Nexus and Sentry were not rebuilt in this phase; their trees are unchanged.
- No agent-to-agent calls were added, and Arthur's harness stub is untouched.
- Windows long paths: some hardware evidence paths exceed 260 characters.
  `git subtree add` failed until `core.longpaths=true` was set. Windows checkouts
  of the monorepo need `git config core.longpaths true`.
- `systems/arthur/.github/workflows/m05.yml` is inside the subtree; GitHub only
  runs workflows from the repository root `.github/`, so it does not run.

## Future subtree synchronization

```bash
git remote add arthur https://github.com/Kaloyan3D/A.R.T.H.U.R.git
git remote set-url --push arthur DISABLED
git fetch arthur main
git subtree pull --prefix=systems/arthur arthur main -m "Sync A.R.T.H.U.R"
```

Do not use `--squash`. Run this only after upstream has been rewritten to the
sanitized history, or the key returns. Merge the resulting PR with a normal
merge commit.

## Remaining work

- Revoke the exposed DeepSeek key.
- Force-push the sanitized history upstream and ask GitHub Support to purge the
  old `refs/pull/*` objects.
- Decide on the `HR-01` git test (parameterize the repo path for nested use).
- Review the tracked WAV fixtures and the historical `.ai-harness` state for
  personal data.
- Run a dedicated secret scanner and a third-party licence review.
- Run the suite on Linux to separate the 15 shared failures from Windows issues.
- Define the Arthur, Nexus and Sentry contracts in a later phase.
