/**
 * HR-02 Parakeet worker contract regressions (deterministic, no GPU/model/network).
 *
 * The real Transformers/model path stays opt-in (live probe only). These tests
 * drive the worker with committed fake `transformers` + `torch` modules
 * (tests/voice/fixtures/hr02_stub/) served first on PYTHONPATH, recording the
 * observable contract:
 *
 *   transformers backend selected by default (NeMo never imported)
 *   CPU -> float32; CUDA available -> float16 (honest fallback chain tested)
 *   explicit cuda with no CUDA -> fail-closed model_unavailable
 *   model init exactly once across three sequential requests
 *   valid PCM -> transcript via in-memory waveform (no temp files)
 *   strict invalid PCM cases -> bounded failures, generate never called
 *   stdout -> protocol JSON only; third-party stdout noise redirected
 *   stderr diagnostics -> bounded backend/device/dtype line
 *
 * Sandbox notes: this environment forbids piped child stdio (spawn EPERM),
 * so the worker is driven through repo-local scratch files
 * (./.tmp/hr02-parakeet/): the request stream goes to an input file and
 * python redirects its own stdio from/to files.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { PARAKEET_MAX_LINE_BYTES, parseWorkerLine } from "../../src/voice/stt/parakeet_provider";

const WORKER = path.join(process.cwd(), "tools", "voice", "parakeet_worker.py");
const STUB_DIR = path.join(process.cwd(), "tests", "voice", "fixtures", "hr02_stub");

interface StubConfig {
  transcript?: string;
  failGenerate?: boolean;
  failProcessor?: boolean;
  failDecode?: boolean;
  emptyResult?: boolean;
  rejectDtypes?: string[];
  printNoise?: string;
  cudaAvailable?: boolean;
  /** Deterministic CUDA memory values (MB) for diagnostic assertions. */
  vramAllocatedMb?: number;
  vramReservedMb?: number;
  vramFreeMb?: number;
  vramTotalMb?: number;
}

/** Repo-local scratch root (platform temp is not writable-sandboxed here). */
function scratchRoot(): string {
  const dir = path.join(process.cwd(), ".tmp", "hr02-parakeet");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let caseSeq = 0;

function silenceB64(bytes: number): string {
  return Buffer.alloc(bytes).toString("base64");
}

interface RunResult {
  lines: string[];
  stderr: string;
  events: Record<string, unknown>[];
  counts: Record<string, number>;
  /** Worker process exit code (null when the spawn itself failed). */
  status: number | null;
}

interface WorkerDriverOpts {
  /** stdout text encoding for the worker process (default "utf-8"). */
  stdoutEncoding?: string;
  /** Hide stdout.reconfigure to simulate a host where it is unavailable. */
  noStreamReconfigure?: boolean;
}

function runWorker(
  requests: unknown[],
  stub: StubConfig = {},
  extraEnv: Record<string, string> = {},
  driverOpts: WorkerDriverOpts = {},
): RunResult {
  caseSeq += 1;
  const caseDir = path.join(scratchRoot(), `case-${process.pid}-${caseSeq}`);
  fs.mkdirSync(caseDir, { recursive: true });
  const inFile = path.join(caseDir, "in.jsonl");
  const outFile = path.join(caseDir, "out.jsonl");
  const errFile = path.join(caseDir, "err.txt");
  const recordFile = path.join(caseDir, "events.json");
  const countFile = path.join(caseDir, "counts.json");
  const configFile = path.join(caseDir, "stub-config.json");
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      transcript: stub.transcript ?? "hello world",
      fail_generate: stub.failGenerate ?? false,
      fail_processor: stub.failProcessor ?? false,
      fail_decode: stub.failDecode ?? false,
      empty_result: stub.emptyResult ?? false,
      reject_dtypes: stub.rejectDtypes ?? [],
      print_noise: stub.printNoise ?? "",
      cuda_available: stub.cudaAvailable ?? false,
      vram_allocated_mb: stub.vramAllocatedMb ?? 0,
      vram_reserved_mb: stub.vramReservedMb ?? 0,
      vram_free_mb: stub.vramFreeMb ?? 0,
      vram_total_mb: stub.vramTotalMb ?? 0,
      record_path: recordFile,
      count_path: countFile,
    }),
  );
  fs.writeFileSync(inFile, requests.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const driver = [
    "import sys",
    `sys.stdin = open(${JSON.stringify(inFile)}, "r", encoding="utf-8")`,
    `sys.stdout = open(${JSON.stringify(outFile)}, "w", encoding=${JSON.stringify(driverOpts.stdoutEncoding ?? "utf-8")})`,
    // A legacy Windows console starts Python with a cp1252 stdout. Hiding
    // reconfigure simulates hosts where it is unavailable, so the protocol
    // must survive on ASCII-safe serialization alone.
    ...(driverOpts.noStreamReconfigure
      ? [
          "class _NoReconfigureStdout:",
          "    def __init__(self, f):",
          "        self._f = f",
          "    def write(self, s):",
          "        return self._f.write(s)",
          "    def flush(self):",
          "        return self._f.flush()",
          "    def fileno(self):",
          "        return self._f.fileno()",
          "sys.stdout = _NoReconfigureStdout(sys.stdout)",
        ]
      : []),
    `sys.stderr = open(${JSON.stringify(errFile)}, "w", encoding="utf-8")`,
    `sys.argv = ["parakeet_worker.py"]`,
    `exec(compile(open(${JSON.stringify(WORKER)}, "r", encoding="utf-8").read(), "parakeet_worker", "exec"))`,
  ].join("\n");
  const env = {
    ...process.env,
    PYTHONPATH: STUB_DIR,
    PARAKEET_STUB_CONFIG: configFile,
    PARAKEET_DEVICE: "cpu",
    PARAKEET_BACKEND: "transformers",
    ...extraEnv,
  };
  const python = process.env.PARAKEET_TEST_PYTHON ?? "python";
  const res = spawnSync(python, ["-c", driver], { stdio: "ignore", env, timeout: 120_000 });
  if (res.error) throw res.error;
  const lines = fs
    .readFileSync(outFile, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.length > 0);
  const stderr = fs.readFileSync(errFile, "utf8");
  let events: Record<string, unknown>[] = [];
  try {
    events = JSON.parse(fs.readFileSync(recordFile, "utf8")) as Record<string, unknown>[];
  } catch {
    events = [];
  }
  let counts: Record<string, number> = {};
  try {
    counts = JSON.parse(fs.readFileSync(countFile, "utf8")) as Record<string, number>;
  } catch {
    counts = {};
  }
  fs.rmSync(caseDir, { recursive: true, force: true });
  return { lines, stderr, events, counts, status: res.status };
}

