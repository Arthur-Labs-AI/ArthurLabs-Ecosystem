import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ModelGateway } from '../../src/models/gateway';
import { FakeProvider } from '../../src/models/providers/fake';
import { ProviderAuthError, ProviderBadResponseError, ProviderTimeoutError, ProviderUnavailableError } from '../../src/models/contracts';
import { ModelRouter } from '../../src/runtime/model_router';
import { NodeRegistry } from '../../src/runtime/hybrid/node_registry';
import { ProviderRegistry } from '../../src/runtime/hybrid/provider_registry';
import { ModelGatewayRegistry } from '../../src/runtime/hybrid/gateway_registry';
import { HybridRoutingEngine } from '../../src/runtime/hybrid/routing_engine';
import { createLanRuntimeHandler, type LanHttpRequest } from '../../src/runtime/hybrid/lan/server';
import { LanModelGateway, assertLanBaseUrl } from '../../src/runtime/hybrid/lan/client';
import { LanAuthenticationError, classifyServerError } from '../../src/runtime/hybrid/lan/errors';
import { tokensEqualConstantTime, extractBearerToken } from '../../src/runtime/hybrid/lan/auth';
import { ARTHUR_LAN_PROTOCOL_VERSION } from '../../src/runtime/hybrid/lan/protocol';

const TOKEN = 'test-runtime-token-0123456789abcdef';

function req(overrides: Record<string, unknown> = {}): import('../../src/models/contracts').ModelRequest {
  return { systemContract: 's', modeContract: 'm', history: [], toolSchemas: [], userMessage: 'hello lan', model: 'lan-model', reasoningProfile: 'fast', ...overrides } as import('../../src/models/contracts').ModelRequest;
}

