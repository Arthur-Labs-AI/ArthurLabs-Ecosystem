# m05-project-capture-mvp (proposed development scope)

Owner review requested: qualify create-only Projects/Captures separately from
`knowledge-v1-full`. This does not amend that approved contract or authorize
production activation. The capability name labels the integration scenario;
the existing candidate wire profile is unchanged, not newly negotiated.

## Implementation plan and boundaries

R2 plan (debug qualification only): (1) SQLite remains canonical for knowledge
and membership; OS Keystore/CNG retains keys. (2) NativeRuntime retains the sole
store and Coordinator/Pool per root. (3) Qualification calls these existing
owners, rustls, engine and importer; none depend on the harness. (4) Only existing
typed messages/permits cross boundaries; no private key or frontend API.
(5) Binding, cancellation, admission and import failures abort without success.
(6) Reconnect retains the same owner's attempt budget; drop releases sockets,
timers and permits. (7) Explicit loopback-only debug admission is distinct from
native LAN attestation; faults use existing cancellation and deadline seams.
(8) Production schema v9, frozen contracts and closed factories remain unchanged.
(9) Verify exact original rows/proofs/cursors, engine outcomes and zero active
permits. (10) No production-equivalent authorized session is published: native
LAN checks and independent gate approvals remain required. Extend the existing
JNI scenario dispatcher, with no new exports, permissions, runtime or listener.

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

R2 extends the same adapter through the existing Android debug qualification
entry point with Keystore. `journal/tls_qualification.rs` orchestrates the
existing authoritative writers, engine and G3 on two disposable NativeRuntime
roots; each root's identity, SQLite and transport Coordinator have one owner.
No second store owns a root. Its synthetic candidate membership is checked
after TLS pin/exporter/context verification and before returning the transport,
then checked again by engine startup and transactional store access. Pool
`establish` is resource accounting only and now follows those binding checks.
No production-equivalent authorized session is created: loopback inspection
does not satisfy native LAN policy, and ClosedTrust/ClosedLan still refuse.

Every connection uses the existing owner's Pool/clock/fence. Reconnect does not
refund attempts. R1's fifth connection waits the actual 30-second budget window;
unrelated timeout/reset cases use independent endpoint fixtures. Explicit
generation invalidation/shutdown cancels pending encrypted IO. The revocation
scenario writes the durable candidate ledger and explicitly invalidates the
existing owner; automatic signed-registry-to-owner notification is still release
work. No additional worker, scheduler, runtime or Java/JNI production API.

The shared scenario checks maximum Unicode Capture, original UUID/content/time
rows, replay, lost encrypted receipt, both owners closing/reopening exact files,
SQLite FULL without false ACK/cursor/proof advance and durable retry. Reopen
reuses the existing ownership registry and test-only v10 opener; production
startup still selects the v9 opener. Android process-restart identity checks
remain separate from this same-process two-owner Sync reopen.

Next qualify an actual Windows-to-Android endpoint connection and selected
socket/interface/network/permission evidence under an approved route policy.
Independent endpoint processes, physical devices/LAN, ARM64, API37 and release
packaging are not inferred from loopback or debug instrumentation.
Production pairing and native SyncNow/status still wait for N1/N2/N3,
G3–G7 and N7 approval; UI remains native-owned and dormant.

## R3 implementation plan (qualification and dormant owner wiring)

1. Truth: each endpoint's SQLite and OS key remain canonical; public test manifests
   only configure pins/session and compare evidence, never transfer knowledge.
2. Ownership: one NativeRuntime/store/Coordinator/Pool per disposable root. A weak
   reference to its existing Pool lets the store notify committed revocations.
3. Direction: orchestration calls the existing socket/TLS/engine/store path;
   membership storage only signals the existing security resource owner after COMMIT.
4. Boundary: existing TLS/AE01/Sync messages. Only public pins/configuration and
   synthetic result snapshots cross the runner boundary; private keys never do.
5. Failure: bounded admission/connect/handshake/session, exact pins/context and
   membership; rollback produces no revocation notification or receipt.
