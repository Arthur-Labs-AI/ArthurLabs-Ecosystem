# Changelog

## [1.0.1] - 2026-10-15

- Fix imports and updates of Python/Next/Nuxt working directories containing
  unreadable generated caches. Preserve existing revision hash compatibility.
- Report permission failures with their path and provide actionable disk-space
  diagnostics instead of a generic managed-copy error.
- Register the packaged Windows `sentry` command during successful setup, with
  explicit `register-command` repair, safe path/argument handling and exit codes.
- Align product, Desktop, runtime, CLI and launcher identity to `1.0.1`; retain
  protocol `1`, schemas, migrations, provider pins and credential contracts.
- Keep the original v1.0.0 tag and downloads unchanged. See
  [patch notes](docs/releases/v1.0.1.md) and the official Release page for assets.

## [1.0.0] - 2026-10-15

- Reconcile root, Desktop, runtime, CLI and source launchers to stable `1.0.0`.
- Preserve runtime protocol `1`, schemas/migrations, provider/model/tool pins and
  existing project/history/credential contracts.
- Integrate owner-merged Phase 6.5 WSL maintenance hardening: fixed inline UAC
  execution, private ACL/path checks and authenticated atomic operation receipts.
- Windows 11 x64 + WSL2 only; unsigned ZIP with online runtime bootstrap. Native
  Linux Desktop deferred. No public RC, automatic updater or signed installer.
- See [stable notes](docs/releases/v1.0.0.md) and the
  [verification handoff](docs/releases/v1-phase-6-6-stable-readiness.md).
  Published Windows Stable; original preparation receipts keep their historical scope.

## [1.0.0-rc.1] - Historical internal Windows preparation (never published)

- Initial release target: Windows 11 x64 with WSL2 (Ubuntu preferred).
- Native Linux Desktop: DEFERRED — FUTURE NATIVE LINUX RELEASE; existing
  CachyOS implementation, results and unresolved import evidence retained.
- Windows Electron continues using the Linux execution runtime, systemd user
  services, bubblewrap, existing protocol and secure DPAPI storage.
- Windows unsigned ZIP review packaging is independent of native Desktop
  packaging; shared Linux runtime/security validation remains required.
- Correct packaged PowerShell WSL-mode forwarding and visible Desktop launch.
- Ground DeepSeek persistent Bash outcomes in explicit tool completion evidence;
  retain strong-finding evidence validation and fail closed on unknown outcomes.
- Confirmed project removal with managed-data/history cleanup, active-operation
  refusal, missing-folder handling and preservation of original source folders.
- Explicit Windows WSL disk reclamation, administrator consent, other-distro
  refusal, bounded disk-lock release waiting and Desktop reconnection.
- Freeze verification and exact-source private Windows archive provenance in the
  [Phase 6.3 handoff](docs/releases/v1-phase-6-3-windows-rc-freeze.md).
- Recovery Option A remains limited to the exact historical corrected I1 pair
  and tested Windows account/machine/DPAPI context. Original-beta rollback FAIL
  is retained. No new version bump, official RC publication or updater.

See the [Windows draft notes](docs/releases/v1.0.0-rc.1.md).

## [0.1.0-beta.1] - 2026-10-09 (historical)

First source-based beta candidate. Publication/gate status is recorded in the
[validation report](docs/releases/v0.1.0-beta.1-validation.md).

### Included

- Electron/React Desktop, projects, immutable revisions, independent findings,
  evidence inspection and persistent history.
- Windows 11 + WSL2 and native CachyOS setup, launchers, diagnostics,
  versioned Linux runtime deployment and handshake validation.
- OpenCode 1.18.32, DeepSeek SDK 0.1.5-rc.2 and GLM through Claude Code
  2.1.270; Full/Targeted QA and cancellation.
- JSON/log export, Save As, CLI control and Desktop provider settings.

### Stabilization

- Setup/update blocks failed graceful shutdown on both hosts.
- Electron quit awaits bootstrap and runtime cleanup.
- Linux launch detects immediate Electron failure with log guidance.
- Runtime staging excludes local credentials, databases and logs.
- Verifier path portability and Claude argv fixture corrections.
- CLI version alignment, pinned beta installs and explicit development updates.
- Release/hotfix CI and owner review policy.

### Limitations

- Source installation; no signed installer/tested binary bundle.
- Provider accounts/credit required; failures can prevent 3/3 completion.
- Beta tags stay pinned; `sentry update` follows the selected source channel (`dev` tracks `origin/dev`, `main` tracks `origin/main`).
- Sandbox proofs require capabilities absent on some runners.
- Legacy merge/verification ingestion is outside current Desktop RPC.
- Private repository access required for testers.
