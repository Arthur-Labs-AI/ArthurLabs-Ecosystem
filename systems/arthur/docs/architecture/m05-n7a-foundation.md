# N7A dormant foundation plan and contracts

N7 remains pending. No native socket, resolver, permission prompt, firewall change,
TLS factory or Sync ingress is introduced. Candidate observations are not trust.

Architecture decisions before implementation:

1. Truth: future native OS adapters own interface/route/permission observations;
   existing CaptureStore alone owns reservations and their charged counters.
2. Ownership: pure candidate evaluation never writes; resource pool owns bounded
   active leases. No database handle reaches route/I/O code.
3. Direction: future platform adapters -> pure route and poll-I/O contracts.
4. Boundary: explicit IP/scope/interface/generation observations and bounded
   encrypted-stream operations; neither peer identity nor authorization inferred.
5. Failure: malformed/stale/ineligible observations refuse; even eligible candidates
   cannot activate. I/O errors, deadline/cancel/shutdown abort and release leases.
6. Lifecycle: candidate selection must be revalidated before/after connect; leases
   reserve before crypto, transition atomically, release on error/drop. Rejected
   qualification cancels only its exact reserved ticket without refund.
7. Seams: deterministic route snapshots, fake nonblocking streams, fake wakeable
   timers and monotonic ticks. No sleep-based correctness assertions.
8. Compatibility: schema9, frozen Sync/journal/codec/routes unchanged. Legacy
   blocking parser remains a test fixture only; no live transport consumes it.
9. Observation: categorical errors and local candidate status; no address/identity
   enumeration response or private logging, no provider/knowledge dependencies.
10. Security: route reachability, expected peer metadata and possession/authentication
    remain separate. Every live Windows/Android adapter returns N7PolicyPending.

Candidate limits (unapproved): 64KiB record, one in-flight frame per stream,
2 handshakes/1 session; four admissions/30 seconds per pool, one active attempt per
expected network/peer. Handshake10s, idle15s, total60s, using monotonic time.
No queued reconnect work. Limits bound hostile buffering/crypto admission;
throughput, fairness, jitter, actual TLS memory and large bootstrap suitability
need owner/security measurement. The 64KiB record is a transport candidate, not a
change to negotiated Sync message/bundle limits.

Future platform adapters must bind observations to actual socket local/remote
addresses and OS network generation, revalidate before private disclosure and
abort on permission/route changes. Windows interface/IP Helper/route selection,
private-profile executable-scoped firewall policy and inbound port are blocked
pending N7. Android remains dialer, Desktop listener; no Android listener fallback.
On target SDK37 Android17 direct broad LAN requires ACCESS_LOCAL_NETWORK or a
system-mediated NSD picker grant for specific endpoints. Neither is implemented;
denial/revocation must abort work, not cause internet/VPN fallback. API36 emulator
tests cannot certify API37 permission enforcement. No manifest/target SDK change.

