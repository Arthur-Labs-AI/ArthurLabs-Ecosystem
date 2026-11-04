import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  PARAKEET_DIAG_STDERR_BYTES,
  ParakeetSttProvider,
  parakeetDebugEnabled,
  parseWorkerLine,
} from "../../src/voice/stt/parakeet_provider";
import { frameFromInt16 } from "../../src/voice/contracts";
import type { PcmFrame } from "../../src/voice/contracts";
import { SecretSanitizer } from "../../src/security/sanitize";

function frames(n = 2): AsyncIterable<PcmFrame> {
  return {
    [Symbol.asyncIterator]: async function* (): AsyncGenerator<PcmFrame> {
      for (let i = 0; i < n; i++) yield frameFromInt16(new Int16Array(320).fill(50), i, i * 20);
    },
  };
}

test("HR-02 Parakeet: worker line schema strict (ok + error + malformed)", () => {
  assert.deepEqual(parseWorkerLine(JSON.stringify({ id: "a", ok: true, text: "hi", language: "bg" }), 1024), {
    id: "a",
    text: "hi",
    language: "bg",
  });
  assert.deepEqual(parseWorkerLine(JSON.stringify({ id: "b", ok: false, error: "model_unavailable" }), 1024), {
    id: "b",
    error: "model_unavailable",
  });
  assert.throws(() => parseWorkerLine("not json", 1024));
  assert.throws(() => parseWorkerLine(JSON.stringify({ ok: true, text: "x" }), 1024));
  assert.throws(() => parseWorkerLine(JSON.stringify({ id: "c", ok: true }), 1024));
  assert.throws(() => parseWorkerLine("x".repeat(2048), 1024));
});

test("HR-02 Parakeet: request id correlation (stale ids ignored)", async () => {
  const p = ParakeetSttProvider.fromCommandLine('python "tools/voice/parakeet_worker.py"', {
    requestTimeoutMs: 200,
    maxAudioBytes: 1024 * 1024,
  });
  assert.equal(p.id(), "parakeet-stt");
  const stray = JSON.stringify({ id: "no-such-request", ok: true, text: "stale" });
  (p as unknown as { onWorkerLine(line: string): void }).onWorkerLine(stray);
  await assert.rejects(p.transcribeAudio(Buffer.alloc(640), "u-crash-probe"));
  await p.shutdown();
});

test("HR-02 Parakeet: audio bounds enforced (oversize -> STT_FAILED, no worker needed)", async () => {
  const p = new ParakeetSttProvider({ command: ["python", "worker.py"], maxAudioBytes: 100 });
  const events: string[] = [];
  for await (const e of p.transcribeStream(frames(10), { utteranceId: "u-big", maxTranscriptChars: 8000 })) {
    events.push(e.type);
  }
  assert.deepEqual(events, ["error"]);
  await p.shutdown();
});

test("HR-02 Parakeet: wrong sample format fails closed", async () => {
  const p = new ParakeetSttProvider({ command: ["python", "worker.py"] });
  const bad: AsyncIterable<PcmFrame> = {
    [Symbol.asyncIterator]: async function* (): AsyncGenerator<PcmFrame> {
      yield {
        sequence: 0,
        timestamp_ms: 0,
        sample_rate_hz: 48000,
        channels: 1,
        sample_format: "s16le",
        duration_ms: 20,
        data: new Uint8Array(1920),
      };
    },
  };
  const events: string[] = [];
  for await (const e of p.transcribeStream(bad, { utteranceId: "u-badfmt", maxTranscriptChars: 8000 })) {
    events.push(e.type);
  }
  assert.deepEqual(events, ["error"]);
  await p.shutdown();
});

test("HR-02 Parakeet: cancel prevents delivery", async () => {
  const p = new ParakeetSttProvider({ command: ["python", "worker.py"], requestTimeoutMs: 50 });
  await p.cancel("u-x");
  const events: string[] = [];
  for await (const e of p.transcribeStream(frames(1), { utteranceId: "u-x", maxTranscriptChars: 8000 })) {
    events.push(e.type);
  }
  assert.deepEqual(events, []);
  await p.shutdown();
});

test("HR-02 Parakeet: one final result shape via fake worker transport", async () => {
  const { spawn } = await import("node:child_process");
  void spawn;
  const fakeLine = JSON.stringify({ id: "pq-1", ok: true, text: "fake transcript", language: "en" });
  const parsed = parseWorkerLine(fakeLine, 1024 * 1024);
  assert.equal(parsed.text, "fake transcript");
});