test("HR-02 worker: transformers backend selected by default (NeMo never imported)", () => {
  const { lines, stderr } = runWorker(
    [{ id: "t1", audio_b64: silenceB64(32000), sample_rate_hz: 16000 }],
    {},
  );
  assert.equal(lines.length, 1);
  const res = JSON.parse(lines[0] as string) as { id: string; ok: boolean; text: string };
  assert.equal(res.id, "t1");
  assert.equal(res.ok, true);
  assert.equal(res.text, "hello world");
  // Default backend reports transformers on the bounded stderr diagnostic.
  assert.match(stderr, /backend=transformers device=cpu dtype=float32/);
  // No NeMo import surface: the stub tree has no nemo package, so any NeMo
  // import would have failed the load with model_unavailable.
});

test("HR-02 worker: CPU selects float32 and places tensors on cpu", () => {
  const { events, stderr } = runWorker(
    [{ id: "c1", audio_b64: silenceB64(6400), sample_rate_hz: 16000 }],
    {},
    { PARAKEET_DEVICE: "cpu" },
  );
  assert.match(stderr, /dtype=float32/);
  const placed = events.filter((e) => e["kind"] === "tensor_placed").map((e) => e["placed_on"]);
  assert.ok(placed.length >= 1, "expected tensor placement records");
  for (const where of placed) assert.equal(where, "cpu");
});

test("HR-02 worker: CUDA available selects float16 on cuda", () => {
  const { stderr, events } = runWorker(
    [{ id: "g1", audio_b64: silenceB64(6400), sample_rate_hz: 16000 }],
    { cudaAvailable: true },
    { PARAKEET_DEVICE: "auto" },
  );
  assert.match(stderr, /backend=transformers device=cuda dtype=float16/);
  const placed = events.filter((e) => e["kind"] === "tensor_placed").map((e) => e["placed_on"]);
  assert.ok(placed.length >= 1);
  for (const where of placed) assert.equal(where, "cuda");
  // Input features are cast to the exact load dtype (FP16 inputs vs Half weights
  // mismatch is a hard generate error on real CUDA).
  const casts = events.filter((e) => e["kind"] === "tensor_cast").map((e) => e["cast_dtype"]);
  assert.ok(casts.length >= 1);
  for (const cast of casts) assert.equal(cast, "torch.float16");
});

