# Sentry RC1 — quick CachyOS test

Mert will send you two files:

- `sentry-1.0.0-rc.1-8a75e9924a41-cachyos-x64.tar.gz` (about 113 MB).
- [`cachyos-rc1-smoke.fish`](../../scripts/distribution/tests/cachyos-rc1-smoke.fish).

Save both directly in `~/Downloads`. Keep the `.tar.gz` intact; the script extracts it.

The archive is an unsigned RC review build from Sentry's GitHub Actions
[distribution run 38514834916](https://github.com/Mert1026/Sentry/actions/runs/38514834916),
using approved source `8a75e9924a41b98351e46255111fdbfed335f1f0`.
It is not yet a published GitHub Release. The fish script was prepared for this
manual test: it verifies the archive and creates separate test profile, data and
runtime directories. Your usual `sentry` command and existing installation remain
available. This test establishes actual native CachyOS compatibility.

## 1. Close the existing Sentry

Cancel any active QA, then run in fish:

```fish
sentry stop
```

Make sure the old app has closed. If stopping fails, report the error before continuing.

## 2. Install and open the RC test copy

From your normal graphical desktop session, run:

```fish
source ~/Downloads/cachyos-rc1-smoke.fish
```

The script checks the checksum, creates a new `~/sentry-rc1-smoke.XXXXXX` folder,
sets up the runtime and opens the RC. Internet is required; setup may take several
minutes. It requires Linux Node >=22 with npm, systemd user services,
bubblewrap and socat. The helper installs pnpm 9.12.3 into the test directory
and supplies its bin directory to setup and runtime build subprocesses.
If a prerequisite is missing, send the printed error. Continue only after setup
reports `Runtime verified and active` and the RC app opens. The corrected helper
refuses `open` if the runtime entry has not been installed.

Expected checksum:

```text
8d906885c10c6fe9be2892f0dff6797e7236c5f85cec18c219f043f7262e75a8
```

Keep this fish terminal open. The following `sentry_rc1` commands are defined in
that terminal; ordinary `sentry` commands still refer to your existing installation.

## 3. Check basic functionality

```fish
sentry_rc1 status
sentry_rc1 doctor
```

In the app, check Environment reports a connected runtime with:

- Version `1.0.0-rc.1`.
- Source `8a75e9924a41b98351e46255111fdbfed335f1f0`.
- Protocol `1`.

Import a disposable project and browse the app. This fresh test profile starts
without your saved credentials or old history; that is expected. No provider
credentials or paid QA run is needed.

## 4. Check restart and project persistence

```fish
sentry_rc1 stop
sentry_rc1 open
```

Confirm normal shutdown/relaunch and that the imported project still appears.

## 5. Finish and return to your usual installation

```fish
sentry_rc1 stop
sentry open
```

Leave the test directory intact until the result is reviewed.

Send Mert a short result:

```text
Archive checksum: PASS / FAIL
Graphical launch: PASS / FAIL
Runtime connected, matching version/source/protocol: PASS / FAIL
Project import and persistence after restart: PASS / FAIL
Graceful shutdown: PASS / FAIL
Error, if any: ...
```

No video, screenshots, provider keys or full QA matrix are required. This is an
RC packaging smoke test, not a recovery/rollback test.

## Retry an earlier missing-pnpm attempt

The original helper assumed pnpm was already on PATH. If setup printed
`Install Linux pnpm 9.12.3`, the runtime was not installed; opening Desktop afterward
produces `MODULE_NOT_FOUND`. In the same fish terminal as that attempt, this
repair keeps its existing test directory:

```fish
function repair_sentry_rc1
    set -q sentry_rc1_root; or return 1
    sentry_rc1 stop; or return 1
    set -l prefix "$sentry_rc1_root/home/.local/share/sentry/pnpm"
    env HOME="$sentry_rc1_root/home" npm install --prefix "$prefix" --no-audit --no-fund pnpm@9.12.3; or return 1
    set -gx PATH "$prefix/node_modules/.bin" $PATH
    sentry_rc1 setup; or return 1
    sentry_rc1 open
end
repair_sentry_rc1
```

If that original terminal is closed, use the corrected helper from step 2 to make
a new test copy. Previous test folders remain intact. Fontconfig warnings in the
reported attempt were separate from the missing-pnpm setup failure.
