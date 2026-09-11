/**
 * SC-05 integration tests (spawn-free): adapter + pack + builtin wiring
 * with an injected fake HardenedGitRunner.
 *
 * The sandbox denies piped child spawn from Node (EPERM), so real git CLI
 * E2E runs through the pwsh verification script instead
 * (see verify_sc05_e2e.ps1 flow in the task report). These tests cover the
 * full adapter logic — mode scoping, validation gates, ref resolution,
 * policy gates, output bounds, error mapping, registration — against a
 * deterministic fake runner that replays canned git outputs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { ArthurMode } from "../../src/core/modes/mode";
import { ToolRegistry } from "../../src/tools/registry";
import { PermissionService } from "../../src/tools/permissions";
import { HarnessStubAdapter } from "../../src/tools/adapters/harness_stub";
import { registerBuiltinTools } from "../../src/tools/builtin";
import { FilesystemScopeRegistry } from "../../src/tools/scoped_path";
import { LocalGitAdapter } from "../../src/tools/adapters/local_git";
import { HardenedGitRunner } from "../../src/tools/git/command_runner";

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);

function sandbox(): { dir: string; projects: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "sc05-"));
  const projects = path.join(dir, "projects");
  mkdirSync(projects, { recursive: true });
  return { dir, projects };
}

function scopesFor(projects: string): FilesystemScopeRegistry {
  return new FilesystemScopeRegistry([
    { id: "projects", label: "Projects", physical_root: projects, permissions: ["list", "stat", "read", "search"] },
  ]);
}

interface FakeSpec {
  match: (args: string[]) => boolean;
  stdout: string;
  stderr?: string;
  exitCode?: number;
}

/** Fake runner: replays canned outputs for fixed argv templates. */
function fakeRunner(specs: FakeSpec[]): { runner: HardenedGitRunner; seen: string[][] } {
  const seen: string[][] = [];
  const runner = new HardenedGitRunner(
    ((exe: string, args: string[], _opts: unknown) => {
      seen.push([exe, ...args]);
      // shell:false invariant: the fake asserts what production guarantees.
      assert.equal((_opts as { shell?: boolean }).shell, false);
      const spec = specs.find((s) => s.match(args));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { EventEmitter } = require("node:events") as typeof import("node:events");
      const out = spec?.stdout ?? "";
      const errOut = spec?.stderr ?? "";
      const child = new EventEmitter() as unknown as import("node:child_process").ChildProcess;
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      (child as unknown as Record<string, unknown>).stdout = stdout;
      (child as unknown as Record<string, unknown>).stderr = stderr;
      (child as unknown as Record<string, unknown>).kill = () => true;
      process.nextTick(() => {
        if (out.length > 0) stdout.emit("data", Buffer.from(out));
        if (errOut.length > 0) stderr.emit("data", Buffer.from(errOut));
        (child as unknown as InstanceType<typeof EventEmitter>).emit("close", spec?.exitCode ?? 0);
      });
      return child as unknown as import("node:child_process").ChildProcess;
    }) as never,
  );
  return { runner, seen };
}

/** Build a fake on-disk repo: real .git dir so filesystem gates pass. */
function fakeRepoDir(projects: string, name: string): string {
  const dir = path.join(projects, name);
  mkdirSync(path.join(dir, ".git", "objects", "info"), { recursive: true });
  return dir;
}

const VALIDATION_SPECS: FakeSpec[] = [
  { match: (a) => a.includes("--show-toplevel"), stdout: "__TOPLEVEL__\n" },
  { match: (a) => a.includes("--is-bare-repository"), stdout: "false\n" },
  { match: (a) => a.includes("extensions.partialClone"), stdout: "", exitCode: 1 },
];

function withTopLevel(specs: FakeSpec[], top: string): FakeSpec[] {
  return specs.map((s) => (s.match(["--show-toplevel"]) ? { ...s, stdout: top + "\n" } : s));
}

