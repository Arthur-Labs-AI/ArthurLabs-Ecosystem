import { describe, expect, it } from 'vitest';
import {
  buildClaudeArgs,
  buildClaudeChildEnvironment,
  buildClaudeSpawnEnv,
  CLAUDE_INVESTIGATION_ALLOWED_TOOLS,
  CLAUDE_PLANNING_ALLOWED_TOOLS,
  describeClaudeHeadlessEnvironment,
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

  it('replaces a hostile Windows HOME at spawn and never forwards profile state on Linux', () => {
    // Regression for run_01M33YXNW80W2Q7H1HK5EA5K7Q: the host runtime
    // carried a Windows-mounted HOME and Claude resolved $HOME/.claude
    // there, so bwrap failed before any tool ran. The spawn env must
    // carry the Sentry-owned ephemeral home instead.
    const hostile = {
      PATH: '/usr/bin',
      HOME: '/mnt/c/Users/CodexSandboxOffline',
      USERPROFILE: 'C:\\Users\\CodexSandboxOffline',
      APPDATA: 'C:\\Users\\CodexSandboxOffline\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\CodexSandboxOffline\\AppData\\Local',
      ANTHROPIC_AUTH_TOKEN: SENTINEL_VALUE,
    };
    const child = buildClaudeChildEnvironment({ source: hostile, platform: 'linux' });
    expect(child.blockedNames).toContain('USERPROFILE');
    expect(child.blockedNames).toContain('APPDATA');
    expect(child.blockedNames).toContain('LOCALAPPDATA');
    expect(child.environment['USERPROFILE']).toBeUndefined();
    expect(child.environment['APPDATA']).toBeUndefined();
    expect(child.environment['LOCALAPPDATA']).toBeUndefined();
    // Provider auth still flows to the parent (credential boundary intact).
    expect(child.environment['ANTHROPIC_AUTH_TOKEN']).toBe(SENTINEL_VALUE);
    const spawnEnv = buildClaudeSpawnEnv({
      executable: 'claude-test',
      cwd: '/tmp/ws',
      configDir: '/tmp/claude-home/config',
      homeDir: '/tmp/claude-home/home',
      environment: child.environment,
      modelId: 'glm-5.3-flash',
      settingsPath: '/tmp/claude-home/config/sentry-settings.json',
      initializeTimeoutMs: 30_000,
      turnTimeoutMs: 60_000,
      shutdownTimeoutMs: 5_000,
    });
    expect(spawnEnv['HOME']).toBe('/tmp/claude-home/home');
    expect(spawnEnv['CLAUDE_CONFIG_DIR']).toBe('/tmp/claude-home/config');
    expect(spawnEnv['CLAUDE_CODE_SUBPROCESS_ENV_SCRUB']).toBe('1');
    expect(spawnEnv['ANTHROPIC_AUTH_TOKEN']).toBe(SENTINEL_VALUE);
  });

  it('keeps Windows profile variables for native Windows execution', () => {
    const child = buildClaudeChildEnvironment({
      source: { PATH: 'C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\qa' },
      platform: 'win32',
    });
    expect(child.environment['USERPROFILE']).toBe('C:\\Users\\qa');
  });
});

