# N7D native I/O and connected-endpoint qualification

Pre-implementation review, 2026-10-25. Accepted N7C: d8ecd0f3cbe820b5e022c4d973eeb49775628a68.

1. **Truth:** owned kernel sockets provide local/peer addresses and readiness; the existing Pool owns attempts/session limits, and the coordinator owns route generations/fences. A Tokio monotonic epoch supplies elapsed time. OS endpoint addresses do not establish interface, LAN permission or authentication.
2. **Ownership:** one lab attempt owns one socket, one existing-Pool Permit and at most one timer registration. External cancellation signals the permit; the next poll closes the socket before returning cancellation. Explicit abort/Drop close synchronously. No second SQLite owner or persistent data is introduced.
3. **Direction:** isolated native I/O -> existing permit/fence/timer contracts. Raw sockets never implement EncryptedIo. Existing TLS memory lab and ClosedTrust/ClosedLan retain their boundaries; no TLS-over-socket claim is planned.
4. **Boundary:** only test/debug instrumentation can create the loopback lab. Listener/dial targets are hardcoded loopback and ephemeral, with no arbitrary endpoint/DNS constructor. Native endpoint evidence is sealed, classified loopback-only/interface-unverified, and cannot authorize a LAN candidate. Caller-declared address fixtures must be explicitly test-only.
5. **Failures:** Truncated framed EOF, reset, invalid/oversized lab data, cancellation, stale fences and monotonic deadlines terminate/close the attempt; no cached route fallback or budget refund. Native interface/route attestation remains Pending, rather than inferred from socket addresses.
6. **Lifecycle:** reuse the existing Tauri/Tokio runtime and reactor. Nonblocking AsyncRead/AsyncWrite polling is bounded per call. Tokio Sleep registrations are owned RAII values, not detached tasks. Runtime/permit shutdown and event invalidation wake pending I/O; cleanup occurs outside owner/pool locks.
7. **Seams:** actual Windows/Android loopback sockets and real monotonic timers are separate from fake transport tests. A disposable synthetic NLAB envelope tests fragmented bytes/length limits without plaintext Sync framing. Controlled timers, channels/readiness and bounded watchdogs replace arbitrary sleeps. Native handle/peer closure and waker/timer cleanup require executed evidence.
8. **Compatibility:** schema9, journal/codec/reducer/snapshot2/D4 and production permissions remain unchanged. Only existing Tokio dependency features needed by the isolated lab are selected. No crypto version, PAKE replacement, listener/service, startup networking or frontend command. TTS ordering is a separately reproduced narrow fix with test-only observation, not a speech architecture refactor.
9. **Observability:** typed errors, bounded test counters and local gate logs distinguish pending/cancelled/expired/closed. Never log knowledge, credentials, socket payloads or user network names. Actual kernel evidence and deterministic fault injection are labeled separately.
10. **Security:** raw I/O -> encrypted authentication -> authorized Sync remains three separate boundaries. No raw socket can become EncryptedIo or VerifiedSession. Interface selection, connected route/profile/permission binding, independent N1 audit and N7 policy remain blocked. G4 UnverifiedBounds and all activation approvals stay unchanged; no E3B.

## Implementation plan and acceptance

- Characterize TTS focus-loss Idle/file cleanup with a deterministic publication probe, record RED, then ensure the local file/player hold are released before natural terminal status publication. Preserve existing assertions and manual-stop semantics.
- Add an explicitly cfg-gated native I/O laboratory using the existing Tokio runtime, bounded socket operations and real Sleep-backed Timer/TimerRegistration. No production networking constructor or EncryptedIo implementation.
- Seal socket endpoint evidence and retire caller-declared connected-address checks to a named qualification seam. Native LAN interface attestation stays unverified; loopback never passes route activation.
- Execute real fragmented/truncated/reset/backpressure/cancel/deadline/Drop/shutdown cases, existing Pool limits and simulated event-fence races with actual sockets. Inspect N7C callback/JNI ownership and add controlled fault coverage where safe, without changing host network settings.
- Run focused and broad gates sequentially, including Android dedicated instrumentation, default builds, APK/JNI/manifest/dependency isolation and release guards. Record historical failures, newly observed flakes and test-development failures separately in readiness section24. Commit/push only reviewed work on the existing feature branch.

