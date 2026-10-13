# Native CachyOS G10-R operator handoff

**NOT EXECUTED here — ENVIRONMENT UNAVAILABLE.** Use a real CachyOS x64
graphical session and unlocked supported OS keychain, same non-root account
throughout. No Ubuntu/WSL substitution. This is a synthetic disposable campaign;
owner policy adoption and real-profile testing are separate approvals.
Read the [recovery contract](v1-g10-recovery-contract.md) before execution.

Required: Node>=22, pnpm9.12.3, Git for the fixture checkout, systemd user bus,
bubblewrap, socat, coreutils/tar and normal Electron runtime/keychain libraries
from the existing [distribution prerequisites](../setup/distribution.md).
Run package installation only as the operator's separately approved setup action.
Do not force `basic_text`, disable Electron's sandbox, or bypass host gates.

## Prepare reviewed tools and the exact archive

Set TOOL_REPO to a reviewed Phase5.2 checkout and TOOL_SOURCE to its approved full
commit. Set ARCHIVE to the privately delivered I1 archive. These are explicit
operator inputs; never point the fixture commands at live user data.

```bash
set -euo pipefail
: "${TOOL_REPO:?reviewed Phase5.2 checkout required}"
: "${TOOL_SOURCE:?approved full tool commit required}"
: "${ARCHIVE:?exact I1 archive path required}"
test "$(git -C "$TOOL_REPO" rev-parse HEAD)" = "$TOOL_SOURCE"
test -z "$(git -C "$TOOL_REPO" status --porcelain)"
grep -Eq '^ID="?cachyos"?$' /etc/os-release
test "$(uname -m)" = x86_64
test -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}"
test "$(pnpm --version)" = 9.12.3
systemctl --user show-environment >/dev/null
bwrap --dev-bind / / --proc /proc /usr/bin/true
command -v socat
EXPECTED=5bd3642ed392607a010078be35885d1cff45db162a2841ee374be228275e89d8
test "$(sha256sum "$ARCHIVE" | cut -d' ' -f1)" = "$EXPECTED"
EXTRACT=$(mktemp -d /var/tmp/sentry-recovery-archive.XXXXXX)
tar -xzf "$ARCHIVE" -C "$EXTRACT"
DIST="$EXTRACT/sentry-0.1.0-beta.1-c78faa74717b-cachyos-x64"
node "$DIST/scripts/distribution/verify.mjs" "$DIST"
cd "$TOOL_REPO"
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @qa/run-engine exec vitest run tests/verification-trust.test.ts --maxWorkers=1 --minWorkers=1
node --test --test-concurrency=1 scripts/distribution/tests/recovery-backup.test.mjs
```

Archive source must be `c78faa74717b0f430a859730e98c3c4915e7b03f`, version
0.1.0-beta.1/protocol1; inventory333. Record actual host/backend and all exits.
Eight real sandbox trust cases must run; a skipped/unavailable mount is not PASS.

## Populate historical data and seed synthetic credentials

Use the immutable beta source, built separately without modifying the tag.
Fixture simulation uses no AI providers. Historical merge/issue records are
generated only to test compatibility, not reinstated in production execution.
The completed legacy retest record is schema/API-seeded, not a paid retest.

```bash
BETA=$(mktemp -d /var/tmp/sentry-recovery-beta.XXXXXX)
git clone --no-checkout "$TOOL_REPO" "$BETA"
git -C "$BETA" checkout --detach 0e5c10cfa80f6385ebfc88a7306b38ce8a12ce38
(cd "$BETA" && pnpm install --frozen-lockfile && pnpm build)
RECEIPT=$(mktemp /var/tmp/sentry-recovery-receipt.XXXXXX)
# The seeder refuses an existing output file; retain this name, not its empty file.
RECEIPT="$RECEIPT.json"
node "$TOOL_REPO/scripts/distribution/tests/recovery-history.mjs" "$BETA" "$RECEIPT"
ROOT=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).root' "$RECEIPT")
case "$ROOT" in /var/tmp/sentry-recovery-*) ;; *) exit 1;; esac
DATA="$ROOT/live/data"
PROFILE="$ROOT/live/profile"
mkdir "$PROFILE"
cp "$DATA/recovery-generation.json" "$PROFILE/recovery-generation.json"
unset OPENROUTER_API_KEY OPENCODE_API_KEY DEEPSEEK_API_KEY ANTHROPIC_AUTH_TOKEN
env SENTRY_DATA_ROOT="$DATA" SENTRY_RUNTIME_ENTRY="$BETA/apps/runtime/dist/host.js" \
  "$BETA/apps/desktop/node_modules/.bin/electron" "$BETA/apps/desktop" \
  --sentry-app --user-data-dir="$PROFILE"
```

In that explicitly isolated beta Desktop, save four synthetic nonproduction
values in OPENROUTER_API_KEY, OPENCODE_API_KEY, DEEPSEEK_API_KEY and
ANTHROPIC_AUTH_TOKEN, and a non-secret model preference. Do not start QA or
provider validation. Record only configured/source/persistence and preference.
Confirm the actual OS backend can encrypt. Close Desktop normally and verify
all owned Desktop/runtime processes exited. If keychain encryption is unavailable,
stop and record ENVIRONMENT UNAVAILABLE; do not introduce a plaintext workaround.

## Seal a stopped matching backup

No file copy is permitted with a writer active. Require no selected Desktop
owner, no active runtime, clean run/retest state and successful checkpoint.

