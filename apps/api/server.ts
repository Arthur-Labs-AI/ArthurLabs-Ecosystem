/**
 * HTTP API entry point (spec section 13).
 *
 * Exposes the same core services the CLI uses. Versioned routes, stable
 * machine-readable error codes, localhost bind by default, and no secret
 * exposure.
 */

import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";

import { buildApp } from "../../src/app";
import { ArthurError, sanitizePublicError, unsupportedMediaType } from "../../src/core/errors/errors";
import { isSecretLikeKey } from "../../src/security/redaction";
import { SecretSanitizer } from "../../src/security/sanitize";
import { parseRouteIdentifier } from "../../src/core/conversation/validation";
import { loadDotEnv } from "../../src/config/settings";
import { newTraceId } from "../../src/observability/tracing";
import {
  parseDocumentBody,
  parseListParams,
  parseQueryParams,
  parseRememberBody,
  parseSearchBody,
  parseTypeLabel,
} from "../../src/memory/api";
import type { App } from "../../src/app";

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

function startupSanitizer(): SecretSanitizer {
  return new SecretSanitizer(
    Object.entries(process.env)
      .filter(([key, value]) => isSecretLikeKey(key) && Boolean(value))
      .map(([, value]) => value as string),
  );
}

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(app: App, res: ServerResponse, err: unknown): void {
  const publicError = app.sanitizePublicError(err);
  sendJson(res, publicError.status, publicError.body);
}

function requireJsonMediaType(req: IncomingMessage): void {
  const mediaType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mediaType || (mediaType !== "application/json" && !/^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType))) {
    throw unsupportedMediaType();
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ArthurError("INVALID_REQUEST", "Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ArthurError("INVALID_REQUEST", "Request body is not valid JSON"));
      }
    });
    req.on("error", (err) => reject(err));
  });
}

function parsePath(url: string | undefined): string[] {
  const pathname = (url ?? "/").split("?")[0] ?? "/";
  try {
    return pathname.split("/").filter((s) => s.length > 0).map((segment) => decodeURIComponent(segment));
  } catch {
    throw new ArthurError("INVALID_REQUEST", "Malformed route identifier");
  }
}

// ---------------------------------------------------------------------------
// Route handling (uses the App's ConversationService only)
// ---------------------------------------------------------------------------

