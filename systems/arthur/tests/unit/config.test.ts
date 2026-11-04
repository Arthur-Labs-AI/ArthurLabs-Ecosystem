import { test } from "node:test";
import assert from "node:assert/strict";

import { ArthurError } from "../../src/core/errors/errors";
import { loadSettings } from "../../src/config/settings";
import { validateSettings } from "../../src/config/validation";

test("validateSettings accepts a valid fake configuration", () => {
  const settings = validateSettings(loadSettings({ modelProvider: "fake" }));
  assert.equal(settings.modelProvider, "fake");
  assert.equal(settings.modelName, "fake-model");
});

test("validateSettings rejects an unknown provider", () => {
  assert.throws(
    () => validateSettings(loadSettings({ modelProvider: "qwen" as never })),
    (err: unknown) => err instanceof ArthurError && err.code === "INVALID_CONFIG",
  );
});

test("validateSettings requires an API key for deepseek", () => {
  assert.throws(
    () =>
      validateSettings(
        loadSettings({ modelProvider: "deepseek", modelName: "deepseek-chat", deepseekApiKey: "" }),
      ),
    (err: unknown) =>
      err instanceof ArthurError && err.code === "INVALID_CONFIG" && err.message.includes("DEEPSEEK_API_KEY"),
  );
});

test("validateSettings rejects an invalid port", () => {
  assert.throws(
    () => validateSettings(loadSettings({ bindPort: 0 })),
    (err: unknown) => err instanceof ArthurError && err.code === "INVALID_CONFIG",
  );
});

test("validateSettings rejects an invalid reasoning profile", () => {
  assert.throws(
    () => validateSettings(loadSettings({ reasoningProfile: "extreme" as never })),
    (err: unknown) => err instanceof ArthurError && err.code === "INVALID_CONFIG",
  );
});

// ---- Phase 2 physical memory DB isolation (audit) ------------------------

test("validateSettings allows distinct normal memory database paths", () => {
  const settings = validateSettings(
    loadSettings({
      memoryPersonalDbPath: "./data/memory-personal.db",
      memoryBusinessDbPath: "./data/memory-business.db",
    }),
  );
  assert.equal(settings.memoryPersonalDbPath, "./data/memory-personal.db");
  assert.equal(settings.memoryBusinessDbPath, "./data/memory-business.db");
});

test("validateSettings rejects identical literal memory database paths", () => {
  assert.throws(
    () =>
      validateSettings(
        loadSettings({
          memoryPersonalDbPath: "./data/memory.db",
          memoryBusinessDbPath: "./data/memory.db",
        }),
      ),
    (err: unknown) =>
      err instanceof ArthurError &&
      err.code === "INVALID_CONFIG" &&
      err.message.includes("Personal and Business memory databases must use different physical files"),
  );
});

test("validateSettings rejects different relative spellings resolving to the same memory database path", () => {
  assert.throws(
    () =>
      validateSettings(
        loadSettings({
          memoryPersonalDbPath: "data/../data/memory.db",
          memoryBusinessDbPath: "data/memory.db",
        }),
      ),
    (err: unknown) =>
      err instanceof ArthurError &&
      err.code === "INVALID_CONFIG" &&
      err.message.includes("Personal and Business memory databases must use different physical files"),
  );
});

test("validateSettings rejects memory database paths differing only by case on Windows", (t) => {
  if (process.platform !== "win32") return t.skip("case-insensitive paths are a Windows concern");
  assert.throws(
    () =>
      validateSettings(
        loadSettings({
          memoryPersonalDbPath: "data/memory.db",
          memoryBusinessDbPath: "DATA/MEMORY.DB",
        }),
      ),
    (err: unknown) =>
      err instanceof ArthurError &&
      err.code === "INVALID_CONFIG" &&
      err.message.includes("Personal and Business memory databases must use different physical files"),
  );
});

test("validateSettings allows both memory databases in :memory: mode (test composition)", () => {
  const settings = validateSettings(
    loadSettings({ memoryPersonalDbPath: ":memory:", memoryBusinessDbPath: ":memory:" }),
  );
  assert.equal(settings.memoryPersonalDbPath, ":memory:");
  assert.equal(settings.memoryBusinessDbPath, ":memory:");
});
