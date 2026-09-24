import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { SENTRY_PROXY_DUMMY_KEY, startOpenCodeAuthProxy } from '../src/index.js';

const FAKE_KEY = 'sentry-test-sentinel-credential';

describe('localhost auth proxy', () => {
  it('relays with the real key while the client only ever sees the dummy', async () => {
    const seen: Array<{ url?: string; auth?: unknown; model?: unknown }> = [];
    const upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        seen.push({
          url: req.url,
          auth: req.headers['authorization'],
          model: (JSON.parse(body) as { model?: unknown }).model,
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
      expect(proxy.relayedRequests()).toBe(1);
      // The provider-local id (what the native SDK actually sends) relays too.
      const local = await fetch(proxy.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'anthropic/x', messages: [] }),
      });
      expect(local.status).toBe(200);
      expect(seen).toHaveLength(2);
      expect(proxy.relayedRequests()).toBe(2);
      // Any other model is rejected before anything goes upstream.
      const denied = await fetch(proxy.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'evil/other', messages: [] }),
      });
      expect(denied.status).toBe(403);
      expect(seen).toHaveLength(2);
      // Unknown routes are rejected.
      const missing = await fetch(proxy.baseUrl + '/v1/secrets', { method: 'POST' });
      expect(missing.status).toBe(404);
    } finally {
      await proxy.close();
      upstream.close();
    }
  });
});
