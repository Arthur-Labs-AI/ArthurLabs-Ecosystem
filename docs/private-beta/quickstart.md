# Sentry Private Beta — Quickstart

For a technically capable friend: from cloned repo to first run without
reading architecture docs.

The CLI has no installer yet. Either alias the built entry once:

```sh
pnpm install && pnpm build
alias qa="node $PWD/apps/cli/dist/index.js"
```

or prefix every command below with `node apps/cli/dist/index.js` instead
of `qa`. Data lives under `SENTRY_DATA_ROOT` when set, otherwise the
OS-default path shown by `qa doctor`.

```sh
qa agent list --json            # which stacks are actually configured
qa verify doctor --json         # sandboxAvailable should be true
qa project add /path/to/project --json
qa run start <project-id> --mode full --wait --json
qa run merge <run-id> --json
qa verify start <merge-result-id> --json
qa issue ingest <merge-result-id> --json   # first occurrence per cluster
qa issue list <project-id> --json
```

No providers configured? `agent list` shows all three unavailable. Use a
dry run instead of `run start` (fake agents, real pipeline):

```sh
qa run simulate <project-id> --scenario success --json
```

Then narrow in:

```sh
qa run start <project-id> --mode targeted --paths src/auth --wait --json
qa project revisions <project-id> --json
qa issue show <issue-id> --json
```

After changing the source:

```sh
qa project update <project-id> --json
qa retest start <issue-id> --wait --json
qa retest show <retest-run-id> --json
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
