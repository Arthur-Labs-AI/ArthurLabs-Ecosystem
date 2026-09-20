export interface LanHandlerOptions {
  gateways: import("../gateway_registry").ModelGatewayRegistry;
  authToken: string;
  /** HR-03E: optional explicitly bound remote-host tool executors. Absent = no remote tools executable. */
  toolBindings?: import("./tool_bindings").ToolExecutorBindings;
}

export interface LanHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  aborted: boolean;
  onAborted(callback: () => void): void;
}

export const LAN_REQUEST_ID_CHARS = 128;

export function lanRequestId(): string {
  const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
  return randomUUID();
}

export interface LanHttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): boolean;
  end(body?: string): void;
  ended: boolean;
}

import { ARTHUR_LAN_PROTOCOL_VERSION, LAN_INFO_PATH, LAN_JSON_CONTENT_TYPE, LAN_NDJSON_CONTENT_TYPE, type LanErrorBody, type WireErrorCode } from "./protocol";
import { LAN_MAX_BODY_BYTES } from "./validation";
import { parseLanModelRequest } from "./validation";
import { extractBearerToken, tokensEqualConstantTime } from "./auth";
import { classifyServerError } from "./errors";

function readBoundedBody(body: AsyncIterable<Uint8Array>, limit: number): Promise<{ ok: true; bytes: Buffer } | { ok: false }> {
  return (async () => {
    const parts: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
      const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      total += buf.length;
      if (total > limit) return { ok: false as const };
      parts.push(buf);
    }
    return { ok: true as const, bytes: Buffer.concat(parts) };
  })();
}

function jsonResponse(res: LanHttpResponse, status: number, body: unknown): void {
  if (res.ended) return;
  res.writeHead(status, { "content-type": LAN_JSON_CONTENT_TYPE });
  res.end(JSON.stringify(body));
}

function errorResponse(res: LanHttpResponse, status: number, requestId: string, code: WireErrorCode): void {
  const body: LanErrorBody = { protocol_version: ARTHUR_LAN_PROTOCOL_VERSION, request_id: requestId, error: { code } };
  jsonResponse(res, status, body);
}

function statusFor(code: WireErrorCode): number {
  if (code === "UNAUTHORIZED") return 401;
  if (code === "PROVIDER_NOT_FOUND") return 404;
  if (code === "INVALID_REQUEST" || code === "UNSUPPORTED_PROTOCOL_VERSION") return 400;
  if (code === "PROVIDER_TIMEOUT") return 504;
  if (code === "PROVIDER_UNAVAILABLE" || code === "PROVIDER_AUTH_FAILED" || code === "PROVIDER_BAD_RESPONSE") return 502;
  return 500;
}

