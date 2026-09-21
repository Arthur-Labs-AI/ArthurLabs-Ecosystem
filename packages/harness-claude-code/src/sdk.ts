import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ReportTurnOptions } from '@qa/evidence-pipeline';

export const CLAUDE_CODE_VERSION = '2.1.270' as const;

/** One parsed stream-json line (structural parse only, never scraped text). */
export interface ClaudeStreamEvent {
  readonly type: string;
  readonly raw: Record<string, unknown>;
}

/**
 * Live handle for one owned Claude turn. Events arrive incrementally as the
 * child emits stream-json lines; the consumer MUST iterate to completion
 * (or break + call abort()) so the child is never orphaned.
 */
export interface ClaudeTurnStream extends AsyncIterable<ClaudeStreamEvent> {
  /** Terminate the owned child for this turn (loop abort, timeout, cancel). */
  abort(): Promise<void>;
  /** True once a valid initialization/system event has been observed. */
  readonly initialized: boolean;
  /** True once the child has settled (exit/error/timeout/abort). */
  readonly settled: boolean;
  /** Await child settlement (resolves after exit or abort cleanup). */
  readonly done: Promise<void>;
}

export interface ClaudeSessionView {
  /**
   * Phase-scoped run. Production sessions return a live ClaudeTurnStream
   * (no whole-turn buffering); legacy fake sessions in existing unit
   * tests return Promise<ClaudeStreamEvent[]> and are normalized by the
   * adapter's streaming turn (same observer path, no live abort possible).
   * New production-style tests use the live path.
   *
   * `tools: 'none'` is a semantic Sentry contract enforced by the
   * adapter-side reporting firewall: Claude Code 2.1.270 exposes no
   * trustworthy native empty-tools flag, so the production client does
   * NOT translate it into CLI flags (only `outputSchema` affects the
   * invocation). Reporting turns may request provider structured
   * output (`outputSchema` → `--json-schema`) where supported.
   */
  runText(
    text: string,
    options?: ReportTurnOptions,
  ): ClaudeTurnStream | Promise<ClaudeStreamEvent[]>;
  /**
   * Legacy whole-turn convenience: collects the live stream. Tests and
   * non-critical callers only — production phase turns iterate the
   * stream incrementally so loop breakers and activity timeouts observe
   * events while the child is alive.
   */
  collectText?(text: string, options?: ReportTurnOptions): Promise<ClaudeStreamEvent[]>;
}

/** Production session: always streams live (narrowed for callers that
 *  need abort()/async-iteration without legacy-union narrowing). */
export interface ClaudeLiveSessionView {
  runText(text: string, options?: ReportTurnOptions): ClaudeTurnStream;
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

/** True for the stream-json init signal that ends the startup window. */
export function isClaudeInitEvent(event: ClaudeStreamEvent): boolean {
  return event.type === 'system' && event.raw['subtype'] === 'init';
}

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
    // stays denied (uncontrolled host capability loading). Artifact stays
    // denied: newer Claude Code artifact tool with no QA use; the Z.AI
    // Anthropic-compatible route rejects tool types outside its supported
    // vocabulary, so exposing it risks provider 400s for zero benefit.
    // WebFetch and WebSearch are ALLOWED: normal investigative QA tools,
    // auditable via harness events and contained by the sandbox.
    '--disallowedTools',
    'Agent,Task,Skill,CronCreate,CronDelete,CronList,ScheduleWakeup,EnterWorktree,ExitWorktree,Artifact',
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

  runText(text: string, options?: ReportTurnOptions): ClaudeTurnStream {
    return this.owner.streamTurnText(text, options?.outputSchema);
  }

