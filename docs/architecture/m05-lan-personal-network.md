# M05 Phase 0 — LAN Personal Arthur Network

**ARCHITECTURE APPROVED — implementation/security evidence gates remain**

Audit date: 2026-10-21 (Europe/Sofia). Companion: [Logical Sync Contract v1](m05-sync-contract.md). This is a design, not a shipped listener, pairing implementation, API, background service or security certification. The current CODEX TASK 01 narrows earlier Home Node plans to **Arthur Desktop ↔ Arthur Android on the same reachable local network**.

## 1. Verified platform starting point

Audited HEAD `e1879f6fa2e34d2e54367c301a372a6bd6b56b44`, branch `feature/nodes-integration`; fetched `origin/dev` remains `214e8a815a754609d28225c8f5e29825852db2fe`. The six branch commits are Thoughtspace UI changes. No existing Sync/Arthur Network public methods, listener, PAKE, NSD or WorkManager integration were found. See Document A for the write inventory and fresh check failures.

| Source inspected | Verified fact and consequence |
|---|---|
| `src-tauri/src/lib.rs` | Store/services are constructed inside Tauri setup. No process-wide Activity-independent Sync runtime currently exists |
| `src-tauri/src/lifecycle.rs` | Android `RunEvent::Exit` calls `_exit(0)` to avoid measured WebView teardown aborts. Async destructors/final network flushes cannot be relied on |
| `gen/android/.../MainActivity.kt` | Root Back backgrounds the task with `moveTaskToBack(true)`; that is not durable OS scheduling or permission to keep syncing indefinitely |
| `gen/android/app/build.gradle.kts` | `minSdk=24`, `compileSdk=37`, `targetSdk=37`; lifecycle-process dependency exists, WorkManager is absent |
| `gen/android/app/src/main/AndroidManifest.xml` | INTERNET and RECORD_AUDIO permissions; no LAN runtime-permission flow, Sync job/service or NSD integration; backups/device transfer disabled |
| `gen/android/.../SecretsPlugin.kt`, `providers/android_keystore.rs` | Existing Keystore bridge protects provider secrets; not yet a device signing identity API |
| `providers/secrets.rs` | Desktop uses plaintext `FileSecretStore`, not an OS keychain. Sync private keys require a separate reviewed secure-store adapter |
| `Cargo.toml`, `tauri.conf.json` | Tauri `features=[]`, no tray setup/close interception or Sync listener. `reqwest` is an outbound HTTP client, not an existing server. Tokio currently enables time/sync, not a complete listener stack |
| `src/client/{arthur-client,desktop-client,mobile-client,tauri-ipc}.ts` | Existing cross-platform seam. New UI capability must be added consistently later; no direct JS sockets or platform checks in features |

Paths in this table are under `apps/arthur/` unless stated otherwise. Proposed implementation locations are names for review, not files added in this task.

## 2. Connection architecture and transport boundary

RECOMMENDED:

```text
Desktop React                       Android React
     | ArthurClient                       | ArthurClient
     v                                    v
native commands                     native commands
     |                                    |
single Rust runtime                 same-process Rust runtime
     |                                    |          ^
LAN TLS listener <--- encrypted ---> LAN dialer       | OS-supported job
     |          bidirectional session     |          | (bounded wake only)
transport/session traits            transport/session traits
     |                                    |
pure Sync engine                    same pure Sync engine
     |                                    |
one CaptureStore owner              one CaptureStore owner
     |                                    |
local SQLite                        local SQLite
```

Desktop accepts connections; Android normally initiates them. One authenticated session carries both directions. Future macOS, another device type, or a NetBird adapter must implement the transport interface without changing operation/ACK/conflict semantics. There is no NetBird dependency, Go Sidecar, Box, Linux Home Node, VPS, VPN, NAT traversal or relay in v1.

Proposed native abstractions:

- `Discovery`: bounded candidates on a selected current LAN, cancellation and permission status. Candidates are untrusted hints.
- `AuthenticatedTransport`: listen/dial/cancel and bounded encrypted frames; returns verified network/device identity and membership epoch, never just an address.
- `SyncStore`: transaction-owned validated apply, snapshots, pending events and cursors. Transport has no DB handle.
- `Scheduler`: wake/due/cancel signals; cannot write domain data or override native settings.
- `DeviceIdentityStore`: sign/verify public identity and secure private-key operations. Key material never reaches React or replication payloads.

Only the composition root chooses concrete adapters. Root `src/sync` and engine code must not import NetBird/Tailscale/private-overlay modules or frozen hybrid tools. TS architecture tests remain unchanged; future Rust structural tests must enforce the same rule.

### 2.1 LAN reachability and listener exposure

Select current user-approved local interface(s), supporting IPv4 and scoped IPv6. Do not indiscriminately bind every interface, VPN adapter and public address. Restrict firewall rules to the executable/private local network profile and configured peer scope; no UPnP, router port mapping, public DNS endpoint, internet fallback, proxy or redirect-following. RFC1918 addressing alone is not authentication or proof of LAN locality. An explicitly entered address must resolve to an allowed on-link/local route; reject remote/public/overlay paths in v1. Reject interface changes/rebinding until the candidate is revalidated. Private-network firewall/AP isolation may still prevent connectivity.