6. Lifecycle: explicit ADB-reverse loopback listener, closed after accept; two real
   endpoint processes exit/restart between phases; fixtures clean their own roots/keys.
7. Seams: extend the existing JNI dispatcher and Windows test executable; reuse
   Socket/RawIo/TlsTransport and existing SQL fault fixtures, no extra engine/runtime.
8. Compatibility: production schema9/closed factories and frozen SQL/codec stay;
   all external network qualification remains test/debug-only and explicitly invoked.
9. Evidence: compare complete original events/rows, durable proofs/cursors, OS
   public key identity across restart, process IDs, cleanup and exact gate results.
10. Security: ADB-mediated loopback is not LAN attestation. No firewall/production
    permission changes or production VerifiedSession; N1/N7/G3/G4 remain blocked.


### R3 release scope and review boundary

The product contract is still knowledge-v1-full. R3 does not approve a create-only
release. Integration priority is existing native D3/D4/snapshot adapters over the
same authenticated transport after N1/N7 approval, with pending/unsupported
history retaining attention status. No alternative importer or automatic scheduler.

| Required operation | Current classification / remaining proof |
| --- | --- |
| Native Project/Capture creation, exact originals and projected rows | Implemented; R3 independent-process qualification described in readiness §28. |
| Project/Capture modification, moves, historical state | Existing D4/import/reconstruction candidates and store tests; not independently cross-platform TLS-qualified. Release-critical for full scope. |
| Knowledge objects, immutable revisions, evidence/provenance | Existing D3/typed G3 candidates and store tests; not integrated in R3 external-process exchange. Release-critical. |
| Reviews and approved decisions, claims/identity/relations | Existing conservative D4 policies/store tests; policy coverage and full authenticated integration remain incomplete for release. No imported review execution. |
| Conflicts and alternative branches | Existing durable retention and attention paths; full cross-device conflict/history integration and acceptance remain. Never report unsupported history as clean. |
| Snapshot/bootstrap and historical reconstruction | Existing bounded capture/retain/publish/reconstruction candidates and tests; not cross-device release-qualified or physically admitted. |
| Discovery, background sync, dashboards, multi-peer scheduling | Optional and safely deferrable for the intended manual one-pair release. |

Committed signed revocation now signals only matching (network, peer) permits in
the existing owner's Pool after SQLite COMMIT and after releasing its mutex.
The store holds only a Weak reference, bound once by NativeRuntime; it neither
owns another connection nor creates a transport registry. Cancellation flags are
set under the Pool mutex, with executor wakes outside both mutexes. Transactional
membership authorization still orders imports and revocation on the one SQLite
owner. A rolled-back update sends no notification. A post-COMMIT notification
error is an error, not a rollback claim. New authorization still rereads the
signed registry, so cancellation is not the source of durable trust.

