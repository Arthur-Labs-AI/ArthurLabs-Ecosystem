import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

/**
 * In-process localhost auth proxy: the OpenRouter credential never leaves
 * Sentry-owned memory.
 *
 * Problem: OpenCode's native OpenRouter SDK requires an API key, and every
 * channel OpenCode accepts it through (environment, auth.json, config) is
 * readable by model-controlled tools (same OS user, inherited env/files).
 *
 * Solution: OpenCode is configured with the NATIVE OpenRouter SDK pointed
 * at this proxy (`baseURL: http://127.0.0.1:<port>/v1`, dummy apiKey) while
 * the proxy adds the REAL `Authorization: Bearer` server-side and relays
 * to OpenRouter. The real key exists only in this closure (heap, never
 * environment/files/command lines/logs). Stealing `auth.json`, scraping
 * the environment, or reading OpenCode config yields at most the dummy.
 *
 * Residual (documented): the proxy itself is reachable over loopback, so a
 * deliberately hostile tool could use it as a bounded oracle. Blast radius
 * is contained by: ephemeral per-run port, model allowlist (exact effective
 * id only), loopback-only bind, lifetime tied to the AgentRun, and no body
 * logging (counts and statuses only in diagnostics).
 */

export const SENTRY_PROXY_DUMMY_KEY = 'sentry-managed-proxy-key' as const;
export const OPENROUTER_UPSTREAM_BASE_URL = 'https://openrouter.ai/api/v1' as const;

export interface OpenCodeAuthProxy {
  /** Loopback base URL to configure as the provider baseURL. */
  readonly baseUrl: string;
  /** Requests relayed so far (diagnostic count only, never bodies). */
  relayedRequests(): number;
  close(): Promise<void>;
}

interface ProxyCounters {
  relayed: number;
  rejected: number;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function errorEnvelope(message: string): unknown {
  return { error: { message, type: 'sentry_proxy_error', code: 'proxy_rejected' } };
}

export async function startOpenCodeAuthProxy(input: {
  readonly apiKey: string;
  readonly allowedModel: string;
  readonly upstreamBaseUrl?: string;
}): Promise<OpenCodeAuthProxy> {
  const upstream = (input.upstreamBaseUrl ?? OPENROUTER_UPSTREAM_BASE_URL).replace(/\/+$/, '');
  const useTls = upstream.startsWith('https://');
  const counters: ProxyCounters = { relayed: 0, rejected: 0 };
  const sockets = new Set<import('node:net').Socket>();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
      sendJson(res, 200, { object: 'list', data: [{ id: input.allowedModel, object: 'model' }] });
      return;
    }
    if (req.method !== 'POST' || (url !== '/v1/chat/completions' && url !== '/chat/completions')) {
      counters.rejected += 1;
      sendJson(res, 404, errorEnvelope('Unknown proxy route.'));
      return;
    }
    // Model allowlist: read the request body to verify the exact model
    // before spending anything upstream.
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 10 * 1024 * 1024) {
        req.destroy();
      }
    });
    req.on('end', () => {
      let model: unknown;
      try {
        model = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: unknown }).model;
      } catch {
        counters.rejected += 1;
        sendJson(res, 400, errorEnvelope('Invalid proxy request body.'));
        return;
      }
      if (model !== input.allowedModel) {
        counters.rejected += 1;
        sendJson(res, 403, errorEnvelope('Model not allowed through this proxy.'));
        return;
      }
      counters.relayed += 1;
      const target = new URL(upstream + '/chat/completions');
      const forward = (useTls ? httpsRequest : httpRequest)(
        {
          hostname: target.hostname,
          port: target.port || (useTls ? 443 : 80),
          path: target.pathname + target.search,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + input.apiKey,
            'HTTP-Referer': 'https://opencode.ai/',
            'X-Title': 'opencode',
          },
        },
        (upstreamRes) => {
          res.writeHead(
            upstreamRes.statusCode ?? 502,
            upstreamRes.headers as Record<string, string>,
          );
          upstreamRes.pipe(res);
        },
      );
      forward.on('error', () => {
        if (!res.headersSent) sendJson(res, 502, errorEnvelope('Upstream provider unreachable.'));
        else res.end();
      });
      forward.on('timeout', () => forward.destroy());
      forward.setTimeout(300_000);
      forward.end(Buffer.concat(chunks));
    });
    req.on('error', () => {
      try {
        res.end();
      } catch {
        // Client already gone.
      }
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    baseUrl: 'http://127.0.0.1:' + String(port) + '/v1',
    relayedRequests: () => counters.relayed,
    close: async () => {
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {
          // Already gone.
        }
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        setTimeout(resolve, 2000).unref?.();
      });
    },
  };
}
