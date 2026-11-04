import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

/**
 * STT Quality v2 (TASK-0008) wrapper contract tests.
 *
 * tools/voice/stt_wrapper.cjs is exercised twice:
 *   - as a module, for the pure argv/parse helpers (language profiles,
 *     prompt assembly, detected-language extraction), and
 *   - end-to-end as a spawned process against a deterministic whisper-cli
 *     stand-in (tools/voice/fixtures/whisper_stub_fixture.cjs) so argv
 *     construction, the single JSON line, and temp WAV cleanup are
 *     observed for real.
 *
 * Signal-based cleanup is only deliverable on POSIX: the provider kills
 * wrappers with taskkill /F on Windows, which bypasses JS handlers by OS
 * design. That case is a documented platform skip, never a silent one.
 */

const TOOLS_VOICE = join(__dirname, "..", "..", "..", "tools", "voice");
const WRAPPER = join(TOOLS_VOICE, "stt_wrapper.cjs");
const STUB = join(TOOLS_VOICE, "fixtures", "whisper_stub_fixture.cjs");

interface WrapperModule {
  MAX_PROMPT_CHARS: number;
  buildWhisperArgs(input: {
    cli: string;
    model: string;
    wavPath: string;
    language?: string;
    prompt?: string;
    extraArgs?: string;
  }): string[];
  extractWhisperText(out: string): string | undefined;
  extractDetectedLanguage(text: string): { language: string; probability: number } | undefined;
}
const wrapper = require(WRAPPER) as WrapperModule;

/** Hermetic env: every wrapper-controlled key is pinned for the child. */
function wrapperEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WHISPER_CLI: "",
    WHISPER_MODEL: "",
    ARTHUR_STT_MODEL_PATH: "",
    ARTHUR_STT_LANGUAGE: "",
    ARTHUR_STT_INITIAL_PROMPT: "",
    WHISPER_EXTRA_ARGS: "",
    ...extra,
  };
}

interface WrapperRun {
  code: number;
  stdout: string;
  stderr: string;
}

function runWrapper(
  env: Record<string, string>,
  input: Buffer = Buffer.alloc(3200),
  timeoutMs = 20000,
): Promise<WrapperRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRAPPER], {
      env: wrapperEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("stt_wrapper run timed out"));
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: out, stderr: err });
    });
    child.stdin.end(input);
  });
}

function parseJsonLine(stdout: string): Record<string, unknown> {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
  assert.equal(lines.length, 1, "wrapper must emit exactly one JSON result line");
  return JSON.parse(lines[0] as string) as Record<string, unknown>;
}

function stubCli(): string {
  return '"' + process.execPath + '" "' + STUB + '"';
}

function newTempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), "arthur-wrapper-" + tag + "-"));
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for " + what);
}

// ---------------------------------------------------------------------------
// A-C: language profiles in the engine argv
// ---------------------------------------------------------------------------

test("A: explicit English profile forwards -l en to whisper-cli", () => {
  const argv = wrapper.buildWhisperArgs({ cli: "whisper-cli", model: "m.bin", wavPath: "t.wav", language: "en" });
  const li = argv.indexOf("-l");
  assert.notEqual(li, -1, "-l flag must be present");
  assert.equal(argv[li + 1], "en");
});

test("B: explicit Bulgarian profile forwards -l bg to whisper-cli", () => {
  const argv = wrapper.buildWhisperArgs({ cli: "whisper-cli", model: "m.bin", wavPath: "t.wav", language: "bg" });
  const li = argv.indexOf("-l");
  assert.deepEqual(argv.slice(li, li + 2), ["-l", "bg"]);
});

test("C: auto profile keeps the documented -l auto behavior", () => {
  for (const language of ["auto", "", undefined]) {
    const argv = wrapper.buildWhisperArgs({ cli: "whisper-cli", model: "m.bin", wavPath: "t.wav", language });
    const li = argv.indexOf("-l");
    assert.equal(argv[li + 1], "auto", "language " + JSON.stringify(language) + " must resolve to auto");
  }
});