The ordinary Sync listener only authenticates enrolled peers; it has no model, tool, shell or provider endpoints. Before authentication it returns bounded generic protocol errors, not network IDs, device lists, user names, project counts or cursors. Pairing is a separate, temporary protocol/route enabled only by an explicit enrollment action. No webview bridge is exposed over LAN; CORS is not an auth mechanism. Rate-limit TCP/TLS/PAKE handshakes, cap frames/connections/timeouts and use backpressure.

## 3. Arthur Network identity, ownership and recovery

An `Arthur Network` is one user's explicitly enrolled trust group. One installation joins at most one network in v1. Network membership is independent of Wi-Fi association, IP, hostname, device display name and provider consent.

RECOMMENDED model:

| Item | Proposed meaning |
|---|---|
| `networkId` | CSPRNG UUIDv4 generated when the user creates the network; never derived from username, IP or pairing code |
| `ownerAdminPublicKey` | Network membership authority; first user-confirmed creator owns the admin role. It need not be the Desktop listener |
| `registryVersion` / epoch | Admin-signed monotone membership log; network genesis binds initial admin key |
| `deviceId` | Stable fingerprint of a domain-separated canonical public identity key; display name/type are informational |
| Device membership | Admin-signed certificate binding network, public key, allowed role/capabilities and enrollment ID; no provider permission |
| Device private key | OS-protected, device-owned; survives ordinary reconnect, never distributed as network data |
| Origin incarnation | New epoch after destructive restore/reinstall/key loss; prevents sequence/cursor reuse |
| Recovery policy | Explicit admin transfer while old admin is available; no implicit takeover based on device presence |

Recommendation for the initial two-device release: one admin, other devices are members; any trusted device may initiate/sponsor Add Device, but the admin must authorize the new membership. If a non-admin sponsor cannot reach the admin, show pending/unavailable; do not manufacture authority. Future delegated enrollment requires a signed scoped delegation and new review. Single-admin membership sequencing avoids an unexamined multi-admin consensus design; it does not centralize knowledge writes.

