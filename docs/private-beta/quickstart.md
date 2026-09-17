# Sentry Private Beta — Quickstart

For a technically capable friend: from cloned repo to first run without
reading architecture docs.

```sh
pnpm install && pnpm build
qa agent list --json            # which stacks are actually configured
qa verify doctor --json         # sandboxAvailable should be true
qa project add /path/to/project --json
qa run start <project-id> --mode full --wait --json
qa run merge <run-id> --json
qa verify start <merge-result-id> --json
```

Then narrow in:

```sh
qa run start <project-id> --mode targeted --paths src/auth --wait --json
qa project revisions <project-id> --json
qa issue list <project-id> --json
```

After changing the source:

```sh
qa project update <project-id> --json
qa issue history <issue-id> --json
```

Useful at any point:

```sh
qa run cancel <run-id> --json   # stop a stuck nonterminal run
qa run status <run-id> --json
qa --help
```

Stuck? Read `docs/private-beta/setup.md` (full setup) and
`docs/private-beta/troubleshooting.md` (common failures). Do not disable
trust checks — report the failure instead.