test("wrapper never passes -np (it suppresses whisper.cpp language logs)", () => {
  const argv = wrapper.buildWhisperArgs({ cli: "whisper-cli", model: "m.bin", wavPath: "t.wav", language: "auto" });
  assert.equal(argv.includes("-np"), false, "-np hides the auto-detected language line");
  assert.deepEqual(argv.slice(0, 6), ["whisper-cli", "-m", "m.bin", "-f", "t.wav", "-l"]);
});

// ---------------------------------------------------------------------------
// D-F: initial prompt contract
// ---------------------------------------------------------------------------

test("D: initial prompt is one logical CLI argument with spaces and commas intact", () => {
  const prompt = "ARTHUR, Nexus, AutoPulse";
  const argv = wrapper.buildWhisperArgs({ cli: "whisper-cli", model: "m.bin", wavPath: "t.wav", language: "en", prompt });
  const pi = argv.indexOf("--prompt");
  assert.notEqual(pi, -1, "--prompt flag must be present");
  assert.equal(argv[pi + 1], prompt, "prompt must stay a single unmodified argv element");
  assert.equal(argv.filter((a) => a === "--prompt").length, 1);
});

test("E: empty or whitespace-only prompt omits the --prompt flag", () => {
  for (const prompt of ["", "   ", undefined]) {
    const argv = wrapper.buildWhisperArgs({ cli: "whisper-cli", model: "m.bin", wavPath: "t.wav", language: "en", prompt });
    assert.equal(argv.includes("--prompt"), false, "no prompt flag for " + JSON.stringify(prompt));
  }
});

test("F: prompt over the documented bound is rejected (fail closed)", () => {
  assert.equal(wrapper.MAX_PROMPT_CHARS, 2048);
  assert.throws(
    () => wrapper.buildWhisperArgs({ cli: "whisper-cli", model: "m.bin", wavPath: "t.wav", language: "en", prompt: "x".repeat(2049) }),
    /initial prompt exceeds 2048 characters/,
  );
  const atLimit = wrapper.buildWhisperArgs({ cli: "whisper-cli", model: "m.bin", wavPath: "t.wav", language: "en", prompt: "x".repeat(2048) });
  assert.equal(atLimit.includes("--prompt"), true, "exactly 2048 characters must be accepted");
});

test("detected-language extraction parses whisper.cpp auto-detection logs only", () => {
  assert.deepEqual(wrapper.extractDetectedLanguage("whisper_full_with_state: auto-detected language: en (p = 0.995679)"), {
    language: "en",
    probability: 0.995679,
  });
  assert.equal(wrapper.extractDetectedLanguage("whisper_full_with_state: auto-detected language = bg (p = 0.85)")?.language, "bg");
  assert.equal(wrapper.extractDetectedLanguage("no language log in here"), undefined);
  assert.equal(wrapper.extractDetectedLanguage("auto-detected language: en (p = 7)"), undefined, "probability must be within [0,1]");
});

// ---------------------------------------------------------------------------
// G-J + cleanup: end-to-end wrapper runs against the deterministic stub
// ---------------------------------------------------------------------------

test("G: explicit language echoes into the wrapper JSON and engine argv", async () => {
  const dir = newTempDir("en");
  const argvFile = join(dir, "argv.json");
  const run = await runWrapper({
    WHISPER_CLI: stubCli(),
    WHISPER_MODEL: "model.bin",
    ARTHUR_STT_LANGUAGE: "en",
    FIXTURE_ARGV_FILE: argvFile,
  });
  assert.equal(run.code, 0, "stderr: " + run.stderr.slice(-400));
  const result = parseJsonLine(run.stdout);
  assert.equal(result.text, "hello world");
  assert.equal(result.language, "en");
  assert.equal("confidence" in result, false, "no fabricated confidence");
  const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  const li = argv.indexOf("-l");
  assert.deepEqual(argv.slice(li, li + 2), ["-l", "en"]);
  assert.equal(argv.includes("--prompt"), false);
  rmSync(dir, { recursive: true, force: true });
});

