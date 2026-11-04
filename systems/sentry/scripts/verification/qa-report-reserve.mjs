// Opt-in, zero-credit integration proof using installed vendor binaries and
// production adapters. Run from a built native checkout:
// node scripts/verification/qa-report-reserve.mjs deepseek|opencode|glm investigation|report
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { DeepSeekHarnessAdapter } from '../../packages/harness-deepseek/dist/index.js';
import { OpenCodeHarnessAdapter } from '../../packages/harness-opencode/dist/index.js';
import { ClaudeCodeHarnessAdapter } from '../../packages/harness-claude-code/dist/index.js';
import { HarnessRunRequestSchema } from '../../packages/schemas/dist/index.js';
import {
  createAgentRunId,
  createProjectContextSnapshotId,
  createQARunId,
  createSnapshotId,
} from '../../packages/shared/dist/index.js';

const [provider, phase = 'investigation'] = process.argv.slice(2);
assert(['deepseek', 'opencode', 'glm'].includes(provider));
assert(['investigation', 'report'].includes(phase));
const root = await mkdtemp(join(tmpdir(), 'sentry-reserve-proof-'));
const workspace = join(root, 'workspace');
await mkdir(workspace);
await writeFile(join(workspace, 'README.md'), '# Synthetic local fixture\n');
const plan = JSON.stringify({
  schemaVersion: 1,
  projectUnderstanding: 'Synthetic fixture',
  criticalFlows: ['Read'],
  weakPoints: ['Unknown'],
  plannedChecks: ['Inspect README'],
});
const report = JSON.stringify({
  schemaVersion: 2,
  summary: 'Incomplete synthetic investigation.',
  checks: [
    { name: 'check_1', status: 'inconclusive', details: 'Interrupted before verification.' },
  ],
  hypotheses: [],
  evidence: [],
  findings: [],
  limitations: ['Investigation interrupted; no behavioral conclusion.'],
});
let blocked = 0,
  reports = 0,
  requests = 0,
  recoverySeen = false;
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (req.url?.includes('count_tokens')) {
    res.end(JSON.stringify({ input_tokens: 100 }));
    return;
  }
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  const last = body.messages?.findLast((message) => message.role === 'user');
  const prompt =
    typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
  let content = 'Synthetic review';
  if (prompt.includes('STAGE 3')) {
    reports += 1;
    recoverySeen ||= prompt.includes('REPORT-ONLY RECOVERY');
    assert(prompt.includes('schemaVersion'), 'Fresh report must carry the schema');
    if (phase === 'report' && reports === 1) {
      blocked += 1;
      return;
    }
    content = report;
  } else if (prompt.includes('STAGE 2')) {
    if (phase === 'investigation') {
      blocked += 1;
      return;
    }
    content = 'Investigation complete; no behavioral verification.';
  } else if (prompt.includes('STAGE 1')) content = plan;
  requests += 1;
  const anthropic = req.url?.includes('/messages');
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (anthropic) {
    const send = (type, fields) =>
      res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n');
    send('message_start', {
      message: {
        id: 'msg_stub_' + requests,
        type: 'message',
        role: 'assistant',
        content: [],
        model: body.model,
        stop_reason: null,
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    });
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: content } });
    send('content_block_stop', { index: 0 });
    send('message_delta', {
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 50 },
    });
    send('message_stop', {});
    res.end();
  } else {
    for (const [delta, finish_reason] of [
      [{ role: 'assistant', content }, null],
      [{}, 'stop'],
    ])
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'stub-' + requests,
            object: 'chat.completion.chunk',
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }) +
          '\n\n',
      );
    res.end('data: [DONE]\n\n');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const tools = join(homedir(), '.local/share/sentry/tools');
// Every provider credential/route is synthetic and loopback only. Never load
// Sentry's credential store or use the user's configured upstream endpoints.
const environment = {
  ...process.env,
  DEEPSEEK_API_KEY: 'local-stub-only',
  DEEPSEEK_BASE_URL: base,
  OPENROUTER_API_KEY: 'local-stub-only',
  ANTHROPIC_API_KEY: 'local-stub-only',
  ANTHROPIC_AUTH_TOKEN: 'local-stub-only',
  ANTHROPIC_BASE_URL: base,
};
const adapter =
  provider === 'deepseek'
    ? new DeepSeekHarnessAdapter({
        executable: join(tools, 'deepseek/bin/dsh'),
        modelId: 'deepseek-v4-flash',
        environment,
        shutdownTimeoutMs: 1000,
      })
    : provider === 'glm'
      ? new ClaudeCodeHarnessAdapter({
          executable: join(tools, 'claude-code/node_modules/.bin/claude'),
          modelId: 'glm-5.3',
          environment,
        })
      : new OpenCodeHarnessAdapter({
          executable: join(tools, 'opencode/node_modules/.bin/opencode'),
          modelId: 'stub-model',
          provider: 'stub',
          providerBaseUrl: base + '/v1',
          providerNpm: '@ai-sdk/openai-compatible',
          providerModels: { 'stub-model': { name: 'stub-model' } },
          environment,
        });
const events = [];
const started = Date.now();
const watchdog = setTimeout(() => void adapter.cancel(input.agentRunId), 105000);
const input = HarnessRunRequestSchema.parse({
  schemaVersion: 1,
  agentRunId: createAgentRunId(),
  qaRunId: createQARunId(),
  agentStackId: 'stack_' + provider + '_main',
  projectContextSnapshotId: createProjectContextSnapshotId(),
  workspace: {
    runtimePath: workspace,
    snapshotId: createSnapshotId(),
    writable: true,
    isolated: true,
  },
  model: {
    provider,
    modelId:
      provider === 'deepseek' ? 'deepseek-v4-flash' : provider === 'glm' ? 'glm-5.3' : 'stub-model',
  },
  task: {
    type: 'qa',
    prompt: 'Inspect this synthetic local fixture.',
    policyId: 'qa-standard',
    policyVersion: 1,
    context: { qaDepth: { version: 1, deadlineAt: started + 90000 } },
  },
  executionSafeguards: { runTimeoutMs: 110000 },
});
try {
  for await (const event of adapter.run(input)) {
    events.push(event);
    if (event.type === 'agent.status' || event.type === 'warning' || event.type === 'run.failed')
      console.log(JSON.stringify(event));
  }
  assert.equal(events.at(-1)?.type, 'run.completed');
  assert.equal(blocked, 1, 'Exactly one model turn must have been interrupted');
  assert(recoverySeen, 'Fresh report context must be explicit');
  assert.equal(events.filter((event) => event.type === 'report.checkpoint').length, 1);
  assert.equal(events.filter((event) => event.type === 'finding.submitted').length, 0);
  assert(Date.now() - started < 90000, 'Recovery must finish inside original budget');
  console.log(
    JSON.stringify({
      provider,
      phase,
      passed: true,
      blocked,
      reports,
      recoverySeen,
      elapsedMs: Date.now() - started,
    }),
  );
} finally {
  clearTimeout(watchdog);
  await adapter.dispose();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