```bash
node "$DIST/scripts/distribution/maintenance.mjs"
if pgrep -f -- "--user-data-dir=$PROFILE" >/dev/null; then
  echo 'Disposable Desktop still active; stop normally' >&2; exit 1
fi
node - "$DATA/sentry.db" <<'JS'
const assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.argv[2]);
try {
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy,0);
} finally {db.close();}
JS
BACKUP="$ROOT/beta-backup"
test ! -e "$BACKUP"
mkdir "$BACKUP"
cp -a -- "$DATA" "$BACKUP/data"
cp -a -- "$PROFILE" "$BACKUP/profile"
cp -- "$DATA/recovery-generation.json" "$BACKUP/fixture.json"
CHECK="$TOOL_REPO/scripts/distribution/tests/recovery-backup.mjs"
IDENTITY="$DIST/build-identity.json"
node "$CHECK" seal "$BACKUP" "$IDENTITY" > "$ROOT/baseline-presence-and-inventory.json"
sha256sum "$BACKUP/backup.json" > "$ROOT/backup-receipt.sha256"
node "$CHECK" verify "$BACKUP" "$IDENTITY"
```

Retain that independent receipt/hash and immutable originals privately. The
verifier requires a marked temp fixture, checks exact schema/integrity/lineage,
export hashes, stopped leases, component hashes and matching generation tokens.
It reads a scratch SQLite copy to leave the backup untouched. It neither restores
files nor proves native keychain decryption; the real GUI tests establish that.

## Activate, upgrade, recover and restart

All runtime installation stays in a disposable HOME; the operator's current
pointer is never changed. Inherited provider secrets remain unset. Existing
DBus/keychain session is retained for the actual desktop account.

```bash
RUNTIME_HOME=$(mktemp -d /var/tmp/sentry-recovery-home.XXXXXX)
env HOME="$RUNTIME_HOME" XDG_CONFIG_HOME="$RUNTIME_HOME/.config" \
  XDG_CACHE_HOME="$RUNTIME_HOME/.cache" XDG_DATA_HOME="$RUNTIME_HOME/.local/share" \
  bash "$DIST/scripts/distribution/bootstrap-runtime.sh" native
ENTRY="$RUNTIME_HOME/.local/share/sentry/runtime/current/apps/runtime/dist/host.js"
env SENTRY_DATA_ROOT="$DATA" SENTRY_RUNTIME_ENTRY="$ENTRY" \
  "$DIST/desktop/sentry" --sentry-app --user-data-dir="$PROFILE"
```

Confirm native connected runtime/full I1 identity, all historical projects/runs,
findings/evidence, issue/retest lineage, actual cached JSON/log exports, four
Stored securely badges and the model preference. Stop normally. Preserve this
post-upgrade generation, then restore the verified stopped pair:

```bash
node "$DIST/scripts/distribution/maintenance.mjs"
if pgrep -f -- "--user-data-dir=$PROFILE" >/dev/null; then exit 1; fi
sha256sum -c "$ROOT/backup-receipt.sha256"
node "$CHECK" verify "$BACKUP" "$IDENTITY"
PRESERVED="$ROOT/candidate-preserved"
STAGE="$ROOT/restore-stage"
test ! -e "$PRESERVED"; test ! -e "$STAGE"
mkdir "$PRESERVED" "$STAGE"
cp -a -- "$BACKUP/data" "$STAGE/data"
cp -a -- "$BACKUP/profile" "$STAGE/profile"
cp -- "$BACKUP/fixture.json" "$STAGE/fixture.json"
node "$CHECK" seal "$STAGE" "$IDENTITY"
node "$CHECK" verify "$STAGE" "$IDENTITY"
cmp "$BACKUP/backup.json" "$STAGE/backup.json"
# Confirm all four resolved paths are inside ROOT before these moves.
case "$DATA:$PROFILE:$PRESERVED:$STAGE" in "$ROOT"/*:"$ROOT"/*:"$ROOT"/*:"$ROOT"/*) ;; *) exit 1;; esac
mv -- "$DATA" "$PRESERVED/data"
mv -- "$PROFILE" "$PRESERVED/profile"
mv -- "$STAGE/data" "$DATA"
mv -- "$STAGE/profile" "$PROFILE"
env SENTRY_DATA_ROOT="$DATA" SENTRY_RUNTIME_ENTRY="$ENTRY" \
  "$DIST/desktop/sentry" --sentry-app --user-data-dir="$PROFILE"
```

If any move is interrupted, keep everything stopped and inspect the complete
generation markers before choosing a pair. Never merge or erase preserved data.
After recovery, compare canonical entity fingerprints, snapshot/project files,
four export SHA256s, encrypted-store/prefs hashes and presence-only statuses to
baseline. Ignore only released runtime-instance bookkeeping and ordinary Chromium
cache changes. Any historical payload/export difference is a failed gate.

Close Desktop/runtime fully; unset all four provider variables; repeat the exact
corrected launch twice. Record `configured=true,persistence=secure,source=stored`
for all four fields each time, preference equality, diagnostic exit/status and
all data/export comparisons. Use `--sentry-credential-status --user-data-dir=...`
only after Desktop is stopped; never publish keys, ciphertext or the whole profile.

For failures, make new disposable copies of the sealed bundle: omit a file,
change a byte or generation marker, use a wrong identity and confirm refusal
before any destination move. Test active Desktop/runtime maintenance refusal,
repeat repair/unique current, controlled activation failure and repeated recovery.
Retain failure receipts. Unavailable native backend behavior is its own gate;
do not simulate it by disabling encryption. No paid-provider execution is authorized.

Submit sanitized host/backend/version/full SHA/checksum, before/after counts,
fingerprint/export comparisons, presence-only restart results, G01–G10/G10-R
verdicts and failure exits. Raw DB/profile/logs and identifying paths stay private.
Native rows remain unexecuted until that actual operator evidence exists.