test("e2e: ARTHUR_STT_INITIAL_PROMPT reaches the engine argv as one intact argument", async () => {
  const dir = newTempDir("prompt");
  const argvFile = join(dir, "argv.json");
  const run = await runWrapper({
    WHISPER_CLI: stubCli(),
    WHISPER_MODEL: "model.bin",
    ARTHUR_STT_LANGUAGE: "en",
    ARTHUR_STT_INITIAL_PROMPT: "ARTHUR, Nexus, AutoPulse, DeepSeek, GitHub, Engineering Mode",
    FIXTURE_ARGV_FILE: argvFile,
  });
  assert.equal(run.code, 0, "stderr: " + run.stderr.slice(-400));
  const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  const pi = argv.indexOf("--prompt");
  assert.notEqual(pi, -1);
  assert.equal(argv[pi + 1], "ARTHUR, Nexus, AutoPulse, DeepSeek, GitHub, Engineering Mode");
  rmSync(dir, { recursive: true, force: true });
});

test("H: auto mode reports the engine-detected language from whisper logs", async () => {
  const dir = newTempDir("auto");
  const run = await runWrapper({
    WHISPER_CLI: stubCli(),
    WHISPER_MODEL: "model.bin",
    ARTHUR_STT_LANGUAGE: "auto",
    FIXTURE_STDERR_LINE: "whisper_full_with_state: auto-detected language: bg (p = 0.987654)\r\n",
  });
  assert.equal(run.code, 0);
  const result = parseJsonLine(run.stdout);
  assert.equal(result.language, "bg", "detected language must be reported in auto mode");
  assert.equal("confidence" in result, false, "language probability is never passed off as confidence");
  rmSync(dir, { recursive: true, force: true });
});

test("H: auto mode without a detection log leaves language undefined (never fabricated)", async () => {
  const dir = newTempDir("auto-none");
  const run = await runWrapper({
    WHISPER_CLI: stubCli(),
    WHISPER_MODEL: "model.bin",
    ARTHUR_STT_LANGUAGE: "auto",
  });
  assert.equal(run.code, 0);
  const result = parseJsonLine(run.stdout);
  assert.equal(result.language, undefined);
  assert.equal("confidence" in result, false);
  rmSync(dir, { recursive: true, force: true });
});

test("I: temporary WAV is deleted on success", async () => {
  const dir = newTempDir("cleanup-ok");
  const argvFile = join(dir, "argv.json");
  const run = await runWrapper({
    WHISPER_CLI: stubCli(),
    WHISPER_MODEL: "model.bin",
    FIXTURE_ARGV_FILE: argvFile,
  });
  assert.equal(run.code, 0);
  const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  const wav = argv[argv.indexOf("-f") + 1] as string;
  assert.ok(wav.endsWith(".wav"), "engine must receive a WAV file path");
  assert.equal(existsSync(wav), false, "temp WAV must be deleted after success");
  rmSync(dir, { recursive: true, force: true });
});

test("I: temporary WAV is deleted when the engine exits non-zero", async () => {
  const dir = newTempDir("cleanup-fail");
  const argvFile = join(dir, "argv.json");
  const run = await runWrapper({
    WHISPER_CLI: stubCli(),
    WHISPER_MODEL: "model.bin",
    FIXTURE_ARGV_FILE: argvFile,
    FIXTURE_EXIT_CODE: "3",
  });
  assert.equal(run.code, 2, "wrapper must fail closed with exit code 2");
  const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  const wav = argv[argv.indexOf("-f") + 1] as string;
  assert.equal(existsSync(wav), false, "temp WAV must be deleted after engine failure");
  rmSync(dir, { recursive: true, force: true });
});