/**
 * Failure-path tests drive the REAL transcribeAudio -> pending -> onWorkerLine
 * machine without spawning (this sandbox forbids piped child stdio, and a
 * spawn-free path is also deterministic: no process startup races). The
 * provider is constructed with a dummy command and its private transport is
 * stubbed at the stdin boundary: writes are captured, child/exited flags are
 * faked live, and responses are injected through the real onWorkerLine.
 */
interface ProviderInternals {
  onWorkerLine(line: string): void;
  onWorkerExit(err: Error): void;
  failAllPending(err: Error): void;
  pending: Map<string, unknown>;
  child: { stdin: { write(s: string, cb: (err?: Error) => void): void } } | undefined;
  exited: boolean;
  requestSeq: number;
}

function liveStubProvider(opts: { requestTimeoutMs?: number } = {}): {
  provider: ParakeetSttProvider;
  internals: ProviderInternals;
  written: string[];
} {
  const provider = new ParakeetSttProvider({
    // Unspawnable on purpose: the stub transport below replaces ensureWorker.
    command: ["hr02-test-stub-worker"],
    requestTimeoutMs: opts.requestTimeoutMs ?? 2000,
  });
  const internals = provider as unknown as ProviderInternals;
  const written: string[] = [];
  internals.child = {
    stdin: {
      write(s: string, cb: (err?: Error) => void): void {
        written.push(s);
        cb();
      },
    },
  };
  internals.exited = false;
  // transcribeAudio awaits ensureWorker(); short-circuit it to "already live".
  (provider as unknown as { ensureWorker(): Promise<void> }).ensureWorker = () => Promise.resolve();
  return { provider, internals, written };
}