Real I/O qualification is not encrypted TLS I/O, physical Windows↔Android LAN, route approval or production activation.

## Implemented contracts

`native_io_lab.rs` is compiled only by Rust tests or the explicit Android
`android-identity-tests` feature; non-debug Android compilation is rejected.
The module exposes no arbitrary bind/dial constructor. `pair` creates two IPv4
sockets at 127.0.0.1 and port 0, accepts one peer, and drops its ephemeral listener
before returning. No startup calls it. The lab uses Tauri's existing Tokio runtime,
reactor-backed TcpStream polling and pinned Sleep registrations; it spawns no I/O
or timer tasks. RawIo is deliberately not EncryptedIo.

Each poll moves at most 4096 bytes. The disposable NLAB header is eight bytes;
its payload must be 1..65536 bytes and only one frame is allocated at a time.
AE01 is rejected. A pending operation owns one timer registration and the
existing permit's replaceable waker. Ready operations clear those registrations;
errors, expiry, cancellation, abort and Drop release the socket and permit.
Write-half shutdown permits normal TCP half-close; abort is idempotent full
resource release. Actual peer EOF is checked after cancellation and Drop.
The Windows resource test additionally probes the retired SOCKET using
getsockopt/WSAENOTSOCK; Android uses fcntl(F_GETFD)/EBADF. These inspect the actual
handle immediately after Drop, before a replacement socket is created.

Deadlines share the permit's monotonic admission epoch: 10 seconds before the
budget-only session transition, min(last complete lab frame +15, admission +60)
afterwards. Partial headers/payloads do not refresh idle. Registration Drop drops
the reactor Sleep directly; there is no detached timer job. Existing Pool limits
(two concurrent handshakes, one session, four admissions per 30 seconds) remain
unchanged and cancellation/failure never refunds admission history.

ConnectedEndpoints has private fields and no production constructor. The sole
lab inspector reads local_addr/peer_addr from a live socket and records revocable
owner liveness. Endpoint and selected source mismatches fail. Loopback evidence
always returns N7PolicyPending for native LAN/interface qualification. The old
caller-address helper is now explicitly named connected_fixture and compiled only
for qualification. Coordinator::verify_connected requires native provenance,
current owner/revision/registration fence, cancellation/shutdown checks, a fresh
native acquisition outside locks, the original candidate/source/route/profile
comparison, and a final fence/generation check. It creates no permit and does not
convert endpoint addresses into interface evidence. There is currently no
successful native-LAN connected attestation path.

The runtime socket tests combine real loopback I/O with **simulated** route
facts/events. They prove owner-generation/event/shutdown cancellation closes
pending sockets, not that Windows or Android changed a real LAN route. Existing
fresh-acquisition/admission race tests remain separate. Native monitor tests use
actual Windows IP Helper and NLM subscriptions with controlled epoch overflow and
reentrant worker shutdown; a test-only destruction signal waits for all worker,
callback-context and COM-sink references to disappear. They never change network
adapters, profiles, VPNs or firewall rules.

## Security and lifecycle review

Self-review covers the changed data flow and N7C Windows callback context,
CancelMibChangeNotify2 ordering, NLM Unadvise, Android opaque-token registry,
NetworkCallback teardown, JNI partial-registration cleanup and quarantine.
Windows keeps the callback context until successful cancellations; failure
quarantines further registrations and deliberately retains the context. Android
revokes its token before Java teardown; late callbacks cannot regain eligibility.
Both close fences before native teardown and dispatch outside owner locks.
The controlled new tests do not inject native unregister/JNI allocation failure
or prove those platform failure paths; those remain unverified. No independent
N1 security audit is claimed.

