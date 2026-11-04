# Storage/sync reference inventory

Measured read-only on `feature/nodes-integration` at
`93b960d19a69cd34a85a7a6fd78c9b3010f107bb`, before this extraction.
All source paths and before-line numbers below are relative to `src/`.
Production includes dormant and platform-specific release code. Qualification
means test or the explicit Android identity-test feature, not ordinary Android.

Counts are occurrences, not distinct imported names. A grouped root import is
counted once separately from literal `crate::sync` / `crate::storage` paths.
Two paths on `enrollment_store.rs:679` count twice. Wildcards are preserved in
the inventory rather than incorrectly counted as one concrete type.

| Direction / kind | Production before | Qualification before | Total before | Production after | Qualification code after |
|---|---:|---:|---:|---:|---:|
| storage -> literal `crate::sync` | 25 | 62 | 87 | 0 | 55 |
| storage -> additional grouped `sync` root | 1 | 5 | 6 | 0 | 5 |
| sync -> literal `crate::storage` | 4 | 9 | 13 | 0 | 9 |
| sync -> additional grouped `storage` root | 0 | 2 | 2 | 0 | 2 |

The new scanner's synthetic strings add two literal `crate::sync` spellings
and one grouped sample under storage. Thus a raw text search after this change
returns **57 literal + 6 grouped** storage references; **55 + 5** are code
dependencies, all explicitly qualified. Sync returns **9 literal + 2 grouped**,
all explicitly qualified. The scanner ignores strings/comments and verifies
each exception's actual cfg declaration or inherited guarded parent.

## Every literal reference before extraction

### Storage production (25)

| File | Before line(s): target |
|---|---|
| android_device_identity_store.rs | 4: `AndroidIdentity`, `identity::*`, security `Result`, `SecurityError`; 146: `identity::verify` |
| bootstrap_store.rs | 9: `bootstrap::*`, `sync::*` |
| capture_store.rs | 92, 102: `Pool`; 110: `Expected`; 111: security `Result` |
| device_identity_store.rs | 4: `WindowsIdentity`, `identity::*`, security `Result`, `SecurityError`; 132: `identity::verify` |
| enrollment_store.rs | 4: `MembershipBinding`, `Root`; 5: `canonical`, `enrollment::*`, `identity::*`, security errors; 162: `Expected` |
| journal/g3.rs | 8: `Error`, `Result`, `ValidatedEvent` |
| journal/import_view.rs | 6: `Error`, `Result` |
| registry_verification.rs | 13: `canonical`, `enrollment::*`, `identity::*`, security errors |
| signed_import.rs | 9: `canonical`, `identity::*`, `SignedOriginal`, `sync::*`; 24: security `Result` |
| sync_store.rs | 10: `sync::*`; 875: `SnapshotExport`; 881, 899: `SnapshotOffer`; 890: `SnapshotChunk`; 902, 908: `SnapshotReceipt`; 949: bootstrap `envelope` |

### Storage tests and qualification (62)

| File | Before line(s): target |
|---|---|
| enrollment_store.rs | 328: `QualifiedPending` (test/Android qualification); 674-677: `VerifiedSession`, `ValidatedEvent`, `SyncClock`, `Cancellation`; 679: `Result`, `Receipt` (test-only helper) |
| journal/import_physical_tests.rs | 65: `Result` |
| journal/sync_fixtures.rs | 96, 345: `Envelope`; 97: `ValidatedEvent::parse`; 354: bootstrap `envelope` |
| security_android_instrumentation.rs | 4: Android/identity types and security errors; 287-289: `TrustVerifier::verify`, `ClosedTrust`, `PeerHello`; 299: `live_pairing`; 301: `ClosedLan`; 365: `Action`, `Role`; 451-452: `official_vectors`, `negative_cases`; 465, 470: route `acquire`, `Unavailable::MissingPermission`; 473-474: `qualify_android`; 475-476: `qualify_fast`, `qualify_deadlines`; 482: `qualify_selected_network`; 503: TLS module, `CertificateRole`; 547, 552: `TransientVerifier::new`, `abandon_after_ke1` |
| security_e2_tests.rs | 9: enrollment/identity/Windows types; 10: `SignedOriginal`, `TestTrust`, `sync::*`; 87: security `Result`; 228, 1126: `canonical`; 436: `SecurityError::Expired`; 781, 787: `Interrupt`, `Expected`; 1221-1222: `live_pairing`, `ClosedLan`; 1229: `SecurityError::Trust` |
| security_pake_tests.rs | 8: composition/enrollment/PAKE/TLS types and security errors; 142: `abandon_after_ke1`; 352: `live_pairing`; 431: `n7a_tests::run` |
| security_tls_tests.rs | 39: Android `bridge`; 121, 125: Windows/Android identity invalidation; 149, 741: `Action`, `Role`, `Expected`, `Interrupt`; 437: `ClosedLan`; 613: `Action`, `Role`, native I/O, TLS `Pair` |
| sync_d3_tests.rs | 2: `bootstrap::*` |
| sync_r6_tests.rs | 216, 218: `BOOTSTRAP_BYTES`; 238: `BOOTSTRAP_EVENTS` |
| sync_tls_tests.rs | 19-20: `TlsTransport`; 271: `HandshakeFault`; 305: native I/O `both`; 511: `MAX_RECORD` |

### Sync (13)

