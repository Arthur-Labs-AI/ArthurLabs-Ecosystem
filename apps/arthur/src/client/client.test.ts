import { describe, expect, it, vi } from "vitest";
import { createArthurClient, selectClientKind } from "./index";
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
