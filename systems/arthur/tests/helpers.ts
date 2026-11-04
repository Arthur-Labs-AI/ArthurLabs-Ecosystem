import { randomUUID } from "node:crypto";

import { buildApp, BuildDeps } from "../src/app";
import { SettingsOverrides } from "../src/config/settings";
import type { App } from "../src/app";

/** Build an offline App with an in-memory DB and the FakeProvider. */
export function buildTestApp(overrides: SettingsOverrides = {}, deps: BuildDeps = {}): App {
  return buildApp(
    {
      dbPath: ":memory:",
      modelProvider: "fake",
      logLevel: "error",
      approvalTtlSeconds: 300,
      memoryPersonalDbPath: ":memory:",
      memoryBusinessDbPath: ":memory:",
      embeddingProvider: "fake",
      ...overrides,
    },
    deps,
  );
}

export function validTurn(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: "personal",
    message: "hello",
    client_request_id: `req-${randomUUID()}`,
    ...partial,
  };
}