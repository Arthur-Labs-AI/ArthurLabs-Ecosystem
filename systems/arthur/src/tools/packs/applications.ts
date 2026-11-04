/**
 * SC-04 applications tool pack (spec sections 41-49, 60).
 *
 * app.list (read) + app.launch (low_write, mutation, never retry,
 * unsupported cancellation after dispatch). Model supplies app_id
 * only: executable/args/env stay trusted catalog data.
 */

import { ArthurMode } from "../../core/modes/mode";
import type { LocalCapabilityHost } from "../local_host";
import type { ToolRegistry } from "../registry";
import type { ToolExecutionPolicy } from "../execution_policy";

const NO_RETRY_CANCEL_UNSUPPORTED: ToolExecutionPolicy = {
  effects: "mutation",
  attempt_timeout_ms: 5000,
  total_timeout_ms: 10000,
  abort_grace_ms: 1000,
  cancellation: "unsupported",
  idempotency: "none",
  retry: { strategy: "off", max_attempts: 1, base_delay_ms: 100, max_delay_ms: 2000 },
  reconciliation: "none",
  result_persistence: "summary_only",
};

const APP_ID_SCHEMA = { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_]*$" };

export function registerApplicationsPack(registry: ToolRegistry, host: LocalCapabilityHost): void {
  registry.register(
    {
      name: "app.list",
      version: "1.0.0",
      description: "List the registered applications ARTHUR may launch (id + name + availability, no executable paths). Read-only.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      output_schema: {
        type: "object",
        properties: {
          applications: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                available: { type: "boolean" },
              },
              required: ["id", "name", "available"],
              additionalProperties: false,
            },
          },
        },
        required: ["applications"],
        additionalProperties: false,
      },
      risk: "read",
      allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
    },
    async () => {
      const applications = await host.applications.list();
      return { ok: true, summary: applications.length + " application(s)", data: { applications: applications } };
    },
  );

  registry.register(
    {
      name: "app.launch",
      version: "1.0.0",
      description: "Launch a registered application by id via the trusted catalog (no executable/args/env from the model).",
      input_schema: {
        type: "object",
        properties: { app_id: APP_ID_SCHEMA },
        required: ["app_id"],
        additionalProperties: false,
      },
      output_schema: {
        type: "object",
        properties: {
          app_id: { type: "string" },
          launched: { type: "boolean" },
        },
        required: ["app_id", "launched"],
        additionalProperties: false,
      },
      risk: "low_write",
      allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
      execution_policy: NO_RETRY_CANCEL_UNSUPPORTED,
    },
    async (args) => {
      const launched = await host.applications.launch(String(args.app_id));
      return { ok: true, summary: "Launched " + launched.app_id, data: launched };
    },
  );
}
