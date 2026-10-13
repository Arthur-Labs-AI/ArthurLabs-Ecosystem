# v1 acceptance and authorization checklist

This checklist supplements the [owner runbook](v1-owner-acceptance.md) and
[per-host results](v1-owner-acceptance-results.md). The historical beta release
checklist is not evidence for v1. No box is checked by source implementation alone.

- [x] Owner reviews the final correction PR into dev; only the owner merges (PR14 verified human-owner merge).
- [x] Exact full candidate SHA, tree, version, protocol and both archive SHA256s recorded (integrated D; separate Windows local/CI bytes).
- [x] Three required CI jobs pass with head/proposed-merge identities distinguished (postmerge38364397137).
- [x] Both unsigned distribution jobs pass; archives preserved before expiration (38366622239; old PR-head archives also retained).
- [x] After integration, actual merge tree and post-merge CI verified; selected-SHA archives traced honestly (D tree equals PR14 source tree).
- [x] Real systemd-mount trust rerun on the candidate; skips/unavailable hosts disclosed (actual integrated WSL8/8; hosted/native limits recorded).
- [ ] Windows fresh install, packaged launch, maintenance/recovery and beta upgrade/rollback pass (A/B/F/G).
- [ ] Native CachyOS packaged install, GUI, sandbox, maintenance/recovery and beta upgrade/rollback pass (A/C/F/G).
- [ ] Real DPAPI and supported native Linux secure-storage/privacy/continuity pass (D).
- [ ] Owner-authorized funded single/two/three-agent Full and Targeted QA evidence collected (E).
- [ ] All failures/defects adjudicated; mandatory acceptance gaps resolved with actual evidence.
- [ ] Owner explicitly accepts the supported-host evidence and feature freeze.
- [ ] Owner separately authorizes Phase 6 and creation of release/v1.0.0-rc.1.

Current authorization: **Phase 6 NOT AUTHORIZED**. This preparation does not
create an RC branch, change product version, tag, publish, or merge a PR.

Actual [campaign receipt](v1-owner-acceptance-execution.md),
[W1 cases](v1-owner-acceptance-w1-d250e4c.md),
[C1 cases](v1-owner-acceptance-c1-d250e4c.md) and
[native operator handoff](v1-owner-acceptance-cachyos-handoff.md).
W1:20 PASS,16 NOT RUN,4 ENVIRONMENT UNAVAILABLE,20 OWNER ACCEPTANCE REQUIRED,
1 FAIL. C1:44 ENVIRONMENT UNAVAILABLE,14 OWNER ACCEPTANCE REQUIRED.
Prepared-host Windows GUI/DPAPI/idle recovery positives do not pass the combined
Windows gate. **G10 P1 FAIL**: matching stopped beta rollback retains ciphertext
and history but loses configured credential availability. See the
[separate bounded correction proposal](v1-beta-rollback-credential-proposal.md).
No candidate source change or failure waiver. The [owner Windows/WSL Full
all-three export](v1-owner-run-01M4T9XG-acceptance.md) was received and verified3/3
with10 findings/38 evidence. Build/archive attribution and remaining E07 observations
are open; the other13 combinations/modes remain unexecuted. Counts above remain
unchanged. Phase6 is not recommendable.
