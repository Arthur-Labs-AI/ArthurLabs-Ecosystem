# Release checklist — v0.1.0-beta.1

2026-10-09 candidate preparation. See [validation](v0.1.0-beta.1-validation.md)
for commands, failures and platform scope. Historical September checkmarks are
not evidence for this candidate.

- [x] Isolated release branch from main; owner's dirty checkout preserved.
- [x] Frozen dependency installation on Windows and native WSL filesystem.
- [x] Repository hygiene, format, lint, type checks and build.
- [x] Full Linux runtime suite, including real sandbox trust tests.
- [x] Windows Desktop, runtime, CLI and available run-engine tests.
- [x] Windows launcher decision/syntax/smoke/behavior/IO/shutdown fixtures.
- [x] Linux launcher syntax and all shell fixtures.
- [x] Failed shutdown blocks setup/update before mutation on both launchers.
- [x] Runtime refuses active run/retest shutdown; Desktop keeps cancellation usable.
- [x] Actual built Windows Electron → candidate WSL runtime smoke and idle quit.
- [x] Private staging exclusions and unchanged security assertions checked.
- [x] Version, source-install instructions, changelog and branching policy aligned.
- [ ] Mandatory CI on the final PR head — verify Actions receipts.
- [ ] Owner review of release PR.
- [ ] Candidate CachyOS Desktop close/restart and maintenance acceptance.
- [ ] Candidate active-run cancellation/exit/update acceptance on supported hosts.
- [ ] Annotated immutable beta tag on the approved, validated commit.
- [ ] GitHub draft pre-release prepared and reviewed; publish only after gates.

Owner-reported earlier Windows/CachyOS 3/3 runs are preserved as historical
acceptance, not claimed as rerun. Fresh Windows/WSL installation, real CachyOS,
paid-provider runs and signed/binary distribution are unavailable in this check.
No installers are advertised or attached.
