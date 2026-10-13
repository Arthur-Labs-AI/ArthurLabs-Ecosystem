# v1 acceptance and authorization checklist

This checklist supplements the [owner runbook](v1-owner-acceptance.md) and
[per-host results](v1-owner-acceptance-results.md). The historical beta release
checklist is not evidence for v1. No box is checked by source implementation alone.

Current integrated baseline: PR17's credential correction and PR16's owner-run
evidence are owner-merged into dev `c78faa7`. The
[Phase5.1 receipt](v1-post-merge-acceptance-c78faa7.md) selects new unsigned I1
artifacts and records newly executed integrated tests and Windows DPAPI checks.
The [520 correction receipt](v1-provider-credential-persistence-validation.md)
and historical D/W1/C1 results retain their exact identities. G10 remains FAIL.

- [x] Owner reviews correction PRs into dev; only the owner merges (PR14/16/17 actual merges verified; Phase5.1 evidence PR still requires review).
- [x] Exact full selected SHA, tree, version, protocol and both archive SHA256s recorded (I1; separate local/CI Windows bytes).
- [x] Three required post-merge CI jobs pass (I1 run38411670558; receipt-PR checks separately reported).
- [x] Both I1 unsigned distribution jobs pass (38417470244; private artifacts preserved separately from D/520).
- [x] Actual integrated merge/source tree and post-merge CI verified; selected I1 archives traced honestly.
- [x] Real systemd-mount trust rerun on I1,8/8; full WSL1,236PASS/16skips; hosted/native limits disclosed.
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
No beta correction or failure waiver. The [owner Windows/WSL Full
all-three export](v1-owner-run-01M4T9XG-acceptance.md) was received and verified3/3
with10 findings/38 evidence. Build/archive attribution and remaining E07 observations
are open; the other13 combinations/modes remain unexecuted. Counts above remain
unchanged. Phase6 is not recommendable.
