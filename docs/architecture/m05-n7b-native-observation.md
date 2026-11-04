# N7B native observations and dormant coordination

Pre-implementation architecture review (2026-10-24, baseline f34a181):

1. Source of truth: OS APIs own ephemeral interface/route facts. CaptureStore remains the sole durable enrollment owner. NativeRuntime owns the candidate generation and admission pool.
2. Ownership: only runtime construction creates a production coordinator/pool. Read-only adapters produce snapshots; they cannot authorize connections. Test constructors are debug qualification only.
3. Direction: runtime coordinates security candidate types and platform adapters; adapters never import storage, knowledge, providers or UI. No new service.
4. Boundaries: numeric endpoint, bounded OS snapshot, explicit network identity/status and observation ticket. No DNS lookup, socket, private key, SQLite handle or frontend entrypoint crosses this boundary.
5. Failure: absent permission/profile/route, ambiguity, API failure, changed snapshot or stale completion refuses. A refresh invalidates existing work before OS reads; no cached eligibility fallback.
6. Lifecycle: passive runtime creation; explicit observation request; generation-bound admission; refresh/invalidate cancels active candidates without refund; shutdown is terminal and runtime Drop shuts down. No background callback or task starts automatically.
7. Seams: deterministic fake snapshots/clock/I/O remain separate from actual Windows acquisition and Android permission observations. Timer registrations require explicit RAII cleanup and executor callbacks run outside owner locks.
8. Compatibility: no schema, migration, crypto, permission, SDK, Sync, journal or D4 changes. Existing test-only constructors remain available. Rollback is code-only; no persisted N7 state.
9. Observability: typed refusal categories and native-only snapshots, no secret/address logging or network status IPC. Evidence distinguishes OS reads from fake transitions.
10. Security: observation is not membership or activation. Windows private-profile authority and Android broad/picker authorization cannot be inferred from transport availability. ClosedLan, N1 and N7 gates stay closed.

Implementation plan: add platform observation module and runtime coordinator; harden transport timer/waker lifecycle; reproduce and repair exact-ticket Challenge cleanup in the debug qualification seam; add deterministic and OS tests; execute all requested local gates; record limitations in readiness section22; commit/push existing feature branch.

## Implemented contract

`NativeRuntime` constructs exactly one dormant `Coordinator` with its existing
CaptureStore owner. Runtime acquisition reuses the same Arc and coordinator.
The pool has no production Default constructor; its constructor requires the
unforgeable runtime construction token. The token is a deliberately narrow
compile-time dependency on the composition owner, with no store/SQL/runtime
operations available to the lower transport module. Test-only Default remains
inside unit/debug instrumentation configurations. No additional SQLite owner,
service, worker, listener, resolver, discovery or TLS task starts at initialization.

`begin(hint)` removes the current selection, increments its checked revision and
atomically cancels every existing permit before the OS call. It returns a
consumed observation ticket bound to this coordinator's private Arc identity,
endpoint and monotonic start timestamp. `complete` rejects foreign/stale tickets,
then stamps generation/time and evaluates N7A policy. Refresh is deliberately
conservative: even an identical snapshot gets a new revision. Failed reads do
not retain prior eligibility. An old Selection cannot admit work after a newer
begin/complete, shutdown or runtime replacement. Actual adapter snapshots have
zero generation/time until this owner stamps them; they cannot be evaluated as
fresh candidate capabilities directly. DNS never calls the OS adapter/resolver.

Admissions hold coordinator state while reserving from its one pool. Caller
cancellation is the permit's same Interrupt, checked under the admission lock;
pre-cancelled requests consume no admission. An admission linearized before
cancellation stays charged. Route invalidation cancels rather than refunds it.
Pool flags are set under its lock; executor wake/destructor callbacks happen
outside coordinator/pool/Interrupt locks. Establishment and Framed construction
check closed/cancelled state. Shutdown is terminal/idempotent and both explicit
NativeRuntime teardown and Coordinator Drop close the pool. Poisoned shutdown
still cancels known permits and reports State; generation overflow invalidates
and closes rather than wrapping. Reacquiring a still-live runtime does not reset
limits; a replacement runtime after final Drop starts a fresh process-local
availability budget, with a different coordinator identity. Durable enrollment
budgets are separate and are never reset by this pool.