test("I: temporary WAV is deleted when the engine cannot spawn", async () => {
  const tmp = tmpdir();
  const before = readdirSync(tmp).filter((f) => f.startsWith("arthur-stt-"));
  const run = await runWrapper({
    WHISPER_CLI: "C:/arthur-no-such-whisper-xyz-12345.exe",
    WHISPER_MODEL: "model.bin",
  });
  assert.equal(run.code, 2);
  const after = readdirSync(tmp).filter((f) => f.startsWith("arthur-stt-"));
  assert.equal(after.length, before.length, "no temp WAV may leak after a spawn failure");
});

test("I: SIGINT removes the temporary WAV (POSIX signal delivery only)", async (t) => {
  if (process.platform === "win32") {
    return t.skip("taskkill /F cannot deliver signals to JS handlers on Windows; documented wrapper limitation");
  }
  const dir = newTempDir("sigint");
  const argvFile = join(dir, "argv.json");
  const child = spawn(process.execPath, [WRAPPER], {
    env: wrapperEnv({
      WHISPER_CLI: stubCli(),
      WHISPER_MODEL: "model.bin",
      FIXTURE_ARGV_FILE: argvFile,
      FIXTURE_STALL_MS: "8000",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitFor(() => existsSync(argvFile), 4000, "stub to record argv");
  const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  const wav = argv[argv.indexOf("-f") + 1] as string;
  assert.ok(existsSync(wav), "temp WAV must exist while the engine runs");
  child.kill("SIGINT");
  await new Promise<number | null>((resolve) => child.once("close", resolve));
  assert.equal(existsSync(wav), false, "SIGINT handler must delete the temp WAV");
  rmSync(dir, { recursive: true, force: true });
});

test("F: oversized prompt fails closed before the engine is spawned", async () => {
  const dir = newTempDir("prompt-big");
  const argvFile = join(dir, "argv.json");
  const run = await runWrapper({
    WHISPER_CLI: stubCli(),
    WHISPER_MODEL: "model.bin",
    ARTHUR_STT_INITIAL_PROMPT: "SECRET-PROMPT-CONTENT-MARKER" + "x".repeat(3000),
    FIXTURE_ARGV_FILE: argvFile,
  });
  assert.equal(run.code, 2);
  assert.ok(run.stderr.includes("initial prompt exceeds"), "failure must explain the bound");
  assert.equal(run.stderr.includes("SECRET-PROMPT-CONTENT-MARKER"), false, "prompt content must never be logged");
  assert.equal(existsSync(argvFile), false, "engine must never be spawned");
  rmSync(dir, { recursive: true, force: true });
});

test("J: shell metacharacters in the prompt stay inert data", async () => {
  const dir = newTempDir("inject");
  const argvFile = join(dir, "argv.json");
  const prompt = '$(calc.exe) & del * | echo pwned; rm -rf / "quoted arg"';
  const run = await runWrapper({
    WHISPER_CLI: stubCli(),
    WHISPER_MODEL: "model.bin",
    ARTHUR_STT_LANGUAGE: "en",
    ARTHUR_STT_INITIAL_PROMPT: prompt,
    FIXTURE_ARGV_FILE: argvFile,
  });
  assert.equal(run.code, 0, "metacharacters must not break the wrapper");
  const result = parseJsonLine(run.stdout);
  assert.equal(result.text, "hello world", "transcription must still be produced");
  const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  const pi = argv.indexOf("--prompt");
  assert.equal(argv[pi + 1], prompt, "prompt must arrive as one unmodified data argument");
  rmSync(dir, { recursive: true, force: true });
});

test("wrapper still fails closed when no model path is configured", async () => {
  const run = await runWrapper({});
  assert.equal(run.code, 2);
  assert.ok(run.stderr.includes("WHISPER_MODEL"), "failure must name the missing model configuration");
});
