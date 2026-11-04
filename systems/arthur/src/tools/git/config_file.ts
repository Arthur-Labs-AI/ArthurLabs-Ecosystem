/**
 * SC-05 production git catalog loading (TASK-0022).
 *
 * Trusted machine-local configuration source for the SC-05 repository
 * catalog. The normal CLI/API startup path reads an optional setting
 * (ARTHUR_GIT_CONFIG) that points to a machine-local JSON file using the
 * EXACT existing GitCapabilityConfig schema (no second schema), parses and
 * validates it, and feeds it into the same existing path:
 *
 *   ARTHUR_GIT_CONFIG -> loadGitCapabilityConfigFromFile
 *     -> buildApp -> buildDefaultLocalHost -> LocalGitAdapter
 *     -> registerGitPack (the existing six git.* tools)
 *
 * Startup semantics (fail closed):
 *   - setting absent/empty  -> git capability disabled, startup succeeds,
 *     git.* tools absent.
 *   - setting present+valid -> all six git tools registered.
 *   - setting present but malformed/unreadable/invalid ->
 *     ArthurError INVALID_CONFIG out of buildApp (never silently disabled).
 *
 * Security notes:
 *   - No auto-discovery, no directory/drive scanning, no parent probing.
 *   - The model never provides physical paths; only this trusted file does,
 *     and its entries still pass the frozen validateGitCapabilityConfig
 *     contract plus the per-call repository validator.
 *   - File contents are never logged; error messages carry only the failure
 *     reason, never catalog contents.
 */

import { readFileSync } from "node:fs";

import { ArthurError } from "../../core/errors/errors";
import { validateGitCapabilityConfig, type GitCapabilityConfig } from "./repository_catalog";

/** Environment variable naming the machine-local git catalog file. */
export const GIT_CONFIG_ENV_VAR = "ARTHUR_GIT_CONFIG";

/** Hard bound for the catalog file (64 repos max fit in a few KB). */
export const GIT_CONFIG_MAX_BYTES = 256 * 1024;

function invalid(message: string): ArthurError {
  return new ArthurError("INVALID_CONFIG", message);
}

/**
 * Parse + validate one machine-local git catalog file.
 * Throws ArthurError INVALID_CONFIG when the file is unreadable,
 * oversized, malformed JSON, or rejected by validateGitCapabilityConfig.
 */
export function loadGitCapabilityConfigFromFile(filePath: string): GitCapabilityConfig {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw invalid(
      "Invalid git capability config: " +
        GIT_CONFIG_ENV_VAR +
        " points to an unreadable file (" +
        (err instanceof Error ? err.message : String(err)) +
        ")",
    );
  }
  if (Buffer.byteLength(raw, "utf8") > GIT_CONFIG_MAX_BYTES) {
    throw invalid("Invalid git capability config: catalog file exceeds size limit");
  }
  // Tolerate a UTF-8 BOM so Windows-saved machine-local files still load.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw invalid(
      "Invalid git capability config: catalog file is not valid JSON (" +
        (err instanceof Error ? err.message : String(err)) +
        ")",
    );
  }
  try {
    validateGitCapabilityConfig(parsed);
  } catch (err) {
    throw invalid(
      "Invalid git capability config: " + (err instanceof Error ? err.message : String(err)),
    );
  }
  return parsed;
}

/**
 * Resolve the production git capability config from the configured file
 * path (Settings.gitConfigPath, sourced from ARTHUR_GIT_CONFIG).
 * Empty/absent -> undefined (capability disabled). Present -> parsed and
 * validated (throws INVALID_CONFIG on any failure; never silent).
 */
export function resolveGitCapabilityConfig(gitConfigPath: string): GitCapabilityConfig | undefined {
  const trimmed = gitConfigPath.trim();
  if (trimmed === "") return undefined;
  return loadGitCapabilityConfigFromFile(trimmed);
}
