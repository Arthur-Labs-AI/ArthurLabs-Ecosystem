# DeepSeek persistent Bash evidence repair — local review

Owner requested a local fix, with no GitHub PR. Branch
`codex/deepseek-shell-evidence` starts at `90677b5`, which includes the Windows
bootstrap correction and the application baseline used by the installed
`16b47d8` archive. No push, PR, release publication or paid provider calls.

## Diagnosis

The supplied run `run_01M4XH2DHRPX0QD51AB3FTP0W5` completed investigation,
then rejected both report attempts with `DEEPSEEK_INVALID_RESULT: Strong findings
require grounded source/tool evidence`. Its export contains 46 completed tools,
zero `command.executed` events and 28 visible persistent-shell completion markers.
Other tool messages are truncated; their original tails are unavailable. The
rejected report JSON is not exported, so its exact evidence keys are unavailable.

The locally installed pinned `@deepseek-ai/dsh-tool-bash-persistent@0.1.5-rc.2`
`renderCaptured` appends `[Command finished with exit code N]`, including zero;
with empty output, the marker is the entire result. Sentry recognized only the
separate `dsh-shell` renderer's `[exit code: N]` and signal format. It therefore
lost observed outcomes, rendered them unknown in the frozen ledger and downgraded
command evidence to manual reasoning. Strong findings citing that evidence fail
canonical trust validation. A deterministic adapter replay reproduces the exact
reported two-attempt error without contacting DeepSeek.

## Repair and verification

The adapter now recognizes the pinned persistent Bash marker at the end of a
shell tool result, on its own line or as the complete empty-output result. Its
exit value must be a nonnegative safe integer. Existing structured metadata
precedence, old marker support, operation correlation and canonical trust checks
remain. No implicit success for missing markers, confidence downgrades, schema
changes, provider upgrades or retries beyond the existing limit were introduced.

- Regression: three positive cases failed with the exact production error before
  the fix; all pass afterward. They assert frozen-ledger exit code, successful
  first report and durable canonical operation IDs on command evidence.
- Seven negative cases retain rejection: missing, embedded, nonterminal,
  negative, fractional and unsafe-integer markers, and markers from a file tool.
- Windows adapter file: 39/39 pass. Entire DeepSeek package: 56/56 pass.
- Windows evidence pipeline: 18/18; domain: 88/88; schemas: 118/118;
  harness protocol: 25/25 pass. All affected checks executed uncached.
- DeepSeek lint/typecheck and dependency builds: 15/15 uncached tasks pass.
- The broader Windows run-engine check had 80 passes and six Linux sandbox
  failures because systemd user tools are unavailable on Windows, with secondary
  SQLite cleanup locks. These failures are retained, not hidden or weakened;
  Linux/WSL execution subsequently passed all 391 affected tests, including
  run-engine 86/86 and its eight real sandbox trust tests (20 uncached tasks).
- Local Windows packaging passed all 20 forced builds, 332-file inventory and
  ZIP extraction verification. Windows distribution tests: 31 pass, 27
  platform skips. Format, diff and repository hygiene checks passed.
- Exact archive bootstrap under isolated WSL HOME passed frozen installation,
  candidate and active runtime handshakes. Packaged Desktop smoke passed with
  an explicit isolated profile: production entrypoint, preload, renderer, IPC,
  matching Linux handshake, import, single instance and graceful stop.
  Populated historical upgrades, encrypted credentials and live paid QA were
  not retested; the owner's installation was not replaced by the agent.

## Exact local candidate

Tested source: `0ac6c1c62ccc2660ce1f92bed078cfdad7f4a80a`. Later receipt-only
documentation commits do not change the archive's source identity.

Archive: `dist/distributions/sentry-1.0.0-rc.1-0ac6c1c62ccc-windows-x64.zip`.
SHA256: `63c9b166ba1f5fb7d9fc487f61833422a613023ce789c57b3a33427a63216308`.
Version remains `1.0.0-rc.1`; protocol remains 1. Local review candidate only.

The private `install-local-fix.ps1` script verifies this checksum, extracts to a
separate directory in LocalAppData, validates the manifest, uses the supported
graceful stop and Windows setup, checks the activated runtime identity and opens
the matching Desktop. Syntax and `-VerifyOnly` passed. The owner subsequently
installed this exact candidate; the launch correction below records acceptance.
It preserves existing provider configuration and
does not provision tools or start QA. After installation, check Environment is
Connected and start a new DeepSeek QA run. Earlier failed runs remain unchanged.

Private logs: `C:/Users/merte/.codex/artifacts/sentry-deepseek-evidence-fix-20261014`.
The complete export and project content are not copied into the repository.
Primary checkout's preexisting owner edits are preserved. `shux contract` was
attempted but is unavailable; task status, ledger and handoff are maintained
directly. A funded live rerun and historical failing-run recovery are unverified;
the fix applies to new QA runs after installing the matching local build.

## Follow-up: Windows hidden launch corrected

The owner successfully installed source `0ac6c1c` but saw no window. Inspection
found that exact packaged Desktop running with no visible main window. The
distribution `open` command used `Start-Process -WindowStyle Hidden`; repeated
opens only focused the hidden single instance. Earlier packaged smoke launched
the executable directly and therefore did not test this launcher path.

Changed the source launcher to `WindowStyle Normal`. A new test executes the
real PowerShell entrypoint with a mocked process boundary and checks arguments,
working directory and visible launch style. RED: Hidden differs from Normal;
GREEN: 6/6 launcher tests, full Windows distribution 32 pass/27 platform skips.
PowerShell syntax checks passed for the launcher and both private user scripts.

The immutable installed archive was preserved. The private installer now starts
its verified executable normally. `open-local-fix.ps1` validates installed and
active runtime identities, returns without interruption if already visible,
otherwise gracefully stops the hidden process and starts the matching Desktop
normally. Actual owner installation: visible `Sentry` window, PID 14276,
nonzero main-window handle, matching source `0ac6c1c`; a repeated helper call
returned already visible with the same PID. No runtime reinstall or QA call.

The global `Sentry` shim still points at `Sentry-latest`, and the owner's former
working directory is archive `16b47d8`. Use the private `open-local-fix.ps1` for
this installed candidate. Future archives include the source launcher repair;
this follow-up did not rebuild or mutate the existing candidate. No PR or push.
