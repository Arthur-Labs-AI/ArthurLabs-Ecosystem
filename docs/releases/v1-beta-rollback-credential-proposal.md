# G10: beta rollback credential availability — correction proposal

Status: **P1 acceptance blocker; G10 FAIL on W1, 2026-10-13**. The affected
rollback track is stopped. No candidate or beta production code was changed.
See the [campaign receipt](v1-owner-acceptance-execution.md) and
[W1 results](v1-owner-acceptance-w1-d250e4c.md).

Phase5.1 reviewed these retained failure/control receipts after owner-merged
PR17/16. [New I1 credential acceptance](v1-post-merge-acceptance-c78faa7.md)
does not retest or repair the original beta rollback target. G10 stays FAIL.

## Reproduction and controls

1. Build the immutable source beta at
   `0e5c10cfa80f6385ebfc88a7306b38ce8a12ce38`. Create disposable beta-layout
   Linux data and an explicitly isolated Windows Electron profile on the same
   OS account. Seed synthetic history and a synthetic DPAPI credential through
   the real beta Desktop. Stop both components and back up data/projects/profile.
2. Open candidate `d250e4cabdae7735af5905146db8d7806fe4427c` from the W1 archive
   (`01e6590c78f6456ee7a4c273ac76369e42d1d17fc0b817f2dcbb28fc3accc7c6`).
   Historical records reopen and provider status reports stored/secure/configured.
3. Stop candidate. Preserve its data/profile separately. Restore matching stopped
   beta database, projects and encrypted profile together; use beta Desktop and
   beta runtime. Beta status reports the credential unconfigured: the normal
   Desktop continuity assertion fails (`false !== true`).
4. Independently launch beta → candidate → beta against that restored profile,
   using presence-only status and historical read IPC. Outcomes are false → true
   → false for credential configured. Ciphertext is byte-identical throughout.
   Completed run, finding, evidence, issue and retest remain readable each time.
   No credential value is returned by the observation script.

Private retained receipts: `acceptance-upgrade-rollback.log` (initial FAIL),
`acceptance-rollback-independent.log` (independent repeated control),
`acceptance-history-counts-output.log` (read-only SQLite inventory). These names
identify private evidence, not public log attachments. No owner profile or real
provider credential was used. Candidate-created records were retained separately.

| Stopped fixture     | Projects | Revisions | QA runs / agent runs | Findings / evidence | Issues / retests | Exports |
| ------------------- | -------: | --------: | -------------------- | ------------------- | ---------------- | ------: |
| Beta backup         |        2 |         3 | 1 / 1                | 1 / 1               | 1 / 1            |       0 |
| Restored beta       |        2 |         3 | 1 / 1                | 1 / 1               | 1 / 1            |       0 |
| Preserved candidate |        3 |         4 | 1 / 1                | 1 / 1               | 1 / 1            |       0 |

The candidate added one disposable import/revision. Existing export-byte
preservation was not tested because this fixture contains zero exports.

## Cause and severity

Beta `apps/desktop/src/main/index.ts` calls `bootstrapDesktop()` before
`app.whenReady()`. Beta `apps/desktop/src/main/bootstrap.ts` immediately calls
`credentials.load()`, before the OS secure-storage bridge is ready. The selected
candidate already contains the Phase 4 app-ready correction. The same-account
candidate decrypt control rules out lost ciphertext and a generally unavailable
W1 DPAPI backend.

This is a reproduced historical beta startup limitation, **not a newly introduced
candidate regression**. It is P1 for this mandatory supported rollback gate:
the restored previous installation loses usable provider configuration despite
retaining its encrypted store. No credential disclosure, destructive data loss,
isolation escape, or new P0 defect was demonstrated. G10 cannot pass on preserved
files alone. The original beta standalone diagnostic was skipped; this failure
comes from normal Desktop status, not that historical diagnostic defect.

## Smallest bounded next action, requiring owner disposition

Retain the private stopped backups and candidate-preserved copies. Do not
recommend downgrading to the immutable beta as an accepted credential-continuity
procedure while this failure remains unresolved. Do not move its tag, modify its
release, export/decrypt keys, or silently ask users to re-enter owner credentials.

The owner must choose a supported rollback policy or authorize a separate narrow
recovery correction. A possible policy is a specifically identified Desktop/runtime
pair that already waits for secure-storage readiness, together with a compatible
matching stopped backup. That alternative is **proposed, not accepted or tested
as a replacement G10 target**. A beta recovery patch would instead require a new
distinct source/artifact identity; it must never be relabeled as the published beta.

Any authorized code correction starts on a normal task branch from dev and gets
regression coverage, new exact-SHA CI/artifacts, real DPAPI upgrade/restart tests,
and G01–G10 re-evaluation against the explicitly approved rollback target. Native
Linux secure storage needs independent native-host evidence. Existing D artifact
results cannot be transferred to changed binaries. Until the owner resolves the
procedure and actual retest passes, upgrade/rollback remains FAIL and Phase 6
cannot be recommended.

## Phase5.1 recommended owner disposition (proposal only)

Prefer an explicitly named **recovery restore**, using the exact I1
Desktop/runtime pair `c78faa74717b0f430a859730e98c3c4915e7b03f` and its
[recorded unsigned artifacts](v1-post-merge-acceptance-c78faa7.md#c-exact-unsigned-candidate),
over building another beta patch. This needs zero new production code. It
retains the readiness and transactional credential corrections and can restore
a matching stopped data/projects/profile backup on the same account/keychain.
It is a proposed change from restoring the old binary to restoring prior data
under a validated recovery binary, **not a successful downgrade to the beta**.
No supported recovery designation or rollback policy is adopted by this receipt.

Approval scope should name the exact Windows archive hash, matching runtime,
compatible backup source/schema, supported host, and recovery procedure. Before
calling it supported, use a separate disposable populated fixture with projects,
revisions, runs, findings/evidence, issues/retests and actual export bytes. Stop
all components; retain both the original stopped backup and candidate data;
restore the approved matching backup without mixing schema generations; start
the selected recovery pair; verify all inventory/lineage/export comparisons,
all credential presence and model preferences, then two full restarts. Repeat
applicable G01–G10 failure/refusal/activation cases under the approved policy.
Native CachyOS/keychain evidence remains independent. The Phase5.1 D→I1
credential/preference test is useful context but does not perform this recovery.

If the owner instead requires returning to beta behavior and code lineage, a
separately approved beta-derived recovery artifact would minimally delay
bootstrap/credential loading until app.whenReady, with a regression reproducing
the pre-ready load and real DPAPI restore/restart tests. Its own full SHA,
artifact identity, CI, compatibility review and acceptance are mandatory;
historical beta source/tag/release remain immutable. That route increases
maintenance and compatibility work, so it is the secondary option. No recovery
code, release/version change, key export or new target testing is authorized
by this recommendation. Owner disposition plus actual retest is still required.
