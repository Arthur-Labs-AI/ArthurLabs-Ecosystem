export interface LanClientOptions {
  providerId: string;
  baseUrl: string;
  authToken: string;
  capabilities: import("../../../models/contracts").ModelCapabilities;
  timeoutMs?: number;
  firstResponseTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

import { randomUUID } from "node:crypto";
import {
  ProviderAuthError,
  ProviderBadResponseError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  type ModelCapabilities,
  type ModelGateway,
  type ModelRequest,
  type ModelResult,
  type ModelStreamEvent,
} from "../../../models/contracts";
import { ARTHUR_LAN_PROTOCOL_VERSION, LAN_JSON_CONTENT_TYPE, LAN_NDJSON_CONTENT_TYPE, LAN_INFO_PATH, isLanStreamFrame, isWireErrorCode, lanGeneratePath, lanStreamPath, type WireErrorCode } from "./protocol";
import { LAN_MAX_BODY_BYTES, LAN_MAX_STREAM_FRAME_BYTES, parseLanModelResult, parseLanStreamEvent } from "./validation";
import { LAN_BEARER_PREFIX } from "./auth";
import { LanAuthenticationError, LanProtocolError, throwForWireCode } from "./errors";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function assertLanBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new LanProtocolError("PROTOCOL", "invalid lan base url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new LanProtocolError("PROTOCOL", "unsupported lan url scheme");
  if (url.username !== "" || url.password !== "") throw new LanProtocolError("PROTOCOL", "credentials in lan url are forbidden");
  if (url.search !== "" || url.hash !== "") throw new LanProtocolError("PROTOCOL", "query and fragment are forbidden in lan url");
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new LanProtocolError("PROTOCOL", "plaintext lan http is loopback-only");
  }
  return url;
}

async function readBoundedText(res: Response, limit: number): Promise<string> {
  const declared = res.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isInteger(length) || length < 0 || length > limit) throw new ProviderBadResponseError("lan response exceeds the bound");
  }
  const reader = (res.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (reader === undefined || reader === null) {
    const text = await res.text();
    if (text.length > limit) throw new ProviderBadResponseError("lan response exceeds the bound");
    return text;
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > limit) {
      try { await reader.cancel(); } catch { /* best effort */ }
      throw new ProviderBadResponseError("lan response exceeds the bound");
    }
  }
  text += decoder.decode();
  return text;
}

function parseErrorEnvelope(body: string, fallbackRequestId: string): { code: WireErrorCode; requestId: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ProviderBadResponseError("lan error body is not json");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ProviderBadResponseError("lan error body malformed");
  const raw = parsed as Record<string, unknown>;
  const err = raw["error"] as Record<string, unknown> | undefined;
  if (err === undefined || !isWireErrorCode(err["code"])) throw new ProviderBadResponseError("lan error code malformed");
  const requestId = typeof raw["request_id"] === "string" ? (raw["request_id"] as string) : fallbackRequestId;
  return { code: err["code"] as WireErrorCode, requestId };
}

function assertProviderId(providerId: string): string {
  if (typeof providerId !== "string" || providerId.trim() === "" || providerId.length > 128) {
    throw new LanProtocolError("PROTOCOL", "invalid provider id");
  }
  return providerId.trim();
}

