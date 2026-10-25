# m05-project-capture-mvp (proposed development scope)

Owner review requested: qualify create-only Projects/Captures separately from
`knowledge-v1-full`. This does not amend that approved contract or authorize
production activation. The capability name labels the integration scenario;
the existing candidate wire profile is unchanged, not newly negotiated.

## Implementation plan and boundaries

| Architecture question | Decision |
| --- | --- |
| Source of truth | Each installation's real SQLite file, including journal and import proofs. |
| Ownership | Existing CaptureStore/DataRootOwnership; one owner per disposable root. |
| Dependencies | Test scenario calls native journal writers, SyncEngine and G3 importer. No reverse dependencies. |
| Boundary | Existing canonical envelopes and bounded AuthenticatedTransport trait; no database handles cross devices. |
| Failure | Existing explicit deferred/conflict/unsupported/storage/trust outcomes; disconnect ends the attempt without success. |
| Lifecycle | Disposable roots, bounded exchanges, drop both owners and reopen their exact files for restart. |
| Test seams | Existing cfg(test) FakeTransport, TestTrust and clock; real database, journal and importer. |
| Compatibility | No production migration or API change; v9/default closed gates and frozen contracts stay unchanged. |
| Observability | Assert engine attention/status, original row images, canonical events, import proofs and durable progress. |
| Security | Synthetic data and qualification trust only; no production trust factory, listener or plaintext LAN transfer. |

The scenario refuses the whole exchange when either journal contains operations
outside Project/Capture creation. It never filters individual events out of an
origin chain. Unsupported history remains local with an explicit unsupported
result. This preflight is test orchestration, not a shipped capability API.

The runnable entry point is `cargo test --locked --offline --manifest-path
apps/arthur/src-tauri/Cargo.toml --lib mvp1 -- --test-threads=1 --nocapture`.
It uses the same storage owner primitive as NativeRuntime; production
NativeRuntime's schema9 constructor is not changed to open candidate files.

## Smallest remaining product connection

Real encrypted networking is BLOCKED: TLS laboratory sessions and N7D socket I/O
exist separately; no authenticated Sync transport composes them. FakeTransport
provides no encryption or independent endpoint authentication. The smallest
implementation is a test-only two-endpoint rustls-to-existing-I/O adapter for
the existing AuthenticatedTransport boundary, with exporter/peer binding,
bounded framing, cancellation and disconnect tests. Keep production closed.

N1: independently select/accept the exact maintained audited PAKE implementation
and locked features; resolve the advisory via supported upstream remediation;
review two-endpoint enrollment, confirmation, attempt accounting, human approval
and TLS composition. Follow `m05-n1-external-review.md`; self-review is not approval.
No new protocol or dependency substitution is proposed here.
The retained experimental lock is opaque-ke 4.0.1 (defaults off,
ristretto255/argon2), argon2 0.5.3 (zeroize), rustls 0.23.46/ring 0.17.14.
The prior review packet prefers balanced spake2 0.4.0/Ed25519Group, but its
audit/encoding/confirmation gaps mean it is neither installed nor approved.
The reviewer must accept a concrete implementation and remedied dependency
closure before any replacement or activation; passing this fixture decides neither.

G3: owner approval of this narrow create-only scope and its import policy is
still required. Updates, deletion, reviews, historical reconstruction and other
knowledge are unsupported here; existing full-profile work remains separate.

G4: measure worst-case existing journal + G3 transaction/WAL growth for bounded
Project/Capture creates and retained duplicates/dependencies; apply the existing
physical admission mechanism to those operations, prove SQLite FULL/rollback/
restart at the boundary, then obtain bounds approval. Logical event quotas do
not prove physical bounds. No universal storage manager is proposed.

N7: approve actual connected endpoint/interface, route freshness, certificate/
session policy and cancellation on the encrypted adapter on Windows and Android.
N2/N3 and G5–G7 remain separate unapproved gates; no E3B or production activation.

ArthurClient desktop/mobile currently have no native Sync action/status API.
After those gates: add one native foreground SyncNow/status command through the
existing runtime owner and ArthurClient adapters, expose paired name/status/
last-success/error, and invalidate reads after committed imports. React never
owns sockets or signing. No fake connected/success UI is added in this milestone.
