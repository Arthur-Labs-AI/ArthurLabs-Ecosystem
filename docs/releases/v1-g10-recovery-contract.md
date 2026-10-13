# Proposed G10-R recovery contract

This is a disposable-fixture acceptance procedure pending owner adoption, not
permission to restore an owner's installation. Original-beta G10 remains FAIL.
The preferred target is the verified I1 Desktop/runtime pair at
`c78faa74717b0f430a859730e98c3c4915e7b03f`, version0.1.0-beta.1/protocol1.
The new dev merge8bbe8ba changes documentation only; executable source and
the beta/I1 persistence migration definitions were compared directly.

## What must remain together

I1 packaged profile selection is explicit `--user-data-dir` first, otherwise
`app.getPath('appData')/@qa/desktop` (Windows roaming appData; native Linux
appData/config location). Bootstrap uses that same resolved Electron userData
for credentials and host preferences. The campaign always selects and proves a
fresh explicit profile; it never discovers an owner's default profile.

The authoritative runtime data is Linux-owned: absolute SENTRY_DATA_ROOT when
provided, otherwise `$XDG_DATA_HOME/sentry` or `$HOME/.local/share/sentry`.
Windows legacy `%LOCALAPPDATA%/Sentry` is not silently mixed with that runtime
database. Runtime versions/current and `.release-maintenance` live separately
under Linux `$HOME/.local/share/sentry/runtime`; retain the selected archive,
version directories and recorded pointer target. This campaign separates its
explicit data root from that runtime root inside a disposable HOME. The fixture
verifier is not a whole-default-home backup utility and refuses symlink material.

The Linux runtime owns `sentry.db` under its explicit data root and all
`projects/` material: working copies, retained revisions, contexts, run snapshots,
events, artifacts, exports and their SQLite metadata/issue/retest relationships.
Desktop owns the selected Electron userData profile: encrypted
`credentials/providers.json`, non-secret `sentry-prefs/models.json`, host/distro
preferences and Chromium profile/Local State. Preserve the complete selected
profile, not only the ciphertext file. Imported originals outside the managed
data root are separate user source; preserve them separately if future updates
need them. Fixture originals remain retained and unchanged.

Back up data and profile as one identified stopped generation. Record full
source/version/protocol, schema migrations and SQLite schema fingerprint,
component paths privately, every file's SHA256, entity payload fingerprints,
snapshot hashes, export artifact hashes, model preferences and presence-only
credential statuses. Never publish raw paths, database/profile files or keys.
Database, project source, events, reports, exports, profile and logs may all
contain private information. A manifest checksum checks integrity, not trust:
keep the expected receipt/hash separately through the owner's trusted channel.

## Stop, checkpoint, copy, verify

Stop active QA/retests first, then gracefully close the owning Desktop and
runtime/CLI. Stop installers, exporters and other writers. Confirm owned process
exit and refuse maintenance if any Sentry runtime remains. Windows additionally
checks the explicit disposable profile has no live Desktop owner. Do not kill
an unrelated process to make this gate pass.

After every writer has stopped, open only the disposable database, require
`PRAGMA integrity_check=ok`, empty `foreign_key_check` and no active run/retest
or unreleased runtime lease. Run `wal_checkpoint(TRUNCATE)` and require its busy
count0; close that connection. Copy the complete stopped data/profile into new
empty staging directories, never over an existing destination. A residual
nonempty WAL/journal refuses this checkpointed-backup procedure: retain DB and
sidecars together and investigate, rather than deleting WAL or copying an active
DB alone. Verify the copied database read-only and hash all copied material.

Seal the two components under a shared fixture-generation token. The
acceptance-only backup verifier rejects absent/incomplete/changed components,
mixed generation tokens, symlinks, unsupported schema/version/protocol,
uncheckpointed WAL, active leases/runs and corrupt SQLite. It never decrypts
credentials, installs a runtime, restores files or selects arbitrary live data.
Its explicit marked bundle is private fixture evidence, not an owner backup tool.
Only the OS-provided temporary base is canonicalized to support trusted Windows
temp junctions/drive aliases; path redirection inside the fixture stays refused.

## Restore and activate

Verify the source backup against its independently retained manifest/hash and
the exact recovery binary before changing any destination. Keep the backup
read-only. Verify no writer and no ambiguous profile selection. Preserve the
entire current data/profile in separate stopped directories. Restore both
components to their original explicit paths as one generation; do not merge
files from multiple backups or overwrite the preserved directories. Copy and
verify into new staging paths first. On copy/verification failure, leave current
data and the original backup intact; never label an incomplete attempt restored.
If a multi-component rename is interrupted, keep everything stopped and inspect
the generation markers before choosing either complete pair. There is no claim
of atomic cross-filesystem data/profile replacement.

Use unchanged archive bootstrap to stage, validate, atomically activate and
recheck a unique runtime inside a disposable HOME. Keep the previous runtime
directory and pointer target. Failed post-activation validation restores that
pointer; an interrupted maintenance lock is inspected after all writers stop.
No owner runtime/current is changed. Corrected Desktop and runtime must report
the same full SHA/version/protocol. Setup's disposable handshake is not a data
restore or proof of provider readiness.

## Compatibility and acceptance

Published beta and I1 have identical migrations1–6. Opening their fixture does
not require a schema change. Reject unknown generations before opening with a
mutable application; binary rollback never reverses database migrations.
DPAPI continuity requires the same Windows account/machine/security context and
the complete same profile. Native Linux requires its actual supported keychain;
do not infer continuity across accounts, computers or keychains. Unavailable or
unreadable secure storage must report unavailable, refuse saves, and preserve
encrypted bytes. No plaintext export/fallback or automatic provider call.

Compare baseline and restored canonical entity payloads, valid lineage, snapshot
material and actual JSON/log export bytes. Launch the real corrected packaged
pair, inspect presence-only `stored/secure` status, stop both processes, clear
inherited provider variables, and repeat fresh-process restart twice. Runtime
lease/history bookkeeping may grow across launches; canonical historical data
must remain equal. Original backup, preserved candidate data, exports, encrypted
profile, old runtime and original archive must survive every failed attempt.

An actual Windows pass establishes a validated proposed G10-R candidate only.
Original G10, native CachyOS, owner policy adoption and Phase6 authorization
remain separate decisions/gates. No beta tag/release or production schema is changed.
