# Muse Code setup

Phase 3 requires a separately installed Muse Code CLI. Sentry never downloads,
bundles, or silently substitutes a harness or model.

## Configure

1. Install and authenticate Muse Code using Meta's
   [official SDK and host instructions](https://github.com/meta-models/muse-code-sdk).
2. Make `muse` available on `PATH`, or set `SENTRY_MUSE_BINARY` to the executable.
   On Linux, `muse` may instead be the unrelated MusE music sequencer. Its
   `--version` prints `MusE 4.2.1`, not `Muse Code ...`; set
   `SENTRY_MUSE_BINARY` to the actual Meta Muse Code executable in that case.
3. Set `SENTRY_MUSE_MODEL` to the exact model ID accepted by that installation.
   The intended Phase 3 configuration is `muse-spark-1.3-contributor`, but Sentry
   does not assume the host supports it.
4. Run `qa agent doctor muse`. This checks configuration and `muse --version`
   without a model call. Sandbox enforcement itself is exercised by Muse during
   real session startup, so doctor reports that check as a warning until then.

PowerShell example:

```powershell
$env:SENTRY_MUSE_BINARY = 'C:\Tools\Muse\muse.exe'
$env:SENTRY_MUSE_MODEL = 'muse-spark-1.3-contributor'
qa agent doctor muse
```

Then add or update a project and run:

```text
qa run start <project-id> --mode full --agents muse --wait
```

The discovery order is explicit adapter option (embedders),
`SENTRY_MUSE_BINARY`, then `muse` on `PATH`. There is no fallback model or fake
production path. Never configure Sentry with `--yolo`, `--disable-sandbox`, or a
wrapper that injects those flags.

Sentry uses Muse's documented noninteractive approval selection while retaining
the default sandbox boundary. Meta's [contained execution](https://github.com/meta-models/meta-model-cookbook/blob/main/04_muse_code/04_contained_execution/README.md)
and [staged approvals](https://github.com/meta-models/meta-model-cookbook/blob/main/04_muse_code/03_staged_approvals/README.md)
guides describe the distinction. A sandbox startup failure stops the run.

## Optional live test

Normal tests are deterministic and offline. To authorize a real model smoke in
a prepared environment, set `SENTRY_LIVE_MUSE_TEST=1` together with the binary,
model, and credentials, then run the `@qa/harness-muse` test suite. The flag is
an explicit cost/network opt-in.
