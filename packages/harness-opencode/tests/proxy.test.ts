import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { SENTRY_PROXY_DUMMY_KEY, startOpenCodeAuthProxy } from '../src/index.js';

const FAKE_KEY = 'sentry-test-sentinel-credential';

describe('localhost auth proxy', () => {
  it('relays with the real key while the client only ever sees the dummy', async () => {
    const seen: Array<{
      url?: string;
      auth?: unknown;
      model?: unknown;
      session?: unknown;
      agent?: unknown;
    }> = [];
    const upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        seen.push({
          url: req.url,
          auth: req.headers['authorization'],
          model: (JSON.parse(body) as { model?: unknown }).model,
          session: req.headers['x-opencode-session'],
          agent: req.headers['user-agent'],
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [] }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const proxy = await startOpenCodeAuthProxy({
      apiKey: FAKE_KEY,
      allowedModel: 'openrouter/anthropic/x',
      upstreamBaseUrl: 'http://127.0.0.1:' + String(port) + '/v1',
      sessionId: 'arun_test_session_1',
    });
    try {
      expect(proxy.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      // Models endpoint is served locally without touching upstream.
      const models = await fetch(proxy.baseUrl + '/models').then((r) => r.json());
      expect(models).toMatchObject({ data: [{ id: 'openrouter/anthropic/x' }] });
      // Allowed model relays with the REAL key (never the dummy).
      const ok = await fetch(proxy.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + SENTRY_PROXY_DUMMY_KEY,
        },
        body: JSON.stringify({ model: 'openrouter/anthropic/x', messages: [] }),
      });
      expect(ok.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.auth).toBe('Bearer ' + FAKE_KEY);
      expect(seen[0]?.model).toBe('openrouter/anthropic/x');
      expect(seen[0]?.session).toBe('arun_test_session_1');
      // Native client identity is preserved, never overwritten.
      const native = await fetch(proxy.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-opencode-session': 'ses_native_1',
          'user-agent': 'opencode/1.18.32',
        },
        body: JSON.stringify({ model: 'openrouter/anthropic/x', messages: [] }),
      });
      expect(native.status).toBe(200);
      expect(seen[1]?.session).toBe('ses_native_1');
      expect(seen[1]?.agent).toBe('opencode/1.18.32');
      expect(typeof seen[0]?.agent === 'string' && (seen[0]?.agent as string).length > 0).toBe(
        true,
      );
      expect(proxy.relayedRequests()).toBe(2);
      // The provider-local id (what the native SDK actually sends) relays too.
      const local = await fetch(proxy.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'anthropic/x', messages: [] }),
      });
      expect(local.status).toBe(200);
      expect(seen).toHaveLength(3);
      expect(proxy.relayedRequests()).toBe(3);
      // Any other model is rejected before anything goes upstream.
      const denied = await fetch(proxy.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'evil/other', messages: [] }),
      });
      expect(denied.status).toBe(403);
      expect(seen).toHaveLength(3);
      // Unknown routes are rejected.
      const missing = await fetch(proxy.baseUrl + '/v1/secrets', { method: 'POST' });
      expect(missing.status).toBe(404);
    } finally {
      await proxy.close();
      upstream.close();
    }
  });

  it('maps responses and messages routes with strict allowlisting', async () => {
    const seen: Array<{ url?: string; model?: unknown; apiKey?: unknown; version?: unknown }> = [];
    const upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        seen.push({
          url: req.url,
          model: (JSON.parse(body) as { model?: unknown }).model,
          apiKey: req.headers['x-api-key'],
          version: req.headers['anthropic-version'],
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const proxy = await startOpenCodeAuthProxy({
      apiKey: FAKE_KEY,
      allowedModel: 'opencode-go/muse-spark-1.3-contributor',
      upstreamBaseUrl: 'http://127.0.0.1:' + String(port) + '/v1',
      sessionId: 'arun_test_session_2',
    });
    try {
      // Responses route maps explicitly (no open path forwarding).
      const responses = await fetch(proxy.baseUrl + '/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'muse-spark-1.3-contributor', input: 'hi' }),
      });
      expect(responses.status).toBe(200);
      // Messages route maps explicitly with real x-api-key + forwarded version.
      const messages = await fetch(proxy.baseUrl + '/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': SENTRY_PROXY_DUMMY_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model: 'muse-spark-1.3-contributor', messages: [] }),
      });
      expect(messages.status).toBe(200);
      expect(seen.map((s) => s.url)).toEqual(['/v1/responses', '/v1/messages']);
      expect(seen[1]?.apiKey).toBe(FAKE_KEY);
      expect(seen[1]?.version).toBe('2023-06-01');
      expect(proxy.relayedRoutes()).toMatchObject({
        responses: 1,
        messages: 1,
        'chat-completions': 0,
      });
      // Arbitrary routes never reach upstream.
      for (const path of ['/v1/files', '/v1/models/delete', '/admin', '/secrets']) {
        const rejected = await fetch(proxy.baseUrl + path, { method: 'POST' });
        expect(rejected.status).toBe(404);
      }
      expect(seen).toHaveLength(2);
      // Wrong model on a valid route is still rejected locally.
      const wrong = await fetch(proxy.baseUrl + '/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'evil/other', input: 'hi' }),
      });
      expect(wrong.status).toBe(403);
      expect(seen).toHaveLength(2);
    } finally {
      await proxy.close();
      upstream.close();
    }
  });
});
