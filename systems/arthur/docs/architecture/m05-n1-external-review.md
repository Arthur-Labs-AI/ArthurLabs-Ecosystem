# M05 N1 external security review packet — E3A3

**2026-10-24; N1_AUDIT_PENDING; recommendation: REJECT activation.**
Repository: Kaloyan3D/A.R.T.H.U.R, branch `feature/nodes-integration`.
Review target is the E3A3 commit containing this document, relative to accepted
`1414dd4ccaf2aa4f8d4762045aa3c80ba531816c`. The commit, locked manifest and
qualification JSON must travel together. This is an internal engineering review
request, not an independent audit. Executed results are in readiness section 20.

## 1. Candidate decision and exact implementation

**Preferred candidate for subsequent independent qualification: balanced
RustCrypto `spake2 0.4.0`, Ed25519Group. None of the evaluated implementations
currently meets N1.** This preference follows the actual model: both devices
hold the same short-lived code, so neither a registration protocol nor a
password verifier provides a required product capability. It is not permission
to replace the harness or invent key confirmation. Blockers: independent audit,
resolution of upstream RFC9382 encoding issue, a reviewed mutual-confirmation
and TLS-context profile, exact locked dependency review, vectors and both native
platforms. No SPAKE implementation is installed by E3A3.

| Candidate | Fit and remaining evidence gap |
| --- | --- |
| RustCrypto spake2 0.4.0 | Balanced shared-code model; no local registration. Published source `3e126d74b692a20d88f6ec62c770ac0c93ab002c`, crate SHA256 `c5482afe85a0b6ce956c945401598dbc527593c77ba51d0a87a586938b1b893a`. MIT OR Apache-2.0, MSRV 1.60. Direct production requirements: curve25519-dalek 4, rand_core 0.6, sha2 0.10, hkdf 0.12. These are requirements, not an Arthur resolved lock. Maintained repository has 0.5.0-pre.0; that is a different candidate. Upstream explicitly disclaims independent audit. Issue #186 is open. Windows/Android integration, vectors, dependency closure and cleanup have not been qualified here. |
| opaque-ke 4.0.1 | Augmented login adds confidential local registration/setup/record lifecycle to this model. Stronger historical audit lineage, but current revision and composition uncovered; unresolved dependency advisory. Retained as an explicitly rejected-for-activation experimental harness, not selected because its tests pass. |
| spake2plus 0.1.0 | Augmented design also needs registration/verifier handling. MIT, MSRV 1.85, first publication 2026-10-04; no independent audit. Upstream reports RFC9383 vectors, but Arthur has not run them or qualified platforms/dependency graph. Prover-first `confirm_first` is excluded because it exposes offline guessing. Neither recent publication nor vector claims establish maintenance maturity. |

