# Beta compatibility

What changes for an existing 1.0.2 install when it moves to this `dev` build. The
product version stays `1.0.2`; no version numbers changed.

| Area                             | Status                | Notes                                                                                                                                                                                                             |
| -------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime protocol                 | Unchanged (version 1) | New RPC methods (`projects.profile`, `projects.buildProfile`, `toolchains.*`) and the `profile.updated` notification are additive.                                                                                |
| Run schema                       | Backward compatible   | New optional fields only: `configuration.profileUsage` and `executionSafeguards.toolDownloads`. Older runs read unchanged.                                                                                        |
| Database                         | Migration 7 (one-way) | Drops the merge, verification, issue and retest tables and legacy retest runs. Full and Targeted runs, findings, evidence and exports are kept. Back up the data folder first if issue or retest history matters. |
| Project profiles                 | New files             | Stored per project and agent under `<dataRoot>/projects/<id>/profiles/`. Missing or corrupt files are ignored and rebuilt on request.                                                                             |
| Toolchains                       | New, optional         | Installed under `<dataRoot>/toolchains/<pack>/<version>/` by the host. Nothing is installed unless you click install. Removing the folder is safe.                                                                |
| CLI                              | Commands removed      | `run merge`, `issue`, `retest` and `verify` no longer exist.                                                                                                                                                      |
| Settings, secrets, provider pins | Unchanged             |                                                                                                                                                                                                                   |

## Agent support

| Harness     | Toolchain mounts and version pins | Tool and SDK downloads                            | Windows-drive hiding |
| ----------- | --------------------------------- | ------------------------------------------------- | -------------------- |
| OpenCode    | Yes                               | Yes                                               | Yes                  |
| Claude Code | No                                | Yes (sandbox `allowedDomains`)                    | Its own sandbox      |
| DeepSeek    | No                                | No (its network policy is managed by the harness) | Its own sandbox      |

## Known limits in this beta

- Toolchain installers for Rust, Go and Java are covered by unit tests with a fake
  runner but have not been run end to end. Python and .NET have.
- A single run-mode switch (Standard / Unrestricted) is not part of this beta; the
  per-run download option is the only widening control.
- Pins for Gradle projects and `pyproject.toml` ranges are not read; those fall back
  to the newest installed version.
- Which checks an agent plans varies between runs of the same project.

## Upgrade check

1. `sentry stop`, then back up the data folder.
2. Switch to `dev`, run `sentry setup` and `sentry open`.
3. `sentry status` shows the commit, a clean tree and a passed runtime handshake
   (protocol 1).
4. Existing projects and runs are listed; start a Targeted or Full run to confirm.