test("HR-02 worker: rejected float16 falls to bfloat16, then honestly to float32", () => {
  const bf = runWorker(
    [{ id: "d1", audio_b64: silenceB64(3200), sample_rate_hz: 16000 }],
    { cudaAvailable: true, rejectDtypes: ["float16"] },
    { PARAKEET_DEVICE: "cuda" },
  );
  assert.match(bf.stderr, /device=cuda dtype=bfloat16/);
  assert.equal((JSON.parse(bf.lines[0] as string) as { ok: boolean }).ok, true);
  const f32 = runWorker(
    [{ id: "d2", audio_b64: silenceB64(3200), sample_rate_hz: 16000 }],
    { cudaAvailable: true, rejectDtypes: ["float16", "bfloat16"] },
    { PARAKEET_DEVICE: "cuda" },
  );
  // Honest fallback: still CUDA, but the diagnostic says float32.
  assert.match(f32.stderr, /device=cuda dtype=float32/);
  assert.equal((JSON.parse(f32.lines[0] as string) as { ok: boolean }).ok, true);
});

test("HR-02 worker: explicit cuda with no CUDA fails closed (model_unavailable)", () => {
  const { lines } = runWorker(
    [{ id: "x1", audio_b64: silenceB64(3200), sample_rate_hz: 16000 }],
    { cudaAvailable: false },
    { PARAKEET_DEVICE: "cuda" },
  );
  assert.equal(lines.length, 1);
  const res = JSON.parse(lines[0] as string) as { ok: boolean; error: string };
  assert.equal(res.ok, false);
  assert.equal(res.error, "model_unavailable");
});

test("HR-02 worker: model initializes exactly once across three sequential requests", () => {
  const reqs = [1, 2, 3].map((n) => ({
    id: `seq-${n}`,
    audio_b64: silenceB64(3200),
    sample_rate_hz: 16000,
  }));
  const { lines, counts, events } = runWorker(reqs, {});
  assert.equal(lines.length, 3);
  for (const [i, line] of lines.entries()) {
    const res = JSON.parse(line as string) as { id: string; ok: boolean };
    assert.equal(res.id, `seq-${i + 1}`);
    assert.equal(res.ok, true);
  }
  assert.equal(counts["model_loads"], 1);
  assert.equal(counts["processor_loads"], 1);
  assert.equal(events.filter((e) => e["kind"] === "generate_call").length, 3);
});

test("HR-02 worker: valid PCM reaches the processor as a 16 kHz float waveform", () => {
  const pcm = Buffer.alloc(3200);
  pcm.writeInt16LE(16384, 0);
  pcm.writeInt16LE(-16384, 2);
  const { events } = runWorker(
    [{ id: "w1", audio_b64: pcm.toString("base64"), sample_rate_hz: 16000 }],
    {},
  );
  const proc = events.filter((e) => e["kind"] === "processor_call");
  assert.equal(proc.length, 1);
  assert.equal(proc[0]?.["frames"], 1600);
  assert.equal(proc[0]?.["has_shape"], true);
  assert.equal(proc[0]?.["sampling_rate"], 16000);
  assert.equal(proc[0]?.["return_tensors"], "pt");
  // 16384/32768 = 0.5 peak: s16le normalization is exact.
  assert.equal(proc[0]?.["peak"], 0.5);
});

test("HR-02 worker: strict invalid PCM cases fail bounded, generate never called", () => {
  const cases: { req: unknown; error: string }[] = [
    { req: { id: "z", audio_b64: Buffer.alloc(0).toString("base64"), sample_rate_hz: 16000 }, error: "bad_audio_format" },
    { req: { id: "o", audio_b64: Buffer.alloc(3).toString("base64"), sample_rate_hz: 16000 }, error: "bad_audio_format" },
    { req: { id: "s", audio_b64: silenceB64(3200), sample_rate_hz: 48000 }, error: "bad_audio_format" },
    { req: { id: "b", audio_b64: "!!!not-base64!!!", sample_rate_hz: 16000 }, error: "bad_audio_format" },
    {
      req: { id: "h", audio_b64: silenceB64(120 * 16000 * 2 + 2), sample_rate_hz: 16000 },
      error: "audio_too_large",
    },
  ];
  const { lines, events } = runWorker(cases.map((c) => c.req), {});
  assert.equal(lines.length, cases.length);
  lines.forEach((line, i) => {
    const res = JSON.parse(line) as { id: string; ok: boolean; error: string };
    assert.equal(res.ok, false);
    assert.equal(res.error, (cases[i] as { error: string }).error);
  });
  // Rejected inputs never reach the model.
  assert.equal(events.filter((e) => e["kind"] === "generate_call").length, 0);
});