References: [Android local network permission](https://developer.android.com/privacy-and-security/local-network-permission),
[NsdManager](https://developer.android.com/reference/android/net/nsd/NsdManager).
Future native NSD results are bounded, expiring hints, not peer IDs. A picker grant
must match exact endpoint and network generation. Manual numeric addresses still
need direct-route and permission checks; DNS is parsed only as an untrusted hint
and refused with N7PolicyPending until resolver/rebinding policy is approved.
DHCP/roaming/interface loss invalidate candidates; IPv6 link-local requires a
nonzero numeric scope matching selected interface. No all-interface bind, UPnP,
router mapping, public fallback, raw multicast, or automatic firewall exception.

## Actual candidate behavior

`route_candidate.rs` separates manual/discovery Hint from numeric SocketAddr/DNS
name and from future native Observation. Parse is bounded to 128 ASCII bytes,
canonical decimal nonzero port (no leading zero), numeric IPv6 scope only; no
URLs, userinfo, paths, queries, fragments, whitespace or wildcard/multicast/
broadcast/loopback/IPv4-mapped IPv6 endpoints. DNS grammar is validated but DNS
evaluation always returns N7PolicyPending. No resolver or hostname is passed to
a socket, so this slice has no DNS rebinding path.

Conservative evaluation requires fresh (<=3s, now not before snapshot) generation,
nonzero selected interface matching native route interface, link Up, Wi-Fi or
Ethernet, direct next hop, matching address family/subnet/destination route and
exact endpoint. It excludes VPN/cellular/loopback/unknown, gateway/default/public
routes, IPv4 subnet network/broadcast endpoints and /31-/32 (pending decision).
IPv4 RFC1918 and IPv6 ULA/scoped link-local are candidates only with these route
observations. Public IPv6 on-link support and IPv4 link-local remain excluded
pending explicit policy. This intentionally favors refusal over broad reachability.
Link-local IPv6 scope must match the interface. Revalidation permits a fresh
timestamp for the identical generation/path; generation, route, endpoint,
permission or interface changes invalidate it. A post-connect observation must
also match actual local IP/remote SocketAddr. Multi-homed selection is explicit,
never whichever interface a caller declares trustworthy. Native observation
acquisition is NOT implemented; arbitrary fake snapshots prove no OS fact.
Candidate.activate and both live observation stubs refuse with N7PolicyPending.

`transport_candidate.rs` replaces the old production-visible blocking seam with
a nonblocking poll contract. The old read_exact/parser and simple ResourcePool/
Lease remain cfg(test) regression fixtures only. Candidate Pool serializes
2 handshake / 1 session admission and single-flight expected network+peer;
expected IDs are metadata, never authenticated membership. A four-entry rolling
30s admission history limits retries globally even when keys change; release,
failure or cancellation never refunds that history. No queue or per-attacker
map grows. Restart resets this process-local availability throttle, unlike the
separate durable enrollment attempt ledger. Owner must decide production retry
fairness/backoff/jitter and whether additional persistence is required.
The future native coordinator must own ONE pool for all its network attempts;
no pool is installed into NativeRuntime by this dormant slice. Multiple manually
constructed pools are not a demonstrated process-wide bound.

Handshake is a budget/lifecycle model owning I/O and permit, not a TLS engine or
authentication result. It registers a 10s deadline wake, aborts and releases on
timeout/cancellation, and cannot turn finish into production trust. Framed owns
one admitted session, a fixed 8-byte header and one bounded frame. Header is
validated before payload allocation; EOF, wrong magic, zero/oversize length,
I/O error or invalid byte count aborts the stream. Partial ready operations yield
after one read/write per poll. There is no application-level ACK or import.

Framed allocation is at most one 64KiB receive body OR 64KiB+8 output frame;
send construction can temporarily also own the <=64KiB input Vec, whose capacity
is checked. Returned payloads become the consumer's responsibility: no claim of
a global consumer-memory bound. Underlying TLS/OS/Argon2 memory remains outside
this bound and needs adapter limits/measurement before N7. Handshake budget does
not yet account for actual TLS handshake bytes because no TLS adapter is wired.
Existing TLS memory lab bounds are separate evidence, not production allocation
certification. These limitations keep live transport BLOCKED.

Cancellation registers a waker under a mutex with an atomic cancellation flag,
avoiding lost cancellation registration. Pool shutdown closes admission and
wakes active handles. A pending read/write is aborted on its next awakened poll;
drop aborts owned I/O and releases the permit. This proves the fake nonblocking
contract, not prompt cancellation of kernel I/O. A future implementation must
register I/O readiness, use a monotonic timer with one coalesced registration per
stream, remove completed timer callbacks and implement synchronous abort/Drop
that closes its own socket. Blocking std::io::Read/Write wrappers are excluded.
Deadlines are handshake10s, idle15s per COMPLETE frame (partial slow-drip bytes
do not refresh it), total60s from original admission including handshake. Clock
regression refuses. Neither reconnect nor completing a frame extends total time.

## Review and owner decisions still required

- Exact interface allowlist, Windows profile/route acquisition and binding,
  selected listening port, executable-scoped firewall rules and user consent.
- IPv4 link-local, public on-link IPv6, /31-/32, multi-homed and VPN coexistence
  policy; numeric scope mapping and network-generation invalidation strategy.
- Broad Android permission versus system picker grants, denial/revocation UX,
  NSD lifetime/fallback and supported foreground/background behavior.
- Approved frame/message/handshake-byte and memory limits, deadlines, concurrency,
  retry fairness/backoff/jitter and compatibility with large bootstrap workloads.
- Actual nonblocking encrypted adapter, timer/abort/route-change integration and
  hostile real-network evidence before any listener/dialer is exposed.

N1 remains blocked independently. No E3B, enrollment activation, production
VerifiedSession or frontend networking/signing surface is introduced. Schema9,
ClosedTrust, G4 UnverifiedBounds and frozen writer/journal/codec/reducer/snapshot2/
D4 boundaries are unchanged. Tests and counts are recorded in readiness section21.

## E3A3 qualification rejection follow-up

The regression first reproduced reserved state/code retention after a rejected
proof. `record_qualification` now always erases its Challenge code. On rejection
it cancels only the submitted exact enrollment+boot+ticket still in reserved
state, in the existing owner transaction. A stale submitted ticket does not
cancel the later active ticket. No counter is decremented. Expired rows retain
expired state, consumed/approval rows cannot be cancelled by this cleanup.
The strengthened regression rejects both stale-ticket and old-proof/new-ticket
submissions, verifies terminal cancellation/no remaining reservation/no grant,
then restarts and verifies the charged counter remains two and issuance works.
If SQLite cannot commit cleanup it returns Storage, without refund or false
success; memory code is already erased and recovery requires the existing
cancel/startup path once storage works. This is not a promise to write during
disk failure. The original E3A3 external-review packet remains a historical
revision snapshot; this follow-up changes owner cleanup only, not cryptography.
