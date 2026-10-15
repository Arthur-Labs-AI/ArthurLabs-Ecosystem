# Windows stable release procedure

This is a reusable procedure, not a completed historical checklist. The published
[v1.0.0 Release](https://github.com/Mert1026/Sentry/releases/tag/v1.0.0) and
[v1.0.1 Release](https://github.com/Mert1026/Sentry/releases/tag/v1.0.1) retain their
immutable sources and assets. See [history](../history.md) for original gate results.

1. Obtain an approved exact source/target/platform and version/protocol. Fetch and
   inspect refs, worktrees, tags, CI and releases; preserve owner work and refuse
   an unexpected existing version tag or Release.
2. Verify a clean committed build input, component versions, dependency lock,
   required security/recovery behavior and [test gates](../development/testing.md).
   Distinguish capable-host trust proof from hosted skips.
3. On Windowsx64 run pnpm distribution:build windows-x64. The archive must identify
   the actual approved source; never rename another commit's archive. Record ZIP,
   sidecar, manifest, inventory and source hashes privately.
4. Externally extract and validate complete inventory/component identities. Exercise
   prepared-host packaged setup, visible launch, matching Linux runtime, shutdown,
   restart and essential disposable workflows. Keep limitations explicit.
5. Review public notes, prerequisites, unsigned/online-bootstrap requirements,
   payload privacy, provider charges, updates and recovery. Obtain explicit owner
   authorization for those exact bytes and immutable annotated tag.
6. Recheck source/assets/tag absence and authentication. Create/push the annotated
   tag normally; independently verify the remote tag object and peeled source.
7. Create one non-prerelease draft with the verified tag/notes. Upload only approved
   Windows ZIP and sidecar without overwriting assets. Authenticated-download both
   draft assets and revalidate approved bytes, complete manifest and source.
8. Publish that verified draft as stable. Independently fetch the live public page
   and both assets without credentials; verify checksums, extraction/inventory and
   embedded identity before claiming publication success.
9. Prepare reviewed main→dev propagation and owner-approved post-release maintenance
   PRs. Do not reset/force-push dev or self-merge. Keep tags, release assets and
   relevant historical evidence immutable; no automatic artifact/branch deletion.

Stop on unexpected identity, security, packaging or delivery failures. Do not
silently replace published bytes or move a tag. No test procedure itself authorizes
paid QA, real owner-data restoration or elevated compaction.