test("HR-02 worker: generate failure maps to bounded transcription_failed", () => {
  const { lines } = runWorker(
    [{ id: "f1", audio_b64: silenceB64(3200), sample_rate_hz: 16000 }],
    { failGenerate: true },
  );
  assert.equal(
    (JSON.parse(lines[0] as string) as { ok: boolean; error: string }).error,
    "transcription_failed",
  );
});

test("HR-02 worker: stdout carries protocol JSON only; third-party noise redirected", () => {
  const { lines } = runWorker(
    [{ id: "n1", audio_b64: silenceB64(6400), sample_rate_hz: 16000 }],
    { transcript: "ok after noise", printNoise: "Transcribing: 0it" },
  );
  // Exactly one stdout line, and it is the matching protocol response:
  // the stub print during generate must have gone to stderr, not stdout.
  assert.equal(lines.length, 1);
  const res = JSON.parse(lines[0] as string) as { id: string; ok: boolean; text: string };
  assert.equal(res.id, "n1");
  assert.equal(res.ok, true);
  assert.equal(res.text, "ok after noise");
});

test("HR-02 worker: stderr diagnostics are bounded (no paths, no env dumps)", () => {
  const { stderr } = runWorker(
    [{ id: "e1", audio_b64: silenceB64(3200), sample_rate_hz: 16000 }],
    {},
  );
  const diagLines = stderr.split(/\r?\n/).filter((l) => l.includes("parakeet_worker:"));
  assert.ok(diagLines.length >= 1);
  for (const line of diagLines) {
    assert.ok(line.length < 300, `diagnostic too long: ${line}`);
    assert.match(line, /^parakeet_worker: (backend=\w+ device=\w+ dtype=[\w.]+|vram .*)/);
  }
});

test("HR-02 worker: unknown backend is an explicit bounded configuration error", () => {
  const { lines, stderr } = runWorker(
    [{ id: "u1", audio_b64: silenceB64(3200), sample_rate_hz: 16000 }],
    {},
    { PARAKEET_BACKEND: "whisper" },
  );
  assert.equal((JSON.parse(lines[0] as string) as { ok: boolean; error: string }).error, "model_unavailable");
  assert.match(stderr, /unavailable \(bad_configuration\)/);
});

/** Diag lines emitted by the worker (all stderr diagnostics are prefixed). */
function diagLines(stderr: string): string[] {
  return stderr.split(/\r?\n/).filter((l) => l.includes("parakeet_worker:"));
}

/** Base64 request id line, e.g. "request=d1 pcm_bytes=... duration_ms=...". */
function requestMetaLine(stderr: string): string | undefined {
  return diagLines(stderr).find((l) => l.includes("parakeet_worker: request="));
}

test("HR-02 worker: request metadata diagnostics are opt-in and bounded", () => {
  const b64 = silenceB64(32000);
  const on = runWorker(
    [{ id: "d1", audio_b64: b64, sample_rate_hz: 16000 }],
    {},
    { PARAKEET_DEBUG: "1" },
  );
  const meta = requestMetaLine(on.stderr);
  assert.ok(meta, "debug mode must emit bounded request metadata");
  // 32000 bytes = 16000 samples = exactly 1000 ms at 16 kHz.
  assert.match(
    meta,
    /parakeet_worker: request=d1 pcm_bytes=32000 duration_ms=1000 sample_rate=16000 backend=transformers device=cpu dtype=float32/,
  );
  assert.ok(meta.length < 300, `metadata line too long: ${meta.length}`);
  // Never audio, never base64, never the transcript.
  assert.ok(!on.stderr.includes(b64), "base64 audio must never reach stderr");
  assert.ok(!on.stderr.includes("hello world"), "transcript must never reach stderr");

  // Disabled: production stderr keeps exactly its existing startup diagnostic.
  const off = runWorker(
    [{ id: "d2", audio_b64: b64, sample_rate_hz: 16000 }],
    {},
    { PARAKEET_DEBUG: "0" },
  );
  assert.equal(requestMetaLine(off.stderr), undefined);
  assert.ok(!off.stderr.includes("cuda_"), "no CUDA fields without the debug switch");
  assert.match(off.stderr, /backend=transformers device=cpu dtype=float32/);
});

