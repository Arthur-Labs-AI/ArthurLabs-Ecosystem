import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelGateway } from '../../src/models/gateway';
import { FakeProvider } from '../../src/models/providers/fake';
import { ProviderAuthError, ProviderTimeoutError, ProviderUnavailableError } from '../../src/models/contracts';
import { ModelRouter } from '../../src/runtime/model_router';
import { NodeRegistry } from '../../src/runtime/hybrid/node_registry';
import { ProviderRegistry } from '../../src/runtime/hybrid/provider_registry';
import { ModelGatewayRegistry } from '../../src/runtime/hybrid/gateway_registry';

function req(overrides: Partial<import('../../src/models/contracts').ModelRequest> = {}): import('../../src/models/contracts').ModelRequest {
  return { systemContract: 's', modeContract: 'm', history: [], toolSchemas: [], userMessage: 'hi', model: 'test-model', reasoningProfile: 'fast', ...overrides };
}

function gwWith(id: string, opts: { fail?: unknown; text?: string; tools?: boolean; ctx?: number } = {}) {
  const calls = { n: 0 };
  const provider = new FakeProvider({ id, responder: () => { calls.n += 1; if (opts.fail !== undefined) throw opts.fail; return { assistant_text: opts.text || ('from-' + id), tool_calls: [], finish_reason: 'stop' }; } });
  const caps = provider.capabilities();
  provider.capabilities = () => Object.assign({}, caps, { supportsTools: opts.tools !== undefined ? opts.tools : true, maxContextTokens: opts.ctx || 32000 });
  return { gw: new ModelGateway(provider), calls };
}

function baseNodes() {
  const nodes = new NodeRegistry();
  nodes.register({ id: 'laptop', role: 'laptop', runtime_mode: 'local', platform: 'linux', runtime_capabilities: ['model.generate', 'model.tools'], tool_ids: [] }, { status: 'ready', active_jobs: 0, last_seen_at_ms: 1 });
  nodes.register({ id: 'arthur-server', role: 'server', runtime_mode: 'lan', platform: 'linux', runtime_capabilities: ['model.generate', 'model.tools'], tool_ids: [] }, { status: 'ready', active_jobs: 0, last_seen_at_ms: 1 });
  return nodes;
}

function regModel(providers: ProviderRegistry, gateways: ModelGatewayRegistry, id: string, mode: 'local' | 'lan' | 'cloud', nodeId: string | undefined, gw: ModelGateway, opts: { tools?: boolean; ctx?: number } = {}) {
  providers.register({ identity: { id, kind: 'model', runtime_mode: mode }, capabilities: opts.tools === false ? ['model.generate'] : ['model.generate', 'model.tools'], ...(nodeId ? { node_id: nodeId } : {}), model: { supports_tools: opts.tools !== undefined ? opts.tools : true, supports_reasoning: true, max_context_tokens: opts.ctx || 32000 } });
  gateways.register(id, gw);
}

function trio(t: { local?: { fail?: unknown; text?: string; tools?: boolean; ctx?: number }; lan?: { fail?: unknown; text?: string; tools?: boolean; ctx?: number }; cloud?: { fail?: unknown; text?: string; tools?: boolean; ctx?: number }; locality?: 'cloud_allowed' | 'lan_or_local' | 'local_only' }) {
  const nodes = baseNodes();
  const providers = new ProviderRegistry();
  const gateways = new ModelGatewayRegistry();
  const a = gwWith('local-qwen', t.local || {});
  const b = gwWith('server-qwen', t.lan || {});
  const c = gwWith('deepseek', t.cloud || {});
  regModel(providers, gateways, 'local-qwen', 'local', 'laptop', a.gw, t.local || {});
  regModel(providers, gateways, 'server-qwen', 'lan', 'arthur-server', b.gw, t.lan || {});
  regModel(providers, gateways, 'deepseek', 'cloud', undefined, c.gw, t.cloud || {});
  const seen: { provider_id: string; runtime_mode: string; reason: string; attempt: number; fallback: boolean }[] = [];
  const router = new ModelRouter({ nodes, providers, gateways, observer: { onAttempt: (i) => { seen.push({ provider_id: i.provider_id, runtime_mode: i.runtime_mode, reason: i.reason, attempt: i.attempt, fallback: i.fallback }); } }, ...(t.locality ? { dataLocalityPolicy: t.locality } : {}) });
  return { router, seen, calls: { local: a.calls, lan: b.calls, cloud: c.calls } };
}