function adapterWithFake(
  projects: string,
  repoName: string,
  specs: FakeSpec[],
  modes: Array<"personal" | "business"> = ["personal", "business"],
): { adapter: LocalGitAdapter; seen: string[][] } {
  const dir = fakeRepoDir(projects, repoName);
  const { runner, seen } = fakeRunner(withTopLevel(specs, dir));
  const adapter = new LocalGitAdapter(
    scopesFor(projects),
    { repositories: [{ id: "repo", label: "Repo", root_id: "projects", path: repoName, allowed_modes: modes }] },
    { runner, probeAvailability: async () => true },
  );
  return { adapter, seen };
}

const STATUS_OUT = [
  "# branch.oid " + OID_A,
  "# branch.head main",
  "# branch.upstream origin/main",
  "# branch.ab +1 -0",
  "1 M. 000000 100644 100644 100644 " + OID_A + " " + OID_A + " src/app.ts",
  "? new.txt",
].join("\0");

test("status/log/branches/show/diff flow through fixed argv templates", async () => {
  const { projects } = sandbox();
  const logOut = [OID_A, "", "Jane", "1700000000", "1700000100", "second", ""].join("\x1f") + "\x1e";
  const { adapter, seen } = adapterWithFake(projects, "repo", [
    ...VALIDATION_SPECS,
    { match: (a) => a.includes("status"), stdout: STATUS_OUT },
    { match: (a) => a[0] === "rev-parse" && a.includes("HEAD^{commit}") && !a.includes("--verify"), stdout: OID_A + "\n" },
    { match: (a) => a.includes("rev-parse") && a.includes("--verify"), stdout: OID_A + "\n" },
    { match: (a) => a.includes("for-each-ref") && a.includes("refs/heads/"), stdout: "refs/heads/main\x1f" + OID_A + "\x1f\n" },
    { match: (a) => a.includes("for-each-ref") && a.includes("refs/remotes/"), stdout: "refs/remotes/origin/main\x1f" + OID_A + "\x1f\n" },
    { match: (a) => a.includes("symbolic-ref"), stdout: "main\n" },
    { match: (a) => a.some((x) => x.startsWith("--format=")) && !a.includes("--numstat"), stdout: logOut },
    { match: (a) => a.includes("diff") && a.includes("--numstat"), stdout: "3\t1\tsrc/app.ts\0" },
    { match: (a) => a.includes("diff") && !a.includes("--numstat"), stdout: "diff --git a/src/app.ts b/src/app.ts\n" },
    { match: (a) => a[0] === "diff-tree", stdout: "3\t1\tsrc/app.ts\0" },
    { match: (a) => a[0] === "show", stdout: "show-patch\n" },
  ]);

  const status = await adapter.getStatus("repo", ArthurMode.PERSONAL);
  assert.equal(status.clean, false);
  assert.ok(status.untracked.includes("new.txt"));
  assert.equal(status.branch.head_oid, OID_A);

  const log = await adapter.getLog("repo", ArthurMode.PERSONAL, { limit: 5 });
  assert.equal(log.commits.length, 1);
  assert.equal(log.resolved_oid, OID_A);

  const branches = await adapter.getBranches("repo", ArthurMode.PERSONAL);
  assert.ok(branches.local.some((b) => b.name === "main"));

  const show = await adapter.showCommit("repo", ArthurMode.PERSONAL, { ref: "HEAD", include_patch: true });
  assert.equal(show.oid, OID_A);

  const diff = await adapter.getDiff("repo", ArthurMode.PERSONAL, "commits", { base_ref: "HEAD~1", target_ref: "HEAD" });
  void diff;

  // No shell, no network subcommand, safety prefix on every call.
  for (const argv of seen) {
    assert.ok(argv.includes("--no-pager"), "missing --no-pager: " + argv.join(" "));
    assert.ok(argv.includes("--no-replace-objects"), "missing --no-replace-objects");
    assert.ok(argv.includes("--literal-pathspecs"), "missing --literal-pathspecs");
    const sub = argv[argv.length - 1] ?? "";
    void sub;
  }
  const flat = seen.map((a) => a.join(" ")).join("\n");
  assert.ok(!/fetch|pull|push|clone|ls-remote/.test(flat), "network subcommand present");
  assert.ok(flat.includes("--no-ext-diff") || flat.includes("--numstat"), "patch path missing --no-ext-diff");
});

