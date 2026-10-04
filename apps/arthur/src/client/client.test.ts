import { describe, expect, it, vi } from "vitest";
import { createArthurClient, selectClientKind } from "./index";
import { createPreviewClient } from "./preview-client";
import type { Invoke } from "./tauri-ipc";

const validPayload = { appVersion: "0.1.0", platform: "linux" };

describe("selectClientKind", () => {
  it("uses the preview client outside Tauri", () => {
    expect(selectClientKind({ isTauri: false })).toBe("preview");
    expect(selectClientKind({ isTauri: false, tauriPlatform: "android" })).toBe("preview");
  });

  it("uses the desktop client for Tauri on desktop platforms", () => {
    for (const tauriPlatform of ["linux", "windows", "macos", undefined]) {
      expect(selectClientKind({ isTauri: true, tauriPlatform })).toBe("desktop");
    }
  });

  it("uses the mobile client for Tauri on Android and iOS", () => {
    expect(selectClientKind({ isTauri: true, tauriPlatform: "android" })).toBe("mobile");
    expect(selectClientKind({ isTauri: true, tauriPlatform: "ios" })).toBe("mobile");
  });
});

describe("createArthurClient", () => {
  it("returns a preview client that needs no native layer", async () => {
    const client = createArthurClient({ isTauri: false });
    expect(client.kind).toBe("preview");
    await expect(client.getRuntimeInfo()).resolves.toEqual({ appVersion: "0.0.0-preview", platform: "unknown" });
  });

  it.each([
    ["desktop", { isTauri: true, tauriPlatform: "linux" }],
    ["mobile", { isTauri: true, tauriPlatform: "android" }],
  ] as const)("reads runtime info over IPC for the %s client", async (kind, env) => {
    const call = vi.fn<Invoke>().mockResolvedValue(validPayload);
    const client = createArthurClient(env, call);
    expect(client.kind).toBe(kind);
    await expect(client.getRuntimeInfo()).resolves.toEqual(validPayload);
    expect(call).toHaveBeenCalledExactlyOnceWith("get_runtime_info");
  });

  it("rejects a malformed native payload instead of passing it to the UI", async () => {
    const env = { isTauri: true, tauriPlatform: "linux" };
    for (const bad of [null, "linux", {}, { appVersion: "0.1.0" }, { appVersion: "0.1.0", platform: "beos" }]) {
      const client = createArthurClient(env, vi.fn<Invoke>().mockResolvedValue(bad));
      await expect(client.getRuntimeInfo()).rejects.toThrow("invalid runtime info");
    }
  });

  it("propagates native errors", async () => {
    const client = createArthurClient({ isTauri: true }, vi.fn<Invoke>().mockRejectedValue(new Error("ipc down")));
    await expect(client.getRuntimeInfo()).rejects.toThrow("ipc down");
  });
});

const stored = { id: "0b8f3c1e-0000-4000-8000-000000000001", source: "text", content: "idea", createdAt: "2026-10-04T12:00:00.123456789Z" };
const androidEnv = { isTauri: true, tauriPlatform: "android" };

describe("mobile client local persistence", () => {
  it("is selected on Android and persists through the native create_capture command", async () => {
    const call = vi.fn<Invoke>().mockResolvedValue(stored);
    const client = createArthurClient(androidEnv, call);
    expect(client.kind).toBe("mobile");

    await expect(client.createCapture({ source: "text", content: "idea" })).resolves.toEqual(stored);
    expect(call).toHaveBeenCalledExactlyOnceWith("create_capture", { input: { source: "text", content: "idea" } });
  });

  it("lists captures through the native list_captures command, preserving order", async () => {
    const second = { ...stored, id: "0b8f3c1e-0000-4000-8000-000000000002", content: "later" };
    const call = vi.fn<Invoke>().mockResolvedValue([second, stored]);
    const client = createArthurClient(androidEnv, call);

    await expect(client.listCaptures()).resolves.toEqual([second, stored]);
    expect(call).toHaveBeenCalledExactlyOnceWith("list_captures");
  });

  it("never sends caller-supplied identity or timestamps to the native layer", async () => {
    const call = vi.fn<Invoke>().mockResolvedValue(stored);
    const client = createArthurClient(androidEnv, call);
    const forged = { source: "text", content: "idea", id: "forged", createdAt: "1999-01-01T00:00:00Z" };

    await client.createCapture(forged as never);
    expect(call).toHaveBeenCalledWith("create_capture", { input: { source: "text", content: "idea" } });
  });

  it("rejects invalid input without calling the native layer", async () => {
    const call = vi.fn<Invoke>();
    const client = createArthurClient(androidEnv, call);

    for (const bad of [{ source: "text", content: "   " }, { source: "mind-reading", content: "x" }, { source: "text", content: "x".repeat(20_001) }]) {
      await expect(client.createCapture(bad as never)).rejects.toThrow("Invalid capture");
    }
    expect(call).not.toHaveBeenCalled();
  });

  it("fails safely on malformed native responses", async () => {
    const malformed = [null, "x", {}, { ...stored, source: "carrier-pigeon" }, { ...stored, createdAt: "yesterday" }, { ...stored, id: "" }];
    for (const bad of malformed) {
      const client = createArthurClient(androidEnv, vi.fn<Invoke>().mockResolvedValue(bad));
      await expect(client.createCapture({ source: "text", content: "idea" })).rejects.toThrow("invalid capture");
    }
    for (const bad of [null, {}, [stored, { ...stored, id: "" }], [{ nope: true }]]) {
      const client = createArthurClient(androidEnv, vi.fn<Invoke>().mockResolvedValue(bad));
      await expect(client.listCaptures()).rejects.toThrow("invalid capture list");
    }
  });

  it("propagates native storage errors", async () => {
    const client = createArthurClient(androidEnv, vi.fn<Invoke>().mockRejectedValue("capture database is unreadable"));
    await expect(client.listCaptures()).rejects.toBe("capture database is unreadable");
  });

  it("gives the desktop client the same capture commands", async () => {
    const call = vi.fn<Invoke>().mockResolvedValue([]);
    await createArthurClient({ isTauri: true, tauriPlatform: "linux" }, call).listCaptures();
    expect(call).toHaveBeenCalledWith("list_captures");
  });
});

describe("preview client captures", () => {
  it("starts empty, lists newest first, and assigns unique ids and timestamps itself", async () => {
    let n = 0;
    const client = createPreviewClient({ newId: () => `id-${++n}`, now: () => new Date(Date.UTC(2026, 9, 4, 12, 0, n)) });

    await expect(client.listCaptures()).resolves.toEqual([]);
    const a = await client.createCapture({ source: "text", content: "first" });
    const b = await client.createCapture({ source: "text", content: "second" });

    expect(a.id).not.toBe(b.id);
    expect((await client.listCaptures()).map((c) => c.content)).toEqual(["second", "first"]);
    expect(await client.listCaptures()).toEqual(await client.listCaptures());
  });

  it("validates input like the native store", async () => {
    const client = createPreviewClient();
    await expect(client.createCapture({ source: "text", content: " \n" })).rejects.toThrow("Invalid capture");
    await expect(client.listCaptures()).resolves.toEqual([]);
  });
});