test('C-A: local-first selection invokes local exactly once', async () => {
  const lab = trio({});
  const out = await lab.router.generate(req());
  assert.equal(out.assistant_text, 'from-local-qwen');
  assert.equal(lab.calls.local.n, 1);
  assert.equal(lab.calls.lan.n, 0);
  assert.equal(lab.calls.cloud.n, 0);
  assert.equal(lab.seen.length, 1);
  assert.equal(lab.seen[0]?.provider_id, 'local-qwen');
  assert.equal(lab.seen[0]?.fallback, false);
});

test('C-B: needs_tools filters local without tools, selects LAN', async () => {
  const lab = trio({ local: { tools: false } });
  const out = await lab.router.generate(req({ toolSchemas: [{ name: 't', description: 'd', parameters: {} }] }));
  assert.equal(out.assistant_text, 'from-server-qwen');
  assert.equal(lab.calls.local.n, 0);
  assert.equal(lab.calls.lan.n, 1);
});

test('C-C: local_only never invokes cloud even when preferred', async () => {
  const lab = trio({ locality: 'local_only' });
  const out = await lab.router.generate(req());
  assert.equal(out.assistant_text, 'from-local-qwen');
  assert.equal(lab.calls.cloud.n, 0);
});

test('C-D: small local context routes to LAN', async () => {
  const nodes = baseNodes();
  const providers = new ProviderRegistry();
  const gateways = new ModelGatewayRegistry();
  const small = gwWith('small', { ctx: 1000 });
  const big = gwWith('big', { ctx: 64000 });
  regModel(providers, gateways, 'small', 'local', 'laptop', small.gw, { ctx: 1000 });
  regModel(providers, gateways, 'big', 'lan', 'arthur-server', big.gw, { ctx: 64000 });
  const router = new ModelRouter({ nodes, providers, gateways });
  const out = await router.generate(req());
  assert.equal(out.assistant_text, 'from-small');
  assert.equal(small.calls.n, 1);
  assert.equal(big.calls.n, 0);
});

test('C-E: unavailable primary falls back once to LAN alternative', async () => {
  const lab = trio({ local: { fail: new ProviderUnavailableError('down') } });
  const out = await lab.router.generate(req());
  assert.equal(out.assistant_text, 'from-server-qwen');
  assert.equal(lab.calls.local.n, 1);
  assert.equal(lab.calls.lan.n, 1);
  assert.equal(lab.calls.cloud.n, 0);
  assert.equal(lab.seen.length, 2);
  assert.equal(lab.seen[1]?.fallback, true);
  assert.equal(lab.seen[0]?.runtime_mode, 'local');
  assert.equal(lab.seen[1]?.runtime_mode, 'lan');
  assert.equal(lab.seen[1]?.provider_id, 'server-qwen');
});

test('C-E2: missing fallback gateway fails closed (no silent third-provider skip)', async () => {
  const nodes = baseNodes();
  const providers = new ProviderRegistry();
  const gateways = new ModelGatewayRegistry();
  const flaky = gwWith('flaky-local', { fail: new ProviderUnavailableError('down') });
  const good = gwWith('good-cloud', {});
  providers.register({ identity: { id: 'flaky-local', kind: 'model', runtime_mode: 'local' }, capabilities: ['model.generate'], node_id: 'laptop', model: { supports_tools: false, supports_reasoning: false, max_context_tokens: 8000 } });
  providers.register({ identity: { id: 'ghost-lan', kind: 'model', runtime_mode: 'lan' }, capabilities: ['model.generate'], node_id: 'arthur-server', model: { supports_tools: false, supports_reasoning: false, max_context_tokens: 8000 } });
  providers.register({ identity: { id: 'good-cloud', kind: 'model', runtime_mode: 'cloud' }, capabilities: ['model.generate'], model: { supports_tools: false, supports_reasoning: false, max_context_tokens: 8000 } });
  gateways.register('flaky-local', flaky.gw);
  gateways.register('good-cloud', good.gw);
  const router = new ModelRouter({ nodes, providers, gateways });
  await assert.rejects(() => router.generate(req()), /no executable gateway for provider "ghost-lan"/);
  assert.equal(flaky.calls.n, 1);
  assert.equal(good.calls.n, 0);
});

test('C-F: timeout primary falls back once', async () => {
  const lab = trio({ local: { fail: new ProviderTimeoutError('slow') } });
  const out = await lab.router.generate(req());
  assert.equal(out.assistant_text, 'from-server-qwen');
  assert.equal(lab.calls.local.n, 1);
  assert.equal(lab.calls.lan.n, 1);
});