The concrete reproduced defect is TTS terminal publication before local
TempAudio/PlayerHold destruction on focus loss or playback-start failure.
A test-only synchronous publication probe records the directory's file count
at finish, rather than waiting for eventual cleanup. RED: one file remained.
The narrow fix explicitly drops the current audio and player hold before the
terminal status. The regression covers focus-loss cancellation and both player
start failures. Existing success, manual user stop and generation semantics are
preserved; this does not claim manual-stop acknowledgement awaits background
cleanup or that filesystem deletion failure is now recoverable.

Raw I/O only was exercised over sockets. Native mutual TLS remains the existing
memory laboratory; no encrypted TLS-over-socket, authenticated Sync, PAKE
approval or physical Windows/Android LAN result is implied. Schema9, frozen
journal/codec/reducer/snapshot2/D4, ClosedTrust, ClosedLan, M05 dormant and G4
UnverifiedBounds remain the production contract. Rollback is removal of this
qualification module and restoration of the dormant connected-check seam;
there is no data migration or persisted socket state.

## Changed files

| Repository-relative file | Purpose |
| --- | --- |
| `apps/arthur/src-tauri/Cargo.toml` | Explicit laboratory Tokio features; existing runtime |
| `apps/arthur/src-tauri/src/sync/security/native_io_lab.rs` | Raw socket, timer and actual-I/O qualification |
| `apps/arthur/src-tauri/src/sync/security/connected_endpoint.rs` | Sealed, revocable socket-address evidence |
| `apps/arthur/src-tauri/src/sync/security/mod.rs` | Compile-time laboratory isolation |
| `apps/arthur/src-tauri/src/sync/security/route_candidate.rs` | Typed connected check; fixture-only address seam |
| `apps/arthur/src-tauri/src/sync/security/transport_candidate.rs` | Reuse existing permit cancellation/waker/epoch |
| `apps/arthur/src-tauri/src/sync/security/n7a_tests.rs` | Explicit fixture helper calls |
| `apps/arthur/src-tauri/src/sync/security/network_watch.rs` | Actual monitor overflow/reentrancy regression cases |
| `apps/arthur/src-tauri/src/runtime/lan_candidate.rs` | Connected freshness gate and owner/actual-socket tests |
| `apps/arthur/src-tauri/src/storage/security_android_instrumentation.rs` | Existing JNI harness scenarios 35/36 |
| `apps/arthur/src-tauri/gen/android/app/src/androidTest/java/dev/kaloyan/arthur/security/NativeIdentityBridgeTest.java` | Two explicitly invoked Android laboratory cases |
| `apps/arthur/src-tauri/src/tts/service.rs` | Reproduced terminal cleanup ordering fix and regression |
| `docs/architecture/m05-n7d-native-io.md` | Plan, contracts, review and file inventory |
| `docs/architecture/m05-activation-readiness.md` | Section24 executed evidence and remaining blockers |

## Android stack regression (N7D development)

The first actual Android run built successfully but did not complete all 42
cases: XML records 35 PASS and one crashed laboratory case; six cases did not
complete. `n7d_actual_loopback_io_endpoints_and_cleanup` crashed with SIGSEGV.
The retained debuggerd dump explicitly reports "stack pointer is not in a rw
map; likely due to stack overflow" and resolves the top frame to Tokio
Runtime::block_on of the native backpressure future. This is a new N7D lab
implementation defect, not one of the accepted historical failures or a flake.

Root cause: a 65536-byte inline array inflated the async future and its debug
copies through Tauri/Tokio wrappers on the Android JNI instrumentation thread.
The fix uses a length-bounded 64KiB Vec and pins the future on the heap before
passing it through runtime wrappers. The permanent execute guard limits future
size to 32KiB, so future inline-buffer growth fails qualification. No thread
stack setting, test expectation or production security gate is relaxed.
The actual Android crash is the RED evidence; host-focused and complete Android
rerun results are recorded in readiness section24. Logcat and the failed XML are
retained as `%TEMP%/arthur-n7d-android-crash-logcat.log` and
`%TEMP%/arthur-n7d-android-red.xml`.
