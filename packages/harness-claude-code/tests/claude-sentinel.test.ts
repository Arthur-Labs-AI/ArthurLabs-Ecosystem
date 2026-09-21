import { describe, expect, it } from 'vitest';
import {
  buildClaudeArgs,
  buildClaudeChildEnvironment,
  buildClaudeSpawnEnv,
  CLAUDE_INVESTIGATION_ALLOWED_TOOLS,
  CLAUDE_PLANNING_ALLOWED_TOOLS,
} from '../src/index.js';

describe('Claude session flag shape', () => {
  const base = {
    modelId: 'glm-5.3-flash',
    settingsPath: '/tmp/claude-home/sentry-settings.json',
    sessionId: '11111111-1111-4111-8111-111111111111',
  };

  it('classifies investigation tools: web QA allowed, delegation denied (§27-30)', () => {
    const args = buildClaudeArgs({ ...base, resume: false });
    const flag = args[args.indexOf('--disallowedTools') + 1] as string;
    const denied = new Set(flag.split(','));
    // B: AI-agent delegation stays denied (independent-AgentStack semantics).
    // TaskOutput (background-task reader) is denied with Task: it succeeded
    // live without any visible Task launch (run_01M324B2ZGD50VSA48ERJ7HM51),
    // which is either ledger-invisible fanout or a blind spot. TaskStop
    // (background-task control) joins the fanout family.
    expect(denied.has('Agent')).toBe(true);
    expect(denied.has('Task')).toBe(true);
    expect(denied.has('TaskOutput')).toBe(true);
    expect(denied.has('TaskStop')).toBe(true);
    expect(denied.has('Artifact')).toBe(true);
    // A: normal investigative QA tools stay available.
    expect(denied.has('WebFetch')).toBe(false);
    expect(denied.has('WebSearch')).toBe(false);
    // C: persistent automation, worktree control, and uncontrolled
    // extensions stay denied.
    for (const tool of [
      'Skill',
      'CronCreate',
      'CronDelete',
      'CronList',
      'ScheduleWakeup',
      'EnterWorktree',
      'ExitWorktree',
    ]) {
      expect(denied.has(tool)).toBe(true);
    }
  });

  it('emits phase-scoped explicit allowlists (verified --allowedTools syntax)', () => {
    // Root-cause fix (run_01M326QHGF26YRV9Z314V4GCN6): with
    // CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 and no allowlist, Claude forces
    // permissionMode=default and every would-prompt Bash call is denied
    // (verified live against 2.1.276: even `pwd && true` fails). Comma-
    // separated bare names is the verified syntax; other shapes do not
    // satisfy the hardening.
    expect(CLAUDE_PLANNING_ALLOWED_TOOLS).toBe('Bash,Read,WebFetch,WebSearch');
    expect(CLAUDE_INVESTIGATION_ALLOWED_TOOLS).toBe('Bash,Read,Edit,Write,WebFetch,WebSearch');
    const planning = buildClaudeArgs({ ...base, resume: false, allowedTools: 'Bash,Read' });
    const flagAt = planning.indexOf('--allowedTools');
    expect(flagAt).toBeGreaterThan(-1);
    expect(planning[flagAt + 1]).toBe('Bash,Read');
    // Reporting passes none: tool-free is firewall-enforced (an empty
    // --allowedTools value is ignored by Claude — verified, not assumed).
    const reporting = buildClaudeArgs({ ...base, resume: true });
    expect(reporting).not.toContain('--allowedTools');
    // Forbidden tools are never allowlisted, even by accident.
    for (const args of [planning]) {
      const value = String(args[args.indexOf('--allowedTools') + 1] ?? '');
      for (const forbidden of ['Agent', 'Task', 'Skill', 'Artifact']) {
        expect(value.split(',')).not.toContain(forbidden);
      }
    }
  });

  it('mints fresh sessions with --session-id and resumes with --resume alone', () => {
    const fresh = buildClaudeArgs({ ...base, resume: false });
    expect(fresh).toContain('--session-id');
    expect(fresh).not.toContain('--resume');
    const continued = buildClaudeArgs({ ...base, resume: true });
    expect(continued).toContain('--resume');
    // Combining --session-id with --resume is rejected without
    // --fork-session (verified on 2.1.270); forking would copy instead
    // of continuing the one logical session.
    expect(continued).not.toContain('--session-id');
    expect(continued).not.toContain('--fork-session');
  });
});

// Credential-boundary sentinel tests for the Claude Code stack. A test-only
// sentinel stands in for the Z.AI authorization credential: the Claude
// parent process may hold it, but model-controlled Bash/hooks/MCP children
// must not inherit it (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` is forced on every
// spawn; live absence is verified with a sentinel Bash probe during the
// GLM smoke). Never a real credential here.
const SENTINEL_VALUE = 'sentry-test-sentinel-credential';

describe('Claude credential boundary', () => {
  it('forces the subprocess scrub flag on every spawn, ignoring overrides', () => {
    const env = buildClaudeSpawnEnv({
      executable: 'claude-test',
      cwd: '/tmp/ws',
      configDir: '/tmp/claude-home',
      environment: {
        PATH: '/usr/bin',
        CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0',
        ANTHROPIC_AUTH_TOKEN: SENTINEL_VALUE,
      },
      modelId: 'glm-5.3-flash',
      settingsPath: '/tmp/claude-home/sentry-settings.json',
      initializeTimeoutMs: 30_000,
      turnTimeoutMs: 60_000,
      shutdownTimeoutMs: 5_000,
    });
    expect(env['CLAUDE_CODE_SUBPROCESS_ENV_SCRUB']).toBe('1');
    expect(env['CLAUDE_CONFIG_DIR']).toBe('/tmp/claude-home');
    // The parent legitimately carries the credential; the scrub flag is
    // what keeps it out of model-controlled children.
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBe(SENTINEL_VALUE);
  });

  it('blocks unrelated secret-shaped names from the child environment', () => {
    const child = buildClaudeChildEnvironment({
      source: {
        PATH: '/usr/bin',
        ANTHROPIC_AUTH_TOKEN: SENTINEL_VALUE,
        GITHUB_TOKEN: 'sentry-test-sentinel-unrelated',
        AWS_SECRET_ACCESS_KEY: 'sentry-test-sentinel-unrelated',
        ANTHROPIC_API_KEY: 'sentry-test-sentinel-unrelated',
      },
    });
    expect(child.environment['ANTHROPIC_AUTH_TOKEN']).toBe(SENTINEL_VALUE);
    expect(child.environment['GITHUB_TOKEN']).toBeUndefined();
    expect(child.environment['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(child.environment['ANTHROPIC_API_KEY']).toBeUndefined();
  });
});
