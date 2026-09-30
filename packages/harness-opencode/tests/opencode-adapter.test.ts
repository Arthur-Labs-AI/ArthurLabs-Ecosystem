import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { IncrementalHarnessEventValidator } from '@qa/harness-protocol';
import { HarnessRunRequestSchema, type HarnessEvent } from '@qa/schemas';
import {
  createAgentRunId,
  createProjectContextSnapshotId,
  createQARunId,
  createSnapshotId,
} from '@qa/shared';
import {
  DirectOpenCodeProcessLauncher,
  OpenCodeHarnessAdapter,
  type OpenCodeClientFactory,
  type OpenCodeHarnessAdapterOptions,
  type OpenCodePromptResult,
} from '../src/index.js';

const SENTINEL_VALUE = 'sentry-test-sentinel-credential';
const FAKE_SESSION = 'ses_test_111111111111111111111111';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function testEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin', OPENROUTER_API_KEY: SENTINEL_VALUE, ...extra };
}

/**
 * Deterministic fake containment for LOGICAL adapter tests (session
 * continuity, masking, validation, cancellation, provider composition).
 *
 * A direct launcher plus a skipped tool shell lets the test reach its fake
 * client without probing the real host for systemd/bubblewrap — the exact
 * probes that fail on restricted CI hosts with OPENCODE_SANDBOX_UNAVAILABLE.
 * Masking, scope creation, the auth proxy, version/credential gates, and all
 * adapter logic still run for real. Production containment stays covered by
 * the dedicated fail-closed tests below and opencode-path-sandbox.test.ts.
 *
 * Fakes are explicit per instance and always win over caller extras, so a
 * logical test can never accidentally exercise host containment.
 */
function logicalAdapterDefaults(
  extra: OpenCodeHarnessAdapterOptions = {},
): OpenCodeHarnessAdapterOptions {
  return {
    executable: 'opencode-test',
    modelId: 'anthropic/claude-test',
    environment: testEnv(),
    ...extra,
    launcherSelector: async () => new DirectOpenCodeProcessLauncher(),
    toolShellBuilder: async () => undefined,
  };
}

async function request(root: string) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'README.md'), '# Fixture\nimportant line\n');
  return HarnessRunRequestSchema.parse({
    schemaVersion: 1,
    agentRunId: createAgentRunId(),
    qaRunId: createQARunId(),
    agentStackId: 'stack_opencode_main',
    projectContextSnapshotId: createProjectContextSnapshotId(),
    workspace: {
      runtimePath: root,
      snapshotId: createSnapshotId(),
      writable: true,
      isolated: true,
    },
    model: { provider: 'openrouter', modelId: 'anthropic/claude-test' },
    task: { type: 'qa', prompt: 'Inspect the fixture.', policyId: 'qa-standard', policyVersion: 1 },
    executionSafeguards: { runTimeoutMs: 30_000 },
  });
}

async function collect(
  adapter: OpenCodeHarnessAdapter,
  input: Awaited<ReturnType<typeof request>>,
): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of adapter.run(input)) events.push(event);
  return events;
}

function validReportV2() {
  return {
    schemaVersion: 2,
    summary: 'One evidence-backed issue.',
    checks: [{ name: 'Inspect README', status: 'passed' }],
    hypotheses: [
      {
        title: 'Boundary risk',
        rationale: 'The fixture is minimal.',
        relatedPaths: ['README.md'],
        plannedChecks: ['Inspect README'],
      },
    ],
    evidence: [
      {
        key: 'readme',
        type: 'code_reference',
        strength: 'strong_code_evidence',
        description: 'Relevant line.',
        relativePath: 'README.md',
        lineStart: 2,
        lineEnd: 2,
      },
    ],
    findings: [
      {
        title: 'Fixture issue',
        category: 'documentation',
        severity: 'low',
        confidence: 'strong',
        description: 'A deterministic fixture finding.',
        locations: [{ relativePath: 'README.md', lineStart: 2 }],
        evidenceKeys: ['readme'],
        reproductionSteps: ['Open README.md'],
      },
    ],
    limitations: [],
  };
}

