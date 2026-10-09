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
- [x] Candidate mandatory CI — all three jobs pass on df6fd49 (PR run 37891284512).
- [x] Fresh real runtime staging/install/build (18/18), activation and handshake.
- [x] Receipt-only PR head CI — b192b03, PR run 37892050450, all three jobs pass.
- [x] Owner authorized proceeding with release after reporting 3/3 on both hosts (2026-10-09).
- [ ] Release documentation update and resulting merge CI — verify before tagging.
- [ ] Further candidate CachyOS close/restart/maintenance checks — not independently verified.
- [ ] Further active-provider cancellation/exit/update checks — automated refusal tests pass; manual matrix not independently verified.
- [ ] Annotated immutable beta tag on the approved, validated commit.
- [ ] GitHub draft pre-release prepared and reviewed; publish only after gates.

Owner confirms Windows/CachyOS 3/3 success and authorizes this release.
These remain owner-reported, not claimed as rerun by the agent. Fresh Windows/WSL installation, real CachyOS,
paid-provider runs and signed/binary distribution are unavailable in this check.
No installers are advertised or attached.