test('C-G: auth failure never falls back', async () => {
  const lab = trio({ local: { fail: new ProviderAuthError('bad key') } });
  await assert.rejects(() => lab.router.generate(req()), (e) => e instanceof ProviderAuthError || (typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'MODEL_UNAVAILABLE'));
  assert.equal(lab.calls.local.n, 1);
  assert.equal(lab.calls.lan.n, 0);
  assert.equal(lab.calls.cloud.n, 0);
});

test('C-G2: typed fallback matrix through the real ModelGateway boundary', async () => {
  const { ArthurError } = await import('../../src/core/errors/errors');
  const { ProviderBadResponseError } = await import('../../src/models/contracts');
  const cases: { name: string; fail: unknown; fallback: boolean }[] = [
    { name: 'raw unavailable', fail: new ProviderUnavailableError('down'), fallback: true },
    { name: 'raw timeout', fail: new ProviderTimeoutError('slow'), fallback: true },
    { name: 'mapped unavailable+cause', fail: new ArthurError('MODEL_UNAVAILABLE', 'Model provider is unavailable', { cause: new ProviderUnavailableError('down') }), fallback: true },
    { name: 'mapped timeout+cause', fail: new ArthurError('MODEL_TIMEOUT', 'Model provider timed out', { cause: new ProviderTimeoutError('slow') }), fallback: true },
    { name: 'mapped auth+cause', fail: new ArthurError('MODEL_UNAVAILABLE', 'Model provider authentication failed', { cause: new ProviderAuthError('bad') }), fallback: false },
    { name: 'mapped unavailable+generic cause', fail: new ArthurError('MODEL_UNAVAILABLE', 'Model provider is unavailable', { cause: new Error('weird') }), fallback: false },
    { name: 'bare unavailable no cause', fail: new ArthurError('MODEL_UNAVAILABLE', 'Model provider is unavailable'), fallback: false },
    { name: 'bad response', fail: new ProviderBadResponseError('garbled'), fallback: false },
    { name: 'arbitrary error', fail: new Error('boom'), fallback: false },
  ];
  for (const c of cases) {
    const lab = trio({ local: { fail: c.fail } });
    if (c.fallback) {
      const out = await lab.router.generate(req());
      assert.equal(out.assistant_text, 'from-server-qwen', c.name);
      assert.equal(lab.calls.lan.n, 1, c.name);
    } else {
      await assert.rejects(() => lab.router.generate(req()), /.+/, c.name);
      assert.equal(lab.calls.lan.n, 0, c.name);
      assert.equal(lab.calls.cloud.n, 0, c.name);
    }
    assert.equal(lab.calls.local.n, 1, c.name);
  }
});

test('C-G3: spoofed message text cannot change classification', async () => {
  const { ArthurError: AE } = await import('../../src/core/errors/errors');
  const spoofedDown = new ProviderUnavailableError('authentication auth failed: bad key');
  const lab1 = trio({ local: { fail: spoofedDown } });
  assert.equal((await lab1.router.generate(req())).assistant_text, 'from-server-qwen');
  const spoofedUp = new AE('MODEL_UNAVAILABLE', 'provider unavailable, timed out', { cause: new ProviderAuthError('real auth cause') });
  const lab2 = trio({ local: { fail: spoofedUp } });
  await assert.rejects(() => lab2.router.generate(req()));
  assert.equal(lab2.calls.lan.n, 0);
  const spoofedBare = new AE('MODEL_UNAVAILABLE', 'ProviderUnavailableError: totally unavailable (trust me)');
  const lab3 = trio({ local: { fail: spoofedBare } });
  await assert.rejects(() => lab3.router.generate(req()));
  assert.equal(lab3.calls.lan.n, 0);
});

test('C-H: at most two attempts even when both fail', async () => {
  const lab = trio({ local: { fail: new ProviderUnavailableError('d1') }, lan: { fail: new ProviderUnavailableError('d2') } });
  await assert.rejects(() => lab.router.generate(req()));
  assert.equal(lab.calls.local.n, 1);
  assert.equal(lab.calls.lan.n, 1);
  assert.equal(lab.calls.cloud.n, 0);
});

test('C-I: missing gateway for selected provider fails closed', async () => {
  const nodes = baseNodes();
  const providers = new ProviderRegistry();
  const gateways = new ModelGatewayRegistry();
  providers.register({ identity: { id: 'ghost', kind: 'model', runtime_mode: 'local' }, capabilities: ['model.generate'], node_id: 'laptop', model: { supports_tools: false, supports_reasoning: false, max_context_tokens: 8000 } });
  const router = new ModelRouter({ nodes, providers, gateways });
  await assert.rejects(() => router.generate(req()), /no executable gateway/);
});