Sources: [exact SPAKE2 manifest](https://github.com/RustCrypto/PAKEs/blob/3e126d74b692a20d88f6ec62c770ac0c93ab002c/spake2/Cargo.toml),
[warning](https://github.com/RustCrypto/PAKEs/blob/master/spake2/README.md),
[encoding issue](https://github.com/RustCrypto/PAKEs/issues/186),
[SPAKE2+ security/API](https://docs.rs/spake2plus/0.1.0/spake2plus/).

**Executable review target:** `src/sync/security/pake_qualification.rs` under
`apps/arthur/src-tauri`, opaque-ke **=4.0.1**, published source/tag
`75fe4cdddb7946440054da0c8e7cdd73828af3f9`, crate SHA256
`ded22991b43cd15561b62b2e1cf9ace1344a8534eebec96202d5c96a77a6616a`.
Default features off; `ristretto255,argon2` only. OPRF Ristretto255/SHA512,
TripleDh<Ristretto255,SHA512>, upstream Argon2id v19 default m=19456 KiB,
t=2, p=1. Fixed zero KSF salt follows the per-record OPRF; this is not an Arthur
password database. Protocol metadata suite is
`arthur-e3a3-opaque401-ristretto255-3dh-sha512-argon2id-tls13-p256-pending-v2`.
Official RFC9807 C.1.1/C.1.2/C.2.1 use their specified Identity KSF instead.

Exact dependency closure is `src/sync/security/qualification/packages.json`
(69 all-target/build packages) plus `Cargo.lock`, not merely this summary:
voprf 0.5.0 (`danger` required by upstream), curve25519-dalek 4.1.3,
elliptic-curve 0.13.8, crypto-bigint 0.5.5, argon2 0.5.3, rand 0.8.6,
sha2 0.10.9, hkdf/hmac 0.12, zeroize 1.9.0. TLS uses rustls 0.23.46/ring 0.17.14;
native identity uses CNG or Android Keystore/JNI 0.21.1, P256/SHA256 signatures.

## 2. Independent audit applicability

The [NCC December 2021 report](https://www.nccgroup.com/media/0uspzge5/_ncc_group_whatsappllc_opaque_report_2021-12-10_v13.pdf)
covered opaque-ke v0.5.0, source `ba8e940e08a630c0d075e730623ebf0b30d4b9e2`,
draft03; principal retest v1.2.0 source
`6538ee30e118cfc99c1f5bff6d2c151e2eaffd2d`. Newer draft fixes were examined
in isolation, not a full newer-protocol audit. Its findings were fixed, but it
does **not** audit RFC9807/4.0.1, this lock, Argon2 profile, native signing or
Arthur's composition. Readiness section 18 records finding/patch lineage.
No applicable independent audit was found for the exact SPAKE candidates.

## 3. Threat model

Six uniformly generated decimal digits provide 1,000,000 possibilities (~20 bits).
An active LAN attacker can race, substitute observed keys, relay, replay,
disconnect and exhaust attempts. A five-guess bound is at most 5/1,000,000 for
one uniform code under the ideal PAKE model, not a proof about implementation
leakage, multiple installations or a compromised endpoint. A passive observer
must not obtain an offline guessing oracle. Code display/input and human
approval are trusted local actions. UI, monotonic live clock, fresh nonce
generation, peer-key acquisition and route selection are not implemented here.
Malware, memory/swap/crash dumps, database rollback and full device compromise
are outside the demonstrated online-attempt bound; independent policy is needed.
Exhaustion is a pairing denial of service. Restart is deliberately no reset.

## 4. Local transient registration and cleanup

The sponsor/admin/code issuer already knows the code and locally executes both
registration roles; no peer supplies registration messages. ServerSetup plus
ServerRegistration exist only inside `TransientVerifier`. The enrollment UUID
is the credential identifier, server identity is the issuer fingerprint, client
identity is default (its native key is bound in login context). This is an
engineering construction requiring review, not the usual remote-user model.

Challenge owns Zeroizing code memory; authentication borrows it. Unused export
keys and completed session keys are explicitly cleared; upstream states/record
and setup secret fields erase on drop. Successful `qualified()` drops the local
verifier before the durable handoff; the durable adapter erases challenge code
on success/expiry. Early errors require caller drop/cancel; a verifier has no
timer or ledger link and the raw lab API can perform unlimited authentication
outside reservation. No production caller exists. Any future live owner must
enforce reserve-before-crypto and teardown on every terminal path, disconnect,
expiry and shutdown. Upstream KSF input and Argon2 working allocations are not
proven fully erased. No heap-erasure or side-channel certification is claimed.

## 5. Complete executed sequence and endpoint knowledge

1. Disposable native admin owner creates a signed network root and starts a
   boot epoch. Issue creates one challenge; reserve durably charges one attempt
   and creates a unique ticket **before** cryptographic work.
2. Sponsor and joiner complete mutual TLS1.3 over memory buffers, using their
   actual CNG/Keystore keys and exact observed raw SPKIs. TLS role is independent
   of authority: either endpoint can be TLS server. No sockets exist.
3. The lab constructs the public Context: enrollment, reservation UUID, network,
   admin fingerprint/full key, sponsor/issuer/joiner keys, both nonces, suite and
   explicit TLS/PAKE roles. Sponsor=issuer=admin is the only accepted profile;
   OPAQUE server=sponsor, client=joiner. Non-admin sponsorship refuses with N2.
4. Local confidential RegistrationRequest -> RegistrationResponse ->
   RegistrationUpload creates transient setup/record. Nothing is sent remotely.
5. Joiner creates/serializes KE1; server parses it and returns serialized KE2
   using that record, issuer identity and context digest.
6. Client parses KE2 and verifies server confirmation against its own digest
   before returning KE3. Server parses KE3 and verifies client confirmation.
7. **Same-process oracle:** harness compares the two session keys and constructs
   private-field ConfirmedExchange only after both completions. Neither remote
   endpoint can perform that comparison. Client finish does not prove KE3
   delivery/acceptance. No final network acknowledgment, remote acceptance or
   two-process state machine has been implemented or proven.
8. `Attempt.finish_qualified` checks expected context/key/exporter binding and
   consumes its local attempt; QualifiedPending still refuses grant. Existing
   owner `record_qualification` checks exact active ticket, boot, deadline,
   native admin anchor and root, then stores candidate key/public digest.
9. A separate explicit local approval checks exact candidate/digest, original
   deadline, boot and admin key; signed grant application and consumed state
   commit together. Receipt/resume use the existing signed owner path, not a
   new PAKE session factory. Joiner-side UI/acceptance remains unqualified.

## 6. TLS/context composition

Lab assurance is **ObservedKeyPossessionOnly**, never stored trust/membership.
Exact pin verification and CertificateVerify demonstrate possession of the
observed key; these pins are injected by one-process fixtures, not discovered
through an approved bootstrap protocol. The actual rustls RFC9266 exporter is
32 bytes, label EXPORTER-Channel-Binding, empty context, equal at both ends.
Context digest is SHA256(domain || canonical JCS(public context, exporter));
OPAQUE confirms it. Approval digest hashes a separate domain, context digest
and SHA256(canonical(KE1,KE2,KE3)). This public digest is not a key schedule.
Reverse TLS roles do not change admin authority. Exporter/key/context/role and
reservation substitution reject. One-process fixtures also supply both peers'
expected network/admin/nonces; how each device obtains and validates them must
be reviewed. Test equality is not a distributed agreement proof.

Native adapter signs the complete RFC8446 preimage, SHA256 exactly once, offers
only ECDSA_NISTP256_SHA256 and validates DER/P256. Existing CaptureStore lock
orders exact-key reopen/sign/verify and invalidation. TLS lab forbids TLS1.2,
resumption/tickets/early data and requires mutual signatures. It supplies no
certificate-discovery or production policy. Native signing success grants no
membership or Sync access.

## 7. Durable accounting, failure and crash recovery

One CaptureStore connection/mutex and IMMEDIATE transactions own all rows.
Five device-wide attempts and eight issuances survive startup; active challenge
is unique. Failed crypto never refunds a reservation. Restart cancels
issued/reserved/approval and retains counters; secret states do not resume.
Original 120-second deadline is rechecked at reservation, proof and approval;
observed clock regression durably expires. Application-level atomic-fault tests
roll back membership/update/consumed state together. These tests do not establish
filesystem durability under power loss or rollback resistance.

**Fixed important finding E3A3:** the old context omitted ticket identity, so an
old success could be submitted under a newly reserved ticket. Regression failed
before correction. Reservation UUID is now authenticated in Context and matched
to ticket.nonce during handoff; replay rejects without approval/membership and
both charged attempts remain. No SQL schema change was needed.

## 8. Compromise and information persistence

Code theft permits online participation during its lifetime; both-endpoint or
setup+record compromise permits offline code enumeration. Argon2 raises cost;
it does not establish that six-digit enumeration takes longer than 120 seconds.
The record excludes the OPRF seed: record-only theft does not supply the secret
needed for straightforward recomputation of password mappings. Setup-only theft
supplies that OPRF capability and AKE key, but not the stored envelope used to
validate guesses; access to captured protocol material changes the analysis.
These are structural observations, not isolated-theft security proofs. The
reviewer must assess each with available captures and endpoint state. The
[RFC's storage/hardening analysis](https://www.rfc-editor.org/rfc/rfc9807.html#section-10.11)
explicitly allows offline enumeration after full server compromise; no such
resistance should be inferred merely from augmented PAKE.
Native device-key theft and admin compromise have separate revocation/policy
consequences. Test public vector secrets are intentionally public fixtures.

Reviewed writes store public keys, IDs, counters, clock/state, signed updates,
approval digest and grant bytes only. No code/verifier/PAKE session/private key
is serialized to SQLite; wrappers have no Debug/Serialize and errors are
categorical. Source/dataflow review establishes the intended write/log paths,
not absence of OS dumps, compiler copies or all future logging. Private native
keys remain in the platform provider; PAKE secrets exist in Rust memory.

## 9. Advisory reachability and upstream remediation

[RUSTSEC-2026-0387](https://github.com/rustsec/advisory-db/blob/main/crates/crypto-bigint/RUSTSEC-2026-0387.md)
remains open for locked crypto-bigint 0.5.5. It concerns timing leakage in integer
operations; the published patched range starts at 0.7.6. Release
[PR1365](https://github.com/RustCrypto/crypto-bigint/pull/1365) incorporates
constant-time fixes (including PR1358/1360 and equality/inversion changes).
New 0.7.7 also exists; neither fits elliptic-curve's 0.5 requirement. Registry
inspection found latest compatible elliptic-curve 0.13.8 / bigint 0.5.5; no
compatible patched release. OPAQUE 4.1.0-pre.2 still requires elliptic-curve 0.13
and voprf 0.5. Both OPAQUE and voprf require elliptic-curve unconditionally, which
requires bigint unconditionally. Disabling optional curves/defaults cannot remove
this package through supported features. No fork, override, patch or waiver.

**Static selected-path conclusion, not independent non-exploitability proof:**
OPAQUE `key_exchange/group/ristretto255.rs` implements 3DH point/scalar arithmetic
with dalek and delegates OPRF group functions to voprf Ristretto. voprf
`group/ristretto.rs` uses dalek for multiply, inverse, reduction, equality and
encoding. Its elliptic-curve use is ExpandMsgXmd/Expander: inspected
`hash2curve/hash2field/expand_msg.rs` and `expand_msg/xmd.rs` use hashes, byte XOR
and public lengths, no bigint calls. Secrets enter these hashes, but not the
advisory's integer operations. No selected registration/login secret-data path
to bigint subtraction, zero counting, division, Montgomery multiply or the
newer UintRef/BoxedMontyForm APIs was identified. Generic Weierstrass group
implementations exist but are not instantiated by EnrollmentSuite; TLS P256 is
ring/CNG/JCA, not that PAKE implementation. No target-specific CT/binary analysis
was performed. This narrows suspected exposure without dismissing the finding.

`verify-isolation.ps1` checks four actual locked trees with positive controls:
Windows default normal/build absent, Windows dev present; Android default
normal/build absent, Android instrumentation feature present. OSV checks the
entire 69-package qualification closure; it is not a whole-application audit.
Source evidence is pinned to the lock and named upstream files; any suite,
feature or dependency change invalidates this reachability conclusion.

## 10. Questions for an independent reviewer

- Accept balanced SPAKE2 as the preferred model, and specify an audited exact
  implementation/profile or reject it because of audit/encoding/confirmation gaps?
- If reconsidering OPAQUE, is this issuer-local registration/identifier/Argon2
  construction justified, and what current-revision audit scope is required?
- Verify selected-path advisory reachability independently and require a
  supported upstream remediation; what additional target CT evidence is needed?
- How must two independent endpoint state machines authenticate initial observed
  keys, expected admin/network, nonces, exporter, reservation and final delivery?
- Is durable human approval tied to the right device/UI intent, and what are
  the grant receipt, retry, disconnect and reverse-enrollment semantics?
- Are attempt limits/deadlines/rollback assumptions adequate for a six-digit
  code, and which secret-buffer lifetimes require stronger guarantees?

## 11. Explicit N1 disposition criteria

Approve only after an independent reviewer accepts an exact maintained audited
implementation + locked features/dependencies, resolves the open advisory through
supported upstream remediation, reviews mutual confirmation and complete
distributed TLS composition, and accepts six-digit accounting/compromise/cleanup
assumptions with corresponding vectors, failure and native-platform evidence.
Reject or defer if any such condition lacks evidence, if a remote endpoint uses
the same-process oracle as authentication, if initial key possession becomes
membership, if attempts can be refunded/replayed, or if private material persists.

**Current disposition: defer N1; do not activate or start E3B.** N2 sponsorship,
N3 enrollment UX/retries, N7 route/certificate/session policy and G4–G7 remain
separate approvals. Production remains schema9, dormant M05, ClosedTrust,
PAKE/TLS/LAN closed, no VerifiedSession factory/live enrollment/second SQL owner,
G4 UnverifiedBounds; frozen journal/reducer/codec/snapshot2/D4/routes unchanged.
