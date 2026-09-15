import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ReportTurnOptions } from '@qa/evidence-pipeline';

export const CLAUDE_CODE_VERSION = '2.1.270' as const;

/** One parsed stream-json line (structural parse only, never scraped text). */
export interface ClaudeStreamEvent {
  readonly type: string;
  readonly raw: Record<string, unknown>;
}

export interface ClaudeSessionView {
  /** Phase-scoped run: reporting turns may request provider structured
   *  output (`outputSchema` → `--json-schema`) and run tool-free (the
   *  adapter firewall enforces tool denial; there is no native
   *  empty-tools flag). */
  runText(text: string, options?: ReportTurnOptions): Promise<ClaudeStreamEvent[]>;
}

export interface ClaudeClientView {
  readonly sessionId: string;
  startSession(): Promise<ClaudeSessionView>;
  close(): Promise<void>;
}

export interface ClaudeSpawnSpec {
  readonly executable: string;
  readonly cwd: string;
  readonly configDir: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly modelId: string;
  readonly settingsPath: string;
  readonly initializeTimeoutMs: number;
  readonly turnTimeoutMs: number;
  /** Bound for graceful owned-process shutdown inside close(). */
  readonly shutdownTimeoutMs: number;
  /**
   * Test seam for process creation (deterministic lifecycle tests).
   * Production always uses node's `spawn`. The adapter never sets this;
   * only tests inject a controlled fixture process. The client owns and
   * terminates whatever this returns exactly like a real child.
   */
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) => ChildProcess;
}

export type ClaudeClientFactory = (spec: ClaudeSpawnSpec) => Promise<ClaudeClientView>;

export function parseStreamJsonLine(line: string): ClaudeStreamEvent | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  // Non-JSON diagnostics (e.g. `[claude-code:...]` markers) are skipped
  // structurally: machine output is parsed, never scraped.
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const type = typeof record['type'] === 'string' ? (record['type'] as string) : 'unknown';
    return { type, raw: record };
  } catch {
    return undefined;
  }
}

/** Settings JSON Sentry writes per AgentRun (fail-closed sandbox). */
export function buildClaudeSettings(): Record<string, unknown> {
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
    },
    disableBypassPermissionsMode: 'disable',
    // No subagent fanout: the Agent/Task tools stay denied at the CLI
    // layer as well (--disallowedTools), this is defense in depth.
    // No uncontrolled extensions: MCP/hooks/skills resolve only from the
    // ephemeral config dir Sentry owns (empty by default).
  };
}

/** CLI flags shared by every Sentry Claude invocation (verified on 2.1.270). */
export function buildClaudeArgs(input: {
  readonly modelId: string;
  readonly settingsPath: string;
  readonly sessionId: string;
  readonly resume: boolean;
  /** Provider structured-output schema (reporting turn only). */
  readonly jsonSchema?: Record<string, unknown>;
}): string[] {
  return [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--model',
    input.modelId,
    '--settings',
    input.settingsPath,
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    // Tool classification (§27): Agent/Task stay denied (AI-agent
    // delegation would break independent-AgentStack semantics; the
    // adapter firewall additionally fails any report-turn tool use, so
    // reporting/frozen-ledger semantics are untouched). Cron*/Schedule*
    // stay denied (persistent automation is outside the QA mission).
    // Enter/ExitWorktree stay denied (Sentry owns workspaces). Skill
    // stays denied (uncontrolled host capability loading). WebFetch and
    // WebSearch are ALLOWED: normal investigative QA tools, auditable
    // via harness events and contained by the sandbox.
    '--disallowedTools',
    'Agent,Task,Skill,CronCreate,CronDelete,CronList,ScheduleWakeup,EnterWorktree,ExitWorktree',
    // Session identity: a fresh turn mints the id via --session-id; a
    // continuing turn resumes via --resume ALONE. Combining --session-id
    // with --resume is rejected without --fork-session (verified on
    // 2.1.270), and forking would copy the session instead of continuing
    // the one logical AgentRun session.
    ...(input.resume ? ['--resume', input.sessionId] : ['--session-id', input.sessionId]),
    // Native structured output for the reporting turn when the provider
    // route supports it (verified per binary; adapter falls back without
    // it when the flag is rejected).
    ...(input.jsonSchema === undefined ? [] : ['--json-schema', JSON.stringify(input.jsonSchema)]),
  ];
}

class ProductionSession implements ClaudeSessionView {
  constructor(private readonly owner: ClaudeClient) {}

  async runText(text: string, options?: ReportTurnOptions): Promise<ClaudeStreamEvent[]> {
    return this.owner.runTurnText(text, options?.outputSchema);
  }
}

/** Wait for a process exit, resolving false on timeout. Never rejects. */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

/**
 * Best-effort owned-tree termination on Windows: `taskkill /PID <ownedPid>
 * /T` targets ONLY a positively Sentry-owned PID (never a process name).
 * Resolves silently on any failure; the caller always escalates against the
 * owned handle itself afterwards.
 */
async function taskkillOwnedTree(pid: number): Promise<void> {
  if (process.platform !== 'win32') return;
  try {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
    });
    await waitForExit(killer, 5_000);
  } catch {
    // best effort only; owned-handle escalation follows regardless
  }
}

