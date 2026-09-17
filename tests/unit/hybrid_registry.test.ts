/**
 * HR-03A: hybrid registry foundation tests (matrix A-I).
 *
 * Deterministic, in-memory only: no network, no persistence, no config,
 * no App/DB startup. Every registration conflict, normalization, and
 * binding rule is asserted through the public barrel surface.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  allowedRuntimeModesFor,
  HybridRegistryError,
  isBackwardCompatibleReason,
  NodeRegistry,
  normalizeHybridRoutingDecision,
  normalizeNodeDescriptor,
  normalizeProviderDescriptor,
  normalizeRoutingRequest,
  ProviderRegistry,
  runtimeModeAllowed,
  validateProviderNodeBinding,
  type ArthurNodeDescriptor,
  type RuntimeProviderDescriptor,
} from '../../src/runtime/hybrid/index';
import { ModelRouter } from '../../src/runtime/model_router';
import { configuredDefaultDecision } from '../../src/runtime/routing';

function localNode(overrides: Record<string, unknown> = {}): ArthurNodeDescriptor {
  return {
    id: 'desktop-3060ti',
    role: 'desktop',
    runtime_mode: 'local',
    platform: 'win32',
    runtime_capabilities: ['model.generate', 'speech.transcribe'],
    tool_ids: ['filesystem.read', 'system.info'],
    ...overrides,
  } as ArthurNodeDescriptor;
}

function lanNode(overrides: Record<string, unknown> = {}): ArthurNodeDescriptor {
  return {
    id: 'arthur-server',
    role: 'server',
    runtime_mode: 'lan',
    platform: 'linux',
    runtime_capabilities: ['model.generate', 'model.tools', 'tool.local'],
    tool_ids: ['filesystem.read'],
    ...overrides,
  } as ArthurNodeDescriptor;
}

function cloudModel(overrides: Record<string, unknown> = {}): RuntimeProviderDescriptor {
  return {
    identity: { id: 'deepseek-cloud', kind: 'model', runtime_mode: 'cloud' },
    capabilities: ['model.generate', 'model.tools'],
    model: { supports_tools: true, supports_reasoning: true, max_context_tokens: 64000 },
    ...overrides,
  } as RuntimeProviderDescriptor;
}

function localStt(nodeId = 'desktop-3060ti'): RuntimeProviderDescriptor {
  return {
    identity: { id: 'parakeet-local', kind: 'stt', runtime_mode: 'local' },
    capabilities: ['speech.transcribe'],
    node_id: nodeId,
  };
}

// ---- A. node descriptor ----------------------------------------------------------

test('A1: valid local and LAN nodes normalize deterministically', () => {
  const n = normalizeNodeDescriptor(localNode({ tool_ids: ['system.info', 'filesystem.read', 'filesystem.read'], runtime_capabilities: ['speech.transcribe', 'model.generate', 'model.generate'] }));
  assert.deepEqual(n.runtime_capabilities, ['model.generate', 'speech.transcribe']);
  assert.deepEqual(n.tool_ids, ['filesystem.read', 'system.info']);
  assert.equal(normalizeNodeDescriptor(lanNode()).runtime_mode, 'lan');
});

test('A2: cloud node rejected; control chars and bounds rejected', () => {
  assert.throws(() => normalizeNodeDescriptor(localNode({ runtime_mode: 'cloud' })), (e: unknown) => e instanceof HybridRegistryError && e.reason === 'INVALID_NODE_DESCRIPTOR');
  assert.throws(() => normalizeNodeDescriptor(localNode({ id: 'bad\u0001id' })), /control/);
  assert.throws(() => normalizeNodeDescriptor(localNode({ id: '  ' })), /non-empty/);
  assert.throws(() => normalizeNodeDescriptor(localNode({ id: 'x'.repeat(129) })), /exceeds/);
  assert.throws(() => normalizeNodeDescriptor(localNode({ role: 'toaster' })), /unknown node role/);
  assert.throws(() => normalizeNodeDescriptor(localNode({ runtime_capabilities: ['nope.cap'] })), /unknown runtime capability/);
});

test('A3: defensive copy - caller mutation cannot affect normalized output', () => {
  const caps = ['model.generate'];
  const tools = ['a.tool'];
  const n = normalizeNodeDescriptor(localNode({ runtime_capabilities: caps, tool_ids: tools }));
  (caps as string[]).push('speech.transcribe');
  (tools as string[]).push('b.tool');
  assert.deepEqual(n.runtime_capabilities, ['model.generate']);
  assert.deepEqual(n.tool_ids, ['a.tool']);
});

// ---- B. node registry ------------------------------------------------------------

test('B1: register/get/list order; idempotent same registration', () => {
  const reg = new NodeRegistry();
  reg.register(lanNode());
  reg.register(localNode());
  assert.deepEqual(reg.list().map((r) => r.descriptor.id), ['arthur-server', 'desktop-3060ti']);
  const again = reg.register(localNode());
  assert.equal(reg.size, 2);
  assert.equal(again.descriptor.id, 'desktop-3060ti');
  assert.equal(reg.has('desktop-3060ti'), true);
  assert.equal(reg.get('desktop-3060ti')?.state.status, 'ready');
});

test('B2: conflicting same-id registration fails closed; unknown update rejected', () => {
  const reg = new NodeRegistry();
  reg.register(localNode());
  assert.throws(() => reg.register(localNode({ platform: 'linux' })), (e: unknown) => e instanceof HybridRegistryError && e.reason === 'NODE_ID_CONFLICT');
  assert.throws(() => reg.updateState('ghost', { status: 'ready', active_jobs: 0, last_seen_at_ms: 1 }), (e: unknown) => e instanceof HybridRegistryError && e.reason === 'UNKNOWN_NODE');
  const updated = reg.updateState('desktop-3060ti', { status: 'busy', active_jobs: 2, last_seen_at_ms: 123 });
  assert.equal(updated.state.status, 'busy');
  assert.equal(updated.state.active_jobs, 2);
  assert.equal(reg.remove('desktop-3060ti'), true);
  assert.equal(reg.has('desktop-3060ti'), false);
});

test('B3: registry internals immune to caller mutation', () => {
  const reg = new NodeRegistry();
  const rec = reg.register(localNode());
  (rec.descriptor.tool_ids as string[]).push('evil.tool');
  rec.state.active_jobs = 99;
  assert.deepEqual(reg.get('desktop-3060ti')?.descriptor.tool_ids, ['filesystem.read', 'system.info']);
  assert.equal(reg.get('desktop-3060ti')?.state.active_jobs, 0);
});

// ---- C. node state ---------------------------------------------------------------

test('C1: ready/busy/unavailable accepted; negative jobs and bad timestamps rejected', () => {
  const reg = new NodeRegistry();
  reg.register(localNode());
  for (const status of ['ready', 'busy', 'unavailable'] as const) {
    assert.equal(reg.updateState('desktop-3060ti', { status, active_jobs: 0, last_seen_at_ms: 0 }).state.status, status);
  }
  assert.throws(() => reg.updateState('desktop-3060ti', { status: 'ready', active_jobs: -1, last_seen_at_ms: 0 }), /active_jobs/);
  assert.throws(() => reg.updateState('desktop-3060ti', { status: 'ready', active_jobs: 1.5, last_seen_at_ms: 0 }), /active_jobs/);
  assert.throws(() => reg.updateState('desktop-3060ti', { status: 'ready', active_jobs: 0, last_seen_at_ms: Number.NaN }), /last_seen/);
  assert.throws(() => reg.updateState('desktop-3060ti', { status: 'ready', active_jobs: 0, last_seen_at_ms: -5 }), /last_seen/);
  assert.throws(() => reg.updateState('desktop-3060ti', { status: 'napping', active_jobs: 0, last_seen_at_ms: 0 } as never), /unknown node status/);
});

// ---- D. provider descriptor --------------------------------------------------------

test('D1: cloud without node valid; cloud with node rejected; local/LAN without node rejected', () => {
  assert.equal(normalizeProviderDescriptor(cloudModel()).identity.runtime_mode, 'cloud');
  assert.throws(() => normalizeProviderDescriptor(cloudModel({ node_id: 'x' })), /must not bind a node/);
  assert.throws(() => normalizeProviderDescriptor({ identity: { id: 'q', kind: 'model', runtime_mode: 'local' }, capabilities: ['model.generate'] }), /requires a node_id/);
  assert.throws(() => normalizeProviderDescriptor({ identity: { id: 'q', kind: 'model', runtime_mode: 'lan' }, capabilities: ['model.generate'] }), /requires a node_id/);
});

test('D2: coherent STT/TTS/model accepted; mismatches rejected; metadata on STT/TTS rejected', () => {
  assert.equal(normalizeProviderDescriptor(localStt()).capabilities[0], 'speech.transcribe');
  assert.equal(normalizeProviderDescriptor({ identity: { id: 'o', kind: 'tts', runtime_mode: 'local' }, capabilities: ['speech.synthesize'], node_id: 'n' }).identity.kind, 'tts');
  assert.throws(() => normalizeProviderDescriptor({ identity: { id: 'bad-stt', kind: 'stt', runtime_mode: 'local' }, capabilities: ['model.generate'], node_id: 'n' }), /speech.transcribe/);
  assert.throws(() => normalizeProviderDescriptor({ identity: { id: 'bad-tts', kind: 'tts', runtime_mode: 'local' }, capabilities: ['speech.transcribe'], node_id: 'n' }), /speech.synthesize/);
  assert.throws(() => normalizeProviderDescriptor({ identity: { id: 'bare', kind: 'model', runtime_mode: 'cloud' }, capabilities: ['network.internet'] }), /model.generate/);
  assert.throws(() => normalizeProviderDescriptor({ identity: { id: 't', kind: 'model', runtime_mode: 'cloud' }, capabilities: ['model.generate'], model: { supports_tools: true, supports_reasoning: false, max_context_tokens: 100 } }), /model.tools/);
  assert.throws(() => normalizeProviderDescriptor({ ...localStt(), model: { supports_tools: false, supports_reasoning: false, max_context_tokens: 10 } }), /only valid for kind model/);
});

// ---- E. provider registry ------------------------------------------------------------

test('E1: deterministic order, kind/mode/capability queries, idempotent, conflicts, copies', () => {
  const reg = new ProviderRegistry();
  reg.register({ identity: { id: 'z-tts', kind: 'tts', runtime_mode: 'local' }, capabilities: ['speech.synthesize'], node_id: 'desktop-3060ti' });
  reg.register(cloudModel());
  reg.register(localStt());
  assert.deepEqual(reg.list().map((d) => d.identity.id), ['deepseek-cloud', 'parakeet-local', 'z-tts']);
  assert.deepEqual(reg.listByKind('model').map((d) => d.identity.id), ['deepseek-cloud']);
  assert.deepEqual(reg.listByRuntimeMode('local').map((d) => d.identity.id), ['parakeet-local', 'z-tts']);
  assert.deepEqual(reg.listByCapability('speech.transcribe').map((d) => d.identity.id), ['parakeet-local']);
  assert.equal(reg.size, 3);
  reg.register(localStt());
  assert.equal(reg.size, 3);
  assert.throws(() => reg.register({ identity: { id: 'parakeet-local', kind: 'tts', runtime_mode: 'local' }, capabilities: ['speech.synthesize'], node_id: 'desktop-3060ti' }), (e: unknown) => e instanceof HybridRegistryError && e.reason === 'PROVIDER_ID_CONFLICT');
  const got = reg.get('parakeet-local') as RuntimeProviderDescriptor;
  (got.capabilities as string[]).push('model.tools');
  assert.deepEqual(reg.get('parakeet-local')?.capabilities, ['speech.transcribe']);
  assert.equal(reg.has('parakeet-local'), true);
  assert.equal(reg.remove('parakeet-local'), true);
  assert.equal(reg.has('parakeet-local'), false);
});

// ---- F. cross-registry ------------------------------------------------------------------

test('F1: binding rules - local/local, lan/lan, cloud-none pass; missing/mismatch fail', () => {
  const nodes = new NodeRegistry();
  nodes.register(localNode());
  nodes.register(lanNode());
  assert.deepEqual(validateProviderNodeBinding(localStt(), nodes), { ok: true });
  assert.deepEqual(validateProviderNodeBinding({ identity: { id: 'qwen-server', kind: 'model', runtime_mode: 'lan' }, capabilities: ['model.generate'], node_id: 'arthur-server' }, nodes), { ok: true });
  assert.deepEqual(validateProviderNodeBinding(cloudModel(), nodes), { ok: true });
  assert.throws(() => validateProviderNodeBinding(localStt('ghost-node'), nodes), (e: unknown) => e instanceof HybridRegistryError && e.reason === 'UNKNOWN_NODE');
  assert.throws(() => validateProviderNodeBinding(localStt('arthur-server'), nodes), (e: unknown) => e instanceof HybridRegistryError && e.reason === 'PROVIDER_NODE_LOCALITY_MISMATCH');
  assert.throws(() => validateProviderNodeBinding({ identity: { id: 'q', kind: 'model', runtime_mode: 'lan' }, capabilities: ['model.generate'], node_id: 'desktop-3060ti' }, nodes), (e: unknown) => e instanceof HybridRegistryError && e.reason === 'PROVIDER_NODE_LOCALITY_MISMATCH');
});

// ---- G. privacy -------------------------------------------------------------------------------

test('G1: locality policy expands to exact mode sets; results are fresh copies', () => {
  assert.deepEqual([...allowedRuntimeModesFor('cloud_allowed')], ['cloud', 'lan', 'local']);
  assert.deepEqual([...allowedRuntimeModesFor('lan_or_local')], ['lan', 'local']);
  assert.deepEqual([...allowedRuntimeModesFor('local_only')], ['local']);
  const first = allowedRuntimeModesFor('local_only');
  (first as string[]).push('cloud');
  assert.deepEqual([...allowedRuntimeModesFor('local_only')], ['local']);
  assert.equal(runtimeModeAllowed('local_only', 'cloud'), false);
  assert.equal(runtimeModeAllowed('lan_or_local', 'local'), true);
  assert.equal(runtimeModeAllowed('cloud_allowed', 'lan'), true);
});

// ---- H. routing request/decision -------------------------------------------------------------------

test('H1: valid model request with tools + context normalizes; malformed rejected', () => {
  const req = normalizeRoutingRequest({
    operation: 'model.generate',
    required_capabilities: ['model.tools', 'model.generate', 'model.generate'],
    data_locality: 'lan_or_local',
    reasoning_profile: 'fast',
    session_id: ' sess-1 ',
    preferred_provider_id: 'qwen-local',
    constraints: { min_context_tokens: 32000, needs_tools: true },
  });
  assert.deepEqual(req.required_capabilities, ['model.generate', 'model.tools']);
  assert.equal(req.session_id, 'sess-1');
  assert.throws(() => normalizeRoutingRequest({ operation: 'warp.drive', required_capabilities: [], data_locality: 'local_only' } as never), /unknown routing operation/);
  assert.throws(() => normalizeRoutingRequest({ operation: 'model.generate', required_capabilities: ['nope'], data_locality: 'local_only' } as never), /unknown required capability/);
  assert.throws(() => normalizeRoutingRequest({ operation: 'model.generate', required_capabilities: [], data_locality: 'local_only', constraints: { min_context_tokens: 0 } }), /positive integer/);
  assert.throws(() => normalizeRoutingRequest({ operation: 'model.generate', required_capabilities: [], data_locality: 'local_only', preferred_node_id: '  ' }), /non-empty/);
});

test('H2: hybrid decision normalizes; extended reasons preserved; legacy reasons compatible', () => {
  const d = normalizeHybridRoutingDecision({
    operation: 'speech.transcribe',
    target_provider_id: ' parakeet-local ',
    target_node_id: 'desktop-3060ti',
    runtime_mode: 'local',
    reason: 'preferred_provider',
    alternatives: ['z-tts', 'a-mic'],
  });
  assert.equal(d.target_provider_id, 'parakeet-local');
  assert.deepEqual(d.alternatives, ['z-tts', 'a-mic']);
  assert.equal(isBackwardCompatibleReason('configured_default'), true);
  assert.equal(isBackwardCompatibleReason('preferred_provider'), false);
  assert.throws(() => normalizeHybridRoutingDecision({ operation: 'model.generate', runtime_mode: 'local', reason: 'vibes', alternatives: [] } as never), /unknown routing reason/);
});

test('H3: alternatives preserve ranked order; dedupe keeps first occurrence; invalid rejected; copies defensive', () => {
  const ranked = normalizeHybridRoutingDecision({
    operation: 'model.generate',
    runtime_mode: 'lan',
    reason: 'lan_preferred',
    alternatives: ['server-qwen', 'deepseek-cloud', 'server-qwen', 'phone-small'],
  });
  assert.deepEqual(ranked.alternatives, ['server-qwen', 'deepseek-cloud', 'phone-small']);
  (ranked.alternatives as string[]).push('evil-injected');
  const again = normalizeHybridRoutingDecision({
    operation: 'model.generate',
    runtime_mode: 'lan',
    reason: 'lan_preferred',
    alternatives: ['server-qwen', 'deepseek-cloud', 'phone-small'],
  });
  assert.deepEqual(again.alternatives, ['server-qwen', 'deepseek-cloud', 'phone-small']);
  assert.throws(() => normalizeHybridRoutingDecision({ operation: 'model.generate', runtime_mode: 'local', reason: 'fallback', alternatives: ['ok-id', 'bad\u0001id'] }), /invalid alternative id/);
  assert.throws(() => normalizeHybridRoutingDecision({ operation: 'model.generate', runtime_mode: 'local', reason: 'fallback', alternatives: ['ok-id', '  '] }), /invalid alternative id/);
  assert.throws(() => normalizeHybridRoutingDecision({ operation: 'model.generate', runtime_mode: 'local', reason: 'fallback', alternatives: 'nope' as never }), /must be an array/);
});

// ---- I. compatibility -------------------------------------------------------------------------------

test('I1: ModelRouter still emits configured_default; no route() engine exists', async () => {
  const fake = {
    id: 'deepseek',
    capabilities: () => ({ supportsTools: true }),
    generate: async () => ({ assistant_text: 'hi', tool_calls: [] }),
  };
  const router = new ModelRouter({ gateway: fake as never, locality: 'cloud' });
  assert.equal(router.routingDecision().reason, 'configured_default');
  assert.deepEqual(configuredDefaultDecision('deepseek', 'cloud'), { provider_id: 'deepseek', runtime_mode: 'cloud', reason: 'configured_default' });
  const barrel = await import('../../src/runtime/hybrid/index');
  assert.equal((barrel as Record<string, unknown>)['route'], undefined);
  assert.equal((barrel as Record<string, unknown>)['selectProvider'], undefined);
  assert.equal((barrel as Record<string, unknown>)['RemoteToolRegistry'], undefined);
  assert.equal((barrel as Record<string, unknown>)['ToolRegistry'], undefined);
});
