/**
 * SC-05 unit tests: catalog, ref/path validation, parsers, runner env,
 * error mapping. Deterministic, no real git spawn (runner/env pure).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildGitChildEnv, gitAbortCode, HardenedGitRunner } from "../../src/tools/git/command_runner";
import { boundPatch, deterministicDiffFlags, deterministicNumstatFlags, parseNumstatZ } from "../../src/tools/git/parsers/diff";
import { parseLogOutput, parseShowMetadata } from "../../src/tools/git/parsers/log";
import { parseBranches } from "../../src/tools/git/parsers/refs";
import { operationStateFromMarkers, parsePorcelainV2, splitNulRecords } from "../../src/tools/git/parsers/status";
import { assertRefShape } from "../../src/tools/git/ref_resolver";
import { GitRepositoryCatalog, validateGitCapabilityConfig } from "../../src/tools/git/repository_catalog";

// ---- catalog ----

test("git catalog rejects duplicate ids and bad modes", () => {
  assert.throws(
    () =>
      validateGitCapabilityConfig({
        repositories: [
          { id: "nexus", label: "N", root_id: "projects", path: "Nexus", allowed_modes: ["personal"] },
          { id: "nexus", label: "N2", root_id: "projects", path: "Other", allowed_modes: ["personal"] },
        ],
      }),
    /Duplicate git repository id/,
  );
  assert.throws(
    () =>
      validateGitCapabilityConfig({
        repositories: [{ id: "Bad!", label: "N", root_id: "projects", path: "x", allowed_modes: ["personal"] }],
      }),
    /Invalid git repository id/,
  );
  assert.throws(
    () =>
      validateGitCapabilityConfig({
        git_executable: "relative/git",
        repositories: [],
      }),
    /absolute trusted path/,
  );
  assert.throws(
    () =>
      validateGitCapabilityConfig({
        repositories: [
          { id: "a", label: "A", root_id: "projects", path: "Nexus", allowed_modes: ["personal"] },
          { id: "b", label: "B", root_id: "projects", path: "Nexus", allowed_modes: ["personal"] },
        ],
      }),
    /Duplicate git repository physical path/,
  );
  assert.doesNotThrow(() =>
    validateGitCapabilityConfig({
      repositories: [
        { id: "a", label: "A", root_id: "projects", path: "Nexus", allowed_modes: ["personal"] },
        { id: "b", label: "B", root_id: "other", path: "Nexus", allowed_modes: ["personal"] },
      ],
    }),
  );
});

test("git catalog mode gate rejects cross-mode access closed", () => {
  const catalog = new GitRepositoryCatalog({
    repositories: [
      { id: "notes", label: "Notes", root_id: "projects", path: "notes", allowed_modes: ["personal"] },
      { id: "backend", label: "Backend", root_id: "projects", path: "backend", allowed_modes: ["business"] },
    ],
  });
  assert.equal(catalog.listForMode("personal").map((e) => e.id).join(","), "notes");
  assert.equal(catalog.listForMode("business").map((e) => e.id).join(","), "backend");
  assert.throws(() => catalog.requireForMode("backend", "personal"), (e: unknown) => (e as { code?: string }).code === "GIT_REPOSITORY_NOT_FOUND");
  assert.throws(() => catalog.requireForMode("missing", "personal"), (e: unknown) => (e as { code?: string }).code === "GIT_REPOSITORY_NOT_FOUND");
});

// ---- ref validation ----

test("ref shape rejects option injection and control bytes", () => {
  for (const bad of ["--exec-path=/tmp/evil", "-h", "", "a".repeat(257), "main\nHEAD", "x\0y"]) {
    assert.throws(() => assertRefShape(bad), (e: unknown) => (e as { code?: string }).code === "GIT_REF_INVALID");
  }
  assert.doesNotThrow(() => assertRefShape("main"));
  assert.doesNotThrow(() => assertRefShape("HEAD"));
});

// ---- status parser ----

test("porcelain v2 parses branch + entries + conflicts", () => {
  const records = [
    "# branch.oid abcdef1234567890abcdef1234567890abcdef12",
    "# branch.head feature/x",
    "# branch.upstream origin/feature/x",
    "# branch.ab +2 -0",
    "1 M. 000000 100644 100644 100644 abcdef1234567890abcdef1234567890abcdef12 abcdef1234567890abcdef1234567890abcdef12 src/app.ts",
    "? untracked file.txt",
  ];
  const parsed = parsePorcelainV2(records, operationStateFromMarkers(() => false));
  assert.equal(parsed.branch.name, "feature/x");
  assert.equal(parsed.branch.head_oid, "abcdef1234567890abcdef1234567890abcdef12");
  assert.equal(parsed.branch.ahead, 2);
  assert.equal(parsed.staged.length, 1);
  assert.equal(parsed.untracked.join(","), "untracked file.txt");
});

test("porcelain v2 handles detached HEAD and unborn branch", () => {
  const detached = parsePorcelainV2(
    ["# branch.oid abcdef1234567890abcdef1234567890abcdef12", "# branch.head (detached)"],
    operationStateFromMarkers(() => false),
  );
  assert.equal(detached.branch.detached, true);
  assert.equal(detached.branch.name, null);
  const unborn = parsePorcelainV2(
    ["# branch.oid (initial)", "# branch.head (initial)"],
    operationStateFromMarkers(() => false),
  );
  assert.equal(unborn.branch.unborn, true);
});

test("porcelain v2 distinguishes conflicts", () => {
  const parsed = parsePorcelainV2(
    ["# branch.oid abcdef1234567890abcdef1234567890abcdef12", "# branch.head main", "u UU 0 0 0 0 0 0 conflicted.ts"],
    operationStateFromMarkers(() => false),
  );
  assert.deepEqual(parsed.conflicted, ["conflicted.ts"]);
});

test("NUL splitting keeps newline/unicode filenames intact", () => {
  const buf = Buffer.from("? bad\nname.txt\0? unicode-\u00e9.ts\0", "utf8");
  const records = splitNulRecords(buf);
  assert.deepEqual(records, ["? bad\nname.txt", "? unicode-\u00e9.ts"]);
  const parsed = parsePorcelainV2(records, operationStateFromMarkers(() => false));
  assert.deepEqual(parsed.untracked, ["bad\nname.txt", "unicode-\u00e9.ts"]);
});

// ---- numstat/diff ----

test("numstat -z parses NUL-framed stats literally incl. adversarial names (F16)", () => {
  const buf = Buffer.from(
    "10\t4\tsrc/app.ts\0-\t-\tbin/blob.bin\0" +
    "1\t0\tspace name.txt\0" +
    "1\t0\tquote\"name.txt\0" +
    "1\t0\ttab\tname.txt\0" +
    "1\t0\tline\nbreak.txt\0" +
    "1\t0\tЮникод.txt\0" +
    "1\t0\t-leading-dash.txt\0",
    "utf8",
  );
  const parsed = parseNumstatZ(buf);
  assert.deepEqual(parsed.files.map((f) => f.path), [
    "src/app.ts",
    "bin/blob.bin",
    "space name.txt",
    "quote\"name.txt",
    "tab\tname.txt",
    "line\nbreak.txt",
    "Юникод.txt",
    "-leading-dash.txt",
  ]);
  assert.equal(parsed.files[1]?.added_lines, 0);
});

test("numstat rejects a patch tail (Git 2.55 regression: --unified re-enables patch)", () => {
  // Real Git 2.55 defect framing: --numstat -z WITH --unified appends the
  // full patch after the stats records. Production argv never sets --unified
  // on numstat runs; if a patch tail ever reaches the parser it must fail
  // closed (GIT_COMMAND_FAILED upstream), never misread as a file stat.
  const framed = Buffer.from("1\t0\ta.txt\0diff --git a/a.txt b/a.txt\n", "utf8");
  assert.throws(() => parseNumstatZ(framed), /unparseable numstat/);
  const clean = Buffer.from("1\t0\ta.txt\0", "utf8");
  const parsed = parseNumstatZ(clean);
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0]?.path, "a.txt");
});

test("patch is bounded whole, never cut", () => {
  const small = boundPatch("abc", 24 * 1024);
  assert.equal(small.patch, "abc");
  const big = boundPatch("x".repeat(24 * 1024 + 1), 24 * 1024);
  assert.equal(big.patch, null);
  assert.equal(big.truncated, true);
});

test("deterministic diff flags disable helpers", () => {
  const flags = deterministicDiffFlags();
  for (const f of ["--no-ext-diff", "--no-textconv", "--no-renames", "--no-color"]) {
    assert.ok(flags.includes(f), f);
  }
});

test("deterministic numstat flags omit unified context (patch stays suppressed)", () => {
  const flags = deterministicNumstatFlags();
  assert.ok(!flags.some((f) => f.startsWith("--unified")), "numstat flags must not set --unified (--unified implies --patch on Git 2.55)");
  assert.ok(!flags.includes("-p") && !flags.includes("--patch") && !flags.includes("-s") && !flags.includes("--no-patch"), "numstat flags must not toggle patch output either way");
  for (const f of ["--no-ext-diff", "--no-textconv", "--no-renames", "--no-color"]) {
    assert.ok(flags.includes(f), f);
  }
});

// ---- log/refs ----

test("log parser bounds subjects and validates oids", () => {
  const oid = "a".repeat(40);
  const out = [oid, "", "Jane", "1700000000", "1700000100", "Hello", ""].join("\x1f") + "\x1e";
  const parsed = parseLogOutput(out);
  assert.equal(parsed.commits.length, 1);
  assert.equal(parsed.commits[0]?.oid, oid);
  assert.equal(parsed.commits[0]?.short_oid, oid.slice(0, 7));
  assert.ok(!("author_email" in (parsed.commits[0] as object)));
});

test("show metadata bounds body at 4KiB", () => {
  const oid = "b".repeat(40);
  const out = [oid, "", "Jane", "1700000000", "1700000100", "Subj", "y".repeat(5000)].join("\x1f") + "\x1e";
  const parsed = parseShowMetadata(out);
  assert.equal(parsed.body_truncated, true);
  assert.ok(parsed.body.length <= 4096);
});

test("for-each-ref parser namespaces local vs remote", () => {
  const oid = "c".repeat(40);
  const parsed = parseBranches(["refs/heads/main\x1f" + oid + "\x1f"], ["refs/remotes/origin/main\x1f" + oid + "\x1f"]);
  assert.equal(parsed.local[0]?.name, "main");
  assert.equal(parsed.remote_tracking[0]?.name, "origin/main");
});

// ---- runner env ----

test("git child env drops GIT_* and secrets", () => {
  const child = buildGitChildEnv({
    GIT_DIR: "/other",
    GIT_EXTERNAL_DIFF: "evil",
    GIT_ASKPASS: "evil",
    DEEPSEEK_API_KEY: "<redacted:nexus-contributor-secret>",
    MY_TOKEN: "<redacted:nexus-contributor-secret>",
    PATH: "/usr/bin",
    LANG: "en_US.UTF-8",
  } as NodeJS.ProcessEnv);
  assert.equal(child.GIT_DIR, undefined);
  assert.equal(child.GIT_EXTERNAL_DIFF, undefined);
  assert.equal(child.GIT_ASKPASS, undefined);
  assert.equal(child.DEEPSEEK_API_KEY, undefined);
  assert.equal(child.MY_TOKEN, undefined);
  assert.equal(child.PATH, "/usr/bin");
  assert.equal(child.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(child.GIT_TERMINAL_PROMPT, "0");
  assert.equal(child.GIT_CONFIG_NOSYSTEM, "1");
});

test("runner has no generic executor surface", () => {
  const runner = new HardenedGitRunner();
  const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(runner));
  assert.ok(!proto.includes("executeRawGit"));
  assert.ok(!proto.includes("runCommand"));
  assert.ok(!proto.includes("runArgs"));
});

// ---- runner process boundary (F33/F37/F38/F39; spawn-free event-emitter fake) ----

function emitterChild(opts: { stdoutSize?: number; stderrSize?: number; hangOpen?: boolean } = {}): { child: unknown; killed: string[] } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const killed: string[] = [];
  (child as unknown as Record<string, unknown>).stdout = stdout;
  (child as unknown as Record<string, unknown>).stderr = stderr;
  (child as unknown as Record<string, unknown>).kill = (sig?: string): boolean => {
    killed.push(sig ?? "SIGTERM");
    process.nextTick(() => (child as unknown as InstanceType<typeof EventEmitter>).emit("close", null));
    return true;
  };
  const { stdoutSize = 0, stderrSize = 0, hangOpen = false } = opts;
  process.nextTick(() => {
    if (stdoutSize > 0) (stdout as InstanceType<typeof EventEmitter>).emit("data", Buffer.alloc(stdoutSize));
    if (stderrSize > 0) (stderr as InstanceType<typeof EventEmitter>).emit("data", Buffer.alloc(stderrSize));
    if (!hangOpen) (child as unknown as InstanceType<typeof EventEmitter>).emit("close", 0);
  });
  return { child, killed };
}

test("runner aborts oversized stdout with SIGKILL + typed failure (F33)", async () => {
  const box: { holder?: { child: unknown; killed: string[] } } = {};
  const runner = new HardenedGitRunner(((() => {
    box.holder = emitterChild({ stdoutSize: 200 });
    return box.holder.child;
  }) as unknown) as typeof import("node:child_process").spawn);
  await assert.rejects(
    runner.run({ executable: "git", args: ["x"], cwd: ".", timeoutMs: 5000, maxStdoutBytes: 100, maxStderrBytes: 100000 }),
    (e: unknown) => (e as { code?: string }).code === "GIT_OUTPUT_LIMIT_EXCEEDED",
  );
  assert.deepEqual(box.holder?.killed, ["SIGKILL"]);
});

test("runner aborts oversized stderr with SIGKILL + typed failure (F33)", async () => {
  const box: { holder?: { child: unknown; killed: string[] } } = {};
  const runner = new HardenedGitRunner(((() => {
    box.holder = emitterChild({ stderrSize: 200 });
    return box.holder.child;
  }) as unknown) as typeof import("node:child_process").spawn);
  await assert.rejects(
    runner.run({ executable: "git", args: ["x"], cwd: ".", timeoutMs: 5000, maxStdoutBytes: 100000, maxStderrBytes: 100 }),
    (e: unknown) => (e as { code?: string }).code === "GIT_OUTPUT_LIMIT_EXCEEDED",
  );
  assert.deepEqual(box.holder?.killed, ["SIGKILL"]);
});

test("runner timeout kills hung child with TOOL_TIMEOUT (F37/F39)", async () => {
  // The runner unrefs its internal timeout (it must not hold a server
  // process open); the test therefore holds its own keep-alive so the
  // test-runner loop cannot drain before the timeout fires.
  const keepAlive = setInterval(() => {}, 1000);
  const box: { holder?: { child: unknown; killed: string[] } } = {};
  const runner = new HardenedGitRunner(((() => {
    box.holder = emitterChild({ hangOpen: true });
    return box.holder.child;
  }) as unknown) as typeof import("node:child_process").spawn);
  const t0 = Date.now();
  await assert.rejects(
    runner.run({ executable: "git", args: ["x"], cwd: ".", timeoutMs: 150, maxStdoutBytes: 1e6, maxStderrBytes: 1e6 }),
    (e: unknown) => (e as { code?: string }).code === "TOOL_TIMEOUT",
  );
  assert.ok(Date.now() - t0 < 5000, "timeout is bounded");
  assert.deepEqual(box.holder?.killed, ["SIGKILL"]);
  clearInterval(keepAlive);
});

test("runner abort signal kills child with TOOL_CANCELLED; pre-abort never spawns (F38)", async () => {
  const keepAlive = setInterval(() => {}, 1000);
  const box: { holder?: { child: unknown; killed: string[] } } = {};
  const runner = new HardenedGitRunner(((() => {
    box.holder = emitterChild({ hangOpen: true });
    return box.holder.child;
  }) as unknown) as typeof import("node:child_process").spawn);
  const ctl = new AbortController();
  const pending = runner.run({ executable: "git", args: ["x"], cwd: ".", signal: ctl.signal, timeoutMs: 10000, maxStdoutBytes: 1e6, maxStderrBytes: 1e6 });
  setTimeout(() => ctl.abort(), 50);
  await assert.rejects(
    pending,
    (e: unknown) => (e as { code?: string }).code === "TOOL_CANCELLED",
  );
  assert.deepEqual(box.holder?.killed, ["SIGKILL"]);
  let spawned = false;
  const runner2 = new HardenedGitRunner(((() => {
    spawned = true;
    return emitterChild().child;
  }) as unknown) as typeof import("node:child_process").spawn);
  const ctl2 = new AbortController();
  ctl2.abort();
  await assert.rejects(
    runner2.run({ executable: "git", args: ["x"], cwd: ".", signal: ctl2.signal, timeoutMs: 5000, maxStdoutBytes: 1e6, maxStderrBytes: 1e6 }),
    (e: unknown) => (e as { code?: string }).code === "TOOL_CANCELLED",
  );
  assert.equal(spawned, false);
  clearInterval(keepAlive);
});

// ---- abort-reason mapping (F37 regression: deadline aborts are timeouts, not cancels) ----

test("gitAbortCode maps SC-03 abort reasons (deadline -> timeout, user cancel -> cancelled)", () => {
  const timeoutCtl = new AbortController();
  timeoutCtl.abort(new Error("attempt timeout"));
  assert.equal(gitAbortCode(timeoutCtl.signal), "TOOL_TIMEOUT");
  const deadlineCtl = new AbortController();
  deadlineCtl.abort(new Error("execution deadline exceeded"));
  assert.equal(gitAbortCode(deadlineCtl.signal), "TOOL_TIMEOUT");
  const userCtl = new AbortController();
  userCtl.abort(new Error("user cancellation"));
  assert.equal(gitAbortCode(userCtl.signal), "TOOL_CANCELLED");
  const bareCtl = new AbortController();
  bareCtl.abort();
  assert.equal(gitAbortCode(bareCtl.signal), "TOOL_CANCELLED");
});

test("runner maps attempt-timeout abort to TOOL_TIMEOUT and pre-aborted timeout never spawns (F37)", async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const box: { holder?: { child: unknown; killed: string[] } } = {};
    const runner = new HardenedGitRunner(((() => {
      box.holder = emitterChild({ hangOpen: true });
      return box.holder.child;
    }) as unknown) as typeof import("node:child_process").spawn);
    const ctl = new AbortController();
    const pending = runner.run({ executable: "git", args: ["x"], cwd: ".", signal: ctl.signal, timeoutMs: 10000, maxStdoutBytes: 1e6, maxStderrBytes: 1e6 });
    setTimeout(() => ctl.abort(new Error("attempt timeout")), 50);
    await assert.rejects(
      pending,
      (e: unknown) => (e as { code?: string }).code === "TOOL_TIMEOUT",
    );
    assert.deepEqual(box.holder?.killed, ["SIGKILL"]);
    let spawned = false;
    const runner2 = new HardenedGitRunner(((() => {
      spawned = true;
      return emitterChild().child;
    }) as unknown) as typeof import("node:child_process").spawn);
    const ctl2 = new AbortController();
    ctl2.abort(new Error("attempt timeout"));
    await assert.rejects(
      runner2.run({ executable: "git", args: ["x"], cwd: ".", signal: ctl2.signal, timeoutMs: 5000, maxStdoutBytes: 1e6, maxStderrBytes: 1e6 }),
      (e: unknown) => (e as { code?: string }).code === "TOOL_TIMEOUT",
    );
    assert.equal(spawned, false);
  } finally {
    clearInterval(keepAlive);
  }
});