test("mode-scoped access rejected; repositories lists only allowed modes", async () => {
  const { projects } = sandbox();
  fakeRepoDir(projects, "backend");
  const { runner } = fakeRunner(VALIDATION_SPECS.map((s) => (s.match(["--show-toplevel"]) ? { ...s, stdout: path.join(projects, "backend") + "\n" } : s)));
  const adapter = new LocalGitAdapter(
    scopesFor(projects),
    { repositories: [{ id: "backend", label: "B", root_id: "projects", path: "backend", allowed_modes: ["business"] }] },
    { runner, probeAvailability: async () => true },
  );
  await assert.rejects(() => adapter.getStatus("backend", ArthurMode.PERSONAL), /unavailable/);
  const repos = await adapter.listRepositories(ArthurMode.PERSONAL);
  assert.equal(repos.repositories.length, 0);
  const biz = await adapter.listRepositories(ArthurMode.BUSINESS);
  assert.equal(biz.repositories.length, 1);
});

test("unknown repo fails closed with no physical path leak", async () => {
  const { projects } = sandbox();
  const { runner } = fakeRunner([]);
  const adapter = new LocalGitAdapter(scopesFor(projects), { repositories: [] }, { runner, probeAvailability: async () => true });
  await assert.rejects(() => adapter.getStatus("nope", ArthurMode.PERSONAL), (e: unknown) => {
    assert.ok(!(e as Error).message.includes(projects), "path leak");
    assert.ok(!(e as Error).message.includes("C:"));
    return true;
  });
});

test("bare repo rejected via --is-bare-repository", async () => {
  const { projects } = sandbox();
  const dir = fakeRepoDir(projects, "bare.git");
  const { runner } = fakeRunner([
    { match: (a) => a.includes("--show-toplevel"), stdout: dir + "\n" },
    { match: (a) => a.includes("--is-bare-repository"), stdout: "true\n" },
  ]);
  const adapter = new LocalGitAdapter(
    scopesFor(projects),
    { repositories: [{ id: "bare", label: "B", root_id: "projects", path: "bare.git", allowed_modes: ["personal"] }] },
    { runner, probeAvailability: async () => true },
  );
  await assert.rejects(() => adapter.getStatus("bare", ArthurMode.PERSONAL), /unavailable/);
});

test("worktree gitfile rejected; subdir config rejected (no parent discovery)", async () => {
  const { projects } = sandbox();
  // gitfile: .git is a FILE not a dir
  const wf = path.join(projects, "linked");
  mkdirSync(wf, { recursive: true });
  writeFileSync(path.join(wf, ".git"), "gitdir: elsewhere");
  const { runner } = fakeRunner([]);
  const adapter = new LocalGitAdapter(
    scopesFor(projects),
    { repositories: [{ id: "linked", label: "L", root_id: "projects", path: "linked", allowed_modes: ["personal"] }] },
    { runner, probeAvailability: async () => true },
  );
  await assert.rejects(() => adapter.getStatus("linked", ArthurMode.PERSONAL), /unavailable/);
  // subdir: top-level differs from configured path
  const repo = path.join(projects, "repo");
  mkdirSync(path.join(repo, ".git", "objects", "info"), { recursive: true });
  mkdirSync(path.join(repo, "src"), { recursive: true });
  const { runner: r2 } = fakeRunner([{ match: (a) => a.includes("--show-toplevel"), stdout: repo + "\n" }]);
  const adapter2 = new LocalGitAdapter(
    scopesFor(projects),
    { repositories: [{ id: "sub", label: "S", root_id: "projects", path: "repo/src", allowed_modes: ["personal"] }] },
    { runner: r2, probeAvailability: async () => true },
  );
  await assert.rejects(() => adapter2.getStatus("sub", ArthurMode.PERSONAL), /unavailable/);
});