test("HR-02 worker: CUDA memory is reported immediately before generate (debug only)", () => {
  const request = { id: "r1", audio_b64: silenceB64(6400), sample_rate_hz: 16000 };
  const { stderr } = runWorker(
    [request],
    {
      cudaAvailable: true,
      failGenerate: true,
      vramAllocatedMb: 1200,
      vramReservedMb: 1400,
      vramFreeMb: 6000,
      vramTotalMb: 8192,
    },
    { PARAKEET_DEVICE: "cuda", PARAKEET_DEBUG: "1" },
  );
  assert.match(
    stderr,
    /parakeet_worker: vram request=r1 cuda_allocated_mb=1200 cuda_reserved_mb=1400 cuda_free_mb=6000 cuda_total_mb=8192/,
  );
  // Ordering: request metadata -> CUDA memory -> the generate failure it explains.
  const meta = stderr.indexOf("parakeet_worker: request=r1");
  const vram = stderr.indexOf("cuda_allocated_mb");
  const failure = stderr.indexOf("error stage=generate");
  assert.ok(meta >= 0 && vram > meta, "CUDA memory must follow the request metadata");
  assert.ok(failure > vram, "CUDA memory must be emitted immediately before generate()");

  // CPU debug: no CUDA fields are fabricated.
  const cpu = runWorker([request], {}, { PARAKEET_DEVICE: "cpu", PARAKEET_DEBUG: "1" });
  assert.ok(!cpu.stderr.includes("cuda_allocated_mb"));
  assert.ok(!cpu.stderr.includes("cuda_free_mb"));
});

test("HR-02 worker: ordinary exceptions emit bounded diagnostics without tracebacks", () => {
  const request = { id: "e1", audio_b64: silenceB64(3200), sample_rate_hz: 16000 };

  const generate = runWorker([request], { failGenerate: true }, { PARAKEET_DEBUG: "0" });
  assert.equal((JSON.parse(generate.lines[0] as string) as { error: string }).error, "transcription_failed");
  const generateDiag = diagLines(generate.stderr).find((l) => l.includes("error stage="));
  assert.ok(generateDiag, "a failed generate must be diagnosed on stderr");
  assert.match(generateDiag, /error stage=generate type=RuntimeError message="stub generate boom"/);
  assert.ok(generateDiag.length < 400, `diagnostic too long: ${generateDiag.length}`);
  assert.ok(!generate.stderr.includes("Traceback"), "no traceback in normal production mode");

  const decode = runWorker([request], { failDecode: true }, { PARAKEET_DEBUG: "0" });
  // The bounded JSON error code on the wire is unchanged.
  assert.equal((JSON.parse(decode.lines[0] as string) as { error: string }).error, "transcription_failed");
  assert.match(decode.stderr, /error stage=decode type=RuntimeError message="stub decode boom"/);
  assert.ok(!decode.stderr.includes("Traceback"));

  const processor = runWorker([request], { failProcessor: true }, { PARAKEET_DEBUG: "0" });
  assert.equal((JSON.parse(processor.lines[0] as string) as { error: string }).error, "model_unavailable");
  assert.match(processor.stderr, /error stage=processor_load type=RuntimeError message="stub processor boom"/);

  const model = runWorker([request], { rejectDtypes: ["float32"] }, { PARAKEET_DEBUG: "0" });
  assert.equal((JSON.parse(model.lines[0] as string) as { error: string }).error, "model_unavailable");
  assert.match(model.stderr, /error stage=model_load type=RuntimeError dtype=float32/);
});

test("HR-02 worker: debug traceback is emitted and bounded", () => {
  const { stderr } = runWorker(
    [{ id: "t1", audio_b64: silenceB64(3200), sample_rate_hz: 16000 }],
    { failGenerate: true },
    { PARAKEET_DEBUG: "1" },
  );
  const tb = diagLines(stderr).find((l) => l.includes("traceback stage=generate"));
  assert.ok(tb, "debug mode must emit a bounded traceback");
  assert.match(tb, /RuntimeError: stub generate boom/);
  assert.ok(tb.length < 2500, `traceback diagnostic too long: ${tb.length}`);
  assert.ok(!tb.includes("\n"), "traceback is emitted as one bounded line");
});