  async collectText(text: string, options?: ReportTurnOptions): Promise<ClaudeStreamEvent[]> {
    const out: ClaudeStreamEvent[] = [];
    for await (const event of this.runText(text, options)) out.push(event);
    return out;
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

/** Terminal outcome of one owned turn (carried out of the stream pump). */
interface TurnOutcome {
  readonly kind: 'exited' | 'failed';
  readonly code?: number | undefined;
  readonly stderr?: string | undefined;
  readonly error?: unknown;
  readonly aborted?: boolean | undefined;
  readonly initTimedOut?: boolean | undefined;
  readonly turnTimedOut?: boolean | undefined;
  readonly turnBudgetMs?: number | undefined;
  readonly initBudgetMs?: number | undefined;
}

/** Live owned turn: parses NDJSON incrementally, queues parsed events. */
class LiveClaudeTurn implements ClaudeTurnStream {
  private readonly queue: ClaudeStreamEvent[] = [];
  private readonly waiters: Array<() => void> = [];
  private outcome: TurnOutcome | undefined;
  private initializedFlag = false;
  private settledFlag = false;
  private readonly donePromise: Promise<void>;
  private resolveDone: () => void = () => undefined;
  private aborted = false;
  private readonly initTimer: ReturnType<typeof setTimeout>;
  private readonly turnTimer: ReturnType<typeof setTimeout>;
  private stdoutTail = '';
  private stderrTail = '';

  constructor(
    private readonly child: ChildProcess,
    private readonly owner: ClaudeClient,
    private readonly spec: ClaudeSpawnSpec,
    private readonly sessionId: string,
    private readonly continued: Set<string>,
    private readonly active: Set<ChildProcess>,
  ) {
    this.donePromise = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
    this.initTimer = setTimeout(() => this.onInitTimeout(), Math.max(1, spec.initializeTimeoutMs));
    this.turnTimer = setTimeout(() => this.onTurnTimeout(), Math.max(1, spec.turnTimeoutMs));
    child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4_096);
    });
    child.once('error', (cause) => this.finish({ kind: 'failed', error: cause }));
    child.once('close', (code) => {
      const tail = this.stdoutTail.trim();
      if (tail.length > 0) {
        const event = parseStreamJsonLine(tail);
        if (event !== undefined) this.push(event);
      }
      if (code !== 0) {
        this.finish({ kind: 'failed', code: code ?? undefined, stderr: this.stderrTail });
        return;
      }
      this.finish({ kind: 'exited' });
    });
  }

  get initialized(): boolean {
    return this.initializedFlag;
  }

  get settled(): boolean {
    return this.settledFlag;
  }

  get done(): Promise<void> {
    return this.donePromise;
  }

  private push(event: ClaudeStreamEvent): void {
    if (isClaudeInitEvent(event) && !this.initializedFlag) {
      this.initializedFlag = true;
      clearTimeout(this.initTimer);
    }
    this.queue.push(event);
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter();
  }

  private onStdout(text: string): void {
    this.stdoutTail += text;
    let index = this.stdoutTail.indexOf('\n');
    while (index >= 0) {
      const line = this.stdoutTail.slice(0, index);
      this.stdoutTail = this.stdoutTail.slice(index + 1);
      const event = parseStreamJsonLine(line);
      if (event !== undefined) this.push(event);
      index = this.stdoutTail.indexOf('\n');
    }
  }

  private onInitTimeout(): void {
    if (this.initializedFlag || this.settledFlag) return;
    this.finish({
      kind: 'failed',
      initTimedOut: true,
      initBudgetMs: this.spec.initializeTimeoutMs,
    });
  }

  private onTurnTimeout(): void {
    if (this.settledFlag) return;
    this.finish({ kind: 'failed', turnTimedOut: true, turnBudgetMs: this.spec.turnTimeoutMs });
  }

  private finish(outcome: TurnOutcome): void {
    if (this.settledFlag) return;
    this.settledFlag = true;
    this.outcome = outcome;
    clearTimeout(this.initTimer);
    clearTimeout(this.turnTimer);
    this.active.delete(this.child);
    if (outcome.kind === 'exited') this.continued.add(this.sessionId);
    // A failed turn must not linger: terminate the owned handle promptly
    // (graceful SIGTERM here; abort()/close() escalate when needed). The
    // consumer still drains every event queued before this outcome.
    if (outcome.kind === 'failed' && !this.aborted) {
      try {
        this.child.kill();
      } catch {
        // already gone; close event settles the handle
      }
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter();
    this.resolveDone();
  }

  async abort(): Promise<void> {
    if (this.settledFlag) return;
    this.aborted = true;
    await this.owner.terminateOwnedChild(this.child);
    this.finish({ kind: 'failed', aborted: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ClaudeStreamEvent> {
    for (;;) {
      while (this.queue.length > 0) {
        const next = this.queue.shift() as ClaudeStreamEvent;
        yield next;
      }
      if (this.settledFlag) {
        const outcome = this.outcome as TurnOutcome;
        if (outcome.kind === 'failed') {
          if (outcome.aborted === true) return;
          if (outcome.initTimedOut === true) {
            throw new Error(
              'Claude Code turn produced no initialization event within ' +
                String(outcome.initBudgetMs) +
                ' ms.',
            );
          }
          if (outcome.turnTimedOut === true) {
            throw new Error(
              'Claude Code turn exceeded its ' + String(outcome.turnBudgetMs) + ' ms budget.',
            );
          }
          if (outcome.error !== undefined) throw outcome.error;
          throw new Error(
            'Claude Code exited with code ' +
              String(outcome.code ?? 'unknown') +
              ': ' +
              (outcome.stderr ?? '').slice(0, 500),
          );
        }
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }
}

function spawnOwnedClaudeTurn(
  owner: ClaudeClient,
  spec: ClaudeSpawnSpec,
  prompt: string,
  sessionId: string,
  continued: Set<string>,
  active: Set<ChildProcess>,
  jsonSchema?: Record<string, unknown>,
): LiveClaudeTurn {
  if (owner.isClosed) {
    throw new Error('Claude client is closed; refusing to start a new turn.');
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
  const spawnFn =
    spec.spawnProcess ??
    ((command: string, argv: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) =>
      spawn(command, [...argv], {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
  const child = spawnFn(spec.executable, [...args, prompt], {
    cwd: spec.cwd,
    env: buildClaudeSpawnEnv(spec),
  });
  // Owned from birth: every active child is registered until it settles,
  // so close()/cancel()/abort() can terminate exactly these processes.
  active.add(child);
  return new LiveClaudeTurn(child, owner, spec, sessionId, continued, active);
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

  /** Live streaming turn (production path: incremental delivery). */
  streamTurnText(prompt: string, jsonSchema?: Record<string, unknown>): ClaudeTurnStream {
    return spawnOwnedClaudeTurn(
      this,
      this.spec,
      prompt,
      this.sessionId,
      this.continued,
      this.active,
      jsonSchema,
    );
  }

  /**
   * Legacy whole-turn helper: collects the live stream. Kept so existing
   * callers/tests that awaited `Promise<ClaudeStreamEvent[]>` keep
   * working; production phase turns use `streamTurnText` directly.
   */
  async runTurnText(
    prompt: string,
    jsonSchema?: Record<string, unknown>,
  ): Promise<ClaudeStreamEvent[]> {
    const out: ClaudeStreamEvent[] = [];
    for await (const event of this.streamTurnText(prompt, jsonSchema)) out.push(event);
    return out;
  }

  /** Graceful-then-escalating termination of ONE owned child. */
  async terminateOwnedChild(child: ChildProcess): Promise<void> {
    try {
      child.kill();
    } catch {
      // already gone
    }
    const exited = await waitForExit(child, Math.max(0, this.spec.shutdownTimeoutMs));
    if (exited) return;
    if (child.pid !== undefined) await taskkillOwnedTree(child.pid);
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
    await waitForExit(child, 2_000);
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