Secure identity recommendation for review: a platform-backed P-256 signing identity (compatible with Android Keystore), bound to the long-term TLS peer identity. Exact key/certificate format, Windows secure-key implementation, TLS external-signing support and Android hardware/key-lock behavior are **N1 security gates**, not assumed library support. Keep protocol verification abstract so a reviewed suite change is possible. Android Keystore offers non-exportable key operations, but existing provider-secret wrapping is not proof this signing integration works. [Android Keystore documentation](https://developer.android.com/privacy-and-security/keystore).

The registry's public certificates/revocations are shared only as authenticated control-plane data; local preferences and all private keys remain local. A different person on the same Wi-Fi cannot query registry or knowledge. A member can see the trust group only after proving its identity and network membership.

Recovery recommendation (N2): no cloud recovery or six-digit recovery password in v1. Transfer admin authority in a signed old→new-admin transition while the old admin works. If admin is lost and no approved recovery exists, existing trusted peers may continue according to the last registry but cannot enroll/revoke via an invented admin. If all trust roots/keys are lost, create a new network and explicitly re-enroll; preserve local knowledge and disclose re-sharing. Do not reset trust just because a peer is temporarily unreachable. Two existing personal networks cannot be silently merged; offer a reviewed leave/join flow that preserves local data, invalidates old trust/cursors and separately confirms sharing existing knowledge with the new network.

### 3.1 Revocation and compromised devices

Admin-signed revocation increments the registry version and is retained permanently as a trust tombstone. A receiver processes valid membership updates before knowledge frames and checks trust both at session start and immediately before each import commit. Native revoke and apply are serialized through the same coordinator/store boundary: if revoke commits first, import fails; if import commits first, that already-authorized commit remains historical. Revocation cancels active sessions and future scheduling. Re-pair creates a new membership/incarnation; old certificates and cursors are not restored by retyping a code.

An offline peer cannot know a revocation it has not received. Document this limitation: local revoke is immediate on the device applying it; remote enforcement begins when the signed update is learned. Revocation cannot erase data already received or undo a request already sent. Proposed policy: exchange registry high-water before every data session; peers with inconsistent/forked membership state fail closed. A compromised enrolled device can lie about its own signed actions; device authentication cannot guarantee honest human review or erase historical exposure. Rooted devices, privileged malware and malicious OS owners remain outside the protection boundary.

N2 must also approve historical-origin policy: keep already accepted knowledge authored by a now-revoked device. A revocation may seal a known accepted origin/incarnation/hash high-water prefix; only that authenticated prefix is eligible for later historical bootstrap. Previously unseen events from the revoked origin cannot be dated as safe from their self-reported timestamps; retain them as untrusted/conflicted material pending explicit review, without applying or silently deleting them. A currently trusted relay cannot bypass this by changing the original author signature.

## 4. Six-digit Add Device protocol

UI entry: `Settings → Arthur Network → Add Device`. Pairing is the only place a six-digit code appears. Normal AutoSync, Sync now and reconnect use remembered identity keys and **never request this code**.

### 4.1 Mechanism evaluation

| Candidate | Assessment / recommendation |
|---|---|
| Balanced SPAKE2 | Fits two devices temporarily sharing a short enrollment secret; needs explicit key confirmation and binding to the resulting secure channel. RFC 9382 is an informational specification, not an audit certificate |
| SPAKE2+ | Augmented verifier model; evaluate if the selected library/platform requires it, but persistent login/verifier storage is unnecessary for this ephemeral flow |
| AOSP ADB secure pairing | Existing SPAKE2-based pairing reference with bounded frames and encrypted peer information; inspect its channel binding and implementation/license as a reference, not a ready Arthur protocol or claimed audit |
| RustCrypto `spake2` crate | Explicitly states no independent security/correctness audit. Do not select it as an audited implementation |
| Code over unauthenticated TLS, hash(code), raw-code PSK | Rejected: no adequate short-secret peer authentication; code is never a permanent credential or encryption key |

References: [SPAKE2 RFC 9382](https://www.rfc-editor.org/rfc/rfc9382.html), [SPAKE2+ RFC 9383](https://www.rfc-editor.org/rfc/rfc9383.html), [AOSP pairing implementation](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/pairing_connection/pairing_connection.cpp), [RustCrypto security warning](https://github.com/RustCrypto/PAKEs/blob/master/spake2/README.md).

**N1 recommendation:** choose an established PAKE family, then approve a specific maintained implementation/version with independent audit coverage, test vectors, platform builds, constant-time/secret-erasure behavior and a reviewed channel-binding composition. This audit did **not** establish an eligible audited cross-platform library. Pairing implementation is blocked until that proof exists; do not replace it with custom cryptography, assert RFC compliance for an incompatible library variant, or silently relax the audit requirement.

### 4.2 Required challenge state and attempt accounting

Generate a uniform integer in `[0, 999999]` using the platform CSPRNG with rejection sampling; render exactly six decimal digits including leading zeroes. Keep code and ephemeral PAKE secrets in protected process memory only and erase on expiry/cancel/use. Never persist a plaintext code, unsalted short-code hash, PAKE password equivalent or secret transcript in SQLite/settings/logs/analytics/crash breadcrumbs. The display response is one-time UI data, excluded from ordinary status serialization and logging.

Persist only nonsecret challenge metadata: random enrollment ID, network/sponsor ID, issued/deadline audit times, attempt count, generation, state (`issued`, `attempt_reserved`, `awaiting_approval`, `consumed`, `expired`, `cancelled`, `locked`), and approved candidate public-key fingerprint. Maintain device-wide rolling abuse counters across challenges and process restarts, not only per-IP counters. The logical states represent a challenge with atomically accounted attempts; only one candidate may win it.

- Lifetime: **120 seconds** by monotonic elapsed time while running; wall-clock rollback never extends it.
- Maximum **5 unsuccessful attempts**, shared across addresses/concurrent connections. Atomically reserve and durably count an attempt **before** PAKE work; a crash/abandoned attempt consumes a slot. A failed confirmation counts as unsuccessful; mere UI cancellation cannot reset the budget.
- On process restart, cancel every unresolved challenge before accepting traffic: the code is gone, so it cannot resume. Retain consumed/locked metadata and device-wide cooldown; generating a new code requires a deliberate trusted local action, not an unauthenticated request.
- New challenge generation does not reset device-wide rate limits; proposed limit of one outstanding challenge, a 2-minute cooldown after lockout, and bounded issuance count/hour requires N3 approval. Rate-limit pre-PAKE resource exhaustion too.
- Single successful PAKE proof reserves the one winning key and closes admission; consume the challenge atomically. Explicit approval is still required before membership/content. Reject other candidates, old enrollment IDs and transcript replays.

Five guesses over a million uniformly generated values leave a nonzero per-challenge guessing risk (at most `5/1,000,000` under the assumed one-guess-per-attempt construction). Repeated user-issued challenges add risk; explicit human approval and global limits are essential. A hostile LAN peer can exhaust the attempt budget and cause denial of enrollment; availability is not fixed by weakening the limits.

### 4.3 Enrollment sequence and crash safety

1. Trusted sponsor initiates Add Device; if admin approval is unavailable, explain the limitation. Show code, expiry and claimed peer identity only in local UI. The new device creates its permanent secure identity locally before enrollment.
2. Find a temporary Desktop pairing endpoint through generic discovery/manual address. PAKE roles are tied to code issuer/joiner, not TCP dial/listen roles. For initial setup, trusted Desktop normally issues code and new Android dials. If trusted Android sponsors enrollment of a new Desktop, Android still dials the Desktop's explicitly opened join endpoint and acts as code issuer; the user enters its code locally on Desktop. This reverse enrollment path requires N3 tests; Android is not made a permanent listener.
3. Use the reviewed PAKE plus explicit mutual confirmation to bind enrollment ID, network/admin fingerprint, both device public keys, protocol suite, roles, nonces and secure-channel transcript/exporter. Candidate names are untrusted display strings. If bootstrap TLS initially lacks a known peer pin, only the isolated PAKE flow is allowed before confirmation; there is no reusable trust-all certificate policy or access to Sync APIs.
4. After PAKE proof, show the pending device/fingerprint on an already trusted device and require explicit approval bound to that candidate/enrollment transcript. No click-through approval inferred from code correctness. Reject/expiry erases secrets and leaves no membership.
5. Admin signs a membership grant for the exact new public key. Persist grant plus consumed enrollment/registry update atomically before sending success; deliver only over the confirmed encrypted channel. The new device persists verified network genesis/grant before returning a signed enrollment receipt.
6. A lost final response may be recovered by the **same approved private key and enrollment ID** against the consumed record, without code reuse and without creating a second grant. A device that never received a grant gets only its already-approved receipt/grant, not private content; if identity proof or approval cannot be recovered, a fresh explicit enrollment is required.
7. Clear PAKE material; close temporary endpoint. Ordinary sessions now use remembered identities. Both sides disclose the selected sharing scope, including existing local data, before any bootstrap; pairing alone must not hide a decision to share all projects.

Suggested additional bounded approval window after successful PAKE: 120 seconds, with candidate fixed and code already consumed. N3 approves whether approval must instead finish within the original code deadline. No unbounded pending enrollment or code shown in notifications/clipboard by default.

## 5. Ordinary peer authentication and encrypted transport

Recommendation: TLS 1.3 with mutual device-key proof, public identity pins and valid admin-signed membership bound to network. Require ephemeral session keys/forward secrecy using the selected standard stack; certificate/key algorithms and how Keystore/CNG signs TLS handshakes remain N1 integration proofs. Session transcript binds protocol/network and both identities; reject wrong network, revoked key, downgrade, replay and stale incarnation. No shared network-wide bearer token and no permanent six-digit secret. Disable 0-RTT for mutations.

Membership freshness is a separate condition from TLS certificate validity. Exchanging opaque identity material during mutual authentication is necessary, but do not expose the user's registry or knowledge before membership succeeds. A fresh unauthenticated connection cannot enumerate private network IDs by probing error differences. Reuse authenticated sessions where policy permits; reauthentication after network change/reconnect uses identity keys, not user re-pairing.

Native secure storage failure means `needs_attention/key_unavailable`, not plaintext fallback. Cross-storage creation uses explicit pending/ready states and idempotent recovery; never report enrollment success before identity and membership are durable. Reset deletes/invalidates identity only through an explicit reviewed local action and preserves knowledge unless separately requested.

## 6. Discovery and manual address fallback

Recommendation: Desktop advertises a generic DNS-SD service such as `_arthur-sync._tcp` only while listening. TXT contains protocol major and an ephemeral opaque instance token; no personal/network names, stable network/device IDs, project data, key fingerprint or registry. Service presence is visible on LAN; this unavoidable presence/timing metadata is disclosed, not claimed to be anonymous. Stable trusted identities are verified inside authentication.

Android uses native `NsdManager` through a small Kotlin↔Rust platform adapter, not JavaScript scanning. NSD is asynchronous; names can collide/change and results disappear, so retain handles, stop discovery on cancellation and treat stale addresses as hints. NSD supports DNS-SD discovery/registration; it does not authenticate peers. [Android NSD guidance](https://developer.android.com/develop/connectivity/wifi/use-nsd).

Avoid raw multicast sockets initially. Investigate `MulticastLock` only if a selected raw mDNS adapter actually requires it; scope any lock to a bounded discovery operation and test OEM behavior. AP isolation, suppressed multicast, Ethernet Desktop vs Wi-Fi Android, IPv6 link-local scopes, roaming and firewall rules must be tested. Same SSID is neither necessary nor sufficient for reachability.

Manual fallback: user enters a local IP/hostname plus port in a controlled local flow. Native validates length/address/route, refuses remote URLs/userinfo/path tricks and never disables certificate/identity checks. Remember addresses only as local hints; DHCP changes never change device identity. No address entry grants trust; an unknown key requires enrollment. Network discovery/permission failure is distinct from unknown membership.

### 6.1 Android API 37 permission gate

The audited app already targets SDK 37. Current Android guidance requires `ACCESS_LOCAL_NETWORK` runtime permission for broad direct LAN access on Android 17; system-mediated NSD picker access is an alternative for user-selected endpoints. The present manifest/bridge implements neither. Recommend a reviewed broad-permission flow for unattended discovery/manual-address use, explain why, handle denial/revocation and test the target OS. A picker may improve Add Device UX but does not automatically prove unattended/background operation. Do not lower target SDK or request permissions silently in P0. [Android local-network permission guidance](https://developer.android.com/privacy-and-security/local-network-permission).

## 7. Native AutoSync / Background state machine

Both devices expose device-local settings; none are knowledge data. Recommended first-run values: `autoSyncEnabled=false`, `backgroundEnabled=false`, `intervalMinutes=15`. Only the interval default is mandated by the task; owner approves the two OFF defaults (N4).

Exactly ten allowed native integer intervals:

| Foreground target | Native minutes | Foreground target | Native minutes |
|---|---:|---|---:|
| 5 minutes | 5 | 1 hour | 60 |
| 10 minutes | 10 | 2 hours | 120 |
| 15 minutes (default) | 15 | 4 hours | 240 |
| 30 minutes | 30 | 8 hours | 480 |
| 45 minutes | 45 | 12 hours | 720 |

Validate membership in `{5,10,15,30,45,60,120,240,480,720}` natively and mirror in pure contracts. Reject zero, negative, fractional, string and arbitrary numeric intervals; UI labels are formatting only. Store requested interval unchanged even when OS-effective cadence differs.

Native settings invariant: `backgroundEnabled ⇒ autoSyncEnabled`. Apply transitions atomically with a settings revision, then reconcile scheduler/listener resources. Reject stale compare-and-set setting revisions and contradictory combined patches.

| Native action | Result | Scheduling/resource consequence |
|---|---|---|
| Set Background ON | Background=true, AutoSync=true | Request supported background execution; permission failure is visible actual state, not a false running flag |
| Set AutoSync OFF | AutoSync=false, Background=false | Cancel automatic jobs/discovery, revoke automatic session leases and close automatic listener; manual lease unaffected |
| Set Background OFF | Background=false; keep AutoSync unchanged | Cancel background jobs; foreground automatic work can continue |
| Set AutoSync ON | AutoSync=true; keep Background unchanged | Start only eligible automatic work; does not grant OS permission or enroll a peer |
| Set interval | New validated integer | Replace unique scheduled work/due calculation, coalesce catch-up |
| Sync now | No settings mutation | One manual session/readiness lease, subject to trust and OS permission |
| Lose membership / reset | Settings may remain requested but cannot run | Cancel sessions, return revoked/not-paired state |

When AutoSync ON and Background OFF, automatic work runs only while native lifecycle reports foreground/active UI. Page Visibility can inform UI but is not the native authority. Leaving foreground revokes the automatic lease; stop at a safe transaction boundary, close socket and retain unacknowledged work. No hidden long-running task after minimizing/backgrounding in this mode.

Separate **requested settings** from **actual execution**: `foreground`, `scheduled`, `running`, `paused_by_os`, `permission_required`, `key_unavailable`, `network_unavailable`, `unsupported`, `stopped`. A persisted ON preference cannot guarantee execution. Do not claim OS pause is known merely because a job was late: use `background_pending/lastRunAt` until the platform provides a reason.

### 7.1 Scheduler and concurrent attempts

Native coordinator owns one single-flight session lease per `(network, peer)` with cancellation/generation; unique platform job names avoid duplicate background work. Manual request while a compatible session runs attaches to it and returns the same attempt ID. Expired/stale callbacks cannot resurrect a session after AutoSync OFF/revoke. Recheck policy before dispatch and before commit; serialize settings/trust changes with commit admission. No network await inside DB transactions.

Monotonic runtime due-times, bounded exponential failure backoff with jitter, and persisted last successful cursor/time prevent tight loops. Resume from sleep/network return coalesces missed ticks into one attempt; never replay every missed interval. Network callbacks can refresh reachability but cannot bypass the due/backoff policy or trigger a broadcast storm. No new journal data still requires a small authenticated summary for peer changes; it never sends the whole DB.

Desktop may request a session over an existing Android-initiated authenticated control connection while Android is eligible. A queued Desktop request cannot wake an OS-suspended Android process. The interval means a target opportunity **when both sides are eligible and reachable**, not guaranteed cross-device completion. Explicitly test unequal intervals; accepting an authenticated incoming automatic session while AutoSync ON does not overwrite local interval settings.

### 7.2 Desktop background lifecycle

Recommendation: native Tauri tray with Open Arthur, Sync now, status and **Quit**. With Background ON, native close handling hides the window and retains the same runtime/listener; with it OFF, close stops automatic work and follows ordinary exit semantics. If tray cannot be established, do not silently hide the only window; expose unsupported/needs-attention. Explicit Quit always cancels admission/discovery, ends bounded tasks and exits, irrespective of persisted Background preference. Restart may resume only after the user launches the app; autostart at OS boot is a separate opt-in scope.

Tauri documents native tray support behind the `tray-icon` feature, absent in the current manifest. Keep this integration native to respect the ArthurClient/UI boundary. [Tauri system tray](https://v2.tauri.app/learn/system-tray/). Future macOS requires its own lifecycle/keychain/firewall validation; no current macOS acceptance claim.

Prevent two Desktop app processes from independently opening/mutating the same store: an OS-held per-data-root runtime lock (not an unchecked stale PID file) plus reviewed single-instance activation. A second launch focuses the owner or fails safely. Do not add a second Sync daemon.

### 7.3 Android background scheduling and runtime ownership

Recommendation: unique WorkManager periodic work under supported OS constraints, bounded discovery/dial/sync, and native cancellation when settings change. Android periodic work has a 15-minute minimum and is inexact. For requested **5 or 10 minutes**, retain that foreground target but use an effective background minimum of **15 minutes**, possibly later; UI must say so. Other choices remain target intervals, not deadlines. [PeriodicWorkRequest reference](https://developer.android.com/reference/androidx/work/PeriodicWorkRequest).

Doze/App Standby can defer CPU/network/jobs. Force-stop, permission denial and vendor restrictions require real-device evidence; they are not solved with a hidden daemon, exact alarms, expedited-work loops, endless one-time rescheduling, battery-exemption prompts or permanent foreground service. On foreground return, perform one due catch-up. [Android Doze/App Standby](https://developer.android.com/training/monitoring-device-state/doze-standby). WorkManager supports constraints, retry/backoff and cancellation; jobs should require suitable connectivity but still verify a reachable allowed LAN themselves. [Work request guidance](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work).

**N5 blocker — background work cannot just call an Activity-bound Tauri State.** Before enabling Android Background Mode, extract the existing store/runtime construction into a process-wide native runtime factory, keyed by the application data root. Tauri setup and a Kotlin WorkManager JNI entry both acquire the same runtime owner in the default application process; `OnceLock`/equivalent guarded registry and the data-root ownership lock prevent a second connection owner. Worker never opens SQLite/Room directly, never starts a second Tauri app/webview and never declares a separate `:sync` process. Existing command handlers adapt to that shared owner after a separately reviewed refactor.

The worker can initialize only that native runtime after process death, using Application context and secure-key access without an Activity. Its provider/model/Graph auto workers must not start as a side effect. Worker lifecycle must coexist with the Android `_exit` teardown workaround: review whether exit is allowed while native work is leased; any unavoidable kill is crash recovery, never a reason to weaken journal durability or simply remove the workaround. A foreground/background race must not create two runtime owners. Prove this with instrumented process-death/Activity-destroy tests before shipping Background ON. Until proven, report unsupported/needs-attention and retain foreground/manual functionality; do not present the full Background feature as delivered.

## 8. Manual Sync and mixed setting combinations

Manual Sync always remains available to paired devices with AutoSync OFF. It never toggles AutoSync/Background or grants trust. Native OS permission prompts require a direct user action and explanatory UX; a missing permission is reported, not bypassed.

Recommended evaluation of the proposed two-button flow:

1. Desktop Sync now creates a **120-second admission lease**, opens the authenticated listener and generic discovery advertisement, and shows `Ready to sync` plus countdown/cancel.
2. Android Sync now discovers or uses a validated local address, proves the stored identity, and opens one bidirectional session. No code, no PAKE, no new membership.
3. One successful peer session consumes the manual admission lease; repeated clicks reuse it rather than spawn listeners. At 120 seconds, close the listening socket and unregister discovery even if no peer connected.
4. An admitted connection may finish only within an additional bounded session budget (proposed max 120 seconds from admission), then closes; no permanent service. UI distinguishes closed admission from finishing transfer. Incomplete bootstrap is staged and resumes during the next explicit manual window; expiry never falsely ACKs unfinished work. N6 approves this admission-vs-session distinction and budgets.
5. Cancel/Quit/permission loss/revocation terminates the lease and connection at a safe transaction boundary. Already committed data remains, pending data retries idempotently later. Manual work is foreground-only on Android; backgrounding cancels the manual lease without enabling Background Mode.

| Desktop policy | Android policy | Expected behavior |
|---|---|---|
| Auto OFF | Auto OFF | Desktop Sync now opens window, then Android Sync now connects |
| Auto ON and execution eligible | Auto OFF | Desktop listener is ready; Android Sync now performs one session without turning auto on |
| Auto OFF | Auto ON and execution eligible | Android can connect automatically only during Desktop's explicit ready window; otherwise unavailable/waiting. No surprise permanent listener |
| Auto ON and eligible | Auto ON and eligible | Android dials when due; bidirectional session, Desktop may request work over existing eligible connection |
| Desktop quit/asleep or Android OS-suspended | Any | No guarantee of contact. Report unavailable/deferred; do not promise remote wake |

Desktop Sync now by itself cannot force an Android process to run. If Android has no eligible control connection, Desktop waits in ready state for Android manual/automatic initiation. N6 must approve that UX limitation; solving it with an inbound Android service or remote wake would expand v1 scope. With a listener already serving an eligible automatic lease, manual window expiry removes only the manual reason to listen; it must not misreport that all listeners closed while AutoSync still independently authorizes one.

Security implications: temporary readiness narrows exposure but is not access control. Every attempt still requires mutual membership authentication; an unpaired LAN device sees neither content nor registry. No unauthenticated “sync now” request opens a window, extends a deadline or flips preferences.

## 9. Proposed user-visible status and client API

Keep settings, membership, discovery, execution and data consistency as separate native fields. Aggregate display precedence: revoked/not-paired → actionable security/integrity/conflict error → running phase → OS/permission limitation → availability/idle. `up_to_date` means committed negotiated cursors **and no unresolved conflicts** at a known watermark; a reachable socket alone is insufficient. No status implies all devices in the group are globally current.

| User-visible state | Native meaning / likely action |
|---|---|
| Not paired | No usable network membership; create/join network |
| Idle | Paired, no active attempt; manual button available |
| Looking for trusted devices | Bounded discovery/probing; candidates not trusted yet |
| Ready for manual sync | Desktop admission lease open; show expiry |
| Connecting | Transport and mutual identity validation in progress |
| Syncing | Authenticated incremental/bootstrap session with progress counts |
| Up to date | Last committed peer watermark, time and conflict-free result |
| Peer unavailable/offline | No reachable eligible peer; distinguish listener closed and permission denial when known |
| Paused by OS | Known scheduling/execution restriction; show requested settings separately |
| Needs attention | Conflict, unsupported protocol/import policy, key/permission failure or integrity rejection; safe typed action |
| Revoked | Membership explicitly removed; no send/receive; explicit re-enrollment only |

Proposed `ArthurClient` capabilities/types/methods, **not edited into current contracts**:

```ts
type SyncIntervalMinutes = 5 | 10 | 15 | 30 | 45 | 60 | 120 | 240 | 480 | 720;
type SyncSettings = {
  autoSyncEnabled: boolean;
  backgroundEnabled: boolean;
  intervalMinutes: SyncIntervalMinutes;
  revision: string;
};

getArthurNetworkStatus(): Promise<NetworkStatus>;
createArthurNetwork(): Promise<NetworkStatus>; // deliberate local creation
listTrustedDevices(): Promise<TrustedDeviceSummary[]>;
startDeviceEnrollment(): Promise<EnrollmentDisplay>; // one-time code + expiry; never logged
openJoinWindow(): Promise<JoinWindow>; // Desktop join endpoint when sponsor is Android
submitEnrollmentCode(input: EnrollmentInput): Promise<EnrollmentAttempt>;
approveDeviceEnrollment(enrollmentId: string, candidateFingerprint: string): Promise<EnrollmentResult>;
rejectDeviceEnrollment(enrollmentId: string): Promise<void>;
cancelDeviceEnrollment(enrollmentId: string): Promise<void>;
revokeTrustedDevice(deviceId: string, expectedRegistryVersion: string): Promise<NetworkStatus>;
getSyncSettings(): Promise<SyncSettings>;
setAutoSyncEnabled(enabled: boolean, expectedRevision: string): Promise<SyncSettings>;
setBackgroundEnabled(enabled: boolean, expectedRevision: string): Promise<SyncSettings>;
setSyncInterval(minutes: SyncIntervalMinutes, expectedRevision: string): Promise<SyncSettings>;
getSyncStatus(): Promise<SyncStatus>;
syncNow(peerId?: string): Promise<SyncAttempt>; // Desktop readiness or Android dial; flags unchanged
cancelSync(attemptId: string): Promise<void>;
setManualPeerAddress(peerId: string, address: string): Promise<void>;
onSyncStatusChanged(listener: () => void): () => void;
onKnowledgeInvalidated(listener: (change: KnowledgeInvalidation) => void): () => void;
```

Document the eventual supporting DTOs and disclosure confirmation tokens before implementation: peer ID is optional for a new join, address is native-validated, enrollment input carries code/challenge ID and reviewed sharing consent; it cannot choose membership roles or registry keys arbitrarily. Proposed `NetworkStatus` contains only local display-safe data/capabilities, never a raw private key or code. `SyncStatus` separates requested settings, actual execution, permissions, per-peer cursors, counts, conflicts and typed failure/retry codes. Feature components render capability explanations; platform-specific branching stays in adapters/native code. Secure address entry is configuration, not a JS network call.

Mirror new methods in desktop, mobile and browser-preview clients and contract validators, with native command tests. Preview uses in-memory deterministic fakes and advertises no real LAN/background support. Domain invalidation triggers canonical rereads for affected mounted screens; it is separate from the local Capture-created event so import cannot accidentally trigger AutoOrganize/providers. See Document A §9 for suppression of the existing semantic indexer as well.

## 10. Threat and failure matrix

| Threat / failure | Required mitigation and acceptance evidence | Remaining risk |
|---|---|---|
| Another user on same Wi-Fi / rogue discovery | No registry/content before matching enrolled cryptographic identity/network; cross-network tests | Generic service presence and traffic timing visible |
| MITM / wrong Desktop address | Reviewed PAKE channel binding at enrollment; pinned mutual auth later; no trust-all fallback | Compromised endpoints/user approving wrong candidate |
| Online guessing / replay / parallel attempts / restart | Durable pre-PAKE reservations, 5 failures, expiry, one winner, restart cancellation, global cooldown | Denial of pairing by exhausting budget |
| Lost enrollment receipt | Resume only exact approved key/enrollment; no second grant/code use | Lost key requires fresh pairing |
| Forged approval/Sync event/ACK | Origin signature, membership epoch, exact payload/dependencies, transactional validation/cursors | Trusted malicious member can attest false local action |
| Stolen/revoked device | Secure keys, admin-signed revoke, cancel sessions, no later apply after local revocation commits | Offline revocation delay; already copied data cannot be recalled |
| Keystore locked/missing / desktop plaintext temptation | Fail closed with visible key-unavailable; no FileSecretStore fallback | Platform integration/device-unlock availability must be measured |
| Oversized frames / connection/NSD floods | Bounded decode/time/session/disk and cancellation, rate limits before expensive work | LAN jamming/total resource exhaustion not solved |
| App kill / `_exit` / suspend / lost ACK | Atomic journal/import plus idempotent resume; no reliance on destructors | Completion delayed until OS permits work |
| Foreground↔worker race / second Desktop launch | One process-wide native owner, ownership lock, single-flight sessions | Runtime extraction regression risk |
| AP isolation / DHCP / IPv6 scope / denied LAN permission | Native status, route validation, manual fallback with unchanged authentication | No connectivity where network policy blocks peers |
| Malicious packet triggers paid AI | Import reason/eligibility prevents AutoOrganize/Graph/embedding calls; synthetic provider spy tests | Existing provider polling must be audited during implementation |
| Registry rollback / restored stale DB | Signed monotone checkpoints, incarnation reset/rebootstrap, reject forks | Full privileged rollback of every local trust store needs recovery/security policy |
| Logs/backups | Counts/codes only; no code/keys/content; keep app backup exclusions and private staging cleanup | Privileged crash dump/disk access outside app trust boundary |

## 11. Implementation sequence and approval gates

These slices are future local work only; this document does not authorize commits, push, PRs or implementation.

| Slice | Deliverable after approval | Exit evidence |
|---|---|---|
| P0 (this task) | Two proposed architecture documents, verified inventory and limitations | Owner/security decisions recorded, no runtime changes |
| P1a | Native engine/store/runtime ownership seam and process lock | Existing behavior unchanged; one owner across UI/worker/second launch; no new network |
| P1b | Reviewed schema/journal/snapshot design implemented | Atomicity, restart, old-schema refusal and populated-v9 tests |
| P2 | Dedicated importer/conflict/approval reconstruction | All Document A fixtures, historical trigger compatibility and no provider calls |
| P3a | Approved secure identity + reviewed PAKE implementation | Audit/version evidence, cross-platform build, wrong-code/MITM/replay/5 attempts/restart tests |
| P3b | LAN mutual auth, NSD/manual fallback, revocation | Two-user same-LAN isolation, API37 permission tests, both enrollment orientations |
| P4a | ArthurClient/UI and foreground/manual scheduler | All flags/transitions/10 intervals, 2-minute listener and mounted-screen rereads |
| P4b | Desktop tray and Android supported background integration | Quit/sleep/Doze/force-stop/Activity-destroy/worker cold-start evidence; honest effective cadence |

| Decision | Recommendation | Approver / unresolved proof |
|---|---|---|
| N1 — crypto and secure keys | Reviewed PAKE/channel composition + TLS mutual auth; no unaudited substitute | Kaloyan/security: exact audited library/version, platform key signer support, suite/license/builds |
| N2 — membership/admin/recovery | One admin with signed registry; explicit transfer, no cloud recovery | Kaloyan: admin-lost policy and enrollment/revocation delegation limits |
| N3 — enrollment abuse/expiry | 120-second code, 5 failures, persistent global budgets, fixed approved key | Security/owner: issuance cooldown/hour limits, pending-approval deadline, reverse enrollment proof |
| N4 — defaults/sharing | Auto OFF, Background OFF, interval 15; explicit all-project scope disclosure | Kaloyan: defaults, scope, conflict UX |
| N5 — Android background | Default-process WorkManager→shared native runtime; no separate DB owner | Owner/platform: lifecycle extraction and `_exit` coexistence, API37 access, cold-start secure keys |
| N6 — manual/operational roles | 120-second admission + bounded admitted session; Android dials, Desktop waits if needed | Kaloyan: mixed modes, unequal cadence expectations, large-bootstrap UX and no Android remote wake |
| N7 — transport and resource budgets | Native LAN adapter, local route/interface policy, bounded sessions/discovery | Security/owner: allowed interfaces/ports/firewall rules and concrete limits |

## 12. Acceptance checklist — not yet executed

- Pair fresh Desktop↔Android; test trusted Android sponsor/new Desktop without an Android permanent listener. Both confirm the exact new identity; enrollment/reconnect never confuses a device label with trust.
- Expiry at 120 seconds, leading-zero code, five incorrect/parallel/aborted attempts, process restart, consumed-code replay, duplicate final receipt, reject and wrong-network enrollment all behave as specified. No code appears in persisted files/logs.
- Same-Wi-Fi stranger cannot enumerate private network/device registry or receive knowledge. Forged discovery/address/cert/device ID and cross-network valid certificates fail before private exchange.
- Revocation racing an import has the specified serialization outcome; reconnect after removal requires new enrollment. Offline revocation lag is shown honestly.
- Validate exactly ten numeric intervals and all native settings transitions, stale/contradictory updates, OS denial and cold restart. Manual sync changes neither flag.
- Both flags OFF: Desktop listener admission closes at two minutes; Android Sync now uses stored keys; no peer/code/setup prompt, no permanent service, safe cancellation/large-bootstrap resume.
- Auto ON/Background OFF stops automatic activity when backgrounded, while foreground automatic sync and local offline functions remain usable. No setting silently grants network/provider permission.
- Desktop hide-to-tray, explicit Quit, sleep/resume and double launch preserve one owner. Android API24 baseline and API37 LAN permission, NSD fallback, Doze, denied/revoked permission, force-stop and worker/UI races are tested on selected devices/emulators; record OS/build/device and actual results.
- Android requested 5/10 minutes clearly displays best-effort background minimum 15 minutes; no exact-execution claim. Longer intervals, unequal peer intervals and missed ticks remain bounded.
- Import/retry never invokes paid providers or local-capture subscribers; each mounted screen rereads committed data; failed apply leaves DB/views unchanged.

Fresh P0 checks: source/Git audit performed; TypeScript/architecture/frontend commands could not execute because `tsc`/`vitest` dependencies are absent; Rust commands could not start because Cargo is absent from PATH. No Android build/device/network/PAKE/Sync test ran. Official platform/protocol references were consulted for design only. Historical v1 pass counts are not acceptance evidence for any proposal here.
