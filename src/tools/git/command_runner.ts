/**
 * SC-05 HardenedGitRunner (spec sections 24-44, 87-94, 101-103).
 *
 * Private implementation detail: the ONLY path to the Git CLI. Fixed argv
 * templates built by the adapter reach spawn() here; the tool layer can
 * never supply raw args. shell:false always; no network-capable subcommand
 * exists in the template set; environment is rebuilt from a safe allowlist
 * with every GIT_* / secret variable scrubbed first.
 *
 * Bounds: max_stdout_bytes / max_stderr_bytes per command; oversized output
 * aborts the child and fails GIT_OUTPUT_LIMIT_EXCEEDED. AbortSignal from
 * SC-03 aborts the child with a bounded kill grace, then reaps it.
 */

import { spawn } from "node:child_process";

export interface GitRunOptions {
  executable: string;
  /** Trusted fixed argv (already includes global safety prefix). */
  args: string[];
  /** Canonical repository root used as cwd. */
  cwd: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  /** Extra deterministic env (safe values only); caller-controlled. */
  extraEnv?: Record<string, string>;
  /** Source env for tests; production passes process.env. */
  sourceEnv?: NodeJS.ProcessEnv;
}

export interface GitRunResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

/** Env names whose VALUES are always stripped (mirrors SC-04 policy). */
const SECRET_NAME_RE = /api[_-]?key|apikey|secret|password|passwd|token|auth|private[_-]?key|credentials?|session[_-]?key/i;
const SECRET_PREFIX_RE = /^(ARTHUR_|DEEPSEEK_|OPENAI_|ANTHROPIC_|APPROVAL_|SECRET_)/i;
const STRIPPED_EXACT = new Set([
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "SUPER_SECRET_CANARY",
]);

const ALLOWED_EXACT = new Set([
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PROGRAMDATA",
  "LANG",
  "LC_ALL",
  "LC_MESSAGES",
  "LANGUAGE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
]);

const ALLOWED_PREFIX_RE = /^(LC_[A-Z_]+|XDG_[A-Z_]+|WAYLAND_[A-Z_]+|DISPLAY|WAYLAND_DISPLAY|LANG|LANGUAGE)$/i;

function isAllowedKey(key: string): boolean {
  if (STRIPPED_EXACT.has(key.toUpperCase())) return false;
  if (SECRET_PREFIX_RE.test(key)) return false;
  if (SECRET_NAME_RE.test(key)) return false;
  if (ALLOWED_EXACT.has(key.toUpperCase())) return true;
  if (ALLOWED_PREFIX_RE.test(key)) return true;
  return false;
}

/**
 * Build the hardened child environment: drop EVERY inherited GIT_* variable
 * (section 32-33), drop credential-helper plumbing (GIT_ASKPASS/SSH_ASKPASS
 * match GIT_*), drop secrets, then install the deterministic safe Git env.
 * Test seam: pure function of source.
 */
export function buildGitChildEnv(
  source: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (key.toUpperCase().startsWith("GIT_")) continue;
    if (key === "GIT_DIR" || key === "GIT_WORK_TREE") continue;
    if (!isAllowedKey(key)) continue;
    out[key] = value;
  }
  // Deterministic safe Git environment (sections 27-28, 35-39).
  out["GIT_OPTIONAL_LOCKS"] = "0";
  out["GIT_LITERAL_PATHSPECS"] = "1";
  out["GIT_TERMINAL_PROMPT"] = "0";
  out["GIT_CONFIG_NOSYSTEM"] = "1";
  // Stabilize identity-dependent output without touching repo config.
  out["LC_ALL"] = "C";
  for (const [k, v] of Object.entries(extra)) out[k] = v;
  return out;
}

/** Global safety prefix applied to every git invocation (section 27). */
export const GIT_SAFETY_PREFIX = ["--no-pager", "--no-replace-objects", "--literal-pathspecs", "-c", "core.fsmonitor=false"];

/** Extra -c overrides for inspection commands that can spawn helpers. */
export const GIT_NO_HELPERS_CONFIG = [
  "-c",
  "core.pager=cat",
];

