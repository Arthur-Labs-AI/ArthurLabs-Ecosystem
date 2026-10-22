# Factual boundaries retained and refreshed

Read-only source root: `/home/kaloyan/Projects/Nexus`. No Nexus application command, test or mutation is part of this website task.

- `apps/nexus-desktop/README.md`: renderer → typed Tauri → client → daemon/kernel; no renderer SQLite, credentials or routing authority.
- `native/nexus-client/src/intent_client.rs`: shared intent client for desktop and CLI over the narrow broker protocol; supports bounded repo-inspect metadata.
- `native/nexus-broker/src/lib.rs`: bounded intent front door and existing authorization/executor chain.
- `native/nexus-broker/src/inspect.rs`, opening description and fixed-tool parser: per-turn native accept/bind/authorize, provider proposal, strict tool/argument/limit validation and independent Kernel tool authorization. Unsupported/mutating/process proposals are refused in inspect mode. The web trace is a simplified illustrative path with grouped boundaries, not a live trace or proof of current release support. The denied variant records/returns a refusal rather than claiming an unauthorized operation ran.
- `config/registry/modes/engineering-v3.json`: status planned, selectable false, runnable false. All Nova choreography and Sentry handoff/feedback remain architectural illustration.
- `config/ContextDurableMutationPolicyV2.cjs`: durable mutation remains false. Context choreography is an authored representation, not production compaction.
- Prior Phase 3A.1 audit remains applicable for SafePoint, checkpoint, unkeyed integrity/provenance and retention-planning restrictions. No seal authentication, lossless compression, measured savings or recovery guarantee is introduced.
- `src/components/suite-launch/releases.ts`: the existing release catalog is empty. Nexus distribution reads this source through an additional metadata guard; the website has no verified Nexus artifact. This establishes catalog state only, not global knowledge of every external release.

Registry cards/providers/roles are fictional sample metadata. Configuration matching illustrates only the declared sample role/capability and configured connection; it is not an implementation or replacement of the real Registry resolver. No provider/model is called. No actual project is inspected. No code, artifact or verification finding is generated.
