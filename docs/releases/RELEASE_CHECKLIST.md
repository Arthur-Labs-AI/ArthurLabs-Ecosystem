# Release checklist — Sentry v0.1 Beta (`v0.1.0-beta.1`)

Check an item only after actually performing it. Evidence first.

- [ ] tree clean (`git status --porcelain` empty)
- [ ] latest `main` checked out and pushed
- [ ] CI green (Linux quality + Windows launcher job)
- [ ] `pnpm repository:check` passes
- [ ] `pnpm format:check` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes (quarantined historical names only, still executed)
- [ ] `pnpm build` passes
- [ ] Desktop Electron smoke passes (`smoke`, `smoke:electron`)
- [ ] setup tested with existing WSL (detect + reuse, no reinstall)
- [ ] setup tested from a fresh/clean Windows environment where possible
- [ ] runtime deploy tested (versioned dir, atomic `current`, handshake)
- [ ] `sentry open` tested (launches; second `open` focuses)
- [ ] `sentry stop` tested (graceful; no unrelated Electron touched)
- [ ] `sentry update` tested (ff-only, dirty-tree refusal, rebuild, reopen)
- [ ] `sentry doctor` tested (zero paid calls, no secrets)
- [ ] provider settings persist across update
- [ ] OpenCode real run passes
- [ ] DeepSeek real run passes
- [ ] GLM real run passes
- [ ] Full QA 3/3 passes
- [ ] README describes the Beta accurately (no Private Beta naming)
- [ ] release notes (`docs/releases/v0.1.0-beta.1.md`) correct
- [ ] tag `v0.1.0-beta.1` created on the validated commit
- [ ] GitHub Pre-release `Sentry v0.1 Beta` created from the notes file
