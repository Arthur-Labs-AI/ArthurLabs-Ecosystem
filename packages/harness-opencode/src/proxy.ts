import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { OpenCodeHarnessError } from './errors.js';

/**
 * In-process localhost auth proxy: the real provider credential never
 * leaves Sentry-owned memory.
 *
 * Problem: OpenCode SDKs require an API key, and every channel OpenCode
 * accepts it through (environment, auth.json, config) is readable by
 * model-controlled tools (same OS user, inherited env/files).
 *
 * Solution: OpenCode is pointed at this proxy (`baseURL:
 * http://127.0.0.1:<port>/v1`, dummy apiKey) while the proxy adds the
 * REAL credential server-side and relays the request UNCHANGED (same
 * protocol path, same body) upstream. The real key exists only in this
 * closure (heap, never environment/files/command lines/logs).
 *
 * Multi-protocol (fail-closed): OpenCode selects the wire protocol per
 * model (responses/chat-completions/messages); the proxy accepts exactly
 * those three route families, validates the model on each, and maps each
 * to its explicit upstream path. Anything else is rejected locally.
 *
 * Residual (documented): the proxy itself is reachable over loopback, so a
 * deliberately hostile tool could use it as a bounded oracle. Blast radius
 * is contained by: ephemeral per-run port, exact model+route allowlists,
 * loopback-only bind, lifetime tied to the AgentRun, and no body logging
 * (counts and statuses only in diagnostics).
 */

export const SENTRY_PROXY_DUMMY_KEY = 'sentry-managed-proxy-key' as const;
export const OPENROUTER_UPSTREAM_BASE_URL = 'https://openrouter.ai/api/v1' as const;

/** Explicitly supported wire protocols (never open path forwarding). */
export type OpenCodeProxyRoute = 'chat-completions' | 'responses' | 'messages';

export interface OpenCodeAuthProxy {
  /** Loopback base URL to configure as the provider baseURL. */
  readonly baseUrl: string;
  /** Requests relayed so far (diagnostic count only, never bodies). */
  relayedRequests(): number;
  /** Relayed requests per route (observed transport evidence). */
  relayedRoutes(): Record<OpenCodeProxyRoute, number>;
  close(): Promise<void>;
}

interface ProxyCounters {
  relayed: number;
  rejected: number;
  routes: Record<OpenCodeProxyRoute, number>;
}

const PROXY_ROUTES: Readonly<Record<string, OpenCodeProxyRoute>> = {
  '/v1/chat/completions': 'chat-completions',
  '/chat/completions': 'chat-completions',
  '/v1/responses': 'responses',
  '/responses': 'responses',
  '/v1/messages': 'messages',
  '/messages': 'messages',
};

const UPSTREAM_PATHS: Readonly<Record<OpenCodeProxyRoute, string>> = {
  'chat-completions': '/chat/completions',
  responses: '/responses',
  messages: '/messages',
};

/** Safe protocol-metadata headers forwarded from the client (allowlist). */
const FORWARDED_CLIENT_HEADERS = ['anthropic-version', 'anthropic-beta'] as const;

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

/** Client identity sent upstream (the Go gateway asks for a real user agent). */
export const SENTRY_PROXY_USER_AGENT = 'sentry-qa-opencode/0.1.0' as const;

export async function startOpenCodeAuthProxy(input: {
  readonly apiKey: string;
  readonly allowedModel: string;
  readonly upstreamBaseUrl?: string;
  /**
   * Stable per-conversation id relayed as `x-opencode-session` (required
   * by the Go gateway for routing/caching). The adapter passes the
   * AgentRun id: unique per run, stable across all its turns.
   */
  readonly sessionId: string;
}): Promise<OpenCodeAuthProxy> {
  // Fail closed: an empty key would relay as `Bearer ` and produce a
  // confusing upstream 401 instead of a clear credential error.
  if (input.apiKey.trim().length === 0) {
    throw new OpenCodeHarnessError(
      'OPENCODE_CREDENTIAL_MISSING',
      'Auth proxy requires a non-empty provider key.',
    );
  }
  const upstream = (input.upstreamBaseUrl ?? OPENROUTER_UPSTREAM_BASE_URL).replace(/\/+$/, '');
  const useTls = upstream.startsWith('https://');
  const counters: ProxyCounters = {
    relayed: 0,
    rejected: 0,
    routes: { 'chat-completions': 0, responses: 0, messages: 0 },
  };
  const sockets = new Set<import('node:net').Socket>();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
      sendJson(res, 200, { object: 'list', data: [{ id: input.allowedModel, object: 'model' }] });
      return;
    }
    const route = req.method === 'POST' ? PROXY_ROUTES[url] : undefined;
    if (route === undefined) {
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
      // The native provider SDK sends the provider-local model id
      // (`meta/muse-spark-1.3-contributor`), not the effective Sentry id
      // (`openrouter/meta/muse-spark-1.3-contributor`). Accept exactly the
      // allowed id in either form — nothing else.
      const allowed = new Set([input.allowedModel]);
      const slash = input.allowedModel.indexOf('/');
      if (slash >= 0) allowed.add(input.allowedModel.slice(slash + 1));
      if (typeof model !== 'string' || !allowed.has(model)) {
        counters.rejected += 1;
        sendJson(res, 403, errorEnvelope('Model not allowed through this proxy.'));
        return;
      }
      counters.relayed += 1;
      counters.routes[route] += 1;
      const target = new URL(upstream + UPSTREAM_PATHS[route]);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        // Real credential inserted ONLY here; the client's dummy values
        // (Authorization Bearer or x-api-key) are never forwarded.
        authorization: 'Bearer ' + input.apiKey,
        'x-api-key': input.apiKey,
        'HTTP-Referer': 'https://opencode.ai/',
        'X-Title': 'opencode',
        // Native client identity is preserved: OpenCode itself sends its
        // own session id + user agent (verified by capture against the real
        // binary), which the Go gateway recognizes. Fallbacks apply only
        // when the client omits them.
        'user-agent':
          typeof req.headers['user-agent'] === 'string' && req.headers['user-agent'].length > 0
            ? req.headers['user-agent']
            : SENTRY_PROXY_USER_AGENT,
        'x-opencode-session':
          typeof req.headers['x-opencode-session'] === 'string' &&
          req.headers['x-opencode-session'].length > 0
            ? req.headers['x-opencode-session']
            : input.sessionId,
      };
      // Protocol metadata the official SDKs require (allowlisted names
      // only; never credentials, cookies, or identity headers).
      for (const name of FORWARDED_CLIENT_HEADERS) {
        const value = req.headers[name];
        if (typeof value === 'string' && value.length > 0 && value.length <= 200) {
          headers[name] = value;
        }
      }
      const forward = (useTls ? httpsRequest : httpRequest)(
        {
          hostname: target.hostname,
          port: target.port || (useTls ? 443 : 80),
          path: target.pathname + target.search,
          method: 'POST',
          headers,
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
    relayedRoutes: () => ({ ...counters.routes }),
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