async function handleRequest(app: App, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const traceId = newTraceId();
  const path = parsePath(req.url);
  const startedAt = Date.now();

  try {
    // GET /health
    if (method === "GET" && path.length === 1 && path[0] === "health") {
      const configured = app.config.modelProvider === "deepseek" ? app.config.deepseekApiKey.length > 0 : true;
      sendJson(res, 200, {
        status: "ok",
        env: app.config.env,
        model_provider: app.config.modelProvider,
        model_configured: configured,
        time: new Date().toISOString(),
      });
      return;
    }

    // GET /v1/status
    if (method === "GET" && path.length === 2 && path[0] === "v1" && path[1] === "status") {
      sendJson(res, 200, app.conversation.getStatus());
      return;
    }

    // POST /v1/turns
    if (method === "POST" && path.length === 2 && path[0] === "v1" && path[1] === "turns") {
      requireJsonMediaType(req);
      const body = await readJsonBody(req);
      const response = await app.conversation.handleTurn(body);
      sendJson(res, 200, response);
      return;
    }

    // GET /v1/sessions/{id}
    if (method === "GET" && path.length === 3 && path[0] === "v1" && path[1] === "sessions") {
      const summary = await app.conversation.getSession(parseRouteIdentifier(path[2] as string, "session"));
      sendJson(res, 200, summary);
      return;
    }

    // POST /v1/sessions/{id}/mode
    if (method === "POST" && path.length === 4 && path[0] === "v1" && path[1] === "sessions" && path[3] === "mode") {
      requireJsonMediaType(req);
      const body = await readJsonBody(req);
      const result = await app.conversation.changeMode(parseRouteIdentifier(path[2] as string, "session"), body);
      sendJson(res, 200, result);
      return;
    }

    // POST /v1/approvals/{id}/approve
    if (method === "POST" && path.length === 4 && path[0] === "v1" && path[1] === "approvals" && path[3] === "approve") {
      const result = await app.conversation.approve(parseRouteIdentifier(path[2] as string, "approval"));
      sendJson(res, 200, result);
      return;
    }

    // POST /v1/approvals/{id}/reject
    if (method === "POST" && path.length === 4 && path[0] === "v1" && path[1] === "approvals" && path[3] === "reject") {
      const result = await app.conversation.reject(parseRouteIdentifier(path[2] as string, "approval"));
      sendJson(res, 200, result);
      return;
    }

    // ---- Phase 2 memory endpoints (domain resolved server-side) ----

    // POST /v1/memory/remember
    if (method === "POST" && path.length === 3 && path[0] === "v1" && path[1] === "memory" && path[2] === "remember") {
      requireJsonMediaType(req);
      const body = parseRememberBody(await readJsonBody(req));
      const memory = await app.memory.remember(body.session_id, {
        text: body.text,
        type: parseTypeLabel(body.type),
        subject_key: body.subject_key,
        project_key: body.project_key,
        client_request_id: body.client_request_id,
      });
      sendJson(res, 200, memory);
      return;
    }

    // POST /v1/memory/search
    if (method === "POST" && path.length === 3 && path[0] === "v1" && path[1] === "memory" && path[2] === "search") {
      requireJsonMediaType(req);
      const body = parseSearchBody(await readJsonBody(req));
      const memories = await app.memory.search(body.session_id, {
        query_text: body.query,
        top_k: body.top_k,
        project_key: body.project_key,
        allowed_types: body.allowed_types?.map(parseTypeLabel),
      });
      sendJson(res, 200, { memories });
      return;
    }

    // GET /v1/memory/status
    if (method === "GET" && path.length === 3 && path[0] === "v1" && path[1] === "memory" && path[2] === "status") {
      const params = parseListParams(parseQueryParams(req.url));
      sendJson(res, 200, app.memory.status(params.session_id));
      return;
    }

    // GET /v1/memory
    if (method === "GET" && path.length === 2 && path[0] === "v1" && path[1] === "memory") {
      const params = parseListParams(parseQueryParams(req.url));
      const memories = await app.memory.list(params.session_id, params.filter);
      sendJson(res, 200, { memories });
      return;
    }

    // DELETE /v1/memory/{id}
    if (method === "DELETE" && path.length === 3 && path[0] === "v1" && path[1] === "memory") {
      const params = parseListParams(parseQueryParams(req.url));
      await app.memory.forget(params.session_id, parseRouteIdentifier(path[2] as string, "memory"));
      sendJson(res, 200, { status: "deleted", memory_id: path[2] });
      return;
    }

    // POST /v1/documents
    if (method === "POST" && path.length === 2 && path[0] === "v1" && path[1] === "documents") {
      requireJsonMediaType(req);
      const body = parseDocumentBody(await readJsonBody(req));
      const document = await app.memory.ingestDocument(
        body.session_id,
        {
          title: body.title,
          source_type: body.source_type,
          content: body.content,
          project_key: body.project_key,
        },
        body.client_request_id,
      );
      sendJson(res, 200, document);
      return;
    }

    // GET /v1/documents/{id}
    if (method === "GET" && path.length === 3 && path[0] === "v1" && path[1] === "documents") {
      const params = parseListParams(parseQueryParams(req.url));
      const document = await app.memory.getDocument(params.session_id, parseRouteIdentifier(path[2] as string, "document"));
      if (!document) {
        sendError(app, res, new ArthurError("INVALID_REQUEST", "document not found in this session's domain"));
        return;
      }
      sendJson(res, 200, document);
      return;
    }

    // DELETE /v1/documents/{id}
    if (method === "DELETE" && path.length === 3 && path[0] === "v1" && path[1] === "documents") {
      const params = parseListParams(parseQueryParams(req.url));
      const result = await app.memory.deleteDocument(params.session_id, parseRouteIdentifier(path[2] as string, "document"));
      sendJson(res, 200, { status: "deleted", ...result });
      return;
    }

    sendError(app, res, new ArthurError("INVALID_REQUEST", `No route for ${method} ${req.url ?? "/"}`));
  } catch (err) {
    sendError(app, res, err);
  } finally {
    app.logger.info("http request", {
      trace_id: traceId,
      method,
      path: req.url ?? "/",
      status_ms: Date.now() - startedAt,
    });
  }
}

export interface ServerOptions {
  host?: string;
  port?: number;
}

export function startServer(app: App, opts: ServerOptions = {}): Promise<{ server: Server; port: number }> {
  const host = opts.host ?? app.config.bindHost;
  const port = opts.port ?? app.config.bindPort;
  const server = createServer((req, res) => {
    handleRequest(app, req, res).catch((err) => sendError(app, res, err));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address !== null ? address.port : port;
      resolve({ server, port: actualPort });
    });
  });
}

export function main(): void {
  let app: App;
  try {
    loadDotEnv();
    app = buildApp();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const publicError = sanitizePublicError(new ArthurError("INVALID_CONFIG", message), startupSanitizer());
    process.stderr.write(`error [${publicError.body.error.code}]: ${publicError.body.error.message}\n`);
    process.exitCode = 1;
    return;
  }

  startServer(app)
    .then(({ server }) => {
      app.logger.info("ARTHUR API listening", {
        host: app.config.bindHost,
        port: app.config.bindPort,
        provider: app.config.modelProvider,
        env: app.config.env,
      });
      process.stdout.write(
        `ARTHUR API listening on http://${app.config.bindHost}:${app.config.bindPort} (provider: ${app.config.modelProvider})\n`,
      );

      const shutdown = (): void => {
        server.close(() => {
          app.close();
          process.exit(0);
        });
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((err) => {
      app.logger.error("http server error", { error: err instanceof Error ? err.message : String(err) });
      process.exitCode = 1;
    });
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("server.js") || process.argv[1].endsWith("server.ts"));

if (isMain) {
  main();
}