function validPlan() {
  return JSON.stringify({
    schemaVersion: 1,
    projectUnderstanding: 'Small fixture',
    criticalFlows: ['Read path'],
    weakPoints: ['Boundary'],
    plannedChecks: ['Inspect README'],
  });
}

interface SeenTurn {
  readonly sessionId?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}

function scriptedFactory(
  script: OpenCodePromptResult[],
  seen: { turns: SeenTurn[]; modelIds: string[]; launcherKinds?: string[] } = {
    turns: [],
    modelIds: [],
  },
): OpenCodeClientFactory {
  let calls = 0;
  return async (input) => {
    seen.modelIds.push(input.modelId);
    seen.launcherKinds?.push(input.launcher?.kind ?? 'none');
    return {
      startSession: async () => ({
        runPrompt: async (_prompt, options) => {
          seen.turns.push({ sessionId: options.sessionId, environment: options.environment });
          const next = script[Math.min(calls, script.length - 1)];
          calls += 1;
          if (next === undefined) throw new Error('Script exhausted');
          return next;
        },
        abort: () => undefined,
      }),
      close: async () => undefined,
    };
  };
}

const textTurn = (text: string, sessionId: string = FAKE_SESSION): OpenCodePromptResult => ({
  text,
  toolCalls: [],
  steps: 1,
  sessionId,
  envelopes: 2,
});

function validateProtocol(
  events: HarnessEvent[],
  input: Awaited<ReturnType<typeof request>>,
): void {
  const validator = new IncrementalHarnessEventValidator(input.qaRunId, input.agentRunId);
  for (const event of events) validator.accept(event);
  validator.finish();
}

