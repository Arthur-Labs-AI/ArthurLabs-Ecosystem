/**
 * HR-03B: deterministic hybrid routing policy tests (matrix A-L).
 *
 * Pure and synchronous: registries are in-memory, the engine performs no
 * I/O, and every decision is asserted on ids/reasons/order only. The
 * task examples (tools-capable server-qwen vs deepseek, local_only
 * exclusion, phone-local tool routing) are covered verbatim.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HybridRegistryError,
  HybridRoutingEngine,
  isNoEligibleTargetError,
  NodeRegistry,
  NO_ELIGIBLE_TARGET,
  normalizeRoutingRequest,
  NoEligibleTargetError,
  ProviderRegistry,
  type ArthurNodeDescriptor,
  type RoutingRequest,
  type RuntimeProviderDescriptor,
} from '../../src/runtime/hybrid/index';
import { ModelRouter } from '../../src/runtime/model_router';

function node(id: string, mode: 'local' | 'lan', opts: { status?: 'ready' | 'busy' | 'unavailable'; tools?: string[]; caps?: string[]; role?: ArthurNodeDescriptor['role'] } = {}): ArthurNodeDescriptor {
  return {
    id,
    role: opts.role ?? (mode === 'local' ? 'laptop' : 'server'),
    runtime_mode: mode,
    platform: mode === 'local' ? 'linux' : 'linux',
    runtime_capabilities: (opts.caps ?? ['model.generate', 'tool.local']) as never,
    tool_ids: opts.tools ?? [],
  };
}

function registerNode(reg: NodeRegistry, id: string, mode: 'local' | 'lan', opts: { status?: 'ready' | 'busy' | 'unavailable'; tools?: string[]; caps?: string[] } = {}): void {
  reg.register(node(id, mode, opts), { status: opts.status ?? 'ready', active_jobs: 0, last_seen_at_ms: 1 });
}

function modelProvider(id: string, mode: 'local' | 'lan' | 'cloud', opts: { nodeId?: string; caps?: string[]; tools?: boolean; ctx?: number } = {}): RuntimeProviderDescriptor {
  const caps = opts.caps ?? (opts.tools === true ? ['model.generate', 'model.tools'] : ['model.generate']);
  const out: RuntimeProviderDescriptor = {
    identity: { id, kind: 'model', runtime_mode: mode },
    capabilities: caps as never,
  };
  if (opts.nodeId !== undefined) (out as { node_id?: string }).node_id = opts.nodeId;
  if (opts.tools !== undefined || opts.ctx !== undefined) {
    (out as { model?: unknown }).model = { supports_tools: opts.tools ?? false, supports_reasoning: false, max_context_tokens: opts.ctx ?? 8000 };
  }
  return out;
}

function speechProvider(id: string, kind: 'stt' | 'tts', mode: 'local' | 'lan' | 'cloud', nodeId?: string): RuntimeProviderDescriptor {
  const out: RuntimeProviderDescriptor = {
    identity: { id, kind, runtime_mode: mode },
    capabilities: [kind === 'stt' ? 'speech.transcribe' : 'speech.synthesize'] as never,
  };
  if (nodeId !== undefined) (out as { node_id?: string }).node_id = nodeId;
  return out;
}

function lab(): { nodes: NodeRegistry; providers: ProviderRegistry } {
  const nodes = new NodeRegistry();
  registerNode(nodes, 'laptop', 'local');
  registerNode(nodes, 'arthur-server', 'lan');
  const providers = new ProviderRegistry();
  return { nodes, providers };
}

function modelReq(overrides: Record<string, unknown> = {}): RoutingRequest {
  return {
    operation: 'model.generate',
    required_capabilities: ['model.generate'],
    data_locality: 'cloud_allowed',
    ...overrides,
  } as RoutingRequest;
}

// ---- request evolution: tool_id -------------------------------------------------------

test('REQ: tool.execute requires tool_id; other operations reject it', () => {
  const ok = normalizeRoutingRequest({ operation: 'tool.execute', required_capabilities: [], data_locality: 'local_only', constraints: { tool_id: ' app.open ' } });
  assert.equal(ok.constraints?.tool_id, 'app.open');
  assert.throws(() => normalizeRoutingRequest({ operation: 'tool.execute', required_capabilities: [], data_locality: 'local_only' }), /constraints\.tool_id/);
  assert.throws(() => normalizeRoutingRequest({ operation: 'model.generate', required_capabilities: [], data_locality: 'local_only', constraints: { tool_id: 'app.open' } }), /only valid for tool.execute/);
  assert.throws(() => normalizeRoutingRequest({ operation: 'tool.execute', required_capabilities: [], data_locality: 'local_only', constraints: { tool_id: 'bad\u0001id' } }), /control/);
});

// ---- A. model hard filters -----------------------------------------------------------------

test('A1: task example - tools filter + local-first policy picks server-qwen', () => {
  const { nodes, providers } = lab();
  providers.register(modelProvider('local-small', 'local', { nodeId: 'laptop', caps: ['model.generate'], tools: false, ctx: 8000 }));
  providers.register(modelProvider('server-qwen', 'lan', { nodeId: 'arthur-server', caps: ['model.generate', 'model.tools'], tools: true, ctx: 64000 }));
  providers.register(modelProvider('deepseek', 'cloud', { caps: ['model.generate', 'model.tools'], tools: true, ctx: 64000 }));
  const engine = new HybridRoutingEngine({ nodes, providers });
  const d = engine.route(modelReq({ required_capabilities: ['model.generate', 'model.tools'], constraints: { needs_tools: true } }));
  assert.equal(d.target_provider_id, 'server-qwen');
  assert.deepEqual(d.alternatives, ['deepseek']);
  assert.equal(d.reason, 'lan_preferred');
});

test('A2: local_only with tools-needing request and incapable local => NO_ELIGIBLE_TARGET, cloud never alternative', () => {
  const { nodes, providers } = lab();
  providers.register(modelProvider('local-small', 'local', { nodeId: 'laptop', caps: ['model.generate'], tools: false, ctx: 8000 }));
  providers.register(modelProvider('deepseek', 'cloud', { caps: ['model.generate', 'model.tools'], tools: true, ctx: 64000 }));
  const engine = new HybridRoutingEngine({ nodes, providers });
  assert.throws(() => engine.route(modelReq({ required_capabilities: ['model.generate', 'model.tools'], data_locality: 'local_only', constraints: { needs_tools: true } })), (e: unknown) => {
    assert.ok(isNoEligibleTargetError(e));
    assert.equal((e as Error).message.split(':')[0], NO_ELIGIBLE_TARGET);
    assert.ok(!(e as NoEligibleTargetError).rejections.some((r) => r.candidate === 'deepseek' && r.reason !== 'DATA_LOCALITY_BLOCKED'));
    return true;
  });
});

test('A3: kind/capability/binding/context/metadata filters are hard', () => {
  const { nodes, providers } = lab();
  providers.register(speechProvider('parakeet', 'stt', 'local', 'laptop'));
  providers.register(modelProvider('ctx-small', 'local', { nodeId: 'laptop', tools: false, ctx: 4000 }));
  providers.register(modelProvider('orphan', 'lan', { nodeId: 'ghost-node', tools: false, ctx: 64000 }));
  providers.register(modelProvider('misplaced', 'lan', { nodeId: 'laptop', tools: false, ctx: 64000 }));
  const engine = new HybridRoutingEngine({ nodes, providers });
  const rejected = (req: RoutingRequest): string[] => engine.explain(req).rejections.map((r) => r.candidate + ':' + r.reason);
  assert.ok(rejected(modelReq()).some((s) => s === 'parakeet:KIND_MISMATCH'));
  assert.ok(rejected(modelReq({ required_capabilities: ['model.generate', 'model.tools'] })).some((s) => s === 'ctx-small:CAPABILITY_MISSING'));
  assert.ok(rejected(modelReq({ constraints: { min_context_tokens: 32000 } })).some((s) => s === 'ctx-small:CONTEXT_TOO_SMALL'));
  assert.ok(rejected(modelReq({ constraints: { min_context_tokens: 100 } })).some((s) => s === 'orphan:NODE_BINDING_INVALID'));
  assert.ok(rejected(modelReq()).some((s) => s === 'misplaced:PROVIDER_NODE_LOCALITY_MISMATCH'));
  const nodes2 = new NodeRegistry();
  registerNode(nodes2, 'laptop', 'local', { status: 'unavailable' });
  const providers2 = new ProviderRegistry();
  providers2.register(modelProvider('down-model', 'local', { nodeId: 'laptop' }));
  assert.throws(() => new HybridRoutingEngine({ nodes: nodes2, providers: providers2 }).route(modelReq()), /NO_ELIGIBLE_TARGET/);
});

// ---- B. speech -----------------------------------------------------------------------------------

test('B1: STT selects stt only; TTS selects tts only; locality enforced', () => {
  const { nodes, providers } = lab();
  providers.register(speechProvider('parakeet', 'stt', 'local', 'laptop'));
  providers.register(speechProvider('cloud-stt', 'stt', 'cloud'));
  providers.register(speechProvider('cloud-tts', 'tts', 'cloud'));
  const engine = new HybridRoutingEngine({ nodes, providers });
  const stt = engine.route({ operation: 'speech.transcribe', required_capabilities: ['speech.transcribe'], data_locality: 'cloud_allowed' });
  assert.equal(stt.target_provider_id, 'parakeet');
  const tts = engine.route({ operation: 'speech.synthesize', required_capabilities: ['speech.synthesize'], data_locality: 'cloud_allowed' });
  assert.equal(tts.target_provider_id, 'cloud-tts');
  const locked = engine.route({ operation: 'speech.transcribe', required_capabilities: ['speech.transcribe'], data_locality: 'local_only' });
  assert.equal(locked.target_provider_id, 'parakeet');
  assert.deepEqual(locked.alternatives, []);
});

// ---- C. tools --------------------------------------------------------------------------------------

test('C1: task example - phone-local wins app.open; missing/unavailable/locality/caps excluded', () => {
  const nodes = new NodeRegistry();
  registerNode(nodes, 'phone-local', 'local', { tools: ['app.open'] });
  registerNode(nodes, 'server-lan', 'lan', { tools: [] });
  const engine = new HybridRoutingEngine({ nodes, providers: new ProviderRegistry() });
  const d = engine.route({ operation: 'tool.execute', required_capabilities: [], data_locality: 'lan_or_local', constraints: { tool_id: 'app.open' } });
  assert.equal(d.target_node_id, 'phone-local');
  assert.equal(d.target_provider_id, undefined);
  assert.deepEqual(d.alternatives, []);
  const nodes2 = new NodeRegistry();
  registerNode(nodes2, 'down', 'local', { status: 'unavailable', tools: ['app.open'] });
  assert.throws(() => new HybridRoutingEngine({ nodes: nodes2, providers: new ProviderRegistry() }).route({ operation: 'tool.execute', required_capabilities: [], data_locality: 'local_only', constraints: { tool_id: 'app.open' } }), /NO_ELIGIBLE_TARGET/);
  const nodes3 = new NodeRegistry();
  registerNode(nodes3, 'lan-box', 'lan', { tools: ['app.open'] });
  assert.throws(() => new HybridRoutingEngine({ nodes: nodes3, providers: new ProviderRegistry() }).route({ operation: 'tool.execute', required_capabilities: [], data_locality: 'local_only', constraints: { tool_id: 'app.open' } }), /NO_ELIGIBLE_TARGET/);
  const nodes4 = new NodeRegistry();
  registerNode(nodes4, 'capless', 'local', { tools: ['app.open'], caps: [] });
  assert.throws(() => new HybridRoutingEngine({ nodes: nodes4, providers: new ProviderRegistry() }).route({ operation: 'tool.execute', required_capabilities: ['tool.local'], data_locality: 'local_only', constraints: { tool_id: 'app.open' } }), /NO_ELIGIBLE_TARGET/);
});

// ---- D. preferences -----------------------------------------------------------------------------------

test('D1: preferred ids boost eligible candidates but never bypass hard filters', () => {
  const { nodes, providers } = lab();
  providers.register(modelProvider('local-qwen', 'local', { nodeId: 'laptop', tools: true, ctx: 64000 }));
  providers.register(modelProvider('deepseek', 'cloud', { tools: true, ctx: 64000 }));
  const engine = new HybridRoutingEngine({ nodes, providers });
  const pref = engine.route(modelReq({ constraints: { needs_tools: true }, preferred_provider_id: 'deepseek' }));
  assert.equal(pref.target_provider_id, 'deepseek');
  assert.equal(pref.reason, 'preferred_provider');
  const locked = engine.route(modelReq({ data_locality: 'local_only', preferred_provider_id: 'deepseek' }));
  assert.equal(locked.target_provider_id, 'local-qwen');
  assert.equal(locked.reason, 'forced_local');
  assert.ok(!locked.alternatives.includes('deepseek'));
  const onlyCloud: { nodes: NodeRegistry; providers: ProviderRegistry } = (() => {
    const n = new NodeRegistry();
    registerNode(n, 'laptop', 'local');
    const p = new ProviderRegistry();
    p.register(modelProvider('deepseek', 'cloud', { tools: true, ctx: 64000 }));
    return { nodes: n, providers: p };
  })();
  try {
    new HybridRoutingEngine(onlyCloud).route(modelReq({ data_locality: 'local_only', preferred_provider_id: 'deepseek' }));
    assert.fail('cloud must stay excluded');
  } catch (e) {
    assert.ok(e instanceof NoEligibleTargetError);
    assert.ok((e as NoEligibleTargetError).rejections.some((r) => r.candidate === 'deepseek' && r.reason === 'DATA_LOCALITY_BLOCKED'));
  }
  const nodePref = engine.route(modelReq({ preferred_node_id: 'arthur-server' }));
  void nodePref;
  const sttNodes = new NodeRegistry();
  registerNode(sttNodes, 'laptop', 'local');
  const sttProviders = new ProviderRegistry();
  sttProviders.register(speechProvider('parakeet', 'stt', 'local', 'laptop'));
  sttProviders.register(speechProvider('cloud-stt', 'stt', 'cloud'));
  const cloudBoost = new HybridRoutingEngine({ nodes: sttNodes, providers: sttProviders }).route({ operation: 'speech.transcribe', required_capabilities: ['speech.transcribe'], data_locality: 'cloud_allowed', preferred_node_id: 'laptop' });
  assert.equal(cloudBoost.target_provider_id, 'parakeet');
  const unknownPref = engine.route(modelReq({ preferred_provider_id: 'ghost', preferred_node_id: 'ghost-node' }));
  assert.ok(['local-qwen', 'deepseek'].includes(unknownPref.target_provider_id as string));
});

// ---- E. busy/ready --------------------------------------------------------------------------------------

test('E1: ready beats busy (LAN-ready beats local-busy); busy stays eligible; all-busy deterministic', () => {
  const nodes = new NodeRegistry();
  registerNode(nodes, 'laptop', 'local', { status: 'busy' });
  registerNode(nodes, 'arthur-server', 'lan', { status: 'ready' });
  const providers = new ProviderRegistry();
  providers.register(modelProvider('local-qwen', 'local', { nodeId: 'laptop' }));
  providers.register(modelProvider('server-qwen', 'lan', { nodeId: 'arthur-server' }));
  const d = new HybridRoutingEngine({ nodes, providers }).route(modelReq());
  assert.equal(d.target_provider_id, 'server-qwen');
  assert.deepEqual(d.alternatives, ['local-qwen']);
  const busyOnly = new NodeRegistry();
  registerNode(busyOnly, 'laptop', 'local', { status: 'busy' });
  const busyProviders = new ProviderRegistry();
  busyProviders.register(modelProvider('solo', 'local', { nodeId: 'laptop' }));
  assert.equal(new HybridRoutingEngine({ nodes: busyOnly, providers: busyProviders }).route(modelReq()).target_provider_id, 'solo');
  const both = new NodeRegistry();
  registerNode(both, 'b-node', 'local', { status: 'busy' });
  registerNode(both, 'a-node', 'local', { status: 'busy' });
  const bothProviders = new ProviderRegistry();
  bothProviders.register(modelProvider('m-b', 'local', { nodeId: 'b-node' }));
  bothProviders.register(modelProvider('m-a', 'local', { nodeId: 'a-node' }));
  assert.equal(new HybridRoutingEngine({ nodes: both, providers: bothProviders }).route(modelReq()).target_provider_id, 'm-a');
});

test('E2: prefer_ready_over_busy=false removes readiness from ranking (local-busy beats lan-ready); unavailable still filtered; order stable', () => {
  const mkLab = (order: string[]): { nodes: NodeRegistry; providers: ProviderRegistry } => {
    const nodes = new NodeRegistry();
    registerNode(nodes, 'laptop', 'local', { status: 'busy' });
    registerNode(nodes, 'arthur-server', 'lan', { status: 'ready' });
    registerNode(nodes, 'dead', 'local', { status: 'unavailable' });
    const providers = new ProviderRegistry();
    for (const id of order) {
      if (id === 'local-qwen') providers.register(modelProvider('local-qwen', 'local', { nodeId: 'laptop' }));
      else if (id === 'server-qwen') providers.register(modelProvider('server-qwen', 'lan', { nodeId: 'arthur-server' }));
      else providers.register(modelProvider('dead-qwen', 'local', { nodeId: 'dead' }));
    }
    return { nodes, providers };
  };
  const req = modelReq();
  const flagged = mkLab(['local-qwen', 'server-qwen', 'dead-qwen']);
  const onTrue = new HybridRoutingEngine({ nodes: flagged.nodes, providers: flagged.providers }).route(req);
  assert.equal(onTrue.target_provider_id, 'server-qwen');
  assert.deepEqual(onTrue.alternatives, ['local-qwen']);
  const off = mkLab(['server-qwen', 'dead-qwen', 'local-qwen']);
  const onFalse = new HybridRoutingEngine({ nodes: off.nodes, providers: off.providers, policy: { runtime_preference: { default: ['local', 'lan', 'cloud'] }, prefer_ready_over_busy: false } }).route(req);
  assert.equal(onFalse.target_provider_id, 'local-qwen');
  assert.deepEqual(onFalse.alternatives, ['server-qwen']);
  assert.ok(!onFalse.alternatives.includes('dead-qwen'));
  const toolsOff = (() => {
    const nodes = new NodeRegistry();
    registerNode(nodes, 'phone', 'local', { status: 'busy', tools: ['app.open'] });
    registerNode(nodes, 'box', 'lan', { status: 'ready', tools: ['app.open'] });
    const engine = new HybridRoutingEngine({ nodes, providers: new ProviderRegistry(), policy: { runtime_preference: { default: ['local', 'lan', 'cloud'] }, prefer_ready_over_busy: false } });
    return engine.route({ operation: 'tool.execute', required_capabilities: [], data_locality: 'cloud_allowed', constraints: { tool_id: 'app.open' } });
  })();
  assert.equal(toolsOff.target_node_id, 'phone');
  assert.deepEqual(toolsOff.alternatives, ['box']);
});

// ---- F. runtime preference ---------------------------------------------------------------------------------

test('F1: default local>lan>cloud; lexical tie-break; reasoning profile selects preference list', () => {
  const { nodes, providers } = lab();
  providers.register(modelProvider('cloud-m', 'cloud'));
  providers.register(modelProvider('lan-m', 'lan', { nodeId: 'arthur-server' }));
  providers.register(modelProvider('local-m', 'local', { nodeId: 'laptop' }));
  const d = new HybridRoutingEngine({ nodes, providers }).route(modelReq());
  assert.equal(d.target_provider_id, 'local-m');
  assert.deepEqual(d.alternatives, ['lan-m', 'cloud-m']);
  assert.equal(d.reason, 'local_preferred');
  const nodes2 = new NodeRegistry();
  registerNode(nodes2, 'n2', 'local');
  registerNode(nodes2, 'n1', 'local');
  const providers2 = new ProviderRegistry();
  providers2.register(modelProvider('m-b', 'local', { nodeId: 'n2' }));
  providers2.register(modelProvider('m-a', 'local', { nodeId: 'n1' }));
  assert.equal(new HybridRoutingEngine({ nodes: nodes2, providers: providers2 }).route(modelReq()).target_provider_id, 'm-a');
  const custom = new HybridRoutingEngine({ nodes, providers, policy: { runtime_preference: { default: ['cloud', 'lan', 'local'] }, prefer_ready_over_busy: true } });
  assert.equal(custom.route(modelReq({ reasoning_profile: 'deep' })).target_provider_id, 'cloud-m');
});

// ---- G. alternatives --------------------------------------------------------------------------------------------

test('G1: alternatives are ranked eligible only (selected + filtered omitted, never re-sorted)', () => {
  const { nodes, providers } = lab();
  providers.register(modelProvider('local-small', 'local', { nodeId: 'laptop', tools: false, ctx: 8000 }));
  providers.register(modelProvider('server-qwen', 'lan', { nodeId: 'arthur-server', tools: true, ctx: 64000 }));
  providers.register(modelProvider('deepseek', 'cloud', { tools: true, ctx: 64000 }));
  const d = new HybridRoutingEngine({ nodes, providers }).route(modelReq({ required_capabilities: ['model.generate', 'model.tools'], constraints: { needs_tools: true } }));
  assert.equal(d.target_provider_id, 'server-qwen');
  assert.deepEqual(d.alternatives, ['deepseek']);
  assert.ok(!d.alternatives.includes('server-qwen'));
  assert.ok(!d.alternatives.includes('local-small'));
});

// ---- H. no target ----------------------------------------------------------------------------------------------------

test('H1: empty registry and all-filtered yield bounded NO_ELIGIBLE_TARGET', () => {
  const { nodes } = lab();
  assert.throws(() => new HybridRoutingEngine({ nodes, providers: new ProviderRegistry() }).route(modelReq()), (e: unknown) => e instanceof HybridRegistryError && e.message.startsWith(NO_ELIGIBLE_TARGET));
  const nodes2 = new NodeRegistry();
  assert.throws(() => new HybridRoutingEngine({ nodes: nodes2, providers: new ProviderRegistry() }).route({ operation: 'tool.execute', required_capabilities: [], data_locality: 'local_only', constraints: { tool_id: 'app.open' } }), /NO_ELIGIBLE_TARGET/);
});

// ---- I/J. determinism + snapshots ---------------------------------------------------------------------------------------

test('IJ1: insertion order irrelevant; repeated routes identical; post-register mutation safe; snapshot consistent', () => {
  const mkNodes = (): NodeRegistry => {
    const n = new NodeRegistry();
    registerNode(n, 'arthur-server', 'lan');
    registerNode(n, 'laptop', 'local');
    return n;
  };
  const mkProviders = (order: string[]): ProviderRegistry => {
    const p = new ProviderRegistry();
    for (const id of order) {
      if (id === 'deepseek') p.register(modelProvider('deepseek', 'cloud'));
      else if (id === 'server-qwen') p.register(modelProvider('server-qwen', 'lan', { nodeId: 'arthur-server' }));
      else p.register(modelProvider('local-qwen', 'local', { nodeId: 'laptop' }));
    }
    return p;
  };
  const e1 = new HybridRoutingEngine({ nodes: mkNodes(), providers: mkProviders(['deepseek', 'server-qwen', 'local-qwen']) });
  const e2 = new HybridRoutingEngine({ nodes: mkNodes(), providers: mkProviders(['local-qwen', 'deepseek', 'server-qwen']) });
  const req = modelReq();
  assert.deepEqual(e1.route(req), e2.route(req));
  assert.deepEqual(e1.route(req), e1.route(req));
  const nodes = mkNodes();
  const providers = mkProviders(['local-qwen']);
  const engine = new HybridRoutingEngine({ nodes, providers });
  const before = engine.route(req);
  assert.equal(before.target_provider_id, 'local-qwen');
  providers.register(modelProvider('deepseek', 'cloud'));
  const afterSameEngine = engine.route(req);
  assert.equal(afterSameEngine.target_provider_id, 'local-qwen');
  assert.deepEqual(afterSameEngine.alternatives, ['deepseek']);
  const snapNodes = mkNodes();
  const snapProviders = mkProviders(['local-qwen', 'server-qwen']);
  const snapEngine = new HybridRoutingEngine({ nodes: snapNodes, providers: snapProviders });
  snapNodes.updateState('laptop', { status: 'unavailable', active_jobs: 0, last_seen_at_ms: 2 });
  assert.equal(snapEngine.route(req).target_provider_id, 'server-qwen');
  const ex = snapEngine.explain(req);
  assert.ok(ex.rejections.some((r) => r.candidate === 'local-qwen' && r.reason === 'NODE_UNAVAILABLE'));
});

// ---- K. security regression --------------------------------------------------------------------------------------------------

test('K1: no ToolRegistry replacement, no execution, no SC-02/03 surface', async () => {
  const barrel = await import('../../src/runtime/hybrid/index');
  const keys = Object.keys(barrel as Record<string, unknown>);
  assert.ok(!keys.some((k) => /toolregistry|remote.*tool|approve|authorize|execut/i.test(k)));
  const { nodes, providers } = lab();
  providers.register(modelProvider('m', 'local', { nodeId: 'laptop' }));
  const engine = new HybridRoutingEngine({ nodes, providers });
  const d = engine.route(modelReq());
  assert.equal(typeof d.target_provider_id, 'string');
  assert.equal(nodes.get('laptop')?.state.active_jobs, 0);
});

// ---- L. legacy -----------------------------------------------------------------------------------------------------------------

test('L1: HR-01 ModelRouter still configured_default', () => {
  const fake = { id: 'deepseek', capabilities: () => ({ supportsTools: false }), generate: async () => ({ assistant_text: 'x', tool_calls: [] }) };
  assert.equal(new ModelRouter({ gateway: fake as never, locality: 'cloud' }).routingDecision().reason, 'configured_default');
});