Candidate limits remain two handshakes, one established candidate, four admissions
per rolling30s, one active expected network/peer; frame64KiB, handshake10s,
complete-frame idle15s and admission-total60s. Permit release does not refund
history. Timer::poll_until now returns an owned registration. Handshake/Framed
retain at most one and release it on replacement, finish, complete frame, error
and Drop. Its RAII contract requires unregistering that exact wake. There is
**no native Timer or EncryptedIo implementation**: fake timer/I/O tests establish
only the seam, not executor wake precision or kernel abort behavior. Synchronous
nonblocking close/abort remains a blocker for any future socket adapter.

## Windows read-only adapter

`route_windows.rs` uses locked windows-sys0.61.2 layouts, with a bounded aligned
15KiB GetAdaptersAddresses allocation (up to three retries /1MiB maximum).
Pointers, record lengths, address sizes and linked-list traversal counts are
checked before dereferencing. GetBestRoute2 supplies selected source, destination
prefix, next hop, interface index and LUID. The selected source must occur exactly
once among that adapter's preferred unicast addresses; its on-link prefix and
adapter operational status are observed, not supplied by a caller.

GetIfEntry2 cross-checks index/LUID, operational status, IfType, hardware/filter/
media flags and physical medium. Wi-Fi/Ethernet classification is a conservative
mapping of those OS fields; unknown/virtual/filter/inconsistent interfaces remain
Unknown. This is an inferred medium classification from observed metadata, never
proof of membership, firewall reachability or a physically isolated LAN.

ConvertInterfaceLuidToGuid and NLM INetworkConnection::GetAdapterId map exactly one
connected NLM entry to the selected adapter. INetwork::GetCategory supplies
Private/Public/Domain category. COM initialization is balanced only when owned by
this invocation; preexisting apartments are borrowed, no COM object escapes.
Absent/failed/ambiguous metadata yields Unknown, never an assumed Private profile.
Profile, interface metadata and best route are read again and differences refuse.
These are sequential read-only snapshots, **not an atomic OS transaction**; an
unobserved ABA change is not ruled out. Profiles never imply that a port is open.
No firewall API or network configuration write is made.

