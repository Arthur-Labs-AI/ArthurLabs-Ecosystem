# Current architecture

Windows Desktop owns presentation, secure provider settings, runtime connection
and native dialogs. The Linux runtime owns SQLite, managed projects, immutable
revisions/snapshots, the execution lease, independent agent coordination and
persisted findings/evidence. Renderer state is presentation-only; adapters own
provider transport and tool/evidence translation behind the common protocol.

Start with the [v1 pipeline contract](v1-pipeline.md), then the maintained details:

- [Domain model](domain-model.md)
- [Agent stacks](agent-stack.md) and [harness protocol](harness-protocol.md)
- [Project lifecycle](project-lifecycle.md) and [project removal](project-removal.md)
- [Windows/WSL ownership](windows-wsl-runtime.md)
- [WSL disk reclamation](wsl-space-reclamation.md) and [security boundary](../security/wsl-maintenance.md)

Architectural decisions remain in [docs/adr](../adr/0001-monorepo.md), including
persistence/leases, symlink isolation, event integrity and provider separation.
ADR0014 supersedes the historical Muse integration; retain ADR0012 as rationale.
Historical phase specifications and retired merger/verifier/UI flows are indexed
in [history](../history.md), not claims of current Desktop behavior.