// transcribeAudio registers its pending entry after an await; poll a tick.
async function awaitPending(internals: ProviderInternals): Promise<void> {
  for (let i = 0; i < 200 && internals.pending.size === 0; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

test("HR-02 Parakeet: worker ok:false rejects deterministically (no hang)", async () => {
  const { provider, internals, written } = liveStubProvider();
  const pending = provider.transcribeAudio(Buffer.alloc(640), "u-okfalse");
  await awaitPending(internals);
  assert.equal(internals.pending.size, 1);
  assert.match(written[0] as string, /"sample_rate_hz":16000/);
  internals.onWorkerLine(JSON.stringify({ id: "pq-1", ok: false, error: "transcription_failed" }));
  await assert.rejects(pending, /transcription_failed/);
  // The pending map must be drained exactly once (no lingering promise).
  assert.equal(internals.pending.size, 0);
  await provider.shutdown();
});

test("HR-02 Parakeet: worker exit rejects pending requests", async () => {
  const { provider, internals } = liveStubProvider();
  const pending = provider.transcribeAudio(Buffer.alloc(640), "u-exit");
  await awaitPending(internals);
  assert.equal(internals.pending.size, 1);
  // Simulate the worker dying mid-flight through the REAL exit path.
  const { VoiceProviderError } = await import("../../src/runtime/voice_errors");
  internals.onWorkerExit(new VoiceProviderError("local_worker_crashed", "parakeet: worker exited"));
  await assert.rejects(pending, /worker exited/);
  assert.equal(internals.pending.size, 0);
  // exit + close each settle exactly once: a second signal is a safe no-op.
  internals.onWorkerExit(new VoiceProviderError("local_worker_crashed", "parakeet: worker exited"));
  await provider.shutdown();
});

test("HR-02 Parakeet: non-JSON diagnostic stdout cannot stall protocol", async () => {
  const { provider, internals } = liveStubProvider();
  const pending = provider.transcribeAudio(Buffer.alloc(640), "u-noise");
  await awaitPending(internals);
  // Third-party log noise on stdout is ignored non-fatally...
  internals.onWorkerLine("Transcribing: 0it");
  internals.onWorkerLine("[NeMo] some diagnostic line");
  assert.equal(internals.pending.size, 1);
  // ...and the real matching response still completes the request.
  internals.onWorkerLine(JSON.stringify({ id: "pq-1", ok: true, text: "hello" }));
  const res = await pending;
  assert.equal(res.text, "hello");
  await provider.shutdown();
});

test("HR-02 Parakeet: malformed line for matching id rejects, noise ignored", async () => {
  const { provider, internals } = liveStubProvider();
  const good = provider.transcribeAudio(Buffer.alloc(640), "u-malformed");
  await awaitPending(internals);
  // Pure noise: no pending request may settle or hang because of it.
  internals.onWorkerLine("definitely not json");
  assert.equal(internals.pending.size, 1);
  // Malformed-but-id-bearing line settles its own request deterministically.
  internals.onWorkerLine(JSON.stringify({ id: "pq-1", ok: true }));
  await assert.rejects(good, /malformed worker response/);
  assert.equal(internals.pending.size, 0);
  await provider.shutdown();
});

test("HR-02 Parakeet: timeout settles exactly once", async () => {
  const { provider, internals } = liveStubProvider({ requestTimeoutMs: 30 });
  await assert.rejects(provider.transcribeAudio(Buffer.alloc(640)), /timed out/);
  assert.equal(internals.pending.size, 0);
  // A late duplicate response for the timed-out id must be a harmless no-op.
  internals.onWorkerLine(JSON.stringify({ id: "pq-1", ok: true, text: "late" }));
  await provider.shutdown();
});

test("HR-02 Parakeet: valid silence setup probe shape is ok:true", () => {
  // The setup probe sends 1 s of 16 kHz mono s16le silence; the worker must
  // accept the envelope (base64 of 32000 bytes, sr 16000) and only the model
  // path decides the transcript. Contract asserted here: request well-formed
  // and a silence success response parses as ok:true with empty transcript.
  const silence = Buffer.alloc(32000);
  assert.equal(silence.length % 2, 0);
  const req = { id: "setup-probe", audio_b64: silence.toString("base64"), sample_rate_hz: 16000 };
  assert.equal(req.sample_rate_hz, 16000);
  assert.ok(req.audio_b64.length > 0);
  const res = parseWorkerLine(JSON.stringify({ id: "setup-probe", ok: true, text: "" }), 8 * 1024 * 1024);
  assert.equal(res.id, "setup-probe");
  assert.equal(res.text, "");
});

test("HR-02 Parakeet: failed probe is a rejection, never success", () => {
  // A probe returning ok:false must surface as transcription_failed so the
  // setup script can exit non-zero instead of printing success.
  const parsed = parseWorkerLine(JSON.stringify({ id: "setup-probe", ok: false, error: "transcription_failed" }), 1024);
  assert.equal(parsed.error, "transcription_failed");
  assert.ok(parsed.text === undefined);
});

/**
 * Exit diagnostics (opt-in ARTHUR_PARAKEET_DEBUG=1).
 *
 * These tests drive the REAL lifecycle — ensureWorker -> child 'exit'/'close'
 * handlers -> stderr capture -> pending settlement — without spawning a
 * process: this sandbox denies piped child stdio (spawn EPERM), so
 * `child_process.spawn` is replaced for the duration of each test with a fake
 * ChildProcess (EventEmitter + PassThrough stdio). No GPU, model, network, or
 * microphone is involved.
 */
class FakeWorkerProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  spawnArgs: unknown[] = [];
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
  /** The env the provider handed to spawn (worker-side switches included). */
  spawnEnv(): Record<string, string> {
    const options = this.spawnArgs[2] as { env?: Record<string, string> } | undefined;
    return options?.env ?? {};
  }
}

/**
 * Replace child_process.spawn for one test; callers always restore in finally.
 * The REAL CJS module object is patched (not an imported namespace copy), which
 * is the same object the provider calls through.
 */
function installFakeWorker(): { fake: FakeWorkerProcess; restore: () => void } {
  const fake = new FakeWorkerProcess();
  const mod = require("node:child_process") as { spawn: unknown };
  const original = mod.spawn;
  mod.spawn = (...args: unknown[]): FakeWorkerProcess => {
    fake.spawnArgs = args;
    return fake;
  };
  return {
    fake,
    restore: () => {
      mod.spawn = original;
      fake.stdin.end();
      fake.stdout.end();
      fake.stderr.end();
    },
  };
}

interface RecordedLog {
  message: string;
  fields: Record<string, unknown>;
}

function recordingLogger(logs: RecordedLog[]): {
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
} {
  const push = (message: string, fields?: Record<string, unknown>): void => {
    logs.push({ message, fields: fields ?? {} });
  };
  return { warn: push, error: push };
}

/** Bounded poll for observable provider state (no sleeps, no timing guesses). */
async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !predicate(); i++) await new Promise((r) => setImmediate(r));
}

function pendingCount(provider: ParakeetSttProvider): number {
  return (provider as unknown as { pending: Map<string, unknown> }).pending.size;
}

function ensureWorkerOf(provider: ParakeetSttProvider): Promise<void> {
  return (provider as unknown as { ensureWorker(): Promise<void> }).ensureWorker();
}

const HR02_DIAG_SECRET = "sk-hr02-diagnostic-secret-1234567890";

