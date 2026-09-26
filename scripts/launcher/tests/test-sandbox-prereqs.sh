#!/usr/bin/env bash
# test-sandbox-prereqs.sh — sandbox prerequisite matrix for check-sandbox.sh.
# Self-contained: stub socat/bwrap binaries in isolated PATH dirs (plus
# symlinked helpers), no system changes, real system tools never leak in.
# Run: bash scripts/launcher/tests/test-sandbox-prereqs.sh   (repo root)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
CHECK="$HERE/../linux/check-sandbox.sh"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
check() {
  name="$1"; shift
  if "$@" >/dev/null 2>&1; then pass=$((pass+1)); echo "PASS $name";
  else fail=$((fail+1)); echo "FAIL $name"; fi
}
mkbin() {
  dir="$1"; name="$2"; body="$3"
  printf '#!/usr/bin/env bash\n%s\n' "$body" > "$dir/$name"
  chmod +x "$dir/$name"
}
mkcase() {
  dir="$1"
  mkdir -p "$dir"
  ln -sf /usr/bin/head "$dir/head"
  ln -sf "$BASH" "$dir/bash"
}
run_check() {
  "$BASH" "$CHECK"
}
# A. both available, init works
mkcase "$T/a"
mkbin "$T/a" socat 'echo "socat version 1.8.0.3"; exit 0'
mkbin "$T/a" bwrap 'if [ "$1" = "--version" ]; then echo "bubblewrap 0.10.1"; exit 0; fi; exit 0'
# NOTE: single quotes above are literal; $1/--version stay intact for the stub shell
out=$(PATH="$T/a" run_check)
check 'A-socat-have' test "$(echo "$out" | grep -c '^HAVE-socat$')" = 1
check 'A-bwrap-have' test "$(echo "$out" | grep -c '^HAVE-bwrap$')" = 1
check 'A-init-ok' test "$(echo "$out" | grep -c '^SANDBOX_INIT_OK$')" = 1
# B. socat missing (isolated PATH: real /usr/bin/socat cannot leak in)
mkcase "$T/b"
mkbin "$T/b" bwrap 'exit 0'
out=$(PATH="$T/b" run_check)
check 'B-socat-miss' test "$(echo "$out" | grep -c '^MISS-socat$')" = 1
check 'B-bwrap-still-have' test "$(echo "$out" | grep -c '^HAVE-bwrap$')" = 1
# C. bwrap missing
mkcase "$T/c"
mkbin "$T/c" socat 'echo "socat version 1.8.0.3"; exit 0'
out=$(PATH="$T/c" run_check)
check 'C-bwrap-miss' test "$(echo "$out" | grep -c '^MISS-bwrap$')" = 1
check 'C-init-fail-names-bwrap' test "$(echo "$out" | grep -c 'bwrap-missing')" = 1
check 'C-socat-still-have' test "$(echo "$out" | grep -c '^HAVE-socat$')" = 1
# D. both missing
mkcase "$T/d"
out=$(PATH="$T/d" run_check)
check 'D-both-miss' test "$(echo "$out" | grep -c '^MISS-')" = 2
# E. bwrap present but init fails (userns restricted)
mkcase "$T/e"
mkbin "$T/e" socat 'echo "socat version 1.8.0.3"; exit 0'
mkbin "$T/e" bwrap 'if [ "$1" = "--version" ]; then echo "bubblewrap 0.10.1"; exit 0; fi; echo "bwrap: No permissions" >&2; exit 1'
out=$(PATH="$T/e" run_check)
check 'E-init-fail-reported' test "$(echo "$out" | grep -c '^SANDBOX_INIT_FAIL=')" = 1
check 'E-binaries-still-have' test "$(echo "$out" | grep -c '^HAVE-')" = 2
echo "sandbox-prereqs: pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