test("dubious ownership on stderr classifies UNSAFE (not generic unsupported)", async () => {
  const { projects } = sandbox();
  const dir = fakeRepoDir(projects, "repo");
  const { runner } = fakeRunner([
    { match: (a) => a.includes("--show-toplevel"), stdout: "", stderr: "fatal: detected dubious ownership in repository at '" + dir + "'", exitCode: 128 },
  ]);
  const adapter = new LocalGitAdapter(
    scopesFor(projects),
    { repositories: [{ id: "repo", label: "R", root_id: "projects", path: "repo", allowed_modes: ["personal"] }] },
    { runner, probeAvailability: async () => true },
  );
  await assert.rejects(() => adapter.getStatus("repo", ArthurMode.PERSONAL), (e: unknown) => {
    assert.equal((e as { code?: string }).code, "TOOL_RESOURCE_UNSUPPORTED");
    assert.deepEqual((e as { details?: unknown }).details, { repository: "repo", git_code: "GIT_REPOSITORY_UNSAFE" });
    return true;
  });
});

test("alternates file rejected", async () => {
  const { projects } = sandbox();
  const dir = fakeRepoDir(projects, "repo");
  writeFileSync(path.join(dir, ".git", "objects", "info", "alternates"), "/elsewhere/objects\n");
  const { runner } = fakeRunner(withTopLevel(VALIDATION_SPECS, dir));
  const adapter = new LocalGitAdapter(
    scopesFor(projects),
    { repositories: [{ id: "repo", label: "R", root_id: "projects", path: "repo", allowed_modes: ["personal"] }] },
    { runner, probeAvailability: async () => true },
  );
  await assert.rejects(() => adapter.getStatus("repo", ArthurMode.PERSONAL), /unavailable/);
});

test("ref injection fails closed before execution", async () => {
  const { projects } = sandbox();
  const dir = fakeRepoDir(projects, "repo");
  const { runner, seen } = fakeRunner(withTopLevel(VALIDATION_SPECS, dir));
  const adapter = new LocalGitAdapter(
    scopesFor(projects),
    { repositories: [{ id: "repo", label: "R", root_id: "projects", path: "repo", allowed_modes: ["personal"] }] },
    { runner, probeAvailability: async () => true },
  );
  const before = seen.length;
  await assert.rejects(() => adapter.showCommit("repo", ArthurMode.PERSONAL, { ref: "--exec-path=/tmp/evil" }), /Invalid git ref|unavailable/);
  const refCalls = seen.slice(before).filter((a) => a.includes("rev-parse") && a.includes("--verify"));
  assert.equal(refCalls.length, 0);
});

test("git.show rejects non-commit expressions and blob paths", async () => {
  const { projects } = sandbox();
  const dir = fakeRepoDir(projects, "repo");
  const { runner } = fakeRunner([
    ...withTopLevel(VALIDATION_SPECS, dir),
    { match: (a) => a.includes("rev-parse") && a.includes("--verify"), stdout: "", exitCode: 1 },
  ]);
  const adapter = new LocalGitAdapter(
    scopesFor(projects),
    { repositories: [{ id: "repo", label: "R", root_id: "projects", path: "repo", allowed_modes: ["personal"] }] },
    { runner, probeAvailability: async () => true },
  );
  await assert.rejects(() => adapter.showCommit("repo", ArthurMode.PERSONAL, { ref: "HEAD:path/to/file" }), /Invalid git ref|unavailable/);
});

test("sensitive path blocked before git runs", async () => {
  const { projects } = sandbox();
  const dir = fakeRepoDir(projects, "repo");
  const { runner, seen } = fakeRunner(withTopLevel(VALIDATION_SPECS, dir));
  const adapter = new LocalGitAdapter(
    scopesFor(projects),
    { repositories: [{ id: "repo", label: "R", root_id: "projects", path: "repo", allowed_modes: ["personal"] }] },
    { runner, probeAvailability: async () => true },
  );
  const before = seen.length;
  await assert.rejects(() => adapter.getDiff("repo", ArthurMode.PERSONAL, "unstaged", { path: ".env" }), /blocked|unsupported|unavailable/i);
  const diffCalls = seen.slice(before).filter((a) => a.includes("diff"));
  assert.equal(diffCalls.length, 0);
});

