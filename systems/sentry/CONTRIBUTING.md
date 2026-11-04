# Contributing

Use Node >=22 and pnpm9.12.3. Inspect [branching and review](docs/development/branching.md)
before creating a branch; ordinary work targets dev, while explicitly approved
release or post-release maintenance follows its approved base/target. Preserve
the owner's dirty worktree and use a separate checkout when needed.

```text
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @qa/desktop dev:electron
```

The runtime needs a supported Linux/WSL environment, systemd user services,
bubblewrap and socat. Development server setup is in the [Desktop README](apps/desktop/README.md).
Run [appropriate tests and static checks](docs/development/testing.md), describe
actual results/platform skips in the PR, and stop for owner review. Do not run
paid provider campaigns or real elevated disk compaction without authorization.

Read [architecture](docs/architecture/README.md), [security](docs/security/V1_THREAT_MODEL.md),
and [release procedure](docs/releases/RELEASE_CHECKLIST.md). Agents also follow
AGENTS.md, applicable CLAUDE.md/GEMINI.md/SOUL.md and .superharness instructions;
those files are active tooling contracts, not disposable release reports.
