import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAiSttProvider, wavWrap16kMono } from "../../src/voice/stt/openai_provider";
import { frameFromInt16 } from "../../src/voice/contracts";
import type { PcmFrame } from "../../src/voice/contracts";

function frames(n = 2): AsyncIterable<PcmFrame> {
  return {
    [Symbol.asyncIterator]: async function* (): AsyncGenerator<PcmFrame> {
      for (let i = 0; i < n; i++) yield frameFromInt16(new Int16Array(320).fill(100), i, i * 20);
    },
  };
}

test("HR-02 OpenAI STT: Authorization header constructed safely, key never in logs", async () => {
  const seen: { auth?: string; url?: string } = {};
  const fetchFn = (async (url: unknown, init: unknown) => {
    const headers = (init as { headers: Record<string, string> }).headers;
    seen.auth = headers.Authorization;
    seen.url = String(url);
    assert.equal(seen.auth, "Bearer sk-test-secret-123");
    return new Response(JSON.stringify({ text: "hello" }), { status: 200 });
  }) as unknown as typeof fetch;
  const p = new OpenAiSttProvider({ apiKey: "sk-test-secret-123", model: "gpt-4o-transcribe", fetchFn });
  assert.equal(p.available, true);
  assert.equal(p.authorizationHeader(), "Bearer sk-test-secret-123");
  const events: string[] = [];
  for await (const e of p.transcribeStream(frames(), { utteranceId: "u-auth", maxTranscriptChars: 8000 })) events.push(e.type);
  assert.deepEqual(events, ["final"]);
  assert.ok((seen.url ?? "").includes("/audio/transcriptions"));
});

test("HR-02 OpenAI STT: unavailable without key (no network call)", async () => {
  let called = false;
  const fetchFn = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const p = new OpenAiSttProvider({ apiKey: "", model: "gpt-4o-transcribe", fetchFn });
  assert.equal(p.available, false);
  const events: string[] = [];
  for await (const e of p.transcribeStream(frames(), { utteranceId: "u-nokey", maxTranscriptChars: 8000 })) events.push(e.type);
  assert.deepEqual(events, ["error"]);
  assert.equal(called, false);
});

test("HR-02 OpenAI STT: 401 normalizes to auth failure (no body leaked)", async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 })) as unknown as typeof fetch;
  const p = new OpenAiSttProvider({ apiKey: "sk-bad", model: "gpt-4o-transcribe", fetchFn });
  const codes: string[] = [];
  for await (const e of p.transcribeStream(frames(), { utteranceId: "u-401", maxTranscriptChars: 8000 })) {
    if (e.type === "error") codes.push(e.code);
  }
  assert.deepEqual(codes, ["STT_AUTH_FAILED"]);
});

test("HR-02 OpenAI STT: serialization valid JSON; secret-like strings never corrupt it", async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ text: "x" }), { status: 200 })) as unknown as typeof fetch;
  const p = new OpenAiSttProvider({ apiKey: "k", model: "gpt-4o-transcribe", fetchFn });
  const tricky = { type: "session.update", prompt: "password=", transcript: "ok" };
  const wire = p.serializeFrame(tricky);
  assert.equal(wire, JSON.stringify(tricky));
  assert.deepEqual(JSON.parse(wire), tricky);
  const wav = wavWrap16kMono(Buffer.from([1, 2, 3, 4]));
  assert.equal(wav.length, 44 + 4);
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
});

test("HR-02 OpenAI STT: cancel closes active request (no stale final)", async () => {
  let resolveFetch: ((r: Response) => void) | undefined;
  const fetchFn = (() =>
    new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })) as unknown as typeof fetch;
  const p = new OpenAiSttProvider({ apiKey: "k", model: "gpt-4o-transcribe", fetchFn, requestTimeoutMs: 5000 });
  const iter = p.transcribeStream(frames(1), { utteranceId: "u-cancel", maxTranscriptChars: 8000 });
  const pending = (async () => {
    const out: string[] = [];
    for await (const e of iter) out.push(e.type);
    return out;
  })();
  await new Promise((r) => setTimeout(r, 20));
  await p.cancel("u-cancel");
  if (resolveFetch) resolveFetch(new Response(JSON.stringify({ text: "late" }), { status: 200 }));
  const events = await pending;
  assert.ok(!events.includes("final"));
});