test("HR-02 worker: exception diagnostic text is control-free and never audio", () => {
  const b64 = silenceB64(3200);
  const { stderr } = runWorker(
    [{ id: "s1", audio_b64: b64, sample_rate_hz: 16000 }],
    { failGenerate: true },
    { PARAKEET_DEBUG: "1" },
  );
  for (const line of diagLines(stderr)) {
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[\u0000-\u001f\u007f]/.test(line), `control characters in diagnostic: ${line}`);
    assert.ok(line.length < 2500, `unbounded diagnostic line: ${line.length}`);
  }
  assert.ok(!stderr.includes(b64), "audio must never reach stderr");
  assert.ok(!stderr.includes("hello world"), "transcript must never reach stderr");
});
test("HR-02 worker: Bulgarian transcript round-trips as ASCII-safe JSONL", () => {
  const transcript = "Отвори Visual Studio Code.";
  const { lines, stderr, status } = runWorker(
    [{ id: "bg1", audio_b64: silenceB64(3200), sample_rate_hz: 16000 }],
    { transcript },
  );
  // No UnicodeEncodeError crash: exactly one protocol line, exit 0.
  assert.equal(status, 0);
  assert.equal(lines.length, 1);
  // The wire is ASCII-safe even under a legacy console code page.
  assert.ok(/^[\x00-\x7F]*$/.test(lines[0] as string), "protocol JSON must be ASCII-safe");
  // Node reconstructs the exact Cyrillic text through the real parse path.
  const parsed = parseWorkerLine(lines[0] as string, PARAKEET_MAX_LINE_BYTES);
  assert.equal(parsed.text, transcript);
  assert.ok(!stderr.includes("UnicodeEncodeError"));
});

test("HR-02 worker: mixed BG/EN transcript round-trips exactly", () => {
  const transcript = "Отвори Visual Studio Code и провери current branch-а.";
  const { lines, status } = runWorker(
    [{ id: "bg2", audio_b64: silenceB64(3200), sample_rate_hz: 16000 }],
    { transcript },
  );
  assert.equal(status, 0);
  assert.equal(lines.length, 1);
  assert.ok(/^[\x00-\x7F]*$/.test(lines[0] as string), "protocol JSON must be ASCII-safe");
  assert.equal(parseWorkerLine(lines[0] as string, PARAKEET_MAX_LINE_BYTES).text, transcript);
});

test("HR-02 worker: emoji/non-Latin Unicode round-trips as valid JSONL", () => {
  const transcript = "Здравей \u{1F44B} test \u{4E2D}\u{6587}";
  const { lines, status } = runWorker(
    [{ id: "uni1", audio_b64: silenceB64(3200), sample_rate_hz: 16000 }],
    { transcript },
  );
  assert.equal(status, 0);
  assert.equal(lines.length, 1);
  assert.ok(/^[\x00-\x7F]*$/.test(lines[0] as string), "protocol JSON must be ASCII-safe");
  assert.equal(parseWorkerLine(lines[0] as string, PARAKEET_MAX_LINE_BYTES).text, transcript);
});

test("HR-02 worker: simulated cp1252 stdout still carries the protocol", () => {
  const transcript = "Отвори Visual Studio Code.";
  const { lines, stderr, status } = runWorker(
    [{ id: "cp1", audio_b64: silenceB64(3200), sample_rate_hz: 16000 }],
    { transcript },
    {},
    { stdoutEncoding: "cp1252", noStreamReconfigure: true },
  );
  assert.equal(status, 0);
  assert.equal(lines.length, 1);
  assert.equal(parseWorkerLine(lines[0] as string, PARAKEET_MAX_LINE_BYTES).text, transcript);
  assert.ok(!stderr.includes("UnicodeEncodeError"));
});

test("HR-02 worker: ASCII transcript behavior is unchanged", () => {
  const { lines, status } = runWorker(
    [{ id: "en1", audio_b64: silenceB64(3200), sample_rate_hz: 16000 }],
    { transcript: "hello world" },
  );
  assert.equal(status, 0);
  assert.equal(lines.length, 1);
  // Python's canonical separators are stable (", " / ": ").
  assert.equal(lines[0], '{"id": "en1", "ok": true, "text": "hello world"}');
  assert.equal(parseWorkerLine(lines[0] as string, PARAKEET_MAX_LINE_BYTES).text, "hello world");
});
