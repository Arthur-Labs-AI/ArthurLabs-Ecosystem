# Owner decision — corrected-binary recovery

**Approval status: OWNER APPROVED on October 14, 2026. Selected option: A.**
The project owner explicitly replied **"i choose A"** to the Phase 6.1 A/B/C
decision request in this chat. Option A is adopted only within its stated,
physically tested Windows/I1 scope and boundaries below. Original-beta G10 stays
historical P1 FAIL; native G10-R remains unverified. This policy decision does
not authorize an actual owner-data restore or an official RC cut.

| Option                                               | Benefit                                                                                                                                      | Cost / boundary                                                                                                                                                                                                |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: corrected-binary restore                          | Physically validated; retains startup correction, historical data, exports, four DPAPI credentials and preferences; published beta unchanged | Matching verified stopped backup; compatible same-account/machine secure storage; no old-executable downgrade; native evidence outstanding; data/profile swap spans filesystems                                |
| B: separately versioned beta-derived recovery binary | Could retain more original executable lineage                                                                                                | Another maintained binary, exact-source builds and full compatibility/host acceptance; distinct version/name required; never replace or impersonate beta; no demonstrated need or implementation authorization |

Option A target: exact I1 Desktop/runtime source
`c78faa74717b0f430a859730e98c3c4915e7b03f`, with the Windows archive and manifest
checksums in the [candidate lock](v1-phase-5-3-candidate-lock.md). Supported
scope **as approved**: Windows11 x64/WSL2, same Windows account/machine/DPAPI
context used to create the backup. Native CachyOS normal functionality is now
[owner-reported accepted](v1-owner-functional-acceptance-2026-10-13.md); full native
G10-R was not established by that statement. Native G10-R remains outside this
physically validated recovery support scope, pending separate evidence/decision.

Require a complete matching-generation stopped data/project/profile backup,
checkpointed database, no active run/retest/lease/GUI/runtime, verified inventory,
canonical payloads, snapshot material and real export hashes. Retain original
backup, source archive, previous runtime and displaced candidate generations.
Verify the full staged pair before either destination is moved. Follow the
[recovery contract](v1-g10-recovery-contract.md); no merge of profile generations,
plaintext credential fallback or automatic schema downgrade.

Beta/I1 migrations1–6 match. The verified schema fingerprint is
`c7c7c1eef023f9eb8de15ca3d3a18ecaac5b4530f18e94d61a5894d462bfe7a8`.
Unknown schema/generation/identity refuses before mutable opening/restoration.
This does not support copying encrypted credentials to different computers,
accounts or keychains. Unreadable/unavailable storage remains a visible failure.
Cross-filesystem data/profile replacement is not atomic; interrupted moves
require stopped inspection and selection of a complete preserved pair.

Required evidence: [Windows G10-R receipt](v1-phase-5-2-g10-recovery-validation.md)
and repeated full process restarts/restore; actual supported-host evidence for
each additional host, backup and staged verification, unchanged historical
payloads/exports and presence-only stored/secure statuses. Operator package
preparation and hosted CI do not satisfy native evidence.

**Original beta executable rollback remains unsupported for secure credential
availability.** Owner adoption of A supersedes that recovery route within the
stated Windows/I1 scope, while preserving original G10 FAIL. B was not selected
and would require separate owner scope.

| Owner approval field                                               | Value                                                                                                                               |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Adopt A / request separately scoped B / reject                     | A — explicitly selected by project owner                                                                                            |
| Approved exact target and archive checksum                         | I1 `c78faa74717b0f430a859730e98c3c4915e7b03f`; Windows SHA256 `ec5edec8a6b3f8ef18bafd961e66c59f80669804cc98d30e0cb10ef18c527d1e`    |
| Approved hosts and secure-storage/backup boundaries                | Tested Windows 11 x64/WSL2 scope, same account/machine/DPAPI, compatible schema and matching verified stopped backup generations    |
| Original G10 disposition acknowledged                              | Historical FAIL retained; corrected I1 route adopted within stated scope                                                            |
| Evidence reviewed / anonymous approver / date / decision reference | Linked historical evidence; project owner / October 14, 2026 / chat reply "i choose A"; independent document review is not asserted |

The explicit Phase 6.1 choice closes the recovery-policy decision gate for this
scope. No historical failure is relabeled PASS, no native recovery support is
inferred and no RC binary is substituted for the approved I1 target.

Phase6.0 preparation/version review was authorized separately. This decision
record does not authorize an official RC cut, main promotion, tag, publication
or PR merge. The new RC version is not silently substituted as the recovery target.