interface LiveServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function serve(gateways: ModelGatewayRegistry, token: string): Promise<LiveServer> {
  const handler = createLanRuntimeHandler({ gateways, authToken: token });
  const server = http.createServer((incoming, outgoing) => {
    const chunks: Uint8Array[] = [];
    incoming.on('data', (c: Uint8Array) => { chunks.push(c); });
    incoming.on('end', () => {
      const oneShot = (async function* () { yield Buffer.concat(chunks); })();
      let peerAborted = false;
      const abortListeners: (() => void)[] = [];
      const fireAbort = (): void => { if (!peerAborted) { peerAborted = true; for (const fn of abortListeners.splice(0)) { try { fn(); } catch { /* listener best effort */ } } } };
      incoming.on('aborted', fireAbort);
      outgoing.on('close', () => { if (!outgoing.writableEnded) fireAbort(); });
      const lanReq: LanHttpRequest = {
        method: incoming.method ?? 'GET',
        url: incoming.url ?? '/',
        headers: incoming.headers as Record<string, string | string[] | undefined>,
        body: oneShot,
        get aborted(): boolean { return peerAborted || incoming.aborted; },
        onAborted: (fn: () => void) => { if (peerAborted || incoming.aborted) { try { fn(); } catch { /* immediate best effort */ } } else abortListeners.push(fn); },
      };
      const lanRes = {
        statusCode: 200,
        headers: {} as Record<string, string>,
        writeHead(status: number, headers: Record<string, string>): void { outgoing.writeHead(status, headers); },
        write(chunk: string): boolean { return outgoing.write(chunk); },
        end(body?: string): void { outgoing.end(body); },
        get ended(): boolean { return outgoing.writableEnded; },
      };
      void handler(lanReq, lanRes).catch(() => { try { outgoing.writeHead(500); outgoing.end('{"error":"x"}'); } catch { /* closed */ } });
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
  const addr = server.address() as AddressInfo;
  return { baseUrl: 'http://127.0.0.1:' + String(addr.port), close: () => new Promise<void>((resolve, reject) => { server.close((e) => { if (e) reject(e); else resolve(); }); }) };
}

function lanCaps(): import('../../src/models/contracts').ModelCapabilities {
  return { id: 'lan-model', modelName: 'lan-model', supportsTools: true, supportsReasoning: true, maxContextTokens: 64000, online: false };
}

function routedRouter(baseUrl: string, remoteId: string, extra?: { cloudText?: string }): { router: ModelRouter; cloudCalls: { n: number } } {
  const nodes = new NodeRegistry();
  nodes.register({ id: 'server-node', role: 'server', runtime_mode: 'lan', platform: 'linux', runtime_capabilities: ['model.generate', 'model.tools'], tool_ids: [] }, { status: 'ready', active_jobs: 0, last_seen_at_ms: 1 });
  nodes.register({ id: 'laptop', role: 'laptop', runtime_mode: 'local', platform: 'linux', runtime_capabilities: ['model.generate'], tool_ids: [] }, { status: 'ready', active_jobs: 0, last_seen_at_ms: 1 });
  const providers = new ProviderRegistry();
  providers.register({ identity: { id: remoteId, kind: 'model', runtime_mode: 'lan' }, capabilities: ['model.generate', 'model.tools'], node_id: 'server-node', model: { supports_tools: true, supports_reasoning: true, max_context_tokens: 64000 } });
  const gateways = new ModelGatewayRegistry();
  gateways.register(remoteId, new LanModelGateway({ providerId: remoteId, baseUrl, authToken: TOKEN, capabilities: lanCaps() }));
  const cloudCalls = { n: 0 };
  if (extra?.cloudText !== undefined) {
    const fake = new FakeProvider({ id: 'cloud-fake', responder: () => { cloudCalls.n += 1; return { assistant_text: extra.cloudText as string, tool_calls: [], finish_reason: 'stop' }; } });
    providers.register({ identity: { id: 'cloud-fake', kind: 'model', runtime_mode: 'cloud' }, capabilities: ['model.generate', 'model.tools'], model: { supports_tools: true, supports_reasoning: true, max_context_tokens: 64000 } });
    gateways.register('cloud-fake', new ModelGateway(fake));
  }
  const seen: unknown[] = [];
  const router = new ModelRouter({ nodes, providers, gateways, observer: { onAttempt: (i) => { seen.push(i); } } });
  void seen;
  return { router, cloudCalls };
}

test('D28: loopback buffered E2E through real HTTP', async () => {
  const serverGateways = new ModelGatewayRegistry();
  serverGateways.register('lan-model', new ModelGateway(new FakeProvider({ id: 'qwen-server', responder: () => ({ assistant_text: 'hello from lan', tool_calls: [], finish_reason: 'stop' }) })));
  const live = await serve(serverGateways, TOKEN);
  try {
    const { router } = routedRouter(live.baseUrl, 'lan-model');
    const out = await router.generate(req());
    assert.equal(out.assistant_text, 'hello from lan');
  } finally {
    await live.close();
  }
});

test('D29: tool-call round trip stays caller-side (remote proposes, caller executes)', async () => {
  const serverGateways = new ModelGatewayRegistry();
  serverGateways.register('lan-model', new ModelGateway(new FakeProvider({
    id: 'qwen-server',
    responder: () => ({ assistant_text: '', tool_calls: [{ id: 'call-1', name: 'system.echo', arguments: { text: 'ping' } }], finish_reason: 'tool_calls' }),
  })));
  const live = await serve(serverGateways, TOKEN);
  try {
    const { router } = routedRouter(live.baseUrl, 'lan-model');
    const out = await router.generate(req({ toolSchemas: [{ name: 'system.echo', description: 'echo', parameters: { type: 'object' } }] }));
    assert.equal(out.tool_calls.length, 1);
    assert.equal(out.tool_calls[0]?.name, 'system.echo');
    assert.deepEqual(out.tool_calls[0]?.arguments, { text: 'ping' });
  } finally {
    await live.close();
  }
});

test('D30: loopback streaming E2E preserves order, unicode, request matching', async () => {
  const serverGateways = new ModelGatewayRegistry();
  serverGateways.register('lan-model', new ModelGateway(new FakeProvider({
    id: 'qwen-server',
    streamResponder: async function* () {
      yield { type: 'text_delta', text: 'Здравей ' };
      yield { type: 'text_delta', text: 'свят 🌍' };
      yield { type: 'usage', usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 } };
      yield { type: 'done', finish_reason: 'stop' };
    },
  })));
  const live = await serve(serverGateways, TOKEN);
  try {
    const { router } = routedRouter(live.baseUrl, 'lan-model');
    const events: import('../../src/models/contracts').ModelStreamEvent[] = [];
    for await (const e of router.generateStream(req())) { events.push(e); }
    assert.deepEqual(events.map((e) => e.type), ['text_delta', 'text_delta', 'usage', 'done']);
    const first = events[0];
    assert.equal(first !== undefined && first.type === 'text_delta' ? first.text : undefined, 'Здравей ');
  } finally {
    await live.close();
  }
});

test('D31: pre-yield LAN failure falls back to cloud across the transport seam', async () => {
  const serverGateways = new ModelGatewayRegistry();
  serverGateways.register('lan-model', new ModelGateway(new FakeProvider({ id: 'qwen-server', responder: () => { throw new ProviderUnavailableError('host down'); } })));
  const live = await serve(serverGateways, TOKEN);
  try {
    const { router } = routedRouter(live.baseUrl, 'lan-model', { cloudText: 'from cloud' });
    const out = await router.generate(req());
    assert.equal(out.assistant_text, 'from cloud');
  } finally {
    await live.close();
  }
});

test('D32: post-yield LAN failure never hops to cloud', async () => {
  const serverGateways = new ModelGatewayRegistry();
  serverGateways.register('lan-model', new ModelGateway(new FakeProvider({
    id: 'qwen-server',
    streamResponder: async function* () {
      yield { type: 'text_delta', text: 'hello' };
      throw new ProviderUnavailableError('mid-stream');
    },
  })));
  const live = await serve(serverGateways, TOKEN);
  try {
    const { router, cloudCalls } = routedRouter(live.baseUrl, 'lan-model', { cloudText: 'from cloud' });
    const seen: import('../../src/models/contracts').ModelStreamEvent[] = [];
    await assert.rejects(async () => { for await (const e of router.generateStream(req())) { seen.push(e); } });
    assert.equal(seen.length, 1);
    assert.equal(cloudCalls.n, 0);
  } finally {
    await live.close();
  }
});

test('D33: auth - correct succeeds; missing/wrong give 401 without provider oracle; token never leaks', async () => {
  const serverGateways = new ModelGatewayRegistry();
  serverGateways.register('lan-model', new ModelGateway(new FakeProvider({ id: 'qwen-server', responder: () => ({ assistant_text: 'ok', tool_calls: [], finish_reason: 'stop' }) })));
  const live = await serve(serverGateways, TOKEN);
  try {
    const good = new LanModelGateway({ providerId: 'lan-model', baseUrl: live.baseUrl, authToken: TOKEN, capabilities: lanCaps() });
    assert.equal((await good.generate(req())).assistant_text, 'ok');
    const noToken = await fetch(live.baseUrl + '/v1/runtime/models/lan-model/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocol_version: ARTHUR_LAN_PROTOCOL_VERSION, request_id: 'r1', request: req() }) });
    assert.equal(noToken.status, 401);
    assert.ok(!(await noToken.text()).includes(TOKEN));
    const wrong = new LanModelGateway({ providerId: 'lan-model', baseUrl: live.baseUrl, authToken: 'wrong-token', capabilities: lanCaps() });
    await assert.rejects(() => wrong.generate(req()), (e) => e instanceof LanAuthenticationError);
    const unknownGood = await fetch(live.baseUrl + '/v1/runtime/models/nope/generate', { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ protocol_version: ARTHUR_LAN_PROTOCOL_VERSION, request_id: 'r2', request: req() }) });
    const unknownBad = await fetch(live.baseUrl + '/v1/runtime/models/nope/generate', { method: 'POST', headers: { authorization: 'Bearer wrong-token', 'content-type': 'application/json' }, body: JSON.stringify({ protocol_version: ARTHUR_LAN_PROTOCOL_VERSION, request_id: 'r3', request: req() }) });
    assert.equal(unknownGood.status, 404);
    assert.equal(unknownBad.status, 401);
    assert.throws(() => new LanModelGateway({ providerId: 'lan-model', baseUrl: 'http://192.168.1.10:8080', authToken: TOKEN, capabilities: lanCaps() }), /loopback-only/);
    assert.throws(() => new LanModelGateway({ providerId: 'lan-model', baseUrl: 'ftp://x/', authToken: TOKEN, capabilities: lanCaps() }), /scheme/);
    assert.throws(() => assertLanBaseUrl('http://user:pass@127.0.0.1:1/'), /credentials/);
  } finally {
    await live.close();
  }
});

test('D34: protocol rejects version/json/size/content mismatches', async () => {
  const serverGateways = new ModelGatewayRegistry();
  serverGateways.register('lan-model', new ModelGateway(new FakeProvider({ id: 'q', responder: () => ({ assistant_text: 'ok', tool_calls: [], finish_reason: 'stop' }) })));
  const live = await serve(serverGateways, TOKEN);
  const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> => fetch(live.baseUrl + '/v1/runtime/models/lan-model/generate', { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  try {
    assert.equal((await post({ protocol_version: 999, request_id: 'r', request: req() })).status, 400);
    assert.equal((await post('not-json{{{')).status, 400);
    assert.equal((await post({ protocol_version: 1, request_id: 'r', request: req() }, { 'content-type': 'text/plain' })).status, 400);
    assert.equal((await post({ protocol_version: 1, request_id: 'r', request: { bogus: true } })).status, 400);
    const gw = new LanModelGateway({ providerId: 'lan-model', baseUrl: live.baseUrl, authToken: TOKEN, capabilities: lanCaps() });
    await assert.rejects(() => gw.generate(req({ userMessage: 'x'.repeat(9 * 1024 * 1024) })), /.+/);
  } finally {
    await live.close();
  }
});

test('D35: typed error mapping across the real boundary (no message sniffing)', async () => {
  const mk = (fail: unknown): ModelGatewayRegistry => {
    const regs = new ModelGatewayRegistry();
    regs.register('lan-model', new ModelGateway(new FakeProvider({ id: 'q', responder: () => { throw fail; } })));
    return regs;
  };
  const cases: { fail: unknown; expect: new (...args: never[]) => Error }[] = [
    { fail: new ProviderTimeoutError('t'), expect: ProviderTimeoutError },
    { fail: new ProviderUnavailableError('u'), expect: ProviderUnavailableError },
    { fail: new ProviderAuthError('a'), expect: ProviderAuthError },
    { fail: new ProviderBadResponseError('b'), expect: ProviderBadResponseError },
    { fail: new Error('programmer bug'), expect: (await import('../../src/runtime/hybrid/lan/errors')).LanProtocolError },
  ];
  for (const c of cases) {
    const live = await serve(mk(c.fail), TOKEN);
    try {
      const gw = new LanModelGateway({ providerId: 'lan-model', baseUrl: live.baseUrl, authToken: TOKEN, capabilities: lanCaps() });
      await assert.rejects(() => gw.generate(req()), (e) => e instanceof (c.expect as new () => Error));
    } finally {
      await live.close();
    }
  }
  assert.equal(classifyServerError(new ProviderTimeoutError('x')), 'PROVIDER_TIMEOUT');
  assert.equal(classifyServerError(new Error('x')), 'INTERNAL_ERROR');
});

test('D36: auth helpers are constant-time and bearer-scoped', () => {
  assert.equal(tokensEqualConstantTime('abc', 'abc'), true);
  assert.equal(tokensEqualConstantTime('abc', 'abd'), false);
  assert.equal(tokensEqualConstantTime('', 'abc'), false);
  assert.equal(extractBearerToken('Bearer abc'), 'abc');
  assert.equal(extractBearerToken(undefined), undefined);
  assert.equal(extractBearerToken('Token abc'), undefined);
});

test('D37: client abort reaches the hosted gateway signal; no fallback-type remap', async () => {
  let observedSignal: AbortSignal | undefined;
  let observedAborted = false;
  const gate = new FakeProvider({
    id: 'blocking',
    streamResponder: async function* (_request, signal) {
      observedSignal = signal;
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted === true) { observedAborted = true; resolve(); return; }
        signal?.addEventListener('abort', () => { observedAborted = true; resolve(); }, { once: true });
        setTimeout(() => reject(new Error('remote gateway never observed abort')), 10000);
      });
    },
  });
  const serverGateways = new ModelGatewayRegistry();
  serverGateways.register('lan-model', new ModelGateway(gate));
  const live = await serve(serverGateways, TOKEN);
  try {
    const gw = new LanModelGateway({ providerId: 'lan-model', baseUrl: live.baseUrl, authToken: TOKEN, capabilities: lanCaps() });
    const controller = new AbortController();
    const reader = (async () => {
      try {
        for await (const event of gw.generateStream(req(), controller.signal)) { void event; }
      } catch (err) {
        return err;
      }
      return undefined;
    })();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(observedSignal !== undefined, 'hosted gateway must receive a signal');
    assert.equal(observedSignal?.aborted, false);
    controller.abort(new Error('caller cancelled'));
    const thrown = await reader;
    assert.ok(thrown instanceof Error, 'aborted stream must throw');
    assert.ok(!(thrown instanceof ProviderUnavailableError), 'cancellation must not remap to unavailable');
    assert.ok(!(thrown instanceof ProviderTimeoutError), 'cancellation must not remap to timeout');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(observedAborted, true);
  } finally {
    await live.close();
  }
});
