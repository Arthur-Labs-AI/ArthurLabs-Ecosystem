import { describe, expect, it } from "vitest";
import { isAiConfig } from "@arthur/contracts";
import { AiSetupError } from "./arthur-client";
import { createMobileClient } from "./mobile-client";
import { createDesktopClient } from "./desktop-client";
import type { Invoke } from "./tauri-ipc";

const CONFIG = {
  setupCompleted: false,
  providers: [{ id: "openai", name: "OpenAI", hasCredential: true }],
  capabilities: [
    { capability: "llm", provider: "openai", providerName: "OpenAI", models: ["gpt-4.1-mini", "gpt-6-luna"], status: "ready" },
    { capability: "stt", provider: "openai", providerName: "OpenAI", models: ["gpt-4o-transcribe"], status: "ready" },
    { capability: "embeddings", provider: "openai", providerName: "OpenAI", models: ["text-embedding-3-small"], status: "ready" },
  ],
};

function recorder(reply: (command: string) => unknown) {
  const calls: { command: string; args: Record<string, unknown> | undefined }[] = [];
  const call: Invoke = (command, args) => {
    calls.push({ command, args });
    const value = reply(command);
    return Promise.resolve(value);
  };
  return { calls, call };
}

describe("provider setup over IPC", () => {
  it("sends the secret exactly once, in set_provider_credential, and gets back a configuration that cannot hold it", async () => {
    const { calls, call } = recorder(() => CONFIG);
    const client = createMobileClient(call);
    const config = await client.setCredential("openai", "test-write-only-secret");
    expect(calls).toEqual([{ command: "set_provider_credential", args: { provider: "openai", secret: "test-write-only-secret" } }]);
    expect(JSON.stringify(config)).not.toContain("test-write-only-secret");
    expect(isAiConfig(config)).toBe(true);
  });

  it("exposes only semantic credential operations: nothing can read a key back", () => {
    for (const client of [createMobileClient(), createDesktopClient()]) {
      const names = Object.keys(client).filter((name) => /key|secret|credential/i.test(name)).sort();
      expect(names).toEqual(["deleteCredential", "hasCredential", "setCredential"]);
      expect(Object.keys(client).some((name) => /^get.*(Key|Secret|Credential)/.test(name))).toBe(false);
    }
  });

  it("replaces whatever the native layer said about a failure with its own words, so a secret can never be displayed", async () => {
    const failing: Invoke = () => Promise.reject({ code: "invalidCredentialFormat", message: "test-leaky-echo was rejected" });
    const error = await createMobileClient(failing).setCredential("openai", "test-leaky-echo").catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AiSetupError);
    expect((error as AiSetupError).code).toBe("invalidCredentialFormat");
    expect((error as AiSetupError).message).not.toContain("test-leaky-echo");
  });

  it("rejects a malformed native configuration and a malformed test result", async () => {
    await expect(createMobileClient(() => Promise.resolve({ setupCompleted: "yes" })).getAiConfig()).rejects.toThrow("invalid AI configuration");
    await expect(createMobileClient(() => Promise.resolve({ capability: "speech", outcome: "connected" })).testProvider("llm")).rejects.toThrow("invalid provider test result");
  });

  it("tests, deletes and completes through their own commands", async () => {
    const { calls, call } = recorder((command) => (command === "test_provider" ? { capability: "stt", outcome: "invalidCredential" } : command === "has_provider_credential" ? true : CONFIG));
    const client = createMobileClient(call);
    expect(await client.testProvider("stt")).toEqual({ capability: "stt", outcome: "invalidCredential" });
    expect(await client.hasCredential("openai")).toBe(true);
    await client.deleteCredential("openai");
    await client.completeSetup();
    expect(calls.map((c) => c.command)).toEqual(["test_provider", "has_provider_credential", "delete_provider_credential", "complete_setup"]);
  });
});

describe("voice output over IPC", () => {
  const STATUS = { state: "idle", sessionId: 3, chunkIndex: 0, chunkCount: 1, truncated: false, outcome: "finished", failure: null, timings: { startupMs: 1, synthesisMs: 800, preparationMs: 30, timeToAudibleMs: 900, cleanupMs: 1 } };

  it("sends English and Bulgarian text exactly as written, and nothing else about the user or the provider", async () => {
    for (const text of ["Hello, Arthur.", "Здравей, Артър! Как си днес?", "Смесен текст with Latin и кирилица, 3.5 — ok…"]) {
      const { calls, call } = recorder(() => ({ sessionId: 1, chunkCount: 1, truncated: false }));
      await createMobileClient(call).speakText({ text });
      expect(calls).toEqual([{ command: "speak_text", args: { text, voice: null, model: null } }]);
    }
  });

  it("refuses empty text locally and maps a refused voice to a fixed message", async () => {
    const { calls, call } = recorder(() => ({}));
    await expect(createMobileClient(call).speakText({ text: "  \n" })).rejects.toMatchObject({ name: "SpeechError", code: "emptyText" });
    expect(calls).toEqual([]);
    const refused: Invoke = () => Promise.reject({ code: "unsupportedVoiceOrModel", message: "sk-echoed-by-provider" });
    const error = await createMobileClient(refused).speakText({ text: "Hi", voice: "nope" }).catch((failure: unknown) => failure);
    expect((error as Error).name).toBe("SpeechError");
    expect((error as Error).message).not.toContain("sk-");
  });

  it("reads a strictly validated status and rejects anything malformed", async () => {
    expect(await createMobileClient(() => Promise.resolve(STATUS)).getSpeechStatus()).toEqual(STATUS);
    await expect(createMobileClient(() => Promise.resolve({ ...STATUS, failure: "providerSaid: sk-leak" })).getSpeechStatus()).rejects.toThrow("invalid speech status");
    await expect(createMobileClient(() => Promise.resolve({ sessionId: "1" })).testVoice()).rejects.toThrow("invalid speech session");
  });

  it("stop and test voice use their own commands, and only the mobile client claims audio output", async () => {
    const { calls, call } = recorder((command) => (command === "test_voice" ? { sessionId: 2, chunkCount: 1, truncated: false } : null));
    const client = createMobileClient(call);
    await client.testVoice();
    await client.stopSpeech();
    expect(calls.map((c) => c.command)).toEqual(["test_voice", "stop_speech"]);
    expect(client.capabilities.speechOutput).toBe(true);
    expect(createDesktopClient().capabilities.speechOutput).toBe(false);
  });

  it("exposes no way to get audio or a credential back", () => {
    const names = Object.keys(createMobileClient()).filter((name) => /speech|speak|testVoice/i.test(name));
    expect(names.sort()).toEqual(["getSpeechStatus", "speakText", "stopSpeech", "testVoice"]);
  });
});