export class LanModelGateway implements ModelGateway {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly authToken: string;
  private readonly trustedCapabilities: ModelCapabilities;
  private readonly timeoutMs: number;
  private readonly firstResponseTimeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: LanClientOptions) {
    this.id = assertProviderId(options.providerId);
    const url = assertLanBaseUrl(options.baseUrl);
    this.baseUrl = url.origin;
    if (typeof options.authToken !== "string" || options.authToken === "") {
      throw new LanProtocolError("PROTOCOL", "lan auth token must be non-empty");
    }
    this.authToken = options.authToken;
    this.trustedCapabilities = { ...options.capabilities, id: this.id, modelName: options.capabilities.modelName };
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.firstResponseTimeoutMs = options.firstResponseTimeoutMs ?? 15_000;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  capabilities(): ModelCapabilities {
    return { ...this.trustedCapabilities };
  }

  async probe(): Promise<{ protocol_version: number; provider_ids: string[] }> {
    const requestId = randomUUID();
    const res = await this.fetchWithTimeout(this.baseUrl + LAN_INFO_PATH, {
      method: "GET",
      headers: { authorization: LAN_BEARER_PREFIX + this.authToken },
    }, this.timeoutMs);
    if (res.status === 401) throw new LanAuthenticationError();
    if (res.status !== 200) throw new LanProtocolError("PROTOCOL", "lan info failed");
    const text = await readBoundedText(res, LAN_MAX_BODY_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ProviderBadResponseError("lan info is not json");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ProviderBadResponseError("lan info malformed");
    const raw = parsed as Record<string, unknown>;
    if (raw["protocol_version"] !== ARTHUR_LAN_PROTOCOL_VERSION) throw new LanProtocolError("PROTOCOL", "unsupported lan protocol version");
    if (!Array.isArray(raw["providers"])) throw new ProviderBadResponseError("lan info providers malformed");
    const ids: string[] = [];
    for (const entry of raw["providers"] as unknown[]) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new ProviderBadResponseError("lan info provider malformed");
      const id = (entry as Record<string, unknown>)["id"];
      if (typeof id !== "string" || id === "") throw new ProviderBadResponseError("lan info provider id malformed");
      ids.push(id);
    }
    void requestId;
    return { protocol_version: ARTHUR_LAN_PROTOCOL_VERSION, provider_ids: ids };
  }

  async generate(request: ModelRequest): Promise<ModelResult> {
    const requestId = randomUUID();
    const attempt = JSON.parse(JSON.stringify(request)) as ModelRequest;
    const envelope = JSON.stringify({ protocol_version: ARTHUR_LAN_PROTOCOL_VERSION, request_id: requestId, request: attempt });
    let res: Response;
    try {
      res = await this.fetchWithTimeout(this.baseUrl + lanGeneratePath(this.id), {
        method: "POST",
        headers: { authorization: LAN_BEARER_PREFIX + this.authToken, "content-type": LAN_JSON_CONTENT_TYPE },
        body: envelope,
        redirect: "error",
      }, this.timeoutMs);
    } catch (err) {
      throw this.mapTransportError(err);
    }
    if (res.status === 401) throw new LanAuthenticationError();
    const text = await readBoundedText(res, LAN_MAX_BODY_BYTES);
    if (res.status !== 200) throwForWireCode(parseErrorEnvelope(text, requestId).code);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ProviderBadResponseError("lan result is not json");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ProviderBadResponseError("lan result envelope malformed");
    const raw = parsed as Record<string, unknown>;
    if (raw["protocol_version"] !== ARTHUR_LAN_PROTOCOL_VERSION) throw new LanProtocolError("PROTOCOL", "unsupported lan protocol version");
    if (raw["request_id"] !== requestId) throw new ProviderBadResponseError("lan request id mismatch");
    try {
      return parseLanModelResult(raw["result"]);
    } catch {
      throw new ProviderBadResponseError("lan model result malformed");
    }
  }

  async *generateStream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const requestId = randomUUID();
    const attempt = JSON.parse(JSON.stringify(request)) as ModelRequest;
    const envelope = JSON.stringify({ protocol_version: ARTHUR_LAN_PROTOCOL_VERSION, request_id: requestId, request: attempt });
    let res: Response;
    try {
      res = await this.fetchWithFirstResponseTimeout(this.baseUrl + lanStreamPath(this.id), {
        method: "POST",
        headers: { authorization: LAN_BEARER_PREFIX + this.authToken, "content-type": LAN_JSON_CONTENT_TYPE },
        body: envelope,
        redirect: "error",
        ...(signal !== undefined ? { signal } : {}),
      }, this.firstResponseTimeoutMs);
    } catch (err) {
      if (signal?.aborted === true) throw err;
      throw this.mapTransportError(err);
    }
    if (res.status === 401) throw new LanAuthenticationError();
    if (res.status !== 200) {
      const text = await readBoundedText(res, LAN_MAX_BODY_BYTES);
      throwForWireCode(parseErrorEnvelope(text, requestId).code);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith(LAN_NDJSON_CONTENT_TYPE)) throw new ProviderBadResponseError("lan stream content type mismatch");
    let seenDone = false;
    let yielded = false;
    for await (const frame of this.readFrames(res, signal)) {
      if (!isLanStreamFrame(frame)) throw new ProviderBadResponseError("lan stream frame malformed");
      if (frame.request_id !== requestId) throw new ProviderBadResponseError("lan request id mismatch");
      if (frame.type === "error") throwForWireCode(frame.error.code);
      let event: ModelStreamEvent;
      try {
        event = parseLanStreamEvent(frame.event);
      } catch {
        throw new ProviderBadResponseError("lan stream event malformed");
      }
      if (seenDone) throw new ProviderBadResponseError("lan event after done");
      if (event.type === "done") {
        if (seenDone) throw new ProviderBadResponseError("lan duplicate done");
        seenDone = true;
      }
      yielded = true;
      void yielded;
      yield event;
    }
    if (!seenDone) throw new ProviderBadResponseError("lan stream ended without done");
  }

  private async *readFrames(res: Response, signal: AbortSignal | undefined): AsyncIterable<unknown> {
    const reader = (res.body as ReadableStream<Uint8Array> | null)?.getReader();
    if (reader === undefined || reader === null) throw new ProviderBadResponseError("lan stream body missing");
    const decoder = new TextDecoder("utf-8");
    let pending = "";
    for (;;) {
      if (signal?.aborted === true) {
        try { await reader.cancel(); } catch { /* best effort */ }
        throw signal.reason instanceof Error ? signal.reason : new Error("lan stream aborted");
      }
      let chunk: { done: boolean; value: Uint8Array | undefined };
      try {
        chunk = await reader.read();
      } catch {
        throw new ProviderUnavailableError("lan stream transport failed");
      }
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (pending.length > LAN_MAX_STREAM_FRAME_BYTES || line.length > LAN_MAX_STREAM_FRAME_BYTES) {
          throw new ProviderBadResponseError("lan stream frame exceeds the bound");
        }
        if (line !== "") {
          let frame: unknown;
          try {
            frame = JSON.parse(line);
          } catch {
            throw new ProviderBadResponseError("lan stream ndjson malformed");
          }
          yield frame;
        }
        newline = pending.indexOf("\n");
      }
      if (pending.length > LAN_MAX_STREAM_FRAME_BYTES) throw new ProviderBadResponseError("lan stream frame exceeds the bound");
    }
    pending += decoder.decode();
    if (pending.replace(/\r?\n$/, "") !== "") {
      const line = pending.replace(/\r?\n$/, "");
      if (line.length > LAN_MAX_STREAM_FRAME_BYTES) throw new ProviderBadResponseError("lan stream frame exceeds the bound");
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        throw new ProviderBadResponseError("lan stream ndjson malformed");
      }
      yield frame;
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new ProviderTimeoutError("lan request timed out")), timeoutMs);
    try {
      const existing = init.signal as AbortSignal | undefined | null;
      if (existing !== undefined && existing !== null) {
        if (existing.aborted) throw (existing.reason instanceof Error ? existing.reason : new ProviderTimeoutError("lan request aborted"));
        const onAbort = (): void => controller.abort((existing as AbortSignal).reason);
        (existing as AbortSignal).addEventListener("abort", onAbort, { once: true });
        try {
          return await this.fetchFn(url, { ...init, signal: controller.signal });
        } finally {
          (existing as AbortSignal).removeEventListener("abort", onAbort);
        }
      }
      return await this.fetchFn(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (err instanceof ProviderTimeoutError) throw err;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchWithFirstResponseTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    return this.fetchWithTimeout(url, init, timeoutMs);
  }

  private mapTransportError(err: unknown): Error {
    if (err instanceof ProviderTimeoutError) return err;
    if (err instanceof ProviderAuthError || err instanceof ProviderBadResponseError || err instanceof LanAuthenticationError || err instanceof LanProtocolError) return err as Error;
    if (err instanceof TypeError) return new ProviderUnavailableError("lan transport failed");
    if (err instanceof Error && /abort/i.test(err.name)) return new ProviderTimeoutError("lan request timed out");
    return new ProviderUnavailableError("lan transport failed");
  }
}