/** Env -c overrides passed as -c flags so repo config cannot enable helpers. */
export function gitConfigOverrides(): string[] {
  return ["-c", "core.fsmonitor=false", "-c", "core.pager=cat"];
}

/**
 * Classify an AbortSignal abort by its reason, using the same convention as
 * SC-03 (coordinator attempt-timeout aborts with an "attempt timeout" reason;
 * user cancellation aborts with a "user cancellation" reason). Attempt/overall
 * deadline aborts are timeouts (retryable for side-effect-free reads); only a
 * genuine user-cancel reason is a cancellation. A bare abort() with no reason
 * stays TOOL_CANCELLED (fail closed, preserves pre-existing behavior).
 */
export function gitAbortCode(signal: AbortSignal): "TOOL_TIMEOUT" | "TOOL_CANCELLED" {
  const reason = signal.reason;
  const text = reason instanceof Error ? reason.message : String(reason ?? "");
  if (/user cancellation|user_cancel|cancel_requested/i.test(text)) return "TOOL_CANCELLED";
  if (/timeout|timed out|deadline/i.test(text)) return "TOOL_TIMEOUT";
  return "TOOL_CANCELLED";
}

export class HardenedGitRunner {
  /** Test seam: how many spawn calls were attempted. */
  spawnCalls = 0;

  constructor(
    private readonly spawnFn: typeof spawn = spawn,
  ) {}

  run(options: GitRunOptions): Promise<GitRunResult> {
    const { executable, args, cwd, signal, timeoutMs, maxStdoutBytes, maxStderrBytes } = options;
    if (signal?.aborted) {
      const code = gitAbortCode(signal);
      const err = new Error(code === "TOOL_TIMEOUT" ? "Git operation timed out" : "Git operation was cancelled");
      (err as { code?: string }).code = code;
      return Promise.reject(err);
    }
    return new Promise<GitRunResult>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      const env = buildGitChildEnv(options.sourceEnv ?? process.env, options.extraEnv ?? {});
      try {
        this.spawnCalls += 1;
        child = this.spawnFn(executable, args, { shell: false, cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        reject(err);
        return;
      }
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let limitCode: string | null = null;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          child.kill("SIGKILL");
        } catch {
          /* reap below */
        }
        reject(err);
      };
      const killForLimit = (code: string): void => {
        limitCode = code;
        try {
          child.kill("SIGKILL");
        } catch {
          /* wait for close */
        }
      };
      let timer: NodeJS.Timeout | undefined;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          const err = new Error("Git operation timed out");
          (err as { code?: string }).code = "TOOL_TIMEOUT";
          fail(err);
        }, timeoutMs);
        timer.unref?.();
      }
      const onAbort = (): void => {
        const code = gitAbortCode(signal as AbortSignal);
        const err = new Error(code === "TOOL_TIMEOUT" ? "Git operation timed out" : "Git operation was cancelled");
        (err as { code?: string }).code = code;
        fail(err);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += buf.length;
        if (stdoutBytes > maxStdoutBytes) {
          const err = new Error("Git output exceeded the bounded limit");
          (err as { code?: string }).code = "GIT_OUTPUT_LIMIT_EXCEEDED";
          fail(err);
          return;
        }
        stdoutChunks.push(buf);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrBytes += buf.length;
        if (stderrBytes > maxStderrBytes) {
          const err = new Error("Git error output exceeded the bounded limit");
          (err as { code?: string }).code = "GIT_OUTPUT_LIMIT_EXCEEDED";
          fail(err);
          return;
        }
        stderrChunks.push(buf);
      });
      child.once("error", (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        const code = (err as { code?: string }).code;
        if (code === "ENOENT") {
          const missing = new Error("Git executable is unavailable");
          (missing as { code?: string }).code = "GIT_UNAVAILABLE";
          reject(missing);
          return;
        }
        reject(err);
      });
      child.once("close", (code: number | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (limitCode !== null) {
          const err = new Error("Git output exceeded the bounded limit");
          (err as { code?: string }).code = "GIT_OUTPUT_LIMIT_EXCEEDED";
          reject(err);
          return;
        }
        resolve({ stdout: Buffer.concat(stdoutChunks), stderr: Buffer.concat(stderrChunks).toString("utf8"), exitCode: code ?? 0 });
      });
    });
  }
}