OS investigation (2026-10-25): Windows already uses IP Helper GetBestRoute2,
interface consistency and NLM category observations, with generation invalidation.
[GetBestRoute2](https://learn.microsoft.com/en-us/windows/win32/api/netioapi/nf-netioapi-getbestroute2)
returns best-route/source information; this is not an attestation of a particular
connected socket. The only sealed connected constructor still inspects loopback
and require_native_lan returns N7PolicyPending. On Android,
[Network.bindSocket(FileDescriptor)](https://developer.android.com/reference/android/net/Network#bindSocket(java.io.FileDescriptor))
supports binding an unconnected socket to a selected Network. The smallest next
route seam is to bind the existing native socket before connect, then check its
connected addresses against fresh LinkProperties/Network identity and callback
fence. ADB reverse traverses loopback and cannot supply that proof. No speculative
binding/attestation API is added; source_selected stays false on Android.
ACCESS_NETWORK_STATE remains confined to the existing standalone debug project;
production permission changes and API37/physical Wi-Fi behavior are unverified.

N1 reviewer packet: this diff plus Cargo.lock and the existing
m05-n1-external-review.md; security/pake_qualification.rs,
composition.rs, tls.rs/tls_lab.rs/tls_socket_lab.rs, storage/tls_identity.rs,
security/windows.rs and Android Keystore/JNI sources; enrollment_store.rs,
registry_verification.rs, security/enrollment.rs and enrollment attempt/approval
stores. Review exact pin/CertificateVerify/exporter/context ordering, durable
attempt accounting and human confirmation, registry/import COMMIT ordering,
OS key loss/substitution, cancellation races and default/release isolation.
Synthetic membership in these tests is not reviewed enrollment and cannot mint
a production VerifiedSession. Interoperability evidence is in readiness §28.

Current authoritative dependency check: opaque-ke 4.0.1 → elliptic-curve 0.13.8
(and voprf 0.5.0 → elliptic-curve 0.13.8) → crypto-bigint 0.5.5, confirmed on
Windows dev and Android feature graphs. Argon2 0.5.3, rustls 0.23.46/ring 0.17.14.
[RustSec RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html)
requires crypto-bigint >=0.7.6. The
[current OPAQUE upstream manifest](https://raw.githubusercontent.com/facebook/opaque-ke/main/Cargo.toml)
(4.1.0-pre.2) still selects elliptic-curve 0.13/voprf 0.5, and
[elliptic-curve 0.13.8](https://raw.githubusercontent.com/RustCrypto/traits/elliptic-curve-v0.13.8/elliptic-curve/Cargo.toml)
requires crypto-bigint 0.5. No supported drop-in fixed chain was identified;
forcing 0.7 or changing PAKE is not remediation. Selected ristretto255 path
analysis does not constitute independent approval or erase the locked advisory.
The old NCC audit cited by upstream covers older releases, not this composition.
Reviewers must decide affected selected operations/compiler/targets, supported
upstream remediation and acceptance of exact current code; N1 remains blocked.

The current check also identified
[RUSTSEC-2026-0386](https://rustsec.org/advisories/RUSTSEC-2026-0386.html)
in Tokio 1.53.2. R3 updates only the locked Tokio package to supported 1.53.3,
which RustSec lists as fixed; no protocol or cryptographic-suite change.
[RUSTSEC-2026-0384](https://rustsec.org/advisories/RUSTSEC-2026-0384.html)
affects 1.54.0, not this version. This is a targeted advisory check, not a clean
all-dependency security audit. Production gates remain closed pending independent
N1/N2/N3/N7 and G3–G7 decisions.


## R4 plan — native socket evidence and revocation outcome

1. Truth: OS Network/IP Helper/NLM and actual owned socket endpoints; signed
   SQLite registry remains authoritative for membership.
2. Ownership: existing NativeRuntime/store/Coordinator/Pool, with one owned
   TcpSocket → TcpStream. No Java socket owner or second SQLite connection.
3. Direction: debug native I/O consumes existing platform observations/fences;
   durable registry reports commit outcome separately from transport notification.
4. Contracts: a small typed ApplyOutcome, existing Observation/ConnectedEndpoints,
   owned OS socket handles and public numeric endpoint configuration only.
5. Failure: bind/connect/freshness/profile contradictions refuse, native callbacks
   invalidate the same permits; committed revocation cannot become a transaction
   failure because notification failed. Poisoned transport shuts down.
6. Lifecycle: explicitly start existing monitor, create/bind/connect bounded
   socket, revalidate before TLS authorization, abort/drop all handles on failure.
7. Tests: real poisoned Pool for post-COMMIT RED regression; existing route/event
   fixtures, real OS interface binding probes and R3 external-process regression.
8. Compatibility: preserve v9/default closed factories, frozen SQL/wire/codec;
   native-LAN factories remain test/explicit debug-only, production permissions stay.
9. Evidence: distinguish binding mechanism, eligible connected route, TLS/import,
   actual physical LAN and approvals. Do not promote emulator/probe evidence.
10. Security: specific interface/address only, no wildcard or new service. Current
    host WiFi is Public; existing Tailscale is private but not an eligible physical
    interface. No profile/firewall/adapter changes or private-network approval.

Extend the existing native_io_lab and sealed connected_endpoint instead of adding
another network module. Android uses the NDK android_setsocknetwork equivalent
of Network.bindSocket on the original unconnected native FD (API23+); CM snapshots
still come from the existing JNI bridge. Before/after binding facts and actual
endpoints must agree with a live native fence. API37 permission and physical
acceptance remain unverified when the environment cannot execute them.

### R4 implemented qualification contract

The existing RawIo now has an explicit native qualification factory; existing
loopback factories retain their original checks. NativeRuntime's Coordinator
must already own a live native monitor with processed callback generation.
Admission uses its existing shared Pool/deadlines. The native socket is bound
before connect, then actual endpoints, fresh native observations and the same
fence are checked after connect and immediately before membership authorization
and session establishment. Network invalidation still cancels existing permits;
there is no additional coordinator, socket owner, timer task or protocol.

Android calls [android_setsocknetwork](https://developer.android.com/ndk/reference/group/networking)
on the original unconnected TcpSocket FD, then binds the actual selected local
address. Android documents this API23+ function as the native equivalent of
Network.bindSocket. No FD transfer to Java, process-wide network binding or new
JNI export. Source-selected evidence is attached only after these OS operations
succeed, and stays private to the owned socket. Android exposes no public NDK
socket-network readback here: successful binding, descriptor custody, fresh CM
Network/interface/source/route facts, actual endpoints and callback fence are
the evidence; they do not prove physical packet traversal by a self-interface
probe. Pre-37 INTERNET evidence is a distinct debug-only policy fact, never a
fabricated API37 broad grant. Default policy still refuses that legacy fact.

Windows sets [IP_UNICAST_IF](https://learn.microsoft.com/en-us/windows/win32/winsock/ipproto-ip-socket-options)
(network-order input, host-order readback), binds the selected IP, and rechecks
the option on the actual connected socket together with IP Helper LUID/interface,
NLM category, operational state, source, route and live generation. Listener
preflight refuses Public/unknown/VPN/virtual/contradictory evidence before bind;
accepted sockets are rechecked before entering the same RawIo/TLS path.
IP_UNICAST_IF constrains outgoing traffic; it is not packet-level proof of the
inbound arrival interface. Physical path qualification remains required.

Optional explicit runner: verify-cross-device.ps1 -Serial SERIAL
-LanAddress WINDOWS_IPV4 -AndroidAddress ANDROID_IPV4. These parameters authorize
only the disposable, pinned synthetic fixture on those specific addresses.
Android uses source port37432 by default; Windows listens on an OS-assigned port,
backlog1. LAN mode requires the standalone qualification-network debug package;
its current verified ABI is x86_64. A physical ARM64 build/installation remains
unverified. First build the feature via verify-identity.ps1, install/verify the
standalone package via verify-network.ps1, then explicitly invoke LAN mode.
ADB carries public pins/config/results/control only in LAN mode, never the TCP
data path. Without these flags the existing ADB-reverse R3 regression is retained.
No wildcard listener, host profile/firewall/route change, default permission,
production activation or full-knowledge contract change is introduced.

NetworkRegistry.apply now returns ApplyOutcome::Committed or
CommittedTransportUnavailable after successful SQLite COMMIT. Transaction errors
remain Err. Notification failure shuts down the poisoned existing Pool and never
changes durable success into a failed revocation. Neither committed outcome
instructs the caller to retry the signed update. The new regression first failed
on R3's Err(State), then passed with typed committed outcome, revoked binding,
closed Pool, durable reopen and unchanged epoch/update count on duplicate retry.

R4 also checks each endpoint's import_g3_commits keys/hashes and stored/integrated/
applied cursors against actual imported sequences; runner compares these across
that endpoint's process restart, separately from exact cross-device canonical
bytes/rows. Local original events and remote import proofs are not conflated.
See the R4 readiness snapshot for executed results and remaining physical gates.
