# v1 acceptance and authorization checklist

This checklist supplements the [owner runbook](v1-owner-acceptance.md) and
[per-host results](v1-owner-acceptance-results.md). The historical beta release
checklist is not evidence for v1. No box is checked by source implementation alone.

- [ ] Owner reviews the final correction PR into dev; only the owner merges.
- [ ] Exact full candidate SHA, tree, version, protocol and both archive SHA256s recorded.
- [ ] Three required CI jobs pass with head/proposed-merge identities distinguished.
- [ ] Both unsigned distribution jobs pass; archives preserved before expiration.
- [ ] After integration, actual merge tree and post-merge CI verified; selected-SHA archives traced honestly.
- [ ] Real systemd-mount trust rerun on the candidate; skips/unavailable hosts disclosed.
- [ ] Windows fresh install, packaged launch, maintenance/recovery and beta upgrade/rollback pass (A/B/F/G).
- [ ] Native CachyOS packaged install, GUI, sandbox, maintenance/recovery and beta upgrade/rollback pass (A/C/F/G).
- [ ] Real DPAPI and supported native Linux secure-storage/privacy/continuity pass (D).
- [ ] Owner-authorized funded single/two/three-agent Full and Targeted QA evidence collected (E).
- [ ] All failures/defects adjudicated; mandatory acceptance gaps resolved with actual evidence.
- [ ] Owner explicitly accepts the supported-host evidence and feature freeze.
- [ ] Owner separately authorizes Phase 6 and creation of release/v1.0.0-rc.1.

Current authorization: **Phase 6 NOT AUTHORIZED**. This preparation does not
create an RC branch, change product version, tag, publish, or merge a PR.
