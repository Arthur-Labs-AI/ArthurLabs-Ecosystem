# Native CachyOS operator package — I1

**NOT EXECUTED: ENVIRONMENT UNAVAILABLE to the preparing agent.** This is the
current ordered workflow. The older D/C1 handoff is historical; do not use its
archive or overwrite C1 results. Return a copy of the
[native receipt](v1-phase-5-3-cachyos-results.md), including partial failures.
Case definitions remain in the [A–G runbook](v1-owner-acceptance.md).

## Inputs and safe stopping

Use an actual CachyOS x64 laptop, graphical X11/Wayland login, **disposable OS
account**, unlocked supported keychain, same non-root user throughout. Keep the
real DBus/systemd session; do not launch GUI as root or disable any sandbox.
No remote operation is authorized by this package. The operator chooses when
to run it. Read each block before executing, use the same Bash terminal, stop
on any unexpected nonzero exit and record that attempt before repair/retest.

Required private inputs: original I1 Linux archive/sidecar from the
[candidate lock](v1-phase-5-3-candidate-lock.md), reviewed tools checkout at
`5c68491ccd0f00e34917bb3efdb4926c2fcfd280`, and network access for frozen npm
dependencies/tool provisioning. An owner can retrieve the retained CI bytes:

```bash
gh run download 38417470244 --repo Mert1026/Sentry \
  --name unsigned-review-cachyos-x64-c78faa74717b0f430a859730e98c3c4915e7b03f \
  --dir ./private-i1-artifact
```

Artifact11824114212 expires2026-10-20; if unavailable, request the retained
verified copy. Do not rebuild/rename a replacement under the old identity.
Logs are private until sanitized; never share keys, ciphertext, complete profile,
DB/project contents, provider responses, usernames or absolute private paths.
Share anonymous host versions, SHA/checksum, command exit, verdict, counts and
hash comparisons. Inspect screenshots before sharing and hide entry fields.

## 1. Host and isolated campaign (C01–C03)

Set ARCHIVE and TOOL_REPO to the delivered archive and clean reviewed checkout.
Confirm the current account is disposable **before** setting a temporary HOME.
Temporary HOME alone does not isolate an owner's keychain. Prerequisite package
installation follows the [native setup guide](../setup/distribution.md), as a
separate deliberate operator action; these commands perform no hidden sudo.

```bash
set -euo pipefail
umask 077
: "${ARCHIVE:?absolute path to delivered I1 archive}"
: "${TOOL_REPO:?absolute path to reviewed clean tools checkout}"
TOOL_SOURCE=5c68491ccd0f00e34917bb3efdb4926c2fcfd280
I1=c78faa74717b0f430a859730e98c3c4915e7b03f
test "$(id -u)" -ne 0
grep -Eq '^ID="?cachyos"?$' /etc/os-release
test "$(uname -m)" = x86_64
test -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}"
test "$(node -p 'Number(process.versions.node.split(".")[0])>=22')" = true
test "$(pnpm --version)" = 9.12.3
test "$(git -C "$TOOL_REPO" rev-parse HEAD)" = "$TOOL_SOURCE"
test -z "$(git -C "$TOOL_REPO" status --porcelain)"
systemctl --user show-environment >/dev/null
command -v systemd-run bwrap socat curl tar sha256sum timeout setsid
bwrap --dev-bind / / --proc /proc /usr/bin/true
pacman -Q systemd bubblewrap socat curl ca-certificates
# A pre-existing legacy temp store is outside this synthetic campaign: stop.
test ! -e "$(node -p 'require("path").join(require("os").tmpdir(),"sentry-desktop-providers.env")')"
CAMPAIGN=$(mktemp -d /var/tmp/sentry-phase53-native.XXXXXX)
export HOME="$CAMPAIGN/home"
export XDG_CONFIG_HOME="$HOME/.config" XDG_CACHE_HOME="$HOME/.cache"
export XDG_DATA_HOME="$HOME/.local/share"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"
export SENTRY_DATA_ROOT="$CAMPAIGN/data"
PROFILE="$XDG_CONFIG_HOME/@qa/desktop"
unset OPENROUTER_API_KEY OPENCODE_API_KEY DEEPSEEK_API_KEY ANTHROPIC_AUTH_TOKEN
unset SENTRY_LIVE_MUSE_TEST SENTRY_LIVE_DEEPSEEK_TEST SENTRY_LIVE_GLM_TEST
```

Record sanitized OS version/kernel, session type, actual visible desktop, Node,
pnpm and package versions privately. A failing prerequisite is FAIL, with
dependent cases BLOCKED; no native execution here means ENVIRONMENT UNAVAILABLE.
Keep systemd/XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS from the actual login.
Every subsequent archive command inherits this disposable HOME; the normal
account runtime/current pointer is untouched. Do not revert HOME mid-campaign.