Primary API references (checked 2026-10-24):
[GetBestRoute2](https://learn.microsoft.com/en-us/windows/win32/api/netioapi/nf-netioapi-getbestroute2),
[GetAdaptersAddresses](https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getadaptersaddresses),
[GetIfEntry2](https://learn.microsoft.com/en-us/windows/win32/api/netioapi/nf-netioapi-getifentry2),
[MIB_IF_ROW2](https://learn.microsoft.com/en-us/windows/win32/api/netioapi/ns-netioapi-mib_if_row2),
[ConvertInterfaceLuidToGuid](https://learn.microsoft.com/en-us/windows/win32/api/netioapi/nf-netioapi-convertinterfaceluidtoguid),
[GetAdapterId](https://learn.microsoft.com/en-us/windows/win32/api/netlistmgr/nf-netlistmgr-inetworkconnection-getadapterid),
[GetCategory](https://learn.microsoft.com/en-us/windows/win32/api/netlistmgr/nf-netlistmgr-inetwork-getcategory).

## Android read-only adapter and permission blocker

`RouteObservation.java` is called only through the existing NativeIdentityBridge,
JavaVM/Application/class global references, per-call attached thread/local frame
and sanitized exception boundary. Numeric address bytes use getByAddress; no DNS
or React/WebView/Activity API is added. Permission state is read before consulting
ConnectivityManager. Missing ACCESS_NETWORK_STATE returns MissingPermission;
SecurityException/revocation, no Network, changed/stale Network or missing facts
return distinct refusal categories. Existing manifest/SDK are unchanged.

The guarded acquisition path obtains active Network identity, NetworkCapabilities
and LinkProperties, routes, interface index/up state, local prefixes and numeric
IPv6 scope. VPN/cellular take priority over Wi-Fi/Ethernet classification;
mixed/unknown media, equal best routes or multiple possible sources refuse.
Route type must be unicast (unsupported older API returns pending). It rereads
active Network/capabilities/link properties and permission before returning.
A LinkProperties local address is **not OS-selected source evidence**: Android
snapshots set source_selected=false, so candidate evaluation stays pending even
if broad permission were observed. No connection is made to resolve this fact.

ACCESS_LOCAL_NETWORK is checked separately on API37+; no NSD picker grant is
invented from broad permission, INTERNET or Wi-Fi availability. Picker acquisition
and its selected endpoint/network binding remain unimplemented. API36 execution
cannot certify Android17/API37 permission enforcement.

Primary references:
[ConnectivityManager](https://developer.android.com/reference/android/net/ConnectivityManager),
[network state / Network lifetime](https://developer.android.com/develop/connectivity/network-ops/reading-network-state),
[NetworkCapabilities](https://developer.android.com/reference/android/net/NetworkCapabilities),
[LinkProperties](https://developer.android.com/reference/android/net/LinkProperties),
[local network permission and picker alternatives](https://developer.android.com/privacy-and-security/local-network-permission).

## Invalidation limits and remaining decisions

This phase implements explicit snapshot refresh/invalidation, not continuous OS
subscriptions. No Android NetworkCallback or Windows NotifyRouteChange2 watcher is
registered automatically (or manually) here. Missing Android permission blocks
actual link/capability acquisition. OS disconnect/reconnect, DHCP, VPN and roaming
notification delivery are **UNVERIFIED**; only synthetic reordered/loss events
exercise coordinator ordering. A future reviewed event source must invalidate
through this owner before any work, pair callbacks with owner-issued tickets and
perform fresh acquisition before connection and again before private disclosure.
The current <=3s snapshot freshness is not continuous route monitoring. Actual
socket source/remote binding, multi-homed connection routing, native nonblocking
abort/timer cleanup, physical Ethernet/Wi-Fi/VPN transitions and API37 denial/
revocation require real platform qualification before any activation.

No N7 limit/interface/profile/permission/NSD/firewall/port policy is approved here.
N1 remains blocked by external PAKE/audit/dependency decisions; no OPAQUE/SPAKE2
replacement, E3B, live enrollment, VerifiedSession or LAN composition is added.
N1/N2/N3/N7 and G4-G7 remain unapproved. Schema9, ClosedTrust, M05 dormancy,
G4 UnverifiedBounds and frozen journal/codec/reducer/snapshot2/D4 remain unchanged.

## Exact-ticket qualification follow-up

The added regression first failed on N7A: rejecting a stale ticket erased the
shared Challenge code while its newer durable reservation remained reserved.
The debug-only qualification owner now erases only on success or terminal
same-challenge cleanup. Its existing transaction cancels only the submitted
exact enrollment+boot+ticket; when it changed no row, it preserves memory only
if that same original challenge remains issued/reserved in the current boot.
An unrelated challenge is untouched. Expired/startup/terminal rows erase stale
memory; storage failure erases and returns failure, requiring existing recovery.
The regression builds a fresh actual TLS/OPAQUE proof after stale rejection,
reaches the debug approval state with the newer ticket, then verifies startup
recovery and unchanged charged attempts. No human approval/grant is performed.
Original E3A3 old-proof/new-ticket rejection and N7A terminal cleanup still run.

Additional limits: IP Helper and NLM acquisition calls are synchronous OS reads.
The post-acquisition freshness check refuses a slow snapshot; it does not abort an
in-flight OS/COM call. Acquisition latency/cancellation is UNVERIFIED and must be
hosted on an approved native worker before a future interactive entrypoint. This
is separate from the stricter nonblocking EncryptedIo contract; no OS read here
is represented as socket-cancellation evidence.

Timestamp precision is currently the existing integer-second candidate clock:
`Instant::elapsed().as_secs()`, not a measured subsecond freshness bound. The
three-tick age check is not a certified hard three-second wall-time limit.
Production precision/latency and event-driven invalidation remain N7 decisions;
no connection or disclosure may rely on this snapshot cache alone.
