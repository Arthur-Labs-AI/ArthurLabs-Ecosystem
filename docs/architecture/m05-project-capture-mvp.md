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

## MVP1 baseline: remaining product connection

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

## R1 integration plan (qualification only)

Keep the ten architecture decisions above. Replace only the fixture transport
in a second scenario: existing native signing/pinned rustls TLS13 configuration,
N7D RawIo/Pool/timer, bounded AE01 records and existing SyncEngine/G3. A small
test-only adapter owns the socket, TLS state and bounded queues; its explicit
async driver bridges the synchronous engine contract on the existing Tauri Tokio
runtime, without a worker or another runtime. Wire values are test-only serde
representations of existing Sync messages, not a production protocol approval.
Each AE01 record retains the 64 KiB ceiling; a native message streams across
records with a 1 MiB serialization/assembly ceiling. No new framing header,
plaintext fallback or bootstrap claim.

Before engine disclosure, both endpoints verify explicit disposable OS-key pins
and exchange expected network/session/peer/epoch plus the actual TLS exporter
inside TLS. TestTrust still supplies qualification-only membership; durable
membership checks remain in the real store. RAII drops socket/timer/permit on
failure; existing handshake/idle/total deadlines and cancellation remain active.
Failure tests cover authentication/context, TLS corruption/truncation, bounded
records and durable retry. No migration, production command, listener or UI is
introduced; removing the test module rolls back this integration without data
changes. Two-process execution is optional and must not force a new runtime or
export private keys. Independently review N1; retain all activation gates.

## R1 disposition and release scope

The previously missing encrypted integration now exists in
`sync/security/tls_socket_lab.rs` (`cfg(test)` only). It reuses the exact lab
TLS13/RFC7250 raw-SPKI pin verifiers, OS-backed OwnedTlsKey signer, ALPN,
disabled resumption/early data, N7D RawIo/Pool and AE01 ceiling. Both socket
address pairs must agree before handshake; this proves loopback endpoints, not
LAN interface eligibility. Both peers exchange network/session/local/peer/epoch
and the actual TLS exporter inside TLS before a SyncEngine can send data.
Membership still comes from isolated TestTrust plus real durable store checks;
this is NOT production enrollment or membership authentication.

The adapter keeps at most eight queued messages per direction with a cumulative
1 MiB queue ceiling, a 1 MiB bounded JSON writer/assembly, one bounded pending
ciphertext buffer and bounded plaintext records. It handles the maximum native
20,000-character Unicode Capture across multiple AE01 records. Oversized native
messages and snapshot payloads refuse explicitly. A synchronous engine tick only queues
or consumes messages; the explicit async test driver moves all bytes over TLS
and actual loopback sockets on the existing Tauri Tokio runtime. No worker,
third transport framework or plaintext fallback exists. Two SQLite domain roots
and the existing disposable native identity fixtures use distinct canonical
roots, never two owners of one root. OS keys remain non-exportable.

R1 runs two endpoints in one process and reopens both domain owners. Separate
processes, Android encrypted Sync, physical devices and actual LAN are NOT
proved. Forcing separate processes would require a new test listener/endpoint
entry point; this milestone does not add one solely for a two-process PASS.

| Release operations | Classification |
| --- | --- |
| Project/Capture creation, exact rows, reverse create, replay, owner restart | Implemented and verified through Windows TLS sockets. |
| Immutable knowledge/revision/provenance and historical bootstrap candidates | Implemented/store-tested, not integrated into this bounded TLS scenario. |
| D4 project changes, membership moves, reviews/claims/identity/relation histories | Existing candidate policies/tests, not qualified here over TLS or approved for release. |
| Complete knowledge-v1-full, real pairing/SyncNow, physical storage guarantees | Required for the intended release; integration/policy/approval still incomplete. No narrower release is approved by R1. |
| Discovery, background/automatic sync, multiple peers, dashboards | Safely deferrable; manual IP/foreground one-pair workflow remains the target. |

N1 minimal independent review package: the R1 commit/diff, existing
`m05-n1-external-review.md`, Cargo.toml/lock and qualification/packages.json,
PAKE/composition/TLS/signer sources, the new adapter and focused fault/interop
results. No private keys or knowledge payload logs. Retain opaque-ke =4.0.1
(defaults off, ristretto255/argon2), Argon2 =0.5.3/zeroize and rustls
=0.23.46/ring =0.17.14. No OPAQUE→SPAKE2 replacement is authorized here.
The repository has no applicable independent approval for that exact composition.
[RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html)
still lists crypto-bigint fixes at >=0.7.6; the qualification lock retains 0.5.5
through its upstream dependency chain. The prior selected-path analysis does
not close this advisory. Supported upstream remediation plus independent
current-version/composition review remains required. SPAKE2's
[encoding issue #186](https://github.com/RustCrypto/PAKEs/issues/186) remains
open; switching implementations is not a shortcut to approval.

Existing CNG↔Keystore public-fixture/JCA evidence is recorded in readiness §24;
it is not a Windows↔Android encrypted Sync session. R1's OS-backed handshake
evidence is Windows↔Windows loopback. Neither this evidence nor Android memory
TLS instrumentation constitutes reviewed two-device enrollment/PAKE composition.

G3/G4: the encrypted scenario exercises actual import rollback under a SQLite
page ceiling, exact proof/cursor preservation and retry after both owners reopen.
It does not bound WAL/journal/scratch/recovery disk usage or grant physical
admission. Keep UnverifiedBounds. Next measure/admit only selected native create
and import transactions with existing PhysicalAdmission/VFS, including FULL and
IOERR at durable COMMIT, before owner acceptance of bounds and narrow G3 policy.
N7 still needs native connected-interface/profile/permission proof and approved
route/certificate/session policy on both platforms; socket addresses alone fail
that requirement. No firewall change, production listener or automatic LAN.

The smallest next implementation is to execute this adapter and its Project/
Capture scenario through the existing Android debug qualification entry point
with Keystore, then an isolated endpoint pair. Bind it to the existing owner's
shared admission/route cancellation before treating it as application transport.
Production pairing and native SyncNow/status still wait for N1/N2/N3,
G3–G7 and N7 approval; UI remains native-owned and dormant.
