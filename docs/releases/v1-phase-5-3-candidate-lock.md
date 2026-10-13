# Phase 5.3 acceptance candidate lock

Acceptance continues with **I1**, subject to owner evidence acceptance. This is
an exact-byte test lock, not a new release, RC, policy approval or version bump.

| Identity                                   | Value                                            |
| ------------------------------------------ | ------------------------------------------------ |
| I1 full source                             | `c78faa74717b0f430a859730e98c3c4915e7b03f`       |
| I1 tree                                    | `8bbaab4a5d1f7830dcf4ed7b4c40362c62f8d71d`       |
| Product / Desktop / runtime                | `0.1.0-beta.1` / `0.1.0-beta.1` / `0.1.0-beta.1` |
| Runtime protocol / Electron                | `1` / `36.2.1`                                   |
| Approved integrated dev / acceptance tools | `5c68491ccd0f00e34917bb3efdb4926c2fcfd280`       |
| Integrated tree                            | `151e19156b9b69be8cb55c89209cf9717e5c5aac`       |

| Platform / exact filename                                             | Archive SHA256                                                     | `distribution.json` SHA256                                         |
| --------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Windows: `sentry-0.1.0-beta.1-c78faa74717b-windows-x64.zip`           | `ec5edec8a6b3f8ef18bafd961e66c59f80669804cc98d30e0cb10ef18c527d1e` | `cd8f0a536e1e76a89413826f5c5367f40f99e3c2817106c81bbd8932698a6cdc` |
| CachyOS target: `sentry-0.1.0-beta.1-c78faa74717b-cachyos-x64.tar.gz` | `5bd3642ed392607a010078be35885d1cff45db162a2841ee374be228275e89d8` | `e79b4d8836394c6cfc87c573b71d1e500f3334cc5d7947c4daf07dcef3ae9a86` |

Both archives and extracted inventories were reverified in Phase 5.3. Root,
Desktop and runtime-source identities agree; Windows inventory332, Linux333.
Private repository-relative retention: Windows `dist/distributions/`, CachyOS
`dist/owner-campaign/phase51-ci-cachyos/`, with original checksum sidecars.
Retain these files independently of CI expiry; the owner must deliver them
privately to the operator. They are available on the maintainer host, not
automatically delivered to the laptop. No binaries are committed here.

The Windows bytes were built locally on Windows from clean I1 using
`pnpm distribution:build windows-x64`, Node24.13.1/pnpm9.12.3,
Electron36.2.1/electron-builder26.0.12/esbuild0.21.5. They passed actual packaged
Windows/WSL DPAPI and populated-history G10-R acceptance in
[Phase5.1](v1-post-merge-acceptance-c78faa7.md) and
[Phase5.2](v1-phase-5-2-g10-recovery-validation.md).
The Linux archive was built on hosted Ubuntu/Node22/pnpm9.12.3 in
[distribution38417470244](https://github.com/Mert1026/Sentry/actions/runs/38417470244),
artifact11824114212. **Native CachyOS GUI/keychain acceptance is unexecuted.**
The same CI run's Windows archive has different bytes (1343b80…); it is not
the selected physical Windows artifact. Its distinct receipt remains in Phase5.1.

## Executable equivalence and evidence boundaries

Actual `git diff --name-only` comparisons were inspected for I1→8bbe8ba,
8bbe8ba→5c68491, and PR19 head9170f06→5c68491. The last pair has equal trees
and an empty complete diff. The first two change documentation/protocol records
and three files under `scripts/distribution/tests/` only. Actual file comparisons
of `apps/`, `packages/`, package metadata, lockfile, launcher and top-level
distribution scripts are empty. Models/protocol/migrations therefore remain
unchanged. `build.mjs` copies tracked runtime sources and top-level distribution
scripts through an explicit allowlist; `tests/` and release receipts are excluded
from executable payloads. INSTALL.md documentation differs, so complete artifact
byte equivalence is neither expected nor claimed.

Production-source equivalence preserves the earlier I1 evidence for its exact
archives. It does not relabel I1 artifacts as 5c68491, transfer physical results
to receipt-PR archives, or satisfy native/clean-host/paid gates. Reopening a new
executable, changing dependencies/models/protocol or rebuilding different bytes
requires a new lock and affected host checks. The task PR's CI/distribution
identities belong in its final receipt and remain separate from this lock.

Phase5.3's final verification additionally exposed a timing assumption in the
existing cancellation test. Its correction waits for durable agent completion
before requesting cancellation and retains a controlled promise barrier/state
assertion. Only `packages/run-engine/tests/closure.test.ts` changes; it is excluded
by the runtime-source allowlist. The [report](v1-phase-5-3-final-host-acceptance.md)
retains the first-head failure and deterministic RED/GREEN evidence. Production
source and selected physical bytes remain unchanged.

Published beta tag object `e92e3be8d2de21ce5c22508c15de3c08f02cb77a` still peels
to `0e5c10cfa80f6385ebfc88a7306b38ce8a12ce38`; no release assets, tag changes
or publication. All candidates are unsigned.
