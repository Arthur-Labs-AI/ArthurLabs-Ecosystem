# Sentry v1 Threat Model (Phase 5)

Phase5.3 evidence addendum: [final host preparation](../releases/v1-phase-5-3-final-host-acceptance.md)
confirms production-source equivalence to corrected I1 and new Windows presence
source/integrity/disconnect checks. Actual Windows DPAPI and proposed G10-R
evidence is retained separately from native keychain/clean-host/paid/owner-profile
gaps. No new secret-handling, persistence or runtime code is introduced. Earlier
candidate-specific boundary statuses below remain historical, not reassigned.

2026-10-13 finalization addendum: [preparation review](../releases/v1-pre-rc-acceptance-preparation.md)
records getter/Proxy fail-closed mapping, corrected registered Electron payload
coverage, and a reproduced synthetic fatal-screen secret reflection. Fatal
render now uses exact known environment-value scrubbing before the common cap;
unreadable host metadata cannot break classification. Earlier broad fatal-path
scrubbing claims were inaccurate and are superseded by this regression-backed
correction. Native OS crypto and packaged-host acceptance remain outstanding;
the [owner matrix](../releases/v1-owner-acceptance-results.md) contains no invented passes.

Date: 2026-10-13. Candidate audited: `origin/dev` `d628837` (PR #10 merge).
Method: source inspection of the implementation listed per boundary below,
plus executed fixture suites and real-host runs recorded in
`docs/releases/v1-phase-5-validation.md`. This model describes what the code
does — speculative threats without reproduction are marked as such.

Status key: VERIFIED (executed evidence on this candidate or an explicitly
cited run), REPRODUCED DEFECT (demonstrated, with failing test), UNVERIFIED
(not yet executed here), ENVIRONMENT UNAVAILABLE (required host missing),
OWNER ACCEPTANCE REQUIRED (paid/real-profile action), OUT OF SCOPE.

Out of scope for v1 (documented, not audited): macOS, generic Ubuntu Desktop
or other native Linux claims; provider account security and model-output
trustworthiness; physical device access; malicious Electron auto-update
(no auto-update channel exists).

## 1. Imported project -> managed project copy

Attacker-controlled inputs: the entire imported directory tree (file names,
contents, modes, symlinks/junctions, deep nesting), the source path string
(renderer/CLI-supplied).

Expected properties: the source tree cannot escape the data root; excluded
private/build dirs stay out; a failed import leaves no trusted state; two
imports cannot corrupt each other.

Existing controls (`packages/project-manager`, `packages/persistence`):
`validateSource` (must be a readable directory); `assertNoPathOverlap`
(canonicalized source vs data root, rejects containment either way);
copy into `staging/import-<rev>` then atomic `rename` to `working-copy`;
`DEFAULT_IMPORT_EXCLUSIONS` prunes node_modules/.git/dist/build/coverage and
harness-local state at any depth without resolving symlinks; `walkTree` uses
`lstat` and never descends into symlinks; import failure deletes the project
row and `rm`s the project root; update/delete use staged promotion with
operation journals and owner-checked recovery (ADR-0009).

Automated evidence: `project-manager.test.ts` (overlap rejection, exclusion
hashVersion, crash-during-promotion restore, retention-failure rollback,
atomic same-project run lock, delete tombstone recovery).
Real-host evidence: UNVERIFIED on this candidate (import smoke covered beta
history, not re-run here). Missing validation: TOCTOU on a source tree the
owner mutates mid-import — OUT OF SCOPE (owner-owned source, owner action).
Consequences of failure: foreign files inside the trust boundary; mitigated
downstream by snapshot hashing and workspace neutralization.
Reproduced defects: none. Status: VERIFIED (fixture).

## 2. Managed project -> immutable snapshot

Inputs: managed working-copy bytes and link topology.

Properties: manifest faithfully records bytes; links recorded, never followed;
retained material provably equals the revision record.

Controls (`packages/snapshot-engine`, `persistence/filesystem.ts`):
`snapshotEntry` hashes file bytes, and for symlinks hashes
`scope + NUL + target` (classification from `classifyLink`: internal /
external / broken via `realpath`+`stat`, Windows case-folded); manifest NDJSON
aggregated into `contentHash`; `retainRevisionMaterial` copies once to
`revisions/<rev>` with `inert-unsafe` links and `validateRetainedMaterial`
re-scans and compares hashes (copy completion alone is never trusted).

Evidence: `snapshot.test.ts` (stable order/hashes, no-follow hashing,
external/broken/cyclic classification, authoritative baseline hashes from the
stored manifest). Status: VERIFIED (fixture).

## 3. Snapshot -> isolated agent workspace

Inputs: snapshot bytes, per-run IDs, concurrent AgentRuns sharing one revision.

Properties: each agent gets a private writable copy; agents cannot reach each
other's workspaces, the managed baseline, or retained revisions; external
links cannot become writable escapes; cleanup removes only the owned tree.

Controls (`packages/workspace-factory`): per-`(project, run, agentRun)` paths
(`agentWorkspacePath`; IDs are Crockford-base32, filename-safe); `rm` +
`copyTree` with `inert-unsafe` (internal links rebased into the copy,
external/broken links become inert JSON descriptors under Sentry-owned
`.sentry-workspace/` with hash-named collision-free metadata); baseline hash
sidecar outside the agent-visible tree; `cleanup()` re-validates with
`resolveInside(dataRoot)` and only removes the `workspace/`-shaped parent.

Evidence: `workspace.test.ts` (independent copies, no mutable hardlinks,
cleanup escape refusal, internal/external/broken link handling, absolute-link
rewrite, metadata namespace, sidecar placement). Concurrent same-revision
execution is covered by run-engine parallel tests with per-agent attribution
asserts. Status: VERIFIED (fixture). Residual: a rapidly mutating source is
frozen at scan time by design; consumers must use the manifest, not re-scan.

## 4. Agent subprocess -> host filesystem

Inputs: model-generated shell commands, tool arguments, and file operations.

Properties: shells see only the owned workspace (+ toolchain); sibling
workspaces, the data root, developer HOME, and host mounts stay hidden;
missing sandbox tooling fails closed; bootstrap failures never masquerade as
command success.

Controls: OpenCode `bash` runs through a per-AgentRun generated `sentry-bash`
wrapper (`packages/harness-opencode/src/toolshell.ts`): bwrap `--ro-bind / /`
plus `--unshare-net`, scope HOME and private /tmp rebound, hide list = scope
dir + workspace parent (covers data root and siblings at any depth) + real
HOME as empty tmpfs, workspace rebound rw last; wrapper accepts only
`[-l] -c <script>` (exit 126 otherwise); missing bwrap/shell throws
`OPENCODE_SANDBOX_UNAVAILABLE`; explicit bypass (`SENTRY_OPENCODE_ALLOW_DIRECT`)
emits a warning diagnostic and is documented development-only. In-process file
tools are deny-listed and can only observe a dummy proxy credential. Claude
Code bootstrap failures (bwrap/bind/mount text without `is_error`) are
classified as infrastructure failure with `GLM_SANDBOX_UNAVAILABLE`, never as
exit 0 (`claude-sandbox-truth.test.ts`). Verifier replay uses the systemd
empty-root mount namespace (`packages/verifier/src/sandbox.ts`) with canary
preflight (work visible, peer + home markers hidden) and honest
`backend: 'none'` when units cannot start — never host fallback.

Evidence: scripted-adapter truth tests (deterministic, kernel-independent);
`opencode-path-sandbox.test.ts` (PATH-only resolution, containment failure
classification); 8 real systemd trust tests (`verification-trust.test.ts`:
host/peer escape, secret isolation, cwd containment, descendant cleanup).
Real-host evidence on this candidate: real WSL Ubuntu run recorded in the
validation report (8/8 target; ENVIRONMENT UNAVAILABLE on Windows/CI runners,
which run the non-mount remainder). Status: VERIFIED (fixture); real-mount
verdict per host in the validation report.

## 5. Agent subprocess -> network and providers

Inputs: model-chosen URLs/commands; provider credentials required for paid calls.

Properties: model-controlled shells have no network (not even loopback to the
host auth proxy); the OpenCode parent alone reaches providers normally;
credentials travel only through designed channels; no silent paid retries.

Controls: tool shells enter a fresh network namespace with no routes
(deny-by-default, no toggle); in-process tools see only a dummy proxy
credential; harness adapters own provider transport with typed errors;
run-engine performs no automatic retry of paid work (`RUN_MAY_HAVE_STARTED`
reconciliation instead of re-execution).

Evidence: `opencode-tool-network.test.ts`; adapter error-path tests; Phase 2
no-duplicate-run regressions. Live provider execution was owner-reported on
Windows/CachyOS for an earlier candidate — not re-run here.
Status: VERIFIED (fixture). Live paid-provider acceptance: OWNER ACCEPTANCE
REQUIRED.

## 6. Electron renderer -> preload/IPC

Inputs: every renderer-supplied ID, path, enum, and numeric option.

Properties: no Node access from the renderer; one explicit bridge; every
channel validated; secrets never cross to the renderer; destructive or
dialog-owned operations unavailable to external CLI callers.

Controls (`apps/desktop`): `nodeIntegration: false`, `contextIsolation: true`,
`sandbox: true`, single `preload.js` (source-asserted in
`ipc-contract.test.ts`); `DesktopChannelSchemas` strict-zod per channel with
length caps; `CLI_ALLOWED_CHANNELS` excludes provider-secret mutation,
distro selection, and dialog/reveal flows; `runs:export-reveal` only opens
session-saved destinations (`revealSavedExport` allowlist); export bytes come
only from canonical artifacts for the requested run+format; Save As
destination always comes from the native dialog, written atomically
(temp + fsync + rename, partial residue removed); router errors truncated to
1000 chars with codes; credential statuses carry presence only.

Evidence: `ipc-contract.test.ts` (isolation flags, channel schemas, CLI
allowlist, router dispatch, error mapping); export-save tests (dialog-owned
destination, atomic write, reveal allowlist). Status: VERIFIED (fixture).
Notes (no defect demonstrated): `providers:save` accepts the value over IPC
by design (user-typed secret, immediately encrypted); model-key status hints
expose non-secret values (base URLs, model IDs, binary paths — may include a
local username in a path) to the local UI only. `runs:start-production` is
accepted by the router/CLI but the renderer preload routes production starts
through `runs:start` with an identical handler — dead-channel parity, P3
cleanup at most, no privilege difference. Provider-SDK error text is passed
through truncated messages; no test shows a secret echoing there, but no
dedicated redaction assert exists — P3 gap (see findings).

## 7. Desktop -> Linux runtime

Inputs: platform selection, distro choice, data-root override, runtime stdout.

Properties: Linux-owned execution only; exact version/protocol identity for
packaged builds; no silent fallback to a mismatched runtime; maintenance
blocked while work is active.

Controls (`bootstrap.ts`, `distribution.ts`, host platforms): Windows-style
`SENTRY_DATA_ROOT` never forwarded to Linux (warning + Linux-managed root);
`assertRuntimeIdentity` enforces version+sourceCommit equality for packaged
boots and reconnects (mismatch refuses instead of reporting healthy);
runtime lease ownership with heartbeat/stale recovery; release-maintenance
marker blocks runtime start; runtime stderr diagnostics capped at 800 chars in
boot errors.

Evidence: handshake/identity unit tests; maintenance-refusal launcher tests;
runtime startup/recovery run-engine tests. Live handshake on a prepared host:
OWNER ACCEPTANCE REQUIRED for this candidate (historical acceptance exists
for earlier builds). Status: VERIFIED (fixture).

## 8. Runtime -> SQLite persistence

Inputs: concurrent workers, cancellation requests, crash/restart timing.

Properties: one run-lock owner; short atomic transactions; no lost partial
evidence; cancelled runs never become successful via late events; restart
never duplicates paid work; recovery only touches stale/unowned rows.

Controls (`run-engine`, `persistence`): `BEGIN IMMEDIATE` lock acquisition;
per-stage operation journals with idempotent recovery; `reconcile-
AgentRunBeforeTerminalWrite` + `persistAgentRunUnlessCancelled` (durable
cancellation wins over late local failure, with a staged
`Agent error after cancellation` marker so the error is not concealed);
terminal-state aggregation rules; `RUN_MAY_HAVE_STARTED` reconciliation
instead of retry; recovery completes stale control requests honestly as
`interrupted`, never fake-cancelled.

Evidence: 86 run-engine tests (parallel/timeout/cancel/recovery/restart
matrices), lease tests, project-manager lock/journal tests. Timing-sensitive
cases (`event-silence`, parallel timeout isolation) flake under concurrent
Windows load and pass focused/serial — a test-margin issue under
investigation (workstream G), not a safety violation: no failing run shows a
wrong terminal state, only scheduling jitter around millisecond budgets.
Status: VERIFIED (fixture); concurrency determinism: see validation report.

## 9. Runtime and agents -> provider credentials

Inputs: user-typed secrets, legacy plaintext file, OS keychain state, test profiles.

Properties: encrypted-at-rest when secure storage exists; never plaintext
fallback; unavailable encryption fails closed and distinguishably; corrupt
entries never present as confirmed absence; migration never destroys
un-repersisted secrets; test runs never touch the owner profile; secrets
absent from archives, exports, logs, and diagnostics.

Controls (`provider-credentials.ts`): safeStorageEncrypt into base64 JSON
with atomic tmp+rename writes; `saveKey` refuses secrets with
`SECURE_STORAGE_UNAVAILABLE` when encryption is down; strict diagnostic mode
(`load({strict:true})`, used by the standalone check after app-ready — the
Phase 4 false-negative fix) validates store shape, base64 well-formedness,
and decryptability, throwing `Credential store/entry unreadable` instead of
reporting absence; legacy file migrated then unlinked only after a successful
secure rewrite; `clearKey` clears memory+env immediately and rewrites the
store best-effort (when encryption is unavailable the ciphertext file is
kept rather than risk destroying secrets during a transient outage — accepted
tradeoff, documented); test isolation via explicit `userDataDir`/`filePath`
overrides (never the real profile); runtime push is memory-only over stdio.
Archive exclusion enforced by `contract.mjs forbidden()` (credentials,
secrets, .env*, *.db, *.key) with adversarial tests.

Evidence: credential unit tests (encrypt/decrypt round-trip with fake
safeStorage, unavailable-encryption refusal, strict-vs-normal diagnostics,
migration, profile isolation); distribution contract tests (secret-bearing
fixtures rejected); verification-trust S56 (fake secrets absent from every
persistence layer). Real OS-backed acceptance: prior packaged Windows/WSL run
used a disposable profile with real DPAPI (historical); CachyOS keyring and
this-candidate DPAPI re-validation: OWNER ACCEPTANCE REQUIRED / ENVIRONMENT
UNAVAILABLE. Synthetic credentials only — owner keys never touched.
Status: VERIFIED (fixture).

## 10. Diagnostics and exports -> user-selected destination

Inputs: run/export IDs (renderer/CLI), dialog results (OS-owned).

Properties: exports contain only the requested run's canonical bytes;
destination cannot be smuggled by the renderer; failed writes leave no
partial file; shell reveal limited to session-saved paths; no secrets in
diagnostic output.

Controls: `RunExporter` derives bytes solely from internal artifacts keyed by
validated runId (Crockford IDs are filename-safe); `exportContent` feeds Save
As; `revealSavedExport` session allowlist; `writeAtomically` temp+fsync+rename
with residue cleanup; `sentry doctor`/status print readiness, never values;
activity titles truncated to 300 chars; ZodError bodies mapped to bounded
protocol messages instead of persisted verbatim.

Evidence: exporter tests (supersede/staleness/attribution), export-save
tests, desktop doctor/status tests. Secret-in-log scanning: covered for
persistence layers (S56); runtime stderr and provider-SDK error text have no
dedicated secret-redaction assert — P3 gap (see findings).
Status: VERIFIED (fixture).

## 11. Release archive -> installed Desktop and runtime

Inputs: built bytes, manifest, companion checksums, extraction environment,
prior installation state.

Properties: exact source-SHA identity; no unexpected/missing/modified files;
no traversal, symlinks, or private data in archives; staged candidate must
pass handshake before atomic activation; failed activation rolls back;
maintenance refused during active work; user databases and credentials
preserved across upgrade and repair.

Controls (`scripts/distribution/`, `deploy-inner.sh`, release launchers):
clean-tree gate plus `git show <SHA>` bytes (never working-tree copies);
`safePath` charset/traversal validation; `forbidden()` private-data
rejection; symlink rejection; required-file list; checksum+inventory match;
triple `build-identity.json` consistency plus package version match;
build-input re-verified before and after; extraction re-validated; companion
`.sha256` file; staged versioned runtime dirs with `current` symlink flip
only after candidate handshake; failure restores the previous target;
graceful-stop refusal before maintenance; user data/config excluded from
archives and never deleted by repair.

Evidence: contract adversarial tests (tamper, missing preload, unlisted
files, `.env`/secret fixtures, SHA/version mismatch, traversal paths,
platform-gated symlink test, PowerShell validator parity test); install,
lifecycle, maintenance, beta-history, and secure-settings distribution
tests; Task A update-channel suites (channel isolation + ancestry
preflight). Packaged launch on a real host for this candidate: OWNER
ACCEPTANCE REQUIRED. Unsigned-artifact limitation (checksums prove
integrity against a trusted manifest, not publisher identity) is documented
in `docs/setup/distribution.md` and must be repeated in release notes.
Status: VERIFIED (fixture).

## 12. Source installation -> selected update channel

Inputs: local branch, working tree, remote refs, Desktop running state.

Properties: `dev` follows only `origin/dev`, `main` only `origin/main`;
pinned/detached and feature/fix/release checkouts refuse with zero
mutations; diverged/ahead branches refuse before any shutdown (PR #10
preflight); failed deploys keep the previous runtime; no automatic branch
switching; packaged installs never track Git.

Evidence: `test-update-channels.sh` (23 checks incl. actual merged SHAs),
`test-update-safety.sh`, `launcher-behavior.test.ps1` channel integration
(fetch/merge refs asserted), desktop/shutdown safety suites. Status:
VERIFIED (fixture + real local-git execution; no network).

## Consolidated findings

| #   | Boundary | Finding                                                                                                                                                                                                         | Severity    | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | 8        | Timing-sensitive tests (`event-silence` drip margins, parallel                                                                                                                                                  | P2          | Corrected (test margins only): drip window 100ms -> 300ms with span preserved (flat clock still kills); opencode cancel test synchronized on turn entry instead of a fixed 50ms sleep (2 concurrent failures, solo green). Remaining concurrent-only flakes (CASE C probe x1, targeted S114 x1, parallel-timeout x1 historically) unreproduced in isolation: resource contention, no production change. No wrong terminal state ever observed.                                                                                                                                                                                                                                                                      |
|     |          | timeout budgets) flake under concurrent Windows load while passing                                                                                                                                              |             |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
|     |          | focused/serial. No wrong terminal state observed.                                                                                                                                                               |             |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| F2  | 6, 10    | Error-boundary secret reflection: `toRouterError` forwarded arbitrary message text (nested-`Error` bypassed the cap; codes unbounded) and no test injected a secret-bearing exception through the real mapping. | P3          | Corrected (Task A): single `toSafeError` policy (validated codes, consistent 1000 cap incl. nested errors) + exact known-value scrubbing wired through IPC/CLI/service/boot-warning paths; matrix in `error-redaction.test.ts` (synthetic secret, real mapping + real broker round-trip). Prior status/disk evidence stands; fake-`enc:` fixture is surface-absence only, not crypto proof — OS-backed acceptance stays owner-required. Precision fix: `secret-surface.test.ts` asserts a known fake secret absent across statuses, strict diagnostics, disk, prefs, and clear; it caught strict mode masking entry errors as store errors, fixed via `CREDENTIAL_ENTRY_UNREADABLE` passthrough (fail-closed kept). |
|     |          | REPRODUCED DEFECT (Task A correction): synthetic secret reflected in mapped responses and, over a real CLI broker round-trip, on the wire.                                                                      |             |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| F3  | 6        | `runs:start-production` router channel duplicated with identical                                                                                                                                                | P3          | Dead-channel parity note; no privilege difference demonstrated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
|     |          | handler; renderer cannot reach it (preload uses `runs:start`).                                                                                                                                                  |             | Out-of-scope unless owner wants the cleanup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| F4  | 9        | Model-key status hints expose non-secret config values (may include                                                                                                                                             | P3          | By design (local UI, non-secret classification); documented.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
|     |          | a username inside a binary path) to the local Desktop UI.                                                                                                                                                       |             | No change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| F5  | 4, 5     | Real-mount containment on THIS candidate via prepared WSL Ubuntu                                                                                                                                                | P1-evidence | VERIFIED: real systemd-mount 8/8 pass on WSL2 Ubuntu (node 22, user manager running) against pristine `d628837`; Windows/CI runners remain honestly unverified for mounts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| F6  | 9        | Real DPAPI/keyring acceptance for THIS candidate outstanding.                                                                                                                                                   | P1-evidence | OWNER ACCEPTANCE REQUIRED; fixture evidence only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| F7  | 11       | Packaged-app launch + rollback on real hosts for THIS candidate.                                                                                                                                                | P1-evidence | OWNER ACCEPTANCE REQUIRED; fixture evidence only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

No P0 (exploitable data loss, secret exposure, isolation bypass, unsafe
execution) was reproduced. No P1 production defect was reproduced: the
audited boundaries hold under fixture and adversarial testing, with the
real-host evidence gates above outstanding by environment, not by code.