function runClaudePrint(
  owner: ClaudeClient,
  spec: ClaudeSpawnSpec,
  prompt: string,
  sessionId: string,
  continued: Set<string>,
  active: Set<ChildProcess>,
  jsonSchema?: Record<string, unknown>,
): Promise<ClaudeStreamEvent[]> {
  return new Promise((resolve, reject) => {
    if (owner.isClosed) {
      reject(new Error('Claude client is closed; refusing to start a new turn.'));
      return;
    }
    // Session continuity: the first turn mints the session id; later turns
    // resume it through the supported `--resume` semantics. One logical
    // Claude session per AgentRun, no cross-run leakage (the set is owned
    // per client instance, never module-global).
    const resume = continued.has(sessionId);
    const args = buildClaudeArgs({
      modelId: spec.modelId,
      settingsPath: spec.settingsPath,
      sessionId,
      resume,
      ...(jsonSchema === undefined ? {} : { jsonSchema }),
    });
    let child: ChildProcess;
    try {
      const spawnFn =
        spec.spawnProcess ??
        ((
          command: string,
          argv: readonly string[],
          options: { cwd: string; env: NodeJS.ProcessEnv },
        ) =>
          spawn(command, [...argv], {
            cwd: options.cwd,
            env: options.env,
            windowsHide: true,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
          }));
      child = spawnFn(spec.executable, [...args, prompt], {
        cwd: spec.cwd,
        env: buildClaudeSpawnEnv(spec),
      });
    } catch (cause) {
      reject(cause);
      return;
    }
    // Owned from birth: every active child is registered until it settles,
    // so close()/cancel() can terminate exactly these processes.
    active.add(child);
    const events: ClaudeStreamEvent[] = [];
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (cause?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A settled turn is no longer active: unregister first so a
      // concurrent close() cannot kill a reaped handle.
      active.delete(child);
      if (cause !== undefined) {
        try {
          child.kill();
        } catch {
          // ignore kill failures; the error is already decided
        }
        reject(cause);
        return;
      }
      continued.add(sessionId);
      resolve(events);
    };
    const timer = setTimeout(() => {
      settle(
        new Error('Claude Code turn exceeded its ' + String(spec.turnTimeoutMs) + ' ms budget.'),
      );
    }, spec.turnTimeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      let index = stdout.indexOf('\n');
      while (index >= 0) {
        const line = stdout.slice(0, index);
        stdout = stdout.slice(index + 1);
        const event = parseStreamJsonLine(line);
        if (event !== undefined) events.push(event);
        index = stdout.indexOf('\n');
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4_096);
    });
    child.once('error', (cause) => settle(cause));
    child.once('close', (code) => {
      const tail = stdout.trim();
      if (tail.length > 0) {
        const event = parseStreamJsonLine(tail);
        if (event !== undefined) events.push(event);
      }
      if (code !== 0) {
        settle(
          new Error('Claude Code exited with code ' + String(code) + ': ' + stderr.slice(0, 500)),
        );
        return;
      }
      settle();
    });
  });
}

/**
 * Spawn environment for the Claude parent process. The subprocess scrub
 * flag is FORCED (caller input cannot disable it): model-controlled
 * Bash/hooks/MCP children must not inherit provider credentials.
 * Verified live with a test-only sentinel during the GLM smoke.
 */
export function buildClaudeSpawnEnv(spec: ClaudeSpawnSpec): NodeJS.ProcessEnv {
  return {
    ...spec.environment,
    CLAUDE_CONFIG_DIR: spec.configDir,
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
  };
}

export function mintClaudeSessionId(): string {
  return randomUUID();
}

/**
 * Production Claude client: owns every active `claude -p` child it spawns.
 *
 * Lifecycle: turns register their child in `active` at spawn and remove it
 * at settle; `close()` refuses new turns, SIGTERMs exactly the owned
 * active children, waits a bounded grace, escalates to SIGKILL (plus a
 * best-effort owned-PID `taskkill /T` on Windows for descendants), waits
 * again, then clears session state. Idempotent. Never kills by process
 * name. Owned top-level children are always terminated; descendant
 * cleanup beyond the owned handle relies on the best-effort Windows tree
 * kill (documented residual limitation on other platforms).
 */
export class ClaudeClient implements ClaudeClientView {
  readonly sessionId = mintClaudeSessionId();
  private readonly continued = new Set<string>();
  private readonly active = new Set<ChildProcess>();
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(private readonly spec: ClaudeSpawnSpec) {}

  get isClosed(): boolean {
    return this.closed;
  }

  /** Number of currently owned live children (observability/testing). */
  get activeChildCount(): number {
    return this.active.size;
  }

  async startSession(): Promise<ClaudeSessionView> {
    return new ProductionSession(this);
  }

  async runTurnText(
    prompt: string,
    jsonSchema?: Record<string, unknown>,
  ): Promise<ClaudeStreamEvent[]> {
    return runClaudePrint(
      this,
      this.spec,
      prompt,
      this.sessionId,
      this.continued,
      this.active,
      jsonSchema,
    );
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      const owned = [...this.active];
      for (const child of owned) {
        try {
          child.kill();
        } catch {
          // already gone; reaped below via exitCode check
        }
      }
      const graceMs = Math.max(0, this.spec.shutdownTimeoutMs);
      await Promise.all(owned.map((child) => waitForExit(child, graceMs)));
      const survivors = owned.filter(
        (child) => child.exitCode === null && child.signalCode === null,
      );
      for (const child of survivors) {
        if (child.pid !== undefined) await taskkillOwnedTree(child.pid);
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
      await Promise.all(survivors.map((child) => waitForExit(child, 2_000)));
      this.active.clear();
      this.continued.delete(this.sessionId);
    })();
    return this.closePromise;
  }
}

export const createProductionClaudeClient: ClaudeClientFactory = async (spec) =>
  new ClaudeClient(spec);