| File | Classification | Before line(s): target |
|---|---|---|
| bootstrap.rs | Production | 4: canonical codec |
| engine.rs | Production | 7: canonical codec |
| protocol.rs | Production | 1: canonical codec |
| validation.rs | Production | 2: codec and reducer (`dependencies_for`) |
| security/tests.rs | Test | 20: `CaptureStore`; 22, 475: `OwnedDeviceIdentity`; 419: `SCHEMA_VERSION`; 703: `grant_test_origins`; 798: `DataRootOwnership::try_acquire` |
| security/tls_lab.rs | Test/Android qualification | 8: `OwnedTlsKey` |
| security/tls_socket_lab.rs | Test/Android qualification | 763, 861: `Fixture` (Windows test functions) |

## Additional grouped imports (8)

| File / before import line | Classification | Target root and members |
|---|---|---|
| storage/tls_identity.rs:2 | Production | sync: `PublicIdentity`, TLS module, `CertificateRole`, `NativeTls13`, security errors |
| storage/journal/cross_device_qualification.rs:12 | Qualification | sync: native I/O/TLS/security types, `Expected`, `Interrupt`, `TestTrust`, `sync::*` |
| storage/journal/import_physical_tests.rs:3 | Test | sync: `TestTrust`, `TrustVerifier`, `sync::*` |
| storage/journal/tls_qualification.rs:13 | Qualification | sync: native I/O/TLS/security types, `Expected`, `Interrupt`, `TestTrust`, `sync::*` |
| storage/security_tls_tests.rs:4 | Qualification | sync: composition, identity and TLS types, security errors, `sync::*` |
| storage/sync_tls_tests.rs:4 | Test | sync: native I/O `execute`, `CertificateRole`, TLS `Pair` |
| sync/security/tests.rs:5 | Test | storage: enrollment store/`NetworkRegistry`, journal fixtures, `install_candidate`, `test_events`, `CandidateSyncStore` |
| sync/security/tls_socket_lab.rs:18 | Qualification | storage: `OwnedTlsKey` |

## Wildcard vocabulary

- `sync::*` included `SyncEngine`, `SyncStore`, `ClosedTrust`, `TrustVerifier`,
  `VerifiedSession`, `ValidatedEvent`, the protocol exports below, and the public
  `bootstrap`, `security`, `trust` module names.
- Protocol exports: `Error`, `Result`, `Outcome`, `SyncStatus`, `Identity`,
  `Envelope`, `Progress`, `Summary`, `Chunk`, `Receipt`, `Payload`, `Message`,
  `PeerHello`, `AuthenticatedTransport`, `SyncClock`, `Cancellation`, `PageKey`,
  `chunk_event`, and constants `MAX_EVENTS`, `SUMMARY_PAGE`, `REPROCESS_BATCH`,
  `CHUNK`, `MAX_FRAME`, `MAX_BATCH`, `MAX_ASSEMBLIES`, `FEATURES`.
- `bootstrap::*`: `SnapshotOffer`, `SnapshotChunk`, `SnapshotReceipt`,
  `SnapshotExport`, `SnapshotCore`, `SnapshotRow`, `HighWater`, `SnapshotImage`,
  `hex`, `unhex`, `envelope`, `canonical`, `decode`, and the five `BOOTSTRAP_*`
  constants.
- `identity::*`: `PublicIdentity`, `KeyAvailability`, `Domain`, `digest`,
  `DeviceIdentityStore`, `verify_identity`, `verify`, `UnavailableIdentity`.
- `enrollment::*`: `Root`, `MembershipBinding`, `Role`, `Action`, `Update`,
  `SignedUpdate`, `SecretCode`, `Transcript`, `Attempt`, `CandidateProof`,
  `Challenge`, `live_pairing`.

## Purity and remaining domain coupling

The original `storage/journal/codec.rs` contained **zero `rusqlite` tokens**, no
storage/sync imports, and no filesystem/network I/O. The original reducer also
contained zero driver tokens. Their definitions are unchanged; the old files
remain compatibility re-exports. No original storage path was removed or renamed.

The only production dependency on the other listed service domains is
`storage/journal/writers.rs` importing `distillation::evolution`: its
`evolve_capture` signature uses `Planned`, `EvolutionLimits`, `Committed`, and
its body calls `evolution::apply` inside the existing transaction. Moving those
types alone would not remove the function dependency. That call remains
unchanged; no callback inversion or behavior change is included here.
`identity` in that writer is an alias for `storage::identity_store`, not the
identity service. Other identity/recall/graph service references are test code
or source-assertion strings, not production service imports.

## Local verification snapshot

The required format and default Windows Clippy commands pass; architecture is
88/88 with no existing assertion edits; frontend checks pass 561/561 plus build.
The Clippy command still reports 493 rustc warnings (mostly dormant code newly
outside the old sync module's dead-code suppression), with no Clippy errors.
No new blanket lint suppression was added.

The first full serial native run is **1458 passed, 2 failed, 26 ignored**.
Both failures are the existing R6 maximum-row/event and near-four-MiB bootstrap
cases. A focused replay gives **6 passed / 2 failed**. A fresh archive of untouched
`93b960d`, built and run on the same machine with the same filter, also gives
**6 passed / 2 failed**, with the same SnapshotTooLarge and Trust refusals.
The unchanged code retains the five-second bootstrap work guards and native I/O
deadlines (`Fault::Expired` maps to `Error::Trust`). This reproduces the local
baseline failure; it does not turn the local native gate into PASS.

All four existing dependency-isolation graphs pass (Windows/Android, default
and qualification). CI and Android compile results must be reported separately
from this local snapshot; no device-execution or release qualification is claimed.
