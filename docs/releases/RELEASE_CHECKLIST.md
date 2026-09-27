# Release checklist — Sentry v0.1 Beta (`v0.1.0-beta.1`)

Check an item only after actually performing it. Evidence first.
Status as of the readiness-hardening pass (code validated at 243ab49, 2026-09-27; this commit is checklist-docs only).

- [x] tree clean (`git status --porcelain` empty) — verified clean
- [ ] latest `main` checked out and pushed — fix commits since e350150 are LOCAL, not pushed
- [ ] CI green (Linux quality + Windows launcher job) — must be read from GitHub Actions on the final HEAD (see validation notes)
- [x] `pnpm repository:check` passes
- [x] `pnpm format:check` passes
- [x] `pnpm lint` passes (20/20)
- [x] `pnpm typecheck` passes (37/37)
- [ ] `pnpm test` passes (quarantined historical names only, still executed) — bare run fails ONLY on pre-existing quarantined merger/verifier names plus Windows-environmental sandbox/EBUSY cases on byte-identical code; required suite otherwise green
- [x] `pnpm build` passes (20/20)
- [x] Desktop Electron smoke passes (`smoke`, `smoke:electron` — 0 failures)
- [x] setup tested with existing WSL (detect + reuse, no reinstall — two full green runs exit 0)
- [ ] setup tested from a fresh/clean Windows environment where possible — NOT performed (no clean machine available)
- [x] runtime deploy tested (versioned dir, atomic `current`, handshake — source-clean turbo build 18/18)
- [x] `sentry open` tested (launches; second `open` focuses — single instance verified)
- [x] `sentry stop` tested (graceful; marker-specific, never taskkill; idle-stop clean)
- [x] `sentry update` tested (origin/main merge, dirty-tree refusal, wrong-branch refusal, no-update path, handoff rebuild + redeploy + revalidate; reopen-when-running not live-fired)
- [x] `sentry doctor` tested (zero paid calls, no secrets — READY with honest CONFIGURATION state; socat/bwrap/init rows green)
- [x] provider settings persist across update (models.json overrides merged, user models untouched)
- [ ] OpenCode real run passes — NOT performed (no provider credentials in this session)
- [ ] DeepSeek real run passes — NOT performed (no provider credentials in this session)
- [ ] GLM real run passes — NOT performed (no provider credentials in this session)
- [ ] Full QA 3/3 passes — NOT performed (blocked on credentials, not on code)
- [x] README describes the Beta accurately (no Private Beta naming — user docs use Beta; ADRs stay historical)
- [x] release notes (`docs/releases/v0.1.0-beta.1.md`) correct
- [ ] tag `v0.1.0-beta.1` created on the validated commit — NOT created (needs 3/3 + CI first)
- [ ] GitHub Pre-release `Sentry v0.1 Beta` created from the notes file — NOT created

## Validation notes (this pass)

- WSL1 conversion, no-WSL elevation/UAC paths, and reboot resume are
  covered by mocked-boundary behavior tests (31 checks) plus code review —
  NOT by live WSL1/no-WSL machines, which were unavailable here.
- `sentry update` with a real newer `origin/main` (fetch → stop → rebuild →
  reopen while running) was exercised as a no-op merge + full handoff; the
  reopen-while-running branch is code-reviewed but not live-fired.
- Windows/Linux CI results must be read from GitHub Actions on this HEAD;
  the Windows job was repaired (full `pnpm build` first) but its green run
  is UNVERIFIED until CI executes it.