// Note: the realtime-seam tests below deliberately keep a realtime-family
// model id: they inject socketFactory, so the REST-path guard never fires.
// The seam stays for a future dedicated gpt-live-transcribe transport.
test("HR-02 OpenAI STT: unexpected realtime event tolerated, completed is final", async () => {
  const sockets: Array<{
    send(d: string): void;
    close(): void;
    onmessage: ((e: { data: unknown }) => void) | null;
    onclose: (() => void) | null;
    onerror: ((e: unknown) => void) | null;
  }> = [];
  const factory = () => {
    const s = {
      send(d: string): void {
        const msg = JSON.parse(d) as { type: string };
        if (msg.type === "input_audio_buffer.commit") {
          setImmediate(() => {
            if (s.onmessage) s.onmessage({ data: JSON.stringify({ type: "weird.unknown.event" }) });
          });
          setImmediate(() => {
            if (s.onmessage)
              s.onmessage({
                data: JSON.stringify({
                  type: "conversation.item.input_audio_transcription.completed",
                  transcript: "final text here",
                }),
              });
          });
        }
      },
      close(): void {},
      onmessage: null as ((e: { data: unknown }) => void) | null,
      onclose: null as (() => void) | null,
      onerror: null as ((e: unknown) => void) | null,
    };
    sockets.push(s);
    return s;
  };
  const noRest = (async () => {
    throw new Error("no rest");
  }) as unknown as typeof fetch;
  const p = new OpenAiSttProvider({
    apiKey: "k",
    model: "gpt-live-transcribe",
    fetchFn: noRest,
    socketFactory: factory as never,
  });
  const events: Array<{ type: string; text?: string }> = [];
  for await (const e of p.transcribeStream(frames(), { utteranceId: "u-ws", maxTranscriptChars: 8000 })) {
    if (e.type === "final") events.push({ type: "final", text: e.text });
    if (e.type === "partial") events.push({ type: "partial", text: e.text });
  }
  assert.deepEqual(events, [{ type: "final", text: "final text here" }]);
  assert.equal(sockets.length, 1);
});

test("HR-02 OpenAI STT: realtime delta yields partials in-stream, completed is the only final", async () => {
  let socket: {
    send(d: string): void;
    close(): void;
    onmessage: ((e: { data: unknown }) => void) | null;
  } | null = null;
  const factory = () => {
    const s = {
      send(d: string): void {
        const msg = JSON.parse(d) as { type: string };
        if (msg.type === "input_audio_buffer.commit" && socket) {
          const target = socket;
          setImmediate(() => {
            if (target.onmessage)
              target.onmessage({
                data: JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", delta: "Arthur otvori" }),
              });
          });
          setImmediate(() => {
            if (target.onmessage)
              target.onmessage({
                data: JSON.stringify({
                  type: "conversation.item.input_audio_transcription.completed",
                  transcript: "Arthur, otvori Visual Studio Code.",
                }),
              });
          });
        }
      },
      close(): void {},
      onmessage: null as ((e: { data: unknown }) => void) | null,
    };
    socket = s;
    return s;
  };
  const noRest = (async () => {
    throw new Error("no rest");
  }) as unknown as typeof fetch;
  const p = new OpenAiSttProvider({
    apiKey: "k",
    model: "gpt-live-transcribe",
    fetchFn: noRest,
    socketFactory: factory as never,
  });
  const events: Array<{ type: string; text?: string }> = [];
  for await (const e of p.transcribeStream(frames(), { utteranceId: "u-ws-delta", maxTranscriptChars: 8000 })) {
    if (e.type === "partial") events.push({ type: "partial", text: e.text });
    if (e.type === "final") events.push({ type: "final", text: e.text });
  }
  assert.deepEqual(events, [
    { type: "partial", text: "Arthur otvori" },
    { type: "final", text: "Arthur, otvori Visual Studio Code." },
  ]);
});

test("HR-02 OpenAI STT: REST rejects realtime-only models (gpt-live-transcribe)", async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ text: "must not send" }), { status: 200 })) as unknown as typeof fetch;
  const p = new OpenAiSttProvider({ apiKey: "k", model: "gpt-live-transcribe", fetchFn });
  // buildRequestFields is the REST-path contract: realtime-only ids fail closed.
  assert.throws(() => p.buildRequestFields(undefined), /unsupported model/);
  // Explicit configured supported models are preserved verbatim.
  const ok = new OpenAiSttProvider({ apiKey: "k", model: "gpt-4o-mini-transcribe", fetchFn });
  assert.deepEqual(ok.buildRequestFields(undefined), { model: "gpt-4o-mini-transcribe", response_format: "json" });
  // Default REST request serializes model/config without mutation.
  const prod = new OpenAiSttProvider({ apiKey: "k", model: "gpt-4o-transcribe", fetchFn });
  assert.deepEqual(prod.buildRequestFields("auto"), { model: "gpt-4o-transcribe", response_format: "json" });
  assert.deepEqual(prod.buildRequestFields("bg"), { model: "gpt-4o-transcribe", response_format: "json", language: "bg" });
});

test("HR-02 OpenAI STT: realtime delta goes to partial sink, never final", async () => {
  const deltas: string[] = [];
  let sink: ((t: string) => void) | undefined;
  const factory = () => ({
    send(_d: string): void {},
    close(): void {},
    onmessage: null as ((e: { data: unknown }) => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as ((e: unknown) => void) | null,
  });
  void sink;
  const noRest = (async () => {
    throw new Error("no rest");
  }) as unknown as typeof fetch;
  const p = new OpenAiSttProvider({
    apiKey: "k",
    model: "gpt-live-transcribe",
    fetchFn: noRest,
    socketFactory: factory as never,
  });
  p.setPartialSink((t) => deltas.push(t));
  assert.deepEqual(deltas, []);
  await p.cancel("noop");
});
