# Owner decision — corrected-binary recovery

**Approval status: OWNER ACCEPTANCE REQUIRED. Selected option: UNDECIDED.**
Recommendation: **Option A for the physically tested Windows scope**. This
document requests a decision; it does not enact one. Original-beta G10 stays
historical P1 FAIL. G10-R stays a successful synthetic Windows experiment.

| Option                                               | Benefit                                                                                                                                      | Cost / boundary                                                                                                                                                                                                |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: corrected-binary restore                          | Physically validated; retains startup correction, historical data, exports, four DPAPI credentials and preferences; published beta unchanged | Matching verified stopped backup; compatible same-account/machine secure storage; no old-executable downgrade; native evidence outstanding; data/profile swap spans filesystems                                |
| B: separately versioned beta-derived recovery binary | Could retain more original executable lineage                                                                                                | Another maintained binary, exact-source builds and full compatibility/host acceptance; distinct version/name required; never replace or impersonate beta; no demonstrated need or implementation authorization |

Option A target: exact I1 Desktop/runtime source
`c78faa74717b0f430a859730e98c3c4915e7b03f`, with the Windows archive and manifest
checksums in the [candidate lock](v1-phase-5-3-candidate-lock.md). Supported
scope **if approved**: Windows11 x64/WSL2, same Windows account/machine/DPAPI
context used to create the backup. Native CachyOS remains excluded from an
adopted support claim until its actual GUI/keychain/recovery receipt is accepted.

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
availability.** Approving A would explicitly supersede that recovery route
within the stated scope, while preserving original G10 FAIL. Rejecting A leaves
the release recovery disposition unresolved. B requires separate owner scope.

| Owner approval field                                               | Value                     |
| ------------------------------------------------------------------ | ------------------------- |
| Adopt A / request separately scoped B / reject                     | OWNER ACCEPTANCE REQUIRED |
| Approved exact target and archive checksum                         | OWNER ACCEPTANCE REQUIRED |
| Approved hosts and secure-storage/backup boundaries                | OWNER ACCEPTANCE REQUIRED |
| Original G10 disposition acknowledged                              | OWNER ACCEPTANCE REQUIRED |
| Evidence reviewed / anonymous approver / date / decision reference | OWNER ACCEPTANCE REQUIRED |

No decision here authorizes Phase6, an RC, version/tag/publication or a PR merge.