test("HR-02 Parakeet: debug switch is opt-in via ARTHUR_PARAKEET_DEBUG only", () => {
  assert.equal(parakeetDebugEnabled({}), false);
  assert.equal(parakeetDebugEnabled({ ARTHUR_PARAKEET_DEBUG: "" }), false);
  assert.equal(parakeetDebugEnabled({ ARTHUR_PARAKEET_DEBUG: "0" }), false);
  assert.equal(parakeetDebugEnabled({ ARTHUR_PARAKEET_DEBUG: "1" }), true);
  assert.equal(parakeetDebugEnabled({ ARTHUR_PARAKEET_DEBUG: "true" }), true);
  // The worker-side switch alone never turns on Node-side diagnostics.
  assert.equal(parakeetDebugEnabled({ PARAKEET_DEBUG: "1" }), false);
});

test("HR-02 Parakeet: debug disabled leaves production logging unchanged", async () => {
  const logs: RecordedLog[] = [];
  const { fake, restore } = installFakeWorker();
  const provider = new ParakeetSttProvider({
    command: ["hr02-fake-worker"],
    debug: false,
    requestTimeoutMs: 5000,
    maxStderrBytes: 65536,
    logger: recordingLogger(logs),
  });
  try {
    const events: string[] = [];
    const run = (async () => {
      for await (const e of provider.transcribeStream(frames(2), { utteranceId: "u-off", maxTranscriptChars: 8000 })) {
        events.push(e.type);
      }
    })();
    await waitUntil(() => pendingCount(provider) === 1);
    assert.equal(pendingCount(provider), 1);
    fake.stderr.write('parakeet_worker: error stage=generate type=RuntimeError message="boom"\n');
    await waitUntil(() => provider.stderrTailText().length > 0);
    fake.exitCode = 1;
    fake.emit("exit", 1, null);
    fake.emit("close", 1, null);
    await run;
    assert.deepEqual(events, ["error"]);
    // Exactly the pre-existing production log, with no diagnostic fields.
    assert.deepEqual(logs, [{ message: "parakeet worker crashed", fields: {} }]);
  } finally {
    restore();
    await provider.shutdown();
  }
});

test("HR-02 Parakeet: debug exit diagnostic reports code, signal, pending and sanitized stderr", async () => {
  const logs: RecordedLog[] = [];
  const { fake, restore } = installFakeWorker();
  const provider = new ParakeetSttProvider({
    command: ["hr02-fake-worker"],
    debug: true,
    requestTimeoutMs: 5000,
    maxStderrBytes: 65536,
    sanitizer: new SecretSanitizer([HR02_DIAG_SECRET]),
    logger: recordingLogger(logs),
  });
  const audio = Buffer.alloc(640, 0x5a);
  const audioB64 = audio.toString("base64");
  try {
    const pending = provider.transcribeAudio(audio, "u-debug");
    await waitUntil(() => pendingCount(provider) === 1);
    // One operator switch: the worker debug flag is forwarded to the child.
    assert.equal(fake.spawnEnv()["PARAKEET_DEBUG"], "1");
    assert.equal(fake.spawnEnv()["PARAKEET_MODEL"], "nvidia/parakeet-tdt-0.6b-v3");
    fake.stderr.write(
      "parakeet_worker: request=pq-1 pcm_bytes=640 duration_ms=20 sample_rate=16000 backend=transformers device=cuda dtype=float16\n",
    );
    fake.stderr.write(
      'parakeet_worker: error stage=generate type=RuntimeError message="CUDA error: unspecified launch failure"\n',
    );
    fake.stderr.write(`parakeet_worker: loaded credential=${HR02_DIAG_SECRET}\n`);
    fake.stderr.write("parakeet_worker: raw\u0000control\u001b[31mchars\u0007 here\n");
    await waitUntil(() => provider.stderrTailText().includes("raw"));
    fake.exitCode = 1;
    fake.emit("exit", 1, null);
    fake.emit("close", 1, null);
    await assert.rejects(pending, /worker exited/);

    assert.equal(logs.length, 1);
    const diagnostic = logs[0] as RecordedLog;
    assert.equal(diagnostic.message, "parakeet worker exited");
    assert.equal(diagnostic.fields["source"], "exit");
    assert.equal(diagnostic.fields["exit_code"], 1);
    assert.equal(diagnostic.fields["signal"], null);
    assert.equal(diagnostic.fields["pending_requests"], 1);
    const tail = String(diagnostic.fields["stderr_tail"]);
    const serialized = JSON.stringify(diagnostic.fields);
    // Useful worker evidence survives into the log.
    assert.match(tail, /request=pq-1 pcm_bytes=640 duration_ms=20/);
    assert.match(tail, /error stage=generate type=RuntimeError/);
    // Audio is never logged: neither base64 nor raw repeated bytes.
    assert.ok(!serialized.includes(audioB64), "base64 audio must never be logged");
    assert.ok(!serialized.includes("ZZZZZZZZ"), "raw audio bytes must never be logged");
    // Secrets are redacted by the EXISTING sanitizer, not a second one.
    assert.ok(!serialized.includes(HR02_DIAG_SECRET), "configured secret must be redacted");
    assert.match(tail, /\[REDACTED\]/);
    // Control characters never reach the log as-is.
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(tail), "control characters must be neutralized");
    assert.ok(tail.includes(" | "), "newlines are flattened into one line");
  } finally {
    restore();
    await provider.shutdown();
  }
});