## 2. Verify, install and launch (A01–A08, C04–C10)

```bash
EXPECTED=5bd3642ed392607a010078be35885d1cff45db162a2841ee374be228275e89d8
test "$(sha256sum "$ARCHIVE" | cut -d' ' -f1)" = "$EXPECTED"
# Also check the trusted delivered sidecar in its own directory.
(cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256")
mkdir "$CAMPAIGN/archive with spaces"
tar -xzf "$ARCHIVE" -C "$CAMPAIGN/archive with spaces"
DIST="$CAMPAIGN/archive with spaces/sentry-0.1.0-beta.1-c78faa74717b-cachyos-x64"
node "$DIST/scripts/distribution/verify.mjs" "$DIST"
test "$(sha256sum "$DIST/distribution.json" | cut -d' ' -f1)" = \
  e79b4d8836394c6cfc87c573b71d1e500f3334cc5d7947c4daf07dcef3ae9a86
candidate() { "$DIST/sentry" "$@"; }
candidate version
candidate setup
export SENTRY_RUNTIME_ENTRY="$HOME/.local/share/sentry/runtime/current/apps/runtime/dist/host.js"
candidate status
candidate doctor
candidate tools
candidate open
```

Expected: verify333 files, all identities I1/version0.1.0-beta.1/protocol1,
unique validated runtime under this HOME, actual loaded packaged GUI,
Environment connected Linux runtime with matching identity and truthful agent
readiness. `open` surviving two seconds alone does not pass GUI/handshake.
Record actual provider tool versions from Environment; configured keys do not
prove billing. No paid request is authorized. Test a second `candidate open`
for single instance, without duplicate work. Import only a small disposable
project in a path with spaces, inspect managed revision/doctor, source byte
preservation, history, renderer isolation and ordinary preferences.

Perform A04/A05 only on separately named copies: corrupt archive byte→checksum
refusal; changed listed file/unexpected file/mismatched identity→version nonzero.
Never launch a tampered copy or replace its checksum. A06 inventory excludes
credentials, logs, DBs, .env/.git/private state. A08 mismatch refusal is a
separate controlled fixture; successful matching hello alone does not pass it.
Use existing distribution adversarial tests below for automated boundary coverage.

These integrity-only negative commands never launch GUI or activate a runtime:

```bash
cp -- "$ARCHIVE" "$CAMPAIGN/corrupt.tar.gz"
node - "$CAMPAIGN/corrupt.tar.gz" <<'JS'
const fs=require('node:fs');
const fd=fs.openSync(process.argv[2],'r+');
try {const b=Buffer.alloc(1);fs.readSync(fd,b,0,1,64);b[0]^=1;fs.writeSync(fd,b,0,1,64);}
finally {fs.closeSync(fd);}
JS
test "$(sha256sum "$CAMPAIGN/corrupt.tar.gz" | cut -d' ' -f1)" != "$EXPECTED"
NEGATIVE="$CAMPAIGN/tampered-extraction"
cp -a -- "$DIST" "$NEGATIVE"
expect_refusal() {
  if "$@" > "$CAMPAIGN/last-refusal-private.log" 2>&1; then
    echo 'Unexpected acceptance; STOP' >&2; return 1
  else echo "Expected refusal exit=$? (review private log for intended reason)"; fi
}
printf '\nsynthetic changed file\n' >> "$NEGATIVE/LICENSE"
expect_refusal "$NEGATIVE/sentry" version
cp -- "$DIST/LICENSE" "$NEGATIVE/LICENSE"
printf 'synthetic unexpected file\n' > "$NEGATIVE/unexpected-test.txt"
expect_refusal "$NEGATIVE/sentry" version
mv -- "$NEGATIVE/unexpected-test.txt" "$CAMPAIGN/unexpected-preserved.txt"
node - "$NEGATIVE/build-identity.json" <<'JS'
const fs=require('node:fs'),file=process.argv[2],d=JSON.parse(fs.readFileSync(file));
d.sourceCommit='f'.repeat(40);fs.writeFileSync(file,JSON.stringify(d));
JS
expect_refusal "$NEGATIVE/sentry" version
node "$DIST/scripts/distribution/verify.mjs" "$DIST"
```

Do not accept a generic nonzero as the intended integrity refusal: inspect the
private error for checksum/inventory/identity rejection. A missing Node or
permission error is a failed test setup. Original archive/extraction stay intact.

## 3. Native keychain and restart (D01–D08, C07)

