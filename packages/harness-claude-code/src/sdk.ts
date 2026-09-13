import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const CLAUDE_CODE_VERSION = '2.1.270' as const;

/** One parsed stream-json line (structural parse only, never scraped text). */
export interface ClaudeStreamEvent {
  readonly type: string;
  readonly raw: Record<string, unknown>;
}

export interface ClaudeSessionView {
  runText(text: string): Promise<ClaudeStreamEvent[]>;
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
    '--disallowedTools',
    'Agent,Task,WebFetch,WebSearch,Skill,CronCreate,CronDelete,CronList,ScheduleWakeup,EnterWorktree,ExitWorktree',
    '--session-id',
    input.sessionId,
    ...(input.resume ? ['--resume', input.sessionId] : []),
  ];
}

class ProductionSession implements ClaudeSessionView {
  constructor(
    private readonly spec: ClaudeSpawnSpec,
    private readonly sessionId: string,
    private readonly continued: Set<string>,
  ) {}

  async runText(text: string): Promise<ClaudeStreamEvent[]> {
    return runClaudePrint(this.spec, text, this.sessionId, this.continued);
  }
}

function runClaudePrint(
  spec: ClaudeSpawnSpec,
  prompt: string,
  sessionId: string,
  continued: Set<string>,
): Promise<ClaudeStreamEvent[]> {
  return new Promise((resolve, reject) => {
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
    });
    let child: ChildProcess;
    try {
      child = spawn(spec.executable, [...args, prompt], {
        cwd: spec.cwd,
        env: buildClaudeSpawnEnv(spec),
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (cause) {
      reject(cause);
      return;
    }
    const events: ClaudeStreamEvent[] = [];
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (cause?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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

export const createProductionClaudeClient: ClaudeClientFactory = async (spec) => {
  const sessionId = mintClaudeSessionId();
  const continued = new Set<string>();
  return {
    sessionId,
    startSession: async () => new ProductionSession(spec, sessionId, continued),
    close: async () => {
      continued.delete(sessionId);
    },
  };
};
