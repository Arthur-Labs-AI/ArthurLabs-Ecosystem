# Changelog

## [0.1.0-beta.1] - Unreleased

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
- Beta tags stay pinned; `sentry update` follows development main.
- Sandbox proofs require capabilities absent on some runners.
- Legacy merge/verification ingestion is outside current Desktop RPC.
- Private repository access required for testers.
