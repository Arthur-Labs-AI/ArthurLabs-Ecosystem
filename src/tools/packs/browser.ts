/**
 * SC-04 browser tool pack (spec sections 52-59).
 *
 * browser.open_url (low_write, mutation, never retry, unsupported
 * cancellation after OS dispatch). Strict URL validation lives in
 * browser_policy; the adapter only receives validated http/https URLs.
 */

import { ArthurError } from "../../core/errors/errors";
import { ArthurMode } from "../../core/modes/mode";
import { validateBrowserUrl } from "../browser_policy";
import type { ToolExecutionPolicy } from "../execution_policy";
import type { LocalCapabilityHost } from "../local_host";
import type { ToolRegistry } from "../registry";

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

export function registerBrowserPack(registry: ToolRegistry, host: LocalCapabilityHost): void {
  registry.register(
    {
      name: "browser.open_url",
      version: "1.0.0",
      description: "Open an http/https URL in the default browser via the OS launcher (no fetch, localhost allowed).",
      input_schema: {
        type: "object",
        properties: { url: { type: "string", minLength: 1, maxLength: 4096 } },
        required: ["url"],
        additionalProperties: false,
      },
      output_schema: {
        type: "object",
        properties: {
          url: { type: "string" },
          opened: { type: "boolean" },
        },
        required: ["url", "opened"],
        additionalProperties: false,
      },
      risk: "low_write",
      allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
      execution_policy: NO_RETRY_CANCEL_UNSUPPORTED,
    },
    async (args) => {
      let validated: string;
      try {
        validated = validateBrowserUrl(args.url);
      } catch (err) {
        throw new ArthurError("TOOL_ARGUMENT_INVALID", err instanceof Error ? err.message : "Invalid URL");
      }
      const opened = await host.browser.openUrl(validated);
      return { ok: true, summary: "Opened " + validated, data: opened };
    },
  );
}
