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
import { VoiceError, VoiceErrorCode } from "../../src/voice/contracts";

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

/** Map a typed VoiceError to an HTTP status (spec section 36). */
function voiceErrorStatus(err: VoiceError): number {
  switch (err.code) {
    case VoiceErrorCode.VOICE_DISABLED:
    case VoiceErrorCode.VOICE_BUSY:
    case VoiceErrorCode.VOICE_STATE_INVALID:
      return 409;
    case VoiceErrorCode.AUDIO_INPUT_UNAVAILABLE:
    case VoiceErrorCode.AUDIO_OUTPUT_UNAVAILABLE:
    case VoiceErrorCode.WAKE_UNAVAILABLE:
    case VoiceErrorCode.VAD_FAILED:
    case VoiceErrorCode.STT_FAILED:
    case VoiceErrorCode.TTS_FAILED:
    case VoiceErrorCode.MODEL_FAILED:
      return 503;
    case VoiceErrorCode.STT_EMPTY:
    case VoiceErrorCode.VOICE_TIMEOUT:
    case VoiceErrorCode.VOICE_CANCELLED:
      return 400;
    default:
      return 500;
  }
}

function sendVoiceError(res: ServerResponse, err: unknown): void {
  if (err instanceof VoiceError) {
    sendJson(res, voiceErrorStatus(err), {
      error: { code: err.code, message: err.message },
    });
    return;
  }
  sendJson(res, 500, { error: { code: "INTERNAL_ERROR", message: "Unexpected internal failure" } });
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

    // GET /v1/approvals/{id}/challenge - server-generated WYSIWYS challenge (SC-02 section 20).
    if (method === "GET" && path.length === 4 && path[0] === "v1" && path[1] === "approvals" && path[3] === "challenge") {
      const challenge = app.conversation.getApprovalChallenge(parseRouteIdentifier(path[2] as string, "approval"));
      sendJson(res, 200, challenge);
      return;
    }

    // POST /v1/approvals/{id}/approve - optional { session_id } body enables
    // session-context verification (SC-02 section 23: accidental cross-session
    // approval guard; session_id is context binding, not authentication).
    if (method === "POST" && path.length === 4 && path[0] === "v1" && path[1] === "approvals" && path[3] === "approve") {
      const id = parseRouteIdentifier(path[2] as string, "approval");
      const body = (await readJsonBody(req)) as { session_id?: unknown; decision_channel?: unknown } | undefined;
      const channel = typeof body?.decision_channel === "string" && ["cli", "voice", "web", "desktop", "mobile", "api"].includes(body.decision_channel) ? (body.decision_channel as string) : undefined;
      if (typeof body?.session_id === "string") {
        const approval = app.store.getApproval(id);
        if (approval && approval.session_id !== body.session_id) {
          sendError(app, res, new ArthurError("APPROVAL_INVALID", "Approval does not belong to this session"));
          return;
        }
      }
      const result = await app.conversation.approve(id, channel);
      sendJson(res, 200, result);
      return;
    }

    // POST /v1/approvals/{id}/reject
    if (method === "POST" && path.length === 4 && path[0] === "v1" && path[1] === "approvals" && path[3] === "reject") {
      const id = parseRouteIdentifier(path[2] as string, "approval");
      const body = (await readJsonBody(req)) as { session_id?: unknown } | undefined;
      if (typeof body?.session_id === "string") {
        const approval = app.store.getApproval(id);
        if (approval && approval.session_id !== body.session_id) {
          sendError(app, res, new ArthurError("APPROVAL_INVALID", "Approval does not belong to this session"));
          return;
        }
      }
      const result = await app.conversation.reject(id);
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


    // ---- Phase 3 voice control endpoints (spec section 24) ----------------

    // GET /v1/voice/status
    if (method === "GET" && path.length === 3 && path[0] === "v1" && path[1] === "voice" && path[2] === "status") {
      sendJson(res, 200, app.voice.status());
      return;
    }

    // POST /v1/voice/enable  { session_id?: string }
    if (method === "POST" && path.length === 3 && path[0] === "v1" && path[1] === "voice" && path[2] === "enable") {
      requireJsonMediaType(req);
      const body = (await readJsonBody(req)) as { session_id?: unknown } | undefined;
      const sessionId = typeof body?.session_id === "string" ? body.session_id : undefined;
      try {
        await app.voice.enable(sessionId);
        sendJson(res, 200, { status: "enabled", state: app.voice.state });
      } catch (err) {
        sendVoiceError(res, err);
      }
      return;
    }

    // POST /v1/voice/disable
    if (method === "POST" && path.length === 3 && path[0] === "v1" && path[1] === "voice" && path[2] === "disable") {
      try {
        await app.voice.disable();
        sendJson(res, 200, { status: "disabled", state: app.voice.state });
      } catch (err) {
        sendVoiceError(res, err);
      }
      return;
    }

    // GET /v1/voice/devices
    if (method === "GET" && path.length === 3 && path[0] === "v1" && path[1] === "voice" && path[2] === "devices") {
      sendJson(res, 200, {
        input_devices: app.voice.status().audio_input.available ? [{ id: "default", label: "default input" }] : [],
        output_devices: app.voice.status().audio_output.available ? [{ id: "default", label: "default output" }] : [],
      });
      return;
    }

    // POST /v1/voice/devices  { input_device_id?, output_device_id? }
    if (method === "POST" && path.length === 3 && path[0] === "v1" && path[1] === "voice" && path[2] === "devices") {
      requireJsonMediaType(req);
      const body = (await readJsonBody(req)) as { input_device_id?: unknown; output_device_id?: unknown } | undefined;
      const inputDeviceId = typeof body?.input_device_id === "string" ? body.input_device_id : undefined;
      const outputDeviceId = typeof body?.output_device_id === "string" ? body.output_device_id : undefined;
      app.voice.setDevices(inputDeviceId, outputDeviceId);
      sendJson(res, 200, { status: "devices_set", state: app.voice.state });
      return;
    }

    // POST /v1/voice/interrupt
    if (method === "POST" && path.length === 3 && path[0] === "v1" && path[1] === "voice" && path[2] === "interrupt") {
      try {
        await app.voice.interrupt("user_stop");
        sendJson(res, 200, { status: "interrupted", state: app.voice.state });
      } catch (err) {
        sendVoiceError(res, err);
      }
      return;
    }

    // POST /v1/voice/ptt/start
    if (method === "POST" && path.length === 4 && path[0] === "v1" && path[1] === "voice" && path[2] === "ptt" && path[3] === "start") {
      try {
        await app.voice.pttStart();
        sendJson(res, 200, { status: "ptt_started", state: app.voice.state });
      } catch (err) {
        sendVoiceError(res, err);
      }
      return;
    }

    // POST /v1/voice/ptt/stop
    if (method === "POST" && path.length === 4 && path[0] === "v1" && path[1] === "voice" && path[2] === "ptt" && path[3] === "stop") {
      try {
        await app.voice.pttStop();
        sendJson(res, 200, { status: "ptt_stopped", state: app.voice.state });
      } catch (err) {
        sendVoiceError(res, err);
      }
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
  app.realtime.attach(server);
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