First identify the actual backend using the same pinned Electron36.2.1 from
the reviewed executable-equivalent tools checkout. This diagnostic uses a new
profile, performs only an in-memory canary encryption roundtrip and prints no
credential or ciphertext. It does not read the Sentry profile or replace the
packaged GUI persistence test. Backend choice is observed in this login/session;
no password-store override is supplied. Run before synthetic credential saving:

```bash
(cd "$TOOL_REPO" && pnpm install --frozen-lockfile)
mkdir "$CAMPAIGN/backend-profile"
test ! -e "$CAMPAIGN/backend-probe.cjs"
cat > "$CAMPAIGN/backend-probe.cjs" <<'JS'
const {app,safeStorage}=require('electron');
const assert=require('node:assert/strict');
assert.equal(process.platform,'linux');
assert.equal(process.versions.electron,'36.2.1');
app.setPath('userData',process.argv[2]);
app.whenReady().then(()=>{
  const backend=safeStorage.getSelectedStorageBackend();
  const available=safeStorage.isEncryptionAvailable();
  if(!available || !['gnome_libsecret','kwallet','kwallet5','kwallet6'].includes(backend)) {
    console.error(JSON.stringify({backend,available,accepted:false}));app.exit(1);return;
  }
  const canary='sentry-native-capability-canary';
  assert.equal(safeStorage.decryptString(safeStorage.encryptString(canary)),canary);
  console.log(JSON.stringify({backend,available,roundtrip:true}));
  app.exit(0);
}).catch(()=>{console.error('Native secure-storage capability refused.');app.exit(1);});
JS
"$TOOL_REPO/apps/desktop/node_modules/.bin/electron" \
  "$CAMPAIGN/backend-probe.cjs" "$CAMPAIGN/backend-profile"
```

Save four conspicuously synthetic, nonproduction values through Providers and a
non-secret model preference. Record backend from actual Electron/keychain
diagnostics or the host's selected supported password-store service; environment
variables/package presence alone cannot identify it. Record the evidence source.
Expect `Stored securely`, configured true, source stored, persistence secure.
Never Validate/start QA with synthetic keys. A missing/unavailable backend must
refuse save, with no plaintext fallback; do not force basic_text to manufacture
D06. If this session cannot exercise unavailable-backend behavior, leave D06
ENVIRONMENT UNAVAILABLE, even if normal native encryption works.

```bash
candidate stop
node "$DIST/scripts/distribution/maintenance.mjs"
candidate open
# Observe same profile, four stored/secure statuses and preferences; then:
candidate stop
node "$DIST/scripts/distribution/maintenance.mjs"
candidate open
```

Observe both complete fresh launches, not empty password inputs. Verify owned
process exit and profile identity privately at every stop. Record D03/D04
plaintext-absence booleans only. D05 unreadable-entry and D07 empty-profile checks
use new disposable copies/roots, preserve the accepted original, and never copy
ciphertext between accounts. D08 needs the separate compatible upgrade below.

## 4. Offline selection and actual sandbox (C11; E remains owner-required)

In Desktop inspect Full and Targeted forms and all seven nonempty selections.
Targeted must identify explicit relevant paths. **Do not press Start** with
synthetic keys. These UI observations are not funded E passes.
Run deterministic existing selection/runtime tests and eight actual sandbox trust
cases from a separate clean I1 source checkout; no hosted exclusion flag:

```bash
candidate stop
TRUST_REPO="$CAMPAIGN/i1-source"
git clone --no-checkout "$TOOL_REPO" "$TRUST_REPO"
git -C "$TRUST_REPO" checkout --detach "$I1"
test -z "$(git -C "$TRUST_REPO" status --porcelain)"
cd "$TRUST_REPO"
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @qa/run-engine exec vitest run tests/verification-trust.test.ts --maxWorkers=1 --minWorkers=1
pnpm --filter @qa/desktop exec vitest run tests/components/run-workspace.test.tsx --maxWorkers=1 --minWorkers=1
pnpm --filter @qa/runtime test -- --maxWorkers=1 --minWorkers=1
cd "$TOOL_REPO"
pnpm install --frozen-lockfile
pnpm build
pnpm distribution:test
```

Record eight individual trust outcomes and actual mount/isolation capability;
skips do not pass C11. Fake-harness Full/Targeted selection, cancellation and
runtime regressions are zero-cost automated evidence, not physical paid QA.
Do not inject fake providers into packaged production. The
[funded matrix](v1-phase-5-3-funded-qa.md) is a separate owner-controlled track.

## 5. Maintenance, history, upgrade and G10-R