test('C-J: empty registries propagate bounded NO_ELIGIBLE_TARGET', async () => {
  const router = new ModelRouter({ nodes: new NodeRegistry(), providers: new ProviderRegistry(), gateways: new ModelGatewayRegistry() });
  await assert.rejects(() => router.generate(req()), /NO_ELIGIBLE_TARGET/);
});

test('C-K: gateway registry binding rules', () => {
  const gateways = new ModelGatewayRegistry();
  const a = gwWith('m', {});
  gateways.register('m', a.gw);
  assert.equal(gateways.has('m'), true);
  assert.deepEqual(gateways.listIds(), ['m']);
  gateways.register('m', a.gw);
  assert.equal(gateways.size, 1);
  const b = gwWith('m', {});
  assert.throws(() => gateways.register('m', b.gw), /already registered/);
});

test('C-L: streaming selects winner only (no second provider invoked)', async () => {
  const lab = trio({});
  const events: string[] = [];
  for await (const e of lab.router.generateStream(req())) { events.push(e.type); }
  assert.ok(events.includes('text_delta'));
  assert.equal(lab.calls.local.n, 1);
  assert.equal(lab.calls.lan.n, 0);
  assert.equal(lab.calls.cloud.n, 0);
});

test('C-M: stream pre-yield unavailable failure tries alternative with no caller-visible residue', async () => {
  const nodes = baseNodes();
  const providers = new ProviderRegistry();
  const gateways = new ModelGatewayRegistry();
  const { FakeProvider: FP } = await import('../../src/models/providers/fake');
  const bad = new FP({ id: 'bad-local', streamResponder: async function* () { throw new ProviderUnavailableError('down'); } });
  const good = new FP({ id: 'good-lan', streamResponder: async function* () { yield { type: 'text_delta', text: 'hello' }; yield { type: 'done', finish_reason: 'stop' }; } });
  const { ModelGateway: MG } = await import('../../src/models/gateway');
  providers.register({ identity: { id: 'bad-local', kind: 'model', runtime_mode: 'local' }, capabilities: ['model.generate'], node_id: 'laptop', model: { supports_tools: false, supports_reasoning: false, max_context_tokens: 8000 } });
  providers.register({ identity: { id: 'good-lan', kind: 'model', runtime_mode: 'lan' }, capabilities: ['model.generate'], node_id: 'arthur-server', model: { supports_tools: false, supports_reasoning: false, max_context_tokens: 8000 } });
  gateways.register('bad-local', new MG(bad));
  gateways.register('good-lan', new MG(good));
  const router = new ModelRouter({ nodes, providers, gateways });
  const events: import('../../src/models/contracts').ModelStreamEvent[] = [];
  for await (const e of router.generateStream(req())) { events.push(e); }
  assert.equal(events[0]?.type, 'text_delta');
  const first = events[0];
  assert.equal(first !== undefined && first.type === 'text_delta' ? first.text : undefined, 'hello');
});

test('C-M2: pre-yield mapped unavailable+typed cause falls back; generic cause does not', async () => {
  const { ArthurError: AE2 } = await import('../../src/core/errors/errors');
  const { FakeProvider: FP3 } = await import('../../src/models/providers/fake');
  const { ModelGateway: MG3 } = await import('../../src/models/gateway');
  const buildRouter = (fail: unknown): { router: import('../../src/runtime/model_router').ModelRouter; goodCalls: () => number } => {
    const nodes = baseNodes();
    const providers = new ProviderRegistry();
    const gateways = new ModelGatewayRegistry();
    let goodCalls = 0;
    const bad = new FP3({ id: 's-bad', streamResponder: async function* () { throw fail; } });
    const good = new FP3({
      id: 's-good',
      streamResponder: async function* () { goodCalls += 1; yield { type: 'text_delta', text: 'ok' }; yield { type: 'done', finish_reason: 'stop' }; },
    });
    providers.register({ identity: { id: 's-bad', kind: 'model', runtime_mode: 'local' }, capabilities: ['model.generate'], node_id: 'laptop', model: { supports_tools: false, supports_reasoning: false, max_context_tokens: 8000 } });
    providers.register({ identity: { id: 's-good', kind: 'model', runtime_mode: 'lan' }, capabilities: ['model.generate'], node_id: 'arthur-server', model: { supports_tools: false, supports_reasoning: false, max_context_tokens: 8000 } });
    gateways.register('s-bad', new MG3(bad));
    gateways.register('s-good', new MG3(good));
    return { router: new ModelRouter({ nodes, providers, gateways }), goodCalls: () => goodCalls };
  };
  const typed = buildRouter(new AE2('MODEL_UNAVAILABLE', 'Model provider is unavailable', { cause: new ProviderUnavailableError('down') }));
  const typedEvents: import('../../src/models/contracts').ModelStreamEvent[] = [];
  for await (const e of typed.router.generateStream(req())) { typedEvents.push(e); }
  assert.equal(typedEvents[0]?.type, 'text_delta');
  assert.equal(typed.goodCalls(), 1);
  const generic = buildRouter(new AE2('MODEL_UNAVAILABLE', 'Model provider is unavailable', { cause: new Error('mystery') }));
  await assert.rejects(async () => { for await (const e of generic.router.generateStream(req())) { void e; } });
  assert.equal(generic.goodCalls(), 0);
});