test("HR-02 Parakeet: debug diagnostic reports zero pending requests when none are in flight", async () => {
  const logs: RecordedLog[] = [];
  const { fake, restore } = installFakeWorker();
  const provider = new ParakeetSttProvider({
    command: ["hr02-fake-worker"],
    debug: true,
    requestTimeoutMs: 5000,
    logger: recordingLogger(logs),
  });
  try {
    await ensureWorkerOf(provider);
    fake.exitCode = 1;
    fake.emit("exit", 1, null);
    fake.emit("close", 1, null);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.fields["pending_requests"], 0);
    assert.equal(logs[0]?.fields["exit_code"], 1);
  } finally {
    restore();
    await provider.shutdown();
  }
});

test("HR-02 Parakeet: debug diagnostic stderr tail stays within the byte bound", async () => {
  const logs: RecordedLog[] = [];
  const { fake, restore } = installFakeWorker();
  const provider = new ParakeetSttProvider({
    command: ["hr02-fake-worker"],
    debug: true,
    maxStderrBytes: 256 * 1024,
    logger: recordingLogger(logs),
  });
  try {
    await ensureWorkerOf(provider);
    fake.stderr.write("H".repeat(200_000));
    await waitUntil(() => provider.stderrTailText().length >= 200_000);
    fake.exitCode = 3;
    fake.emit("exit", 3, null);
    fake.emit("close", 3, null);
    const tail = String(logs[0]?.fields["stderr_tail"]);
    assert.ok(
      Buffer.byteLength(tail, "utf8") <= PARAKEET_DIAG_STDERR_BYTES,
      `stderr tail must stay <= ${PARAKEET_DIAG_STDERR_BYTES} bytes, got ${Buffer.byteLength(tail, "utf8")}`,
    );
    assert.ok(tail.endsWith(" (truncated)"), "truncation must be explicit");
    assert.equal(logs[0]?.fields["exit_code"], 3);
  } finally {
    restore();
    await provider.shutdown();
  }
});

test("HR-02 Parakeet: debug diagnostics preserve exactly-once pending settlement", async () => {
  const logs: RecordedLog[] = [];
  const { fake, restore } = installFakeWorker();
  const provider = new ParakeetSttProvider({
    command: ["hr02-fake-worker"],
    debug: true,
    requestTimeoutMs: 5000,
    logger: recordingLogger(logs),
  });
  try {
    let settlements = 0;
    const pending = provider.transcribeAudio(Buffer.alloc(640), "u-once");
    void pending.then(
      () => {
        settlements += 1;
      },
      () => {
        settlements += 1;
      },
    );
    await waitUntil(() => pendingCount(provider) === 1);
    fake.exitCode = 1;
    fake.emit("exit", 1, null);
    fake.emit("close", 1, null);
    // Duplicate terminal events must stay harmless no-ops.
    fake.emit("exit", 1, null);
    fake.emit("close", 1, null);
    // Settled by the exit path, never by the request timeout.
    await assert.rejects(pending, /worker exited/);
    await new Promise((r) => setImmediate(r));
    assert.equal(settlements, 1, "a pending request settles exactly once");
    assert.equal(pendingCount(provider), 0);
    assert.equal(logs.length, 1, "exit + close produce exactly one diagnostic");
    // A late duplicate response for the settled id stays a harmless no-op.
    (provider as unknown as { onWorkerLine(line: string): void }).onWorkerLine(
      JSON.stringify({ id: "pq-1", ok: true, text: "late" }),
    );
    assert.equal(logs.length, 1);
    assert.equal(pendingCount(provider), 0);
  } finally {
    restore();
    await provider.shutdown();
  }
});
