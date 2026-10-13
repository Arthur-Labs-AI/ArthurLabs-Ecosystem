# Phase5.2 — G10-R corrected-binary recovery validation

**Windows G10-R PASS: validated proposed recovery candidate pending owner
adoption. Original-beta G10 remains historical P1 FAIL. Phase6 NOT AUTHORIZED.**
No production correction was necessary. This bounded task adds acceptance-only
fixture/backup verification tests, a recovery contract, native operator handoff
and sanitized evidence. It does not adopt a replacement rollback policy.

## A. Root cause and decision

The immutable beta loads credentials before Electron readiness. The historical
independent beta→D→beta observation remains false→true→false for credential
availability, with ciphertext and historical rows intact. I1 already waits for
app readiness and correctly loads DPAPI credentials. Modifying the beta or
exporting plaintext keys is unnecessary. Prefer recovery of a verified stopped
beta data/profile pair under the exact corrected I1 Desktop/runtime, rather than
claiming a successful downgrade to the broken beta executable.

The owner authorized evaluating this route in disposable fixtures. Successful
testing is not owner adoption of the supported recovery policy. A beta-derived
patch would add a separately versioned maintenance target and is not recommended
without a new requirement that the old code lineage must be restored.

## B. Repository and implementation scope

Fresh fetch/prune confirmed dev `8bbe8bab34d704eb3f021fbb3203d1bd1d983f8d`,
owner-merged PR18 at 2026-10-13 17:31:57 UTC, head
`255af881c6f32a87bf0aeca094172dc1a06fe1b6`. Post-merge
[CI38439418803](https://github.com/Mert1026/Sentry/actions/runs/38439418803)
completed SUCCESS for quality and both required launcher jobs. No open PR existed
at task start. Main remains `4fd2be9fa3b17370841dbb1d2f0422a2150c62d8`;
the immutable beta tag/source are unchanged. The dirty primary checkout was
preserved, and the clean task worktree branched from dev as
`fix/v1-g10-recovery-acceptance`. `shux contract` was attempted but unavailable;
status, ledger and handoff are maintained directly.

Dev's executable source, lockfile and distribution implementation are identical
to I1. Beta and I1 migration definitions are also identical. **No production
files, schemas, SDK pins, models, independent-agent flow, protocol or update
channel behavior were modified.** New files under scripts/distribution/tests:

- recovery-history.mjs creates a fresh synthetic beta fixture using the existing
  beta CLI/project/simulation/export/issue APIs and schema-validated repository
  retest persistence. It never accepts an owner database or invokes paid providers.
- recovery-backup.mjs verifies an explicitly marked temporary fixture bundle,
  schema/integrity/lineage/export and component hashes. It never restores files,
  decrypts credentials or activates a runtime. Scratch SQLite inspection avoids
  modifying a read-only WAL backup. New seals refuse existing receipts.
- recovery-backup.test.mjs regresses successful verification and refusal of
  missing/changed/incomplete/mixed/schema/identity/active/uncheckpointed/symlink
  inputs, with original receipts and retained current state preserved.

These acceptance utilities are excluded by the existing archive payload
allowlist. The [recovery contract](v1-g10-recovery-contract.md) defines stopped
writers, WAL handling, paired generation markers, staged copies, preserved
destinations and the non-atomic cross-filesystem restore boundary. Existing
bootstrap/maintenance/activation code was reused unchanged.

## C. Exact selected physical candidate

| Field                                     | Actual value                                                       |
| ----------------------------------------- | ------------------------------------------------------------------ |
| Recovery source                           | `c78faa74717b0f430a859730e98c3c4915e7b03f` (I1)                    |
| Source tree                               | `8bbaab4a5d1f7830dcf4ed7b4c40362c62f8d71d`                         |
| Product/Desktop/runtime version; protocol | 0.1.0-beta.1; 1                                                    |
| Actual Windows archive                    | `sentry-0.1.0-beta.1-c78faa74717b-windows-x64.zip`                 |
| Windows SHA256                            | `ec5edec8a6b3f8ef18bafd961e66c59f80669804cc98d30e0cb10ef18c527d1e` |
| Windows distribution.json SHA256          | `cd8f0a536e1e76a89413826f5c5367f40f99e3c2817106c81bbd8932698a6cdc` |
| Native-handoff archive                    | `sentry-0.1.0-beta.1-c78faa74717b-cachyos-x64.tar.gz`              |
| CachyOS-targeted SHA256                   | `5bd3642ed392607a010078be35885d1cff45db162a2841ee374be228275e89d8` |
| CachyOS distribution.json SHA256          | `e79b4d8836394c6cfc87c573b71d1e500f3334cc5d7947c4daf07dcef3ae9a86` |
| Published beta source used to seed        | `0e5c10cfa80f6385ebfc88a7306b38ce8a12ce38`                         |

The existing unsigned I1 archives were rehashed and their extracted manifests,
component identities and inventories reverified: Windows332/CachyOS-targeted333
files. They were not rebuilt or relabeled. Their original build provenance is
in [Phase5.1](v1-post-merge-acceptance-c78faa7.md). New receipt-PR distribution
artifacts have distinct source/identity and do not inherit this physical result.

## D. Populated historical fixture and complete comparison

New synthetic fixture generation `1541147e-968c-4404-8279-2ebd36a4c65f`.
Sealed beta-backup receipt SHA256:
`ea59de25fe938b980ef11a7375cefbc20191b1952b7ce477a0116f8cdfcc3c5f`.
SQLite schema fingerprint:
`c7c7c1eef023f9eb8de15ca3d3a18ecaac5b4530f18e94d61a5894d462bfe7a8`;
applied migrations1–6, integrity_check=ok, foreign_key_check empty, checkpoint
busy0 and no nonempty WAL/journal. Unreleased leases and active runs are refused.

The beta CLI imported/updated two actual synthetic sources and ran two existing
deterministic three-agent simulations. Real run/snapshot/artifact/export code
created the data and bytes. One historical merge and issue ingestion populated
compatibility lineage only. A completed legacy retest row was schema/API-seeded
against those actual source/target runs, snapshots, revisions, issue, merge and
cluster. **This is historical persistence coverage, not a real provider retest.**

| Entity / material                     |    Stopped beta |      I1 upgrade |   G10-R restore |        Restart1 |        Restart2 | Repeated restore |
| ------------------------------------- | --------------: | --------------: | --------------: | --------------: | --------------: | ---------------: |
| Projects / managed copies             |           2 / 2 |           2 / 2 |           2 / 2 |           2 / 2 |           2 / 2 |            2 / 2 |
| Revisions / contexts                  |           4 / 4 |           4 / 4 |           4 / 4 |           4 / 4 |           4 / 4 |            4 / 4 |
| QA runs / AgentRuns                   |           2 / 6 |           2 / 6 |           2 / 6 |           2 / 6 |           2 / 6 |            2 / 6 |
| Findings / evidence                   |           6 / 6 |           6 / 6 |           6 / 6 |           6 / 6 |           6 / 6 |            6 / 6 |
| Issues / occurrences / events         |       1 / 1 / 1 |       1 / 1 / 1 |       1 / 1 / 1 |       1 / 1 / 1 |       1 / 1 / 1 |        1 / 1 / 1 |
| Retests / assessments                 |           1 / 0 |           1 / 0 |           1 / 0 |           1 / 0 |           1 / 0 |            1 / 0 |
| Snapshots / artifacts                 |          2 / 10 |          2 / 10 |          2 / 10 |          2 / 10 |          2 / 10 |           2 / 10 |
| JSON / log export records             |           2 / 2 |           2 / 2 |           2 / 2 |           2 / 2 |           2 / 2 |            2 / 2 |
| Encrypted credential fields           | 4 secure/stored | 4 secure/stored | 4 secure/stored | 4 secure/stored | 4 secure/stored |  4 secure/stored |
| Non-secret model preference           |         present |           equal |           equal |           equal |           equal |            equal |
| Released runtime-instance bookkeeping |              13 |              14 |              14 |              15 |              16 |               14 |

All canonical table row fingerprints match, not merely counts. The entire
22-file managed projects/revisions/snapshots/events/artifacts/export inventory
is byte-identical. Credential-store and model-prefs file hashes match exactly.
Only released runtime-instance bookkeeping and ordinary Chromium profile cache
changes are excluded from canonical equality. Runtime instance growth is shown
explicitly; no historical record mismatch was waived. Both original sources,
the sealed backup and each preserved candidate generation remain private/intact.

Representative project `proj_01M4V68FQ70MYMTM7MBV7F71HB` has:

| Snapshot / revision                                                  | Content hash                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `snap_01M4V68G128RK9ZYQAH6RV4FTW` / `rev_01M4V68FQ70N4WR7TDTR91FC7B` | `017a3edc9e2f644b2ff84d78ea0dc7e5add1748777e990abf59b6b08e0b1f345` |
| `snap_01M4V68GSMFJ8MZ48CX7208RFK` / `rev_01M4V68GKPJ7GV2KNZTF56Q3YH` | `b8d41feaf30e30dd2aea6bbdbdfe2ac2da531f35a1e03e64a806c08a1be7e9fe` |

Actual export SHA256s, equal at every comparison above:

| Run                              | Format | SHA256                                                             |
| -------------------------------- | ------ | ------------------------------------------------------------------ |
| `run_01M4V68G0FEZ48W2D4TCNAZR1X` | JSON   | `ed2dd46d6bc0d1c59a8c74e8df6068654a431085748a85e4095bf60aa2e4932f` |
| Same                             | log    | `be5277650591b3448795cb17c920e4b7763b66a0b6917249a06b2d66e94cc899` |
| `run_01M4V68GRZJA17B60DS5728QQF` | JSON   | `a0c465665118b040de88a787f448f30e45c3616fd77451d076214953121f803a` |
| Same                             | log    | `d6c1ee4e81f7ac8215931a492408fa2001de3284e2c79c9e9059ca2432c6cb69` |

Private receipts retain all representative AgentRun/finding/evidence/issue/retest/
merge/cluster IDs, checked source/target lineage and full file maps. No raw DB,
credential store, plaintext secret, ciphertext or identifying path is committed.

## E. Actual Windows/WSL sequence and security failures

Prepared Windows/WSL Ubuntu, real Electron36.2.1 DPAPI and packaged I1 Desktop;
not a clean Windows VM. Historical beta uses its immutable built source Electron
entry because the published beta has no packaged release assets. Four synthetic
secrets and the model preference were saved through its real application service.
Every launch proves the explicit disposable profile before credential IPC and
clears inherited managed provider variables. Production preload/renderer/service
and runtime RPC are exercised; no security sandbox is disabled.

An I1 runtime was prepared in advance in a disposable HOME using the unchanged
full bootstrap. Beta was explicitly pinned to its separate beta runtime while
seeding. The stopped beta data/profile were copied and sealed before I1 opened
them. Upgrade compares the complete inventory. Subsequent controlled activation
failure and successful repeat setup exercised pointer rollback/unique staging
after that backup; recovery then used the newly validated I1 current target.
The owner's current pointer was never changed.

Recovery copies were staged before destination changes. Existing live fixture
data/profile were renamed into unique preserved directories, and the matching
stopped backup pair restored at its original paths. The real corrected pair
reopened history and cached exports, reported all four configured/secure/stored,
and retained the exact preference. Complete stop and two fresh processes repeated
those observations. A second full recovery restore also passed. Actual Desktop
and owned runtime exits, held-profile diagnostic refusal and post-stop
presence-only diagnostic success were observed, with no secret values returned.

| Required failure scenario    | Actual observation / scope                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Missing backup               | Verification refused; original backup retained                                                                    |
| Incomplete backup            | Missing credential file rejected before restore                                                                   |
| Corrupt backup               | Changed SQLite bytes rejected; no destination mutation                                                            |
| Mismatched candidate version | Actual runtime-check refused version9.0.0; current unchanged                                                      |
| Unsupported schema           | Copied backup with extra schema table refused                                                                     |
| Unreadable encrypted entry   | Separate copied real DPAPI profile reports unavailable, not missing; other ciphertext preserved                   |
| Missing OS backend           | Controlled credential regressions PASS; actual supported unavailable-backend session ENVIRONMENT UNAVAILABLE      |
| Active Desktop               | Held-profile diagnostic refuses, owning Desktop remains running                                                   |
| Active runtime               | Actual production maintenance refuses while packaged runtime is alive; no signalling                              |
| Failed activation            | Real bootstrap with controlled second-probe failure exits71 and restores previous current; prior runtime retained |
| Repeated recovery            | Actual second restore/reopen passes canonical/export/profile equality                                             |
| Existing destination         | Explicit existence guard refuses copy-over; successful route first preserves the stopped pair                     |
| Failed restoration           | Real copy into blocked staging path fails before swap; source backup and current data retained                    |

The backup verifier's read-only refusals do not claim atomic data/profile
restore. Copy/swap is an explicitly guarded manual procedure. An interrupted
cross-filesystem swap remains stopped for generation inspection; this task
tested a pre-swap filesystem failure and post-activation runtime failure, not
an actual power loss during the two-component swap. No plaintext fallback.

## F. G01–G10 and G10-R verdicts (new W3 campaign, exact I1)

| Gate         | Windows-scoped verdict        | Actual evidence / remaining boundary                                                                                                                               |
| ------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G01          | PASS                          | Full owned shutdown, SQLite checkpoint/integrity/FK, sealed paired backup                                                                                          |
| G02          | PASS                          | Complete populated inventory/IDs/lineage/snapshot/export hashes                                                                                                    |
| G03          | PASS                          | Rehashed actual archive, complete manifest, runtime pre-activation hello                                                                                           |
| G04          | PASS                          | Unchanged real bootstrap, disposable HOME, validated atomic current                                                                                                |
| G05          | PASS                          | All canonical records, immutable material, four actual exports, four secrets and preferences retained                                                              |
| G06          | PASS                          | Actual corrupt archive and real-runtime version mismatch rejected                                                                                                  |
| G07          | PASS, controlled failure      | Real installer rollback after injected post-activation validation refusal                                                                                          |
| G08          | PASS                          | Actual repeated setup uses a different validated directory and preserves prior target                                                                              |
| G09          | PASS, deterministic scope     | Real coordinator's active simulated QA causes actual maintenance refusal, then durable cancellation settles cancelled; packaged idle-runtime refusal also observed |
| Original G10 | Historical P1 FAIL            | Immutable beta readiness limitation remains; no success relabel or new waiver                                                                                      |
| G10-R        | PASS, Windows synthetic scope | Actual corrected-binary restore, complete comparison, two fresh restarts and repeated restore; owner adoption pending                                              |

G09 used the existing FakeHarness registry with a real persisted active run,
real lease/coordinator and actual production maintenance scanner in a disposable
runtime process. No provider was called. Funded active-provider/packaged UI
acceptance remains separately OWNER ACCEPTANCE REQUIRED. Native CachyOS G rows
are ENVIRONMENT UNAVAILABLE until the [operator handoff](v1-g10-recovery-cachyos-handoff.md)
is actually executed. Historical D/W1/C1 rows/counts remain untouched.

## G. Automated results and retained attempts

| Gate                                                                                        | Actual result / receipt                                                                                   |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Approved dev8bbe8ba frozen install, hygiene, format, lint, typecheck, build                 | PASS; phase52-baseline-linux.log                                                                          |
| Approved dev8bbe8ba uncached serial full WSL                                                | 1,236 PASS/16 skips;40 successful tasks                                                                   |
| Windows Desktop, fresh isolated TEMP/TMP                                                    | 400 PASS/2 skips; phase52-desktop.log                                                                     |
| New backup regressions, Windows                                                             | 14 PASS/2 symlink skips; phase52-backup-final-win.log                                                     |
| New backup regressions, Linux                                                               | 16/16 PASS; phase52-backup-final-linux.log                                                                |
| Separate actual systemd trust                                                               | 8/8 PASS; phase52-real-trust.log                                                                          |
| Existing installation/security/launcher regressions and final-head static/full-suite checks | Exact commands/conclusions in the PR final receipt                                                        |
| PR CI/distribution                                                                          | Final exact head/proposed-merge identities and completed job conclusions recorded in PR body/final report |

Retained attempts include RED before the verifier existed, the initial SQLite
read-only sidecar issue and an invalid test-only runtime-row insert; both were
fixed without weakening assertions. The deterministic active-run harness first
used the wrong cancellation API, then a synchronous convenience API; its final
run uses the existing durable request API and settles cancelled before releasing
the lease. These were acceptance-harness errors, not reproduced product defects.
An inline WSL extraction-verification invocation lost its quoted variable; the
same retained CachyOS artifact verified through an explicit path on retry.
All failed logs remain private; no failure was converted into PASS.

Final verifier review reproduced and corrected two acceptance-tool defects:
root marker symlinks could be read before regular-file validation, and a file
named **proto** could be omitted by an ordinary object map. Two tests failed
before correction and pass afterward. Markers/receipts now require regular
files, and inventory maps preserve special property names. The verifier's
serialized receipt shape and the sealed physical backup remain compatible.

Principal private receipts: phase52-history-final.log, phase52-physical-beta.log,
phase52-physical-upgrade.log, phase52-physical-restore.log,
phase52-physical-restarts.log, phase52-physical-repeat.log,
phase52-activation-faults.log, phase52-backup-faults.log,
phase52-unreadable-physical.log and phase52-active-maintenance-final.log.

## H. Native handoff, owner adoption and remaining blockers

The executable [CachyOS handoff](v1-g10-recovery-cachyos-handoff.md) supplies exact
archive/hash, prerequisites, reviewed tool/beta builds, native launch/keychain
checks, real sandbox tests, fixture creation, stopped backup/checkpoint, guarded
recovery, data/export comparison, repeated restart and sanitized evidence rules.
It is unexecuted here; no Ubuntu result is called native acceptance.

| Category                                | Remaining requirement                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reproduced current production defect    | None newly reproduced; no application correction necessary                                                                                              |
| Historical beta limitation              | Original G10 P1 FAIL stays in the record                                                                                                                |
| Owner policy decision                   | Explicitly adopt/reject exact I1 corrected-binary recovery and its supported-host scope; Windows G10-R technical success alone does not close this gate |
| Missing physical/environment acceptance | Native CachyOS/keychain, clean Windows provisioning, actual unavailable backend and remaining A–F scenarios                                             |
| Owner-controlled acceptance             | Real-profile observation, funded Full/Targeted/provider matrix and active-provider recovery; exact attribution of the supplied owner Full3/3 export     |
| Process                                 | Owner PR review, procedural main/dev protection limits, remaining evidence acceptance/feature freeze and Phase6 authorization                           |

No branch deletion, owner credential access, main change, tag/version/release,
self-merge or Phase6 action occurred. Stop at owner review. G10-R is a validated
proposed recovery candidate pending owner adoption, not an approved replacement
for original-beta rollback policy.
