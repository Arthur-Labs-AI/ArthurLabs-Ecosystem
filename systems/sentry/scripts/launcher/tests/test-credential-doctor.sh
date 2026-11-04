#!/usr/bin/env bash
# Production doctor, disposable repo/HOME and fake Electron. No providers or runtime.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/repo/apps/desktop/dist/main" "$fixture/repo/apps/desktop/dist/renderer" "$fixture/home"
touch "$fixture/repo/apps/desktop/dist/main/index.js" "$fixture/repo/apps/desktop/dist/renderer/index.html"
cat > "$fixture/electron" <<'EXE'
#!/usr/bin/env bash
if [ "$FIXTURE_MODE" = present ]; then
  printf '%s\n' 'SENTRY_CREDENTIAL_STATUS={"opencode":false,"deepseek":true,"glm":false}'
else
  echo 'Credential status unavailable. Check Settings -> Providers.' >&2
  exit 1
fi
EXE
chmod +x "$fixture/electron"
for mode in present unavailable; do
  output=$(env HOME="$fixture/home" REPO_ROOT="$fixture/repo" FIXTURE_EXE="$fixture/electron" FIXTURE_MODE="$mode" DOCTOR_SOURCE="$REPO/scripts/launcher/linux/commands/doctor.sh" bash <<'RUN'
sentry_require_cachyos() { return 1; }
sentry_os_pretty() { echo 'fixture unsupported host'; }
sentry_preferred_node() { command -v node; }
sentry_electron_binary() { printf '%s\n' "$FIXTURE_EXE"; }
sentry_broker_socket() { return 1; }
git() { return 0; }
source "$DOCTOR_SOURCE"
cmd_doctor || true
RUN
)
  if [ "$mode" = present ]; then
    [[ "$output" == *'[INFO] Provider credentials'*'Desktop reports presence'* ]] || exit 1
  else
    [[ "$output" == *'[INFO] Provider credentials'*'verify in Desktop -> Settings -> Providers'* ]] || exit 1
    [[ "$output" != *'Desktop reports presence'* ]] || exit 1
  fi
  [[ "$output" != *'[WARN] Provider credentials'* ]] || exit 1
done
echo CREDENTIAL-DOCTOR-OK