describe('OpenCodeHarnessAdapter', () => {
  it('exposes opencode metadata with the effective model pattern', async () => {
    const adapter = new OpenCodeHarnessAdapter({
      ...logicalAdapterDefaults(),
      clientFactory: scriptedFactory([]),
    });
    const metadata = await adapter.getMetadata();
    expect(metadata.adapterId).toBe('opencode');
    expect(metadata.protocolVersion).toBe(1);
    expect(metadata.supportedModelPatterns).toEqual(['openrouter/anthropic/claude-test']);
    expect(metadata.capabilities.cancellation).toBe(true);
    expect(metadata.capabilities.sessionResume).toBe(true);
    await adapter.dispose();
  });

  it('fails closed without an OpenRouter credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-nokey-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new OpenCodeHarnessAdapter({
      executable: 'opencode-test',
      modelId: 'anthropic/claude-test',
      environment: { PATH: '/usr/bin' },
      clientFactory: scriptedFactory([]),
    });
    const events = await collect(adapter, input);
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'OPENCODE_CREDENTIAL_MISSING' },
    });
    await adapter.dispose();
  });

  it('run() pre-selects the launcher from the host environment, not the turn env', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-launcher-'));
    roots.push(root);
    const input = await request(root);
    // Bus-sensitive systemd fakes keep Linux CI deterministic with or
    // without a real user manager, and prove WHICH environment is probed:
    // only the host environment carries the session-bus address the fakes
    // require, while the sanitized turn environment is bus-scrubbed.
    const fakeDir = await mkdtemp(join(tmpdir(), 'sentry-oc-launcher-bin-'));
    roots.push(fakeDir);
    if (process.platform === 'linux') {
      const busSensitive =
        '#!/bin/sh\nif [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then exit 1; fi\nexit 0\n';
      await writeFile(join(fakeDir, 'systemctl'), busSensitive);
      await writeFile(join(fakeDir, 'systemd-run'), busSensitive);
      await chmod(join(fakeDir, 'systemctl'), 0o700);
      await chmod(join(fakeDir, 'systemd-run'), 0o700);
    }
    const seen: { launcherKind?: string } = {};
    const factory: OpenCodeClientFactory = async (factoryInput) => {
      seen.launcherKind = factoryInput.launcher?.kind;
      throw new Error('sentry-test-sentinel-factory-stop');
    };
    const adapter = new OpenCodeHarnessAdapter({
      executable: 'opencode-test',
      modelId: 'anthropic/claude-test',
      environment: {
        ...testEnv(),
        PATH: fakeDir + delimiter + (process.env['PATH'] ?? ''),
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
        XDG_RUNTIME_DIR: '/run/user/1000',
      },
      // Isolate ONLY the unrelated tool-shell/bwrap prerequisite. No
      // launcherSelector: the REAL selectProductionLauncher must execute
      // against the host environment above.
      toolShellBuilder: async () => undefined,
      clientFactory: factory,
    });
    const events = await collect(adapter, input);
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'OPENCODE_START_FAILED' },
    });
    // The factory received a pre-selected launcher chosen from the host
    // environment. On Linux the bus-sensitive fakes only succeed with the
    // host session-bus address, so systemd-unit proves host selection: had
    // the scrubbed turn env been probed instead, the run would have failed
    // closed with OPENCODE_SANDBOX_UNAVAILABLE.
    expect(seen.launcherKind).toBe(process.platform === 'linux' ? 'systemd-unit' : 'direct');
    await adapter.dispose();
  });

  it('runs all turns in one OpenCode session with composed model id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-success-'));
    roots.push(root);
    const input = await request(root);
    const seen = {
      turns: [] as SeenTurn[],
      modelIds: [] as string[],
      launcherKinds: [] as string[],
    };
    const adapter = new OpenCodeHarnessAdapter({
      ...logicalAdapterDefaults(),
      clientFactory: scriptedFactory(
        [
          textTurn(validPlan()),
          {
            text: 'Investigation complete.',
            toolCalls: [
              {
                callID: 'call_read_1',
                tool: 'read',
                input: { path: 'README.md' },
                status: 'completed',
                output: 'ok',
              },
              {
                callID: 'call_bash_1',
                tool: 'bash',
                input: { command: 'rg important README.md' },
                status: 'completed',
                output: 'important line',
                exitCode: 0,
                durationMs: 12,
              },
            ],
            steps: 2,
            sessionId: FAKE_SESSION,
            envelopes: 5,
          },
          textTurn(JSON.stringify(validReportV2())),
        ],
        seen,
      ),
    });
    const events = await collect(adapter, input);
    validateProtocol(events, input);
    // Session continuity: first turn creates, later turns continue.
    expect(seen.turns.map((t) => t.sessionId)).toEqual([undefined, FAKE_SESSION, FAKE_SESSION]);
    // Effective composed model id reaches the client.
    expect(seen.modelIds).toEqual(['openrouter/anthropic/claude-test']);
    // The factory received the INJECTED fake launcher (direct), never a
    // production host probe: on Linux production would select systemd-unit
    // or fail closed, so this pins the test-isolation seam.
    expect(seen.launcherKinds).toEqual([new DirectOpenCodeProcessLauncher().kind]);
    // Reporting turn carries the upstream tool deny (plus adapter firewall).
    const reportEnv = seen.turns[2]?.environment ?? {};
    expect(JSON.parse((reportEnv['OPENCODE_PERMISSION'] as string) ?? '{}')).toEqual({
      '*': 'deny',
    });
    expect(seen.turns[0]?.environment?.['OPENCODE_PERMISSION']).toBeUndefined();
    const types = events.map((event) => event.type);
    expect(types[0]).toBe('run.started');
    expect(types).toContain('investigation.plan.created');
    expect(types.filter((type) => type === 'tool.started')).toHaveLength(2);
    expect(types.filter((type) => type === 'tool.completed')).toHaveLength(2);
    expect(types.filter((type) => type === 'command.executed')).toHaveLength(1);
    expect(types.filter((type) => type === 'finding.submitted')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('run.completed');
    const completed = events.find((e) => e.type === 'run.completed');
    expect(completed).toMatchObject({ usage: { turns: 4 } });
    expect(JSON.stringify(events)).not.toContain(SENTINEL_VALUE);
    await adapter.dispose();
  });

  it('masks project .opencode content and cleans the scope afterwards', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-mask-'));
    roots.push(root);
    const input = await request(root);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, '.opencode', 'plugins'), { recursive: true });
    await writeFile(join(root, '.opencode', 'plugins', 'evil.js'), 'evil');
    const adapter = new OpenCodeHarnessAdapter({
      ...logicalAdapterDefaults(),
      clientFactory: scriptedFactory([
        textTurn(validPlan()),
        textTurn('Investigation complete.'),
        textTurn(JSON.stringify(validReportV2())),
      ]),
    });
    const events = await collect(adapter, input);
    expect(events.at(-1)?.type).toBe('run.completed');
    // Masked by rename inside the disposable workspace (readable, undiscoverable).
    await expect(stat(join(root, '.opencode'))).rejects.toThrow();
    // Scope (auth boundary included) removed when the run settles.
    const scopeDir = join(
      dirname(root),
      '.sentry-opencode-' + input.agentRunId.replace(/[^A-Za-z0-9_-]/g, '_'),
    );
    await expect(stat(scopeDir)).rejects.toThrow();
    const masked = adapter
      .getShutdownDiagnostics()
      .find((d) => d.code === 'OPENCODE_PROJECT_CONFIG_MASKED');
    expect(masked?.severity).toBe('info');
    await adapter.dispose();
  });

  it('fails closed when no OpenCode session is established', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-nosession-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new OpenCodeHarnessAdapter({
      ...logicalAdapterDefaults(),
      clientFactory: scriptedFactory([
        { text: validPlan(), toolCalls: [], steps: 1, envelopes: 2 },
        textTurn('Investigation complete.'),
        textTurn(JSON.stringify(validReportV2())),
      ]),
    });
    const events = await collect(adapter, input);
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'OPENCODE_SESSION_MISMATCH' },
    });
    await adapter.dispose();
  });

  it('rejects a mismatched OpenCode session instead of switching conversations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-sesmatch-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new OpenCodeHarnessAdapter({
      ...logicalAdapterDefaults(),
      clientFactory: scriptedFactory([
        textTurn(validPlan(), FAKE_SESSION),
        textTurn('Investigation complete.', 'ses_different_2222222222222222'),
        textTurn(JSON.stringify(validReportV2())),
      ]),
    });
    const events = await collect(adapter, input);
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'OPENCODE_SESSION_MISMATCH' },
    });
    await adapter.dispose();
  });

  it('reports exact exit codes and error previews truthfully', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-exits-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new OpenCodeHarnessAdapter({
      ...logicalAdapterDefaults(),
      clientFactory: scriptedFactory([
        textTurn(validPlan()),
        {
          text: 'Investigation complete.',
          toolCalls: [
            {
              callID: 'call_bash_9',
              tool: 'bash',
              input: { command: 'exit 127' },
              status: 'completed',
              output: 'not found',
              exitCode: 127,
            },
            {
              callID: 'call_bash_10',
              tool: 'bash',
              input: { command: 'cat ../secret' },
              status: 'error',
              error: 'The user rejected permission to use this specific tool call.',
            },
          ],
          steps: 1,
          sessionId: FAKE_SESSION,
          envelopes: 4,
        },
        textTurn(JSON.stringify(validReportV2())),
      ]),
    });
    const events = await collect(adapter, input);
    expect(events.at(-1)?.type).toBe('run.completed');
    const completed = events.filter((e) => e.type === 'tool.completed');
    expect(completed).toHaveLength(2);
    // Exact observed code preserved everywhere (never collapsed to 1).
    expect(completed[0]).toMatchObject({ tool: { name: 'bash', exitCode: 127 } });
    const executed = events.filter((e) => e.type === 'command.executed');
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ command: 'exit 127', exitCode: 127 });
    // Failure without a code: preview, no exitCode, no command.executed.
    expect(completed[1]).toMatchObject({
      tool: { name: 'bash', errorPreview: expect.stringContaining('rejected permission') },
    });
    expect((completed[1] as { tool: { exitCode?: unknown } }).tool.exitCode).toBeUndefined();
    await adapter.dispose();
  });

  it('forbids the task subagent tool', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-subagent-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new OpenCodeHarnessAdapter({
      ...logicalAdapterDefaults(),
      clientFactory: scriptedFactory([
        textTurn(validPlan()),
        {
          text: 'Investigation complete.',
          toolCalls: [
            {
              callID: 'call_task_1',
              tool: 'task',
              input: { description: 'delegate' },
              status: 'completed',
              output: 'delegated',
            },
          ],
          steps: 1,
          sessionId: FAKE_SESSION,
          envelopes: 3,
        },
        textTurn(JSON.stringify(validReportV2())),
      ]),
    });
    const events = await collect(adapter, input);
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'OPENCODE_SUBAGENT_FORBIDDEN' },
    });
    await adapter.dispose();
  });

  it('refuses reporting turns that use tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-reporttools-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new OpenCodeHarnessAdapter({
      ...logicalAdapterDefaults(),
      clientFactory: scriptedFactory([
        textTurn(validPlan()),
        textTurn('Investigation complete.'),
        {
          text: JSON.stringify(validReportV2()),
          toolCalls: [
            {
              callID: 'call_bash_2',
              tool: 'bash',
              input: { command: 'ls' },
              status: 'completed',
              output: 'x',
            },
          ],
          steps: 1,
          sessionId: FAKE_SESSION,
          envelopes: 3,
        },
      ]),
    });
    const events = await collect(adapter, input);
    expect(events.at(-1)?.type).toBe('run.failed');
    await adapter.dispose();
  });

  it('fails the run on an invalid report without weakening validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-badreport-'));
    roots.push(root);
    const input = await request(root);
    const bad = { ...validReportV2(), findings: [{ title: 'Missing everything' }] };
    const adapter = new OpenCodeHarnessAdapter({
      ...logicalAdapterDefaults(),
      clientFactory: scriptedFactory([
        textTurn(validPlan()),
        textTurn('Investigation complete.'),
        textTurn(JSON.stringify(bad)),
      ]),
    });
    const events = await collect(adapter, input);
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'OPENCODE_INVALID_RESULT' },
    });
    await adapter.dispose();
  });

  it('redacts the credential from failure diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-redact-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new OpenCodeHarnessAdapter({
      ...logicalAdapterDefaults(),
      clientFactory: async () => ({
        startSession: async () => ({
          runPrompt: async () => {
            throw new Error('boom ' + SENTINEL_VALUE);
          },
          abort: () => undefined,
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    expect(events.at(-1)?.type).toBe('run.failed');
    expect(JSON.stringify(events)).not.toContain(SENTINEL_VALUE);
    await adapter.dispose();
  });

  it('cancels only the owned session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-cancel-'));
    roots.push(root);
    const first = await request(root);
    const aborted: string[] = [];
    const hangingFactory: OpenCodeClientFactory = async () => ({
      startSession: async () => ({
        runPrompt: async (_prompt, options) => {
          await new Promise<void>((resolve) => {
            options.signal?.addEventListener('abort', () => {
              aborted.push('session');
              resolve();
            });
          });
          throw new Error('cancelled-mid-turn');
        },
        abort: () => undefined,
      }),
      close: async () => undefined,
    });
    const adapter = new OpenCodeHarnessAdapter({
      ...logicalAdapterDefaults(),
      clientFactory: hangingFactory,
    });
    const pending = collect(adapter, first);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await adapter.cancel(first.agentRunId);
    const firstEvents = await pending;
    expect(firstEvents.at(-1)?.type).toBe('run.failed');
    expect(aborted).toEqual(['session']);
    await adapter.dispose();
  });

  it('bounds runaway turns with the watchdog', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-timeout-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new OpenCodeHarnessAdapter({
      ...logicalAdapterDefaults(),
      turnTimeoutMs: 50,
      clientFactory: async () => ({
        startSession: async () => ({
          runPrompt: async () => new Promise<never>(() => undefined),
          abort: () => undefined,
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'OPENCODE_START_FAILED' },
    });
    await adapter.dispose();
  });

  it('fails closed before launch when workspace masking is impossible', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-maskfail-'));
    roots.push(root);
    // A FILE as workspace path: inspection fails, nothing may launch.
    const notADir = join(root, 'file-not-dir');
    await writeFile(notADir, 'x');
    let factoryCalled = false;
    const adapter = new OpenCodeHarnessAdapter({
      ...logicalAdapterDefaults(),
      clientFactory: (async () => {
        factoryCalled = true;
        throw new Error('must not launch');
      }) as OpenCodeClientFactory,
    });
    const base = await request(root);
    const input = { ...base, workspace: { ...base.workspace, runtimePath: notADir } };
    const events = await collect(adapter, input as typeof base);
    expect(factoryCalled).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'OPENCODE_PROJECT_CONFIG_ISOLATION_FAILED' },
    });
    await adapter.dispose();
  });

  it('cleans the scope when the binary fails to start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-binerr-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new OpenCodeHarnessAdapter({
      ...logicalAdapterDefaults(),
      clientFactory: async () => {
        throw new Error('spawn ENOENT');
      },
    });
    const events = await collect(adapter, input);
    expect(events.at(-1)?.type).toBe('run.failed');
    const scopeDir = join(
      dirname(root),
      '.sentry-opencode-' + input.agentRunId.replace(/[^A-Za-z0-9_-]/g, '_'),
    );
    await expect(stat(scopeDir)).rejects.toThrow();
    await adapter.dispose();
  });

  it('routes the opencode provider through the generic loader with a models table', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-zen-'));
    roots.push(root);
    const input = await request(root);
    const seen = { turns: [] as SeenTurn[], modelIds: [] as string[] };
    const adapter = new OpenCodeHarnessAdapter({
      ...logicalAdapterDefaults({
        modelId: 'muse-spark-1.3-contributor-free',
        provider: 'opencode',
        environment: {
          PATH: '/usr/bin',
          OPENCODE_API_KEY: 'sentry-test-zen-key',
          SENTRY_OPENCODE_PROVIDER: 'opencode',
        },
      }),
      clientFactory: scriptedFactory(
        [
          textTurn(validPlan()),
          textTurn('Investigation complete.'),
          textTurn(JSON.stringify(validReportV2())),
        ],
        seen,
      ),
    });
    const events = await collect(adapter, input);
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(seen.modelIds).toEqual(['opencode/muse-spark-1.3-contributor-free']);
    const config = JSON.parse(
      (seen.turns[0]?.environment?.['OPENCODE_CONFIG_CONTENT'] as string) ?? '{}',
    ) as {
      provider?: Record<
        string,
        {
          npm?: string;
          options?: { baseURL?: string; apiKey?: string };
          models?: Record<string, unknown>;
        }
      >;
    };
    // Catalog-preserving config: connection options only (baseURL to the
    // localhost proxy, dummy key). No npm/models overrides, so OpenCode
    // keeps its built-in per-model transport metadata.
    expect(config.provider?.['opencode']?.npm).toBeUndefined();
    expect(config.provider?.['opencode']?.models).toBeUndefined();
    expect(config.provider?.['opencode']?.options?.baseURL).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/v1$/,
    );
    expect(config.provider?.['opencode']?.options?.apiKey).toBe('sentry-managed-proxy-key');
    expect(JSON.stringify(events)).not.toContain('sentry-test-zen-key');
    await adapter.dispose();
  });

  it('names the Zen credential when the opencode provider key is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-zennokey-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new OpenCodeHarnessAdapter({
      executable: 'opencode-test',
      modelId: 'muse-spark-1.3-contributor-free',
      provider: 'opencode',
      environment: { PATH: '/usr/bin', SENTRY_OPENCODE_PROVIDER: 'opencode' },
      clientFactory: scriptedFactory([]),
    });
    const events = await collect(adapter, input);
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'OPENCODE_CREDENTIAL_MISSING' },
    });
    const failed = events.find((e) => e.type === 'run.failed') as {
      failure?: { message?: string };
    };
    expect(failed.failure?.message).toContain('OPENCODE_API_KEY');
    await adapter.dispose();
  });

  it('production launcher fails closed on Linux without functional systemd', async () => {
    // No injected fakes: the production launcherSelector runs. On a host
    // without a functional systemd user manager this must fail closed with
    // OPENCODE_SANDBOX_UNAVAILABLE before the client factory runs. Hosts
    // that genuinely provide containment skip here — the real production
    // path covers them, and opencode-path-sandbox.test.ts pins the
    // selection policy deterministically with fakes.
    if (process.platform !== 'linux') return;
    const { selectProductionLauncher } = await import('../src/index.js');
    try {
      await selectProductionLauncher(testEnv());
      return;
    } catch {
      // No functional containment: assert the adapter fails closed too.
    }
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-nosystemd-'));
    roots.push(root);
    const input = await request(root);
    let factoryCalled = false;
    const adapter = new OpenCodeHarnessAdapter({
      executable: 'opencode-test',
      modelId: 'anthropic/claude-test',
      environment: testEnv(),
      clientFactory: (async () => {
        factoryCalled = true;
        throw new Error('must not launch');
      }) as OpenCodeClientFactory,
    });
    const events = await collect(adapter, input);
    expect(factoryCalled).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'OPENCODE_SANDBOX_UNAVAILABLE' },
    });
    await adapter.dispose();
  });

  it('masking still fails closed in direct/dev mode', async () => {
    // SENTRY_OPENCODE_ALLOW_DIRECT=1 relaxes systemd/bubblewrap only.
    // Project-config masking stays mandatory and blocks before even fake
    // containment is consulted.
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-directmask-'));
    roots.push(root);
    const notADir = join(root, 'file-not-dir');
    await writeFile(notADir, 'x');
    let factoryCalled = false;
    const adapter = new OpenCodeHarnessAdapter({
      ...logicalAdapterDefaults({
        environment: testEnv({ SENTRY_OPENCODE_ALLOW_DIRECT: '1' }),
      }),
      clientFactory: (async () => {
        factoryCalled = true;
        throw new Error('must not launch');
      }) as OpenCodeClientFactory,
    });
    const base = await request(root);
    const input = { ...base, workspace: { ...base.workspace, runtimePath: notADir } };
    const events = await collect(adapter, input as typeof base);
    expect(factoryCalled).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'OPENCODE_PROJECT_CONFIG_ISOLATION_FAILED' },
    });
    await adapter.dispose();
  });

  it('direct mode reaches the fake client with production defaults and warns', async () => {
    // The ONLY bypass: the explicit SENTRY_OPENCODE_ALLOW_DIRECT=1
    // development/test override. Production containment decisions run
    // (no injected fakes), weaker execution is chosen openly, and the
    // degradation is recorded as a warning diagnostic.
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-directok-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new OpenCodeHarnessAdapter({
      executable: 'opencode-test',
      modelId: 'anthropic/claude-test',
      environment: testEnv({ SENTRY_OPENCODE_ALLOW_DIRECT: '1' }),
      clientFactory: scriptedFactory([
        textTurn(validPlan()),
        textTurn('Investigation complete.'),
        textTurn(JSON.stringify(validReportV2())),
      ]),
    });
    const events = await collect(adapter, input);
    expect(events.at(-1)?.type).toBe('run.completed');
    const direct = adapter.getShutdownDiagnostics().find((d) => d.code === 'OPENCODE_DIRECT_SHELL');
    expect(direct?.severity).toBe('warning');
    await adapter.dispose();
  });
});