After graceful stop, `candidate setup` again must stage a distinct target and
retain project/history/preferences/old runtime. Record both private current
targets. `candidate update` must refuse without touching the source channel.
Idle disconnect/relaunch is F04; do not infer automatic reconnect. Active-work
F01/F02/F05/F06/F07 need separately authorized scope; no paid tests here.
The production maintenance checker must refuse while the owned runtime is alive,
then succeed after graceful stop; it never signals processes. A refusal caused
by another session is not proof that this campaign's runtime was detected.

Optional G07 controlled real bootstrap failure, **after all work/GUI/runtime have
stopped** and after successful first setup. The wrapper fails only the actual
post-activation current handshake; other Node calls delegate unchanged. Preserve
the private log, require exit71 and the exact previous pointer, then run normal
setup again for G08. No failure is injected into normal owner installation paths:

```bash
candidate stop
node "$DIST/scripts/distribution/maintenance.mjs"
BEFORE=$(readlink "$HOME/.local/share/sentry/runtime/current")
test -n "$BEFORE"
REAL_NODE=$(command -v node)
FAULT_BIN="$CAMPAIGN/postactivation-fault-bin"
mkdir "$FAULT_BIN"
cat > "$FAULT_BIN/node" <<'SH'
#!/bin/bash
set -euo pipefail
if [ "${1:-}" = "$SENTRY_PHASE53_DIST/scripts/distribution/runtime-check.mjs" ] && \
   [ "${2:-}" = "$HOME/.local/share/sentry/runtime/current/apps/runtime/dist/host.js" ]; then
  exit 71
fi
exec "$SENTRY_PHASE53_REAL_NODE" "$@"
SH
chmod 700 "$FAULT_BIN/node"
if env PATH="$FAULT_BIN:$PATH" SENTRY_PHASE53_REAL_NODE="$REAL_NODE" \
  SENTRY_PHASE53_DIST="$DIST" bash "$DIST/scripts/distribution/bootstrap-runtime.sh" native \
  > "$CAMPAIGN/postactivation-fault-private.log" 2>&1; then
  echo 'Expected failure did not occur; STOP' >&2; exit 1
else result=$?; fi
test "$result" -eq 71
test "$(readlink "$HOME/.local/share/sentry/runtime/current")" = "$BEFORE"
candidate setup
test "$(readlink "$HOME/.local/share/sentry/runtime/current")" != "$BEFORE"
```

Record complete data/profile hashes before and after this optional track; pointer
equality alone does not prove data continuity. The private fault PATH applies to
one command, never global shell/tool configuration. This block is syntax-checked
only here; native G07/G08 require the operator's actual execution and comparison.

For populated beta→I1→corrected-binary restore, follow the existing
[five-block G10-R handoff](v1-g10-recovery-cachyos-handoff.md) in order. It supplies
the immutable beta build, deterministic no-provider histories, actual JSON/log
exports, synthetic keychain seeding, matched stopped backup, full staged pair
verification before moves, preserved generations and two fresh restarts.
Keep this disposable HOME; that handoff creates another disposable runtime HOME
for its bootstrap, never the account's default pointer. Retain TOOL_REPO,
TOOL_SOURCE and ARCHIVE above. Its trust/tool build at5c is executable-equivalent
to I1; the exact-I1 C11 result above is recorded separately. Maintenance refusal
can scan other Sentry runtimes: stop this campaign before starting that track.

Record canonical payload, all snapshot/material files, actual four export hashes,
schema/migrations and stored credential/preference comparisons, not counts alone.
For post-launch canonical comparisons, checkpoint stopped DBs and seal NEW
matched bundles with the existing verifier; compare `canonical`, `exports`,
schema and project-file inventories, excluding only released runtime bookkeeping
and Chromium cache differences. Never reseal or mutate the baseline backup.
Exercise omitted/corrupt/mixed/schema/identity backup copies and failed staging
before any destination move; retain original and displaced pairs. Existing17
verifier tests are automated evidence, separate from executed host refusals.
Controlled post-activation failure/repeated repair and active-work G09 require
their actual separate receipts; the happy restore does not pass them.

Original beta G10 is historical FAIL. Native G10/G10-R are unexecuted until this
operator supplies evidence. Even a native G10-R PASS does not adopt the
[recovery policy](v1-recovery-policy-decision.md). Do not retry paid work, delete
preserved fixtures, remove profile locks blindly, or open an unknown schema with
an older binary. If a swap is interrupted, keep all components stopped and
inspect complete generation pairs; data/profile replacement is not atomic.

## 6. Return partial evidence

Complete one receipt row per existing ID and each E mode. Include exact archive
and source, commands/exits, anonymous session/backend facts, actual comparisons,
each failure and linked retest. NOT RUN is valid. Share only reviewed sanitized
results; keep raw logs/fixtures private. Stop after acceptance evidence collection;
Phase6, policy adoption, feature freeze and release publication need owner decisions.
