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
    { capability: "llm", provider: "openai", providerName: "OpenAI", models: ["gpt-4.1-mini", "gpt-5-mini"], status: "ready" },
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
    await expect(createMobileClient(() => Promise.resolve({ capability: "tts", outcome: "connected" })).testProvider("llm")).rejects.toThrow("invalid provider test result");
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