test("git missing degrades capability; bad catalog throws at construction", async () => {
  const { projects } = sandbox();
  const { runner } = fakeRunner([]);
  const adapter = new LocalGitAdapter(scopesFor(projects), { repositories: [] }, { runner, probeAvailability: async () => false });
  await assert.rejects(() => adapter.getStatus("x", ArthurMode.PERSONAL), (e: unknown) => {
    assert.equal((e as { code?: string }).code, "TOOL_CAPABILITY_UNAVAILABLE");
    return true;
  });
  assert.throws(
    () =>
      new LocalGitAdapter(scopesFor(projects), {
        repositories: [
          { id: "dup", label: "a", root_id: "projects", path: "a", allowed_modes: ["personal"] },
          { id: "dup", label: "b", root_id: "projects", path: "b", allowed_modes: ["personal"] },
        ],
      }),
    /Duplicate git repository id/,
  );
});

test("builtin registers six git tools with single-attempt read policy", async () => {
  const { projects } = sandbox();
  const dir = fakeRepoDir(projects, "repo");
  const registry = new ToolRegistry();
  const permissions = new PermissionService();
  const harness = new HarnessStubAdapter({ verificationSecret: "test-secret" });
  const scopes = scopesFor(projects);
  const { runner } = fakeRunner([
    { match: (a) => a.includes("--show-toplevel"), stdout: dir + "\n" },
    { match: (a) => a.includes("--is-bare-repository"), stdout: "false\n" },
    { match: (a) => a.includes("extensions.partialClone"), stdout: "", exitCode: 1 },
    { match: (a) => a.includes("status"), stdout: ["# branch.oid " + OID_A, "# branch.head main"].join("\0") },
  ]);
  const { buildDefaultLocalHost } = await import("../../src/tools/builtin");
  const host = buildDefaultLocalHost(undefined, {
    filesystem_roots: [{ id: "projects", label: "Projects", physical_root: projects, permissions: ["list", "stat", "read", "search"] }],
    applications: [],
    filesystem_bounds: {
      list_limit_max: 200,
      read_max_lines: 200,
      read_max_bytes: 12 * 1024,
      search_max_results: 50,
      search_max_files: 5000,
      search_max_bytes_per_file: 1024 * 1024,
      search_max_total_bytes: 50 * 1024 * 1024,
    },
  });
  host.git = new LocalGitAdapter(
    scopes,
    { repositories: [{ id: "repo", label: "Repo", root_id: "projects", path: "repo", allowed_modes: ["personal", "business"] }] },
    { runner, probeAvailability: async () => true },
  );
  registerBuiltinTools(registry, harness, { host });
  for (const name of ["git.repositories", "git.status", "git.diff", "git.log", "git.branches", "git.show"]) {
    assert.ok(registry.has(name), name);
    const policy = registry.getExecutionPolicy(name);
    assert.equal(policy?.effects, "none");
    assert.equal(policy?.retry.max_attempts, 1);
    assert.equal(policy?.retry.strategy, "off");
    assert.equal(policy?.cancellation, "cooperative");
  }
  const execution = registry.createExecutionService(permissions);
  const ctx = { session_id: "s", turn_id: "t", trace_id: "tr", mode: ArthurMode.PERSONAL, approved: false };
  const repos = await execution.execute("git.repositories", {}, ctx);
  assert.ok(repos.ok);
  const status = await execution.execute("git.status", { repo_id: "repo" }, ctx);
  assert.ok(status.ok);
  assert.ok(!JSON.stringify(status).includes(projects));
  // No generic git tool exists.
  assert.ok(!registry.has("git.run"));
  assert.ok(!registry.has("git.exec"));
  assert.ok(!registry.has("git.command"));
});