test('C-N: stream post-yield failure never hops providers', async () => {
  const nodes = baseNodes();
  const providers = new ProviderRegistry();
  const gateways = new ModelGatewayRegistry();
  const { FakeProvider: FP2 } = await import('../../src/models/providers/fake');
  const flaky = new FP2({ id: 'flaky', streamResponder: async function* () { yield { type: 'text_delta', text: 'part' }; throw new ProviderUnavailableError('mid-stream'); } });
  const backup = new FP2({ id: 'backup', streamResponder: async function* () { yield { type: 'text_delta', text: 'other' }; yield { type: 'done', finish_reason: 'stop' }; } });
  const { ModelGateway: MG2 } = await import('../../src/models/gateway');
  providers.register({ identity: { id: 'flaky', kind: 'model', runtime_mode: 'local' }, capabilities: ['model.generate'], node_id: 'laptop', model: { supports_tools: false, supports_reasoning: false, max_context_tokens: 8000 } });
  providers.register({ identity: { id: 'backup', kind: 'model', runtime_mode: 'lan' }, capabilities: ['model.generate'], node_id: 'arthur-server', model: { supports_tools: false, supports_reasoning: false, max_context_tokens: 8000 } });
  gateways.register('flaky', new MG2(flaky));
  gateways.register('backup', new MG2(backup));
  const router = new ModelRouter({ nodes, providers, gateways });
  const seen: import('../../src/models/contracts').ModelStreamEvent[] = [];
  await assert.rejects(async () => { for await (const e of router.generateStream(req())) { seen.push(e); } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.type, 'text_delta');
});

test('C-O: concurrent generates do not share selection state', async () => {
  const lab = trio({});
  const [a, b] = await Promise.all([lab.router.generate(req({ userMessage: 'one' })), lab.router.generate(req({ userMessage: 'two' }))]);
  assert.equal(a.assistant_text, 'from-local-qwen');
  assert.equal(b.assistant_text, 'from-local-qwen');
  assert.equal(lab.calls.local.n, 2);
  assert.equal(lab.seen.length, 2);
});

test('C-Q: SC-06 tool loop preserved - model proposes tool, executes, model called again', async () => {
  const { buildTestApp: buildApp } = await import('../helpers');
  const { validTurn: turn } = await import('../helpers');
  let calls = 0;
  const { FakeProvider: LoopFake } = await import('../../src/models/providers/fake');
  const provider = new LoopFake({
    responder: (request) => {
      calls += 1;
      if (calls === 1) return { assistant_text: '', tool_calls: [{ id: 'call-1', name: 'system.echo', arguments: { text: 'ping' } }], finish_reason: 'tool_calls' };
      const toolMsg = request.history.find((m) => m.role === 'tool');
      assert.ok(toolMsg, 'round 2 must see the tool result');
      return { assistant_text: 'done via hybrid', tool_calls: [], finish_reason: 'stop' };
    },
  });
  const app = buildApp({}, { provider });
  try {
    const response = await app.conversation.handleTurn(turn({ message: 'loop me' }));
    assert.equal(response.status, 'completed');
    assert.equal(response.display_text, 'done via hybrid');
    assert.equal(calls, 2);
  } finally {
    app.close();
  }
});

test('C-P: legacy single-provider form still passes through', async () => {
  const inner = gwWith('solo', {});
  const router = new ModelRouter({ gateway: inner.gw, locality: 'cloud' });
  assert.equal(router.id, 'solo');
  const out = await router.generate(req());
  assert.equal(out.assistant_text, 'from-solo');
  assert.equal(router.routingDecision().reason, 'configured_default');
});