describe('Claude headless IDE isolation', () => {
  it('strips IDE/host-bridge inputs from the Linux worker environment', () => {
    const child = buildClaudeChildEnvironment({
      source: {
        PATH: '/usr/bin',
        HOME: '/tmp/sentry-home',
        ENABLE_IDE_INTEGRATION: '1',
        CLAUDE_CODE_SSE_PORT: '12345',
        VSCODE_IPC_HOOK_CLI: '/mnt/c/hooks',
        VSCODE_CWD: '/mnt/c/work',
        TERM_PROGRAM: 'vscode',
        IDEA_INITIAL_DIRECTORY: 'C:\\JetBrains',
        JETBRAINS_IDE: 'idea',
        ANTHROPIC_AUTH_TOKEN: 'sentry-test-sentinel-credential',
      },
      platform: 'linux',
    });
    for (const name of [
      'ENABLE_IDE_INTEGRATION',
      'CLAUDE_CODE_SSE_PORT',
      'VSCODE_IPC_HOOK_CLI',
      'VSCODE_CWD',
      'TERM_PROGRAM',
      'IDEA_INITIAL_DIRECTORY',
      'JETBRAINS_IDE',
    ]) {
      expect(child.environment[name]).toBeUndefined();
      expect(child.blockedNames).toContain(name);
    }
    expect(child.environment['ANTHROPIC_AUTH_TOKEN']).toBe('sentry-test-sentinel-credential');
  });

  it('does not strip IDE inputs for native Windows execution', () => {
    const child = buildClaudeChildEnvironment({
      source: { PATH: 'C:\\Windows\\System32', TERM_PROGRAM: 'vscode' },
      platform: 'win32',
    });
    expect(child.environment['TERM_PROGRAM']).toBe('vscode');
  });

  it('reports headless environment metadata without secret values', () => {
    const spawnEnv = buildClaudeSpawnEnv({
      executable: 'claude-test',
      cwd: '/tmp/ws',
      configDir: '/tmp/claude-home/config',
      homeDir: '/tmp/claude-home/home',
      environment: { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: 'sentry-test-sentinel-credential' },
      modelId: 'glm-5.3-flash',
      settingsPath: '/tmp/claude-home/config/sentry-settings.json',
      initializeTimeoutMs: 30_000,
      turnTimeoutMs: 60_000,
      shutdownTimeoutMs: 5_000,
    });
    const diagnosis = describeClaudeHeadlessEnvironment({
      spawnEnv,
      source: {
        HOME: '/mnt/c/Users/CodexSandboxOffline',
        USERPROFILE: 'C:\\Users\\CodexSandboxOffline',
        VSCODE_CWD: '/mnt/c/work',
      },
      platform: 'linux',
      configDir: '/tmp/claude-home/config',
    });
    expect(diagnosis.homeIsWindowsMounted).toBe(false);
    expect(diagnosis.configDirIsWindowsMounted).toBe(false);
    expect(diagnosis.windowsProfilePresent).toContain('USERPROFILE');
    expect(diagnosis.ideBridgeBlocked).toContain('VSCODE_CWD');
    expect(JSON.stringify(diagnosis)).not.toContain('sentry-test-sentinel-credential');
  });
});

describe('Claude executable runtime identity', () => {
  it('fails closed when Linux resolves to a Windows-mounted executable', async () => {
    const { resolveClaudeExecutableIdentity } = await import('../src/index.js');
    await expect(
      resolveClaudeExecutableIdentity(
        '/mnt/c/Program Files/claude.exe',
        { PATH: '/usr/bin' },
        'linux',
      ),
    ).rejects.toThrow(/GLM_CLAUDE_RUNTIME_MISMATCH/);
  });

  it('classifies versions data-driven: tested ready, 2.1.276 blocked, unknown unverified', async () => {
    const { classifyClaudeCodeVersion, parseClaudeCodeVersion } = await import('../src/index.js');
    expect(parseClaudeCodeVersion('2.1.270 (Claude Code)')).toBe('2.1.270');
    expect(parseClaudeCodeVersion(undefined)).toBeUndefined();
    expect(classifyClaudeCodeVersion('2.1.270 (Claude Code)')).toBe('ready');
    expect(classifyClaudeCodeVersion('2.1.276 (Claude Code)')).toBe('blocked');
    expect(classifyClaudeCodeVersion('9.9.999 (Claude Code)')).toBe('unverified');
    expect(classifyClaudeCodeVersion(undefined)).toBe('unverified');
  });

  it('detects sandbox bootstrap markers without flagging ordinary errors', async () => {
    const { isSandboxBootstrapFailureText } = await import('../src/index.js');
    expect(
      isSandboxBootstrapFailureText(
        "bwrap: Can't mkdir /mnt/c/Users/CodexSandboxOffline/.claude: Permission denied",
      ),
    ).toBe(true);
    expect(
      isSandboxBootstrapFailureText(
        "bwrap: Can't create file at /mnt/c/Users/CodexSandboxOffline/.claude/ide: Permission denied",
      ),
    ).toBe(true);
    expect(isSandboxBootstrapFailureText('Exit code 1\nbwrap: sandbox unavailable')).toBe(true);
    expect(isSandboxBootstrapFailureText('File does not exist: README.md')).toBe(false);
    expect(isSandboxBootstrapFailureText('Exit code 3')).toBe(false);
    expect(isSandboxBootstrapFailureText('EACCES: permission denied')).toBe(false);
    expect(isSandboxBootstrapFailureText('12 passed')).toBe(false);
  });
});