function matchModelRoute(path: string): { providerId: string; mode: "generate" | "stream" } | undefined {
  const prefix = "/v1/runtime/models/";
  if (!path.startsWith(prefix)) return undefined;
  const rest = path.slice(prefix.length);
  const slash = rest.lastIndexOf("/");
  if (slash === -1) return undefined;
  const encoded = rest.slice(0, slash);
  const tail = rest.slice(slash + 1);
  if (tail !== "generate" && tail !== "stream") return undefined;
  let providerId: string;
  try {
    providerId = decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
  if (providerId === "" || providerId.includes("/")) return undefined;
  return { providerId, mode: tail };
}

export function createLanRuntimeHandler(options: LanHandlerOptions): (req: LanHttpRequest, res: LanHttpResponse) => Promise<void> {
  if (options.authToken === "") throw new Error("lan auth token must be non-empty");
  return async (incoming, outgoing) => {
    const path = incoming.url.split("?", 1)[0] as string;
    const supplied = extractBearerToken(incoming.headers["authorization"]);
    if (supplied === undefined || !tokensEqualConstantTime(supplied, options.authToken)) {
      errorResponse(outgoing, 401, "none", "UNAUTHORIZED");
      return;
    }
    if (incoming.method === "GET" && (path === LAN_INFO_PATH || path === "/v1/runtime/info")) {
      const providers: { id: string; capabilities: unknown }[] = [];
      for (const id of options.gateways.listIds()) {
        const gateway = options.gateways.get(id);
        if (gateway === undefined) continue;
        let capabilities: unknown;
        try {
          capabilities = gateway.capabilities();
        } catch {
          continue;
        }
        providers.push({ id, capabilities });
      }
      jsonResponse(outgoing, 200, { protocol_version: ARTHUR_LAN_PROTOCOL_VERSION, providers });
      return;
    }
    // HR-03E: tool execution route (same auth/TLS/bounds/redirect policy).
    // Only explicitly bound capability adapters are executable; with no
    // tool bindings supplied, no remote tools are executable (404).
    const { matchToolRoute, handleToolExecute } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("./tool_server") as typeof import("./tool_server");
    const toolRoute = matchToolRoute(path);
    if (toolRoute !== undefined) {
      if (incoming.method !== "POST" && incoming.method !== "post") {
        errorResponse(outgoing, 404, "none", "PROVIDER_NOT_FOUND");
        return;
      }
      if (options.toolBindings === undefined) {
        const { toolErrorBody, toolStatusFor } =
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require("./tool_server") as typeof import("./tool_server");
        const body = toolErrorBody("none", "TOOL_EXECUTOR_NOT_FOUND", "not_applied");
        if (!outgoing.ended) {
          outgoing.writeHead(toolStatusFor("TOOL_EXECUTOR_NOT_FOUND"), { "content-type": LAN_JSON_CONTENT_TYPE });
          outgoing.end(JSON.stringify(body));
        }
        return;
      }
      await handleToolExecute(toolRoute, incoming, outgoing, { bindings: options.toolBindings });
      return;
    }
    const route = matchModelRoute(path);
    if (route === undefined || (incoming.method !== "POST" && incoming.method !== "post")) {
      errorResponse(outgoing, 404, "none", "PROVIDER_NOT_FOUND");
      return;
    }
    const contentTypeRaw = incoming.headers["content-type"];
    const contentType = (Array.isArray(contentTypeRaw) ? contentTypeRaw[0] : contentTypeRaw) ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      errorResponse(outgoing, 400, "none", "INVALID_REQUEST");
      return;
    }
    const gateway = options.gateways.get(route.providerId);
    if (gateway === undefined) {
      errorResponse(outgoing, 404, "none", "PROVIDER_NOT_FOUND");
      return;
    }
    const buffered = await readBoundedBody(incoming.body, LAN_MAX_BODY_BYTES);
    if (!buffered.ok) {
      errorResponse(outgoing, 413, "none", "INVALID_REQUEST");
      return;
    }
    let envelope: { protocol_version?: unknown; request_id?: unknown; request?: unknown };
    try {
      const parsed: unknown = JSON.parse(buffered.bytes.toString("utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad envelope");
      envelope = parsed as { protocol_version?: unknown; request_id?: unknown; request?: unknown };
    } catch {
      errorResponse(outgoing, 400, "none", "INVALID_REQUEST");
      return;
    }
    if (envelope.protocol_version !== ARTHUR_LAN_PROTOCOL_VERSION) {
      errorResponse(outgoing, 400, typeof envelope.request_id === "string" ? envelope.request_id : "none", "UNSUPPORTED_PROTOCOL_VERSION");
      return;
    }
    if (typeof envelope.request_id !== "string" || envelope.request_id === "" || envelope.request_id.length > LAN_REQUEST_ID_CHARS) {
      errorResponse(outgoing, 400, "none", "INVALID_REQUEST");
      return;
    }
    const requestId = envelope.request_id;
    let modelRequest;
    try {
      modelRequest = parseLanModelRequest(envelope.request);
    } catch {
      errorResponse(outgoing, 400, requestId, "INVALID_REQUEST");
      return;
    }
    if (route.mode === "generate") {
      try {
        const result = await gateway.generate(modelRequest);
        jsonResponse(outgoing, 200, { protocol_version: ARTHUR_LAN_PROTOCOL_VERSION, request_id: requestId, result });
      } catch (err) {
        const code = classifyServerError(err);
        errorResponse(outgoing, statusFor(code), requestId, code);
      }
      return;
    }
    outgoing.writeHead(200, { "content-type": LAN_NDJSON_CONTENT_TYPE });
    // One AbortController per streaming request: abort when the remote peer
    // disconnects/aborts before completion, and hand its signal to the
    // hosted gateway so remote generation stops too. Buffered generate()
    // is out of scope: ModelGateway.generate() has no AbortSignal contract
    // and this gate must not change that global interface.
    const controller = new AbortController();
    let settled = false;
    const onPeerAbort = (): void => {
      if (settled) return;
      try {
        controller.abort();
      } catch {
        /* abort best effort */
      }
    };
    incoming.onAborted(onPeerAbort);
    try {
      for await (const event of gateway.generateStream(modelRequest, controller.signal)) {
        if (outgoing.ended || incoming.aborted) return;
        outgoing.write(JSON.stringify({ type: "event", request_id: requestId, event }) + "\n");
      }
    } catch (err) {
      if (!outgoing.ended && !incoming.aborted) {
        outgoing.write(JSON.stringify({ type: "error", request_id: requestId, error: { code: classifyServerError(err) } }) + "\n");
      }
    } finally {
      settled = true;
      if (!outgoing.ended) outgoing.end();
    }
  };
}
