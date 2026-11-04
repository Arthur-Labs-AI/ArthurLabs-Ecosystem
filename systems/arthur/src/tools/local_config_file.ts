/**
 * SC-04 production local capability loading (TASK-0025).
 *
 * Trusted machine-local configuration source for the existing SC-04
 * LocalCapabilityConfig. The normal CLI/API startup path reads an optional
 * setting (ARTHUR_LOCAL_CONFIG) that points to a machine-local JSON file
 * using the EXACT existing LocalCapabilityConfig schema (no second schema),
 * parses and validates it, and feeds it into the same existing path:
 *
 *   ARTHUR_LOCAL_CONFIG -> loadLocalCapabilityConfigFromFile
 *     -> buildApp -> buildDefaultLocalHost -> NodeLocalApplicationAdapter
 *     -> registerApplicationsPack (the existing app.list / app.launch)
 *
 * Startup semantics (fail closed):
 *   - setting absent/empty  -> existing default local behavior (workspace
 *     filesystem root, default filesystem bounds, empty app catalog).
 *   - setting present+valid -> scopes/bounds/apps from the trusted file.
 *   - setting present but malformed/unreadable/invalid ->
 *     ArthurError INVALID_CONFIG out of buildApp (never silently disabled).
 *
 * Security notes (frozen SC-04 contract preserved):
 *   - No auto-discovery, no Program Files / Start Menu / PATH / registry /
 *     drive / directory scanning, no parent probing.
 *   - The model never provides executable paths or args; only this trusted
 *     file does, and its entries still pass the frozen
 *     validateLocalCapabilityConfig contract (absolute executable, fixed
 *     args, no shell/command fields, unique ids).
 *   - File contents are never logged; error messages carry only the failure
 *     reason, never catalog contents or physical paths.
 */

import { readFileSync } from "node:fs";

import { ArthurError } from "../core/errors/errors";
import { validateLocalCapabilityConfig, type LocalCapabilityConfig } from "./local_config";

/** Environment variable naming the machine-local local-capability file. */
export const LOCAL_CONFIG_ENV_VAR = "ARTHUR_LOCAL_CONFIG";

/** Hard bound for the local capability file (mirrors the git catalog loader). */
export const LOCAL_CONFIG_MAX_BYTES = 256 * 1024;

function invalid(message: string): ArthurError {
  return new ArthurError("INVALID_CONFIG", message);
}

/**
 * Parse + validate one machine-local local-capability file.
 * Throws ArthurError INVALID_CONFIG when the file is unreadable,
 * oversized, malformed JSON, or rejected by validateLocalCapabilityConfig.
 */
export function loadLocalCapabilityConfigFromFile(filePath: string): LocalCapabilityConfig {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw invalid(
      "Invalid local capability config: " +
        LOCAL_CONFIG_ENV_VAR +
        " points to an unreadable file (" +
        (err instanceof Error ? err.message : String(err)) +
        ")",
    );
  }
  if (Buffer.byteLength(raw, "utf8") > LOCAL_CONFIG_MAX_BYTES) {
    throw invalid("Invalid local capability config: config file exceeds size limit");
  }
  // Tolerate a UTF-8 BOM so Windows-saved machine-local files still load.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw invalid(
      "Invalid local capability config: config file is not valid JSON (" +
        (err instanceof Error ? err.message : String(err)) +
        ")",
    );
  }
  try {
    validateLocalCapabilityConfig(parsed);
  } catch (err) {
    throw invalid(
      "Invalid local capability config: " + (err instanceof Error ? err.message : String(err)),
    );
  }
  return parsed;
}

/**
 * Resolve the production local capability config from the configured file
 * path (Settings.localConfigPath, sourced from ARTHUR_LOCAL_CONFIG).
 * Empty/absent -> undefined (existing default behavior). Present -> parsed
 * and validated (throws INVALID_CONFIG on any failure; never silent).
 */
export function resolveLocalCapabilityConfig(localConfigPath: string): LocalCapabilityConfig | undefined {
  const trimmed = localConfigPath.trim();
  if (trimmed === "") return undefined;
  return loadLocalCapabilityConfigFromFile(trimmed);
}
