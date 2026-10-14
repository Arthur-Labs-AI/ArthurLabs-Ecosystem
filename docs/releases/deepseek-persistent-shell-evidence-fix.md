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
  Linux/WSL execution is pending in the source-commit record.
- Local packaging, matching Linux bootstrap/handshake and packaged Desktop
  smoke are pending in this source-commit record. Their receipts will identify
  the exact tested source and artifact outside the archive.

Private logs: `C:/Users/merte/.codex/artifacts/sentry-deepseek-evidence-fix-20261014`.
The complete export and project content are not copied into the repository.
Primary checkout's preexisting owner edits are preserved. `shux contract` was
attempted but is unavailable; task status, ledger and handoff are maintained
directly. A funded live rerun and historical failing-run recovery are unverified;
the fix applies to new QA runs after installing the matching local build.
