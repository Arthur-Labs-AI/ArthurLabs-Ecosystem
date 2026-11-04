/**
 * HR-02.5A: deterministic normalization of raw platform facts.
 *
 * Pure functions only. No I/O, no subprocesses, no model knowledge.
 * The public hardware contract never exposes raw platform strings or
 * command output; every raw fact passes through here first.
 */

import type { CapabilityState, GpuVendor, HardwareArch, HardwareOs } from "./contracts";

/** Normalize Node `process.platform` / `os.platform()` values. */
export function normalizeOs(raw: string | null | undefined): HardwareOs {
  if (raw === null || raw === undefined) return "unknown";
  const v = raw.trim().toLowerCase();
  if (v === "win32" || v === "windows") return "windows";
  if (v === "linux") return "linux";
  if (v === "android") return "android";
  if (v === "darwin" || v === "macos" || v === "mac os" || v === "osx") return "darwin";
  return "unknown";
}

/** Normalize Node `process.arch` / `os.arch()` values. */
export function normalizeArch(raw: string | null | undefined): HardwareArch {
  if (raw === null || raw === undefined) return "unknown";
  const v = raw.trim().toLowerCase();
  if (v === "x64" || v === "x86_64" || v === "amd64" || v === "x86-64") return "x64";
  if (v === "arm64" || v === "aarch64") return "arm64";
  return "unknown";
}

/**
 * Deterministically classify a GPU name into a vendor bucket.
 * Matching is case-insensitive substring matching over well-known tokens;
 * anything unrecognized stays "unknown" (never guessed).
 */
export function normalizeGpuVendor(rawName: string | null | undefined): GpuVendor {
  if (rawName === null || rawName === undefined) return "unknown";
  const v = rawName.toLowerCase();
  if (/(geforce|quadro|tesla|nvidia|rtx [0-9]|gtx [0-9]|nvs |a100|h100|nvml)/.test(v)) return "nvidia";
  if (/(radeon|rx [0-9]|vega|rx vega|navi|radeonpro|firepro|amd)/.test(v)) return "amd";
  if (/(intel|iris|uhd graphics|hd graphics|arc a[0-9]|xe graphics)/.test(v)) return "intel";
  if (v.trim() === "") return "unknown";
  return "other";
}

/** Normalize a byte count to whole MiB; rejects non-finite input. */
export function normalizeBytesToMb(bytes: number | null | undefined): number | null {
  if (bytes === null || bytes === undefined) return null;
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return null;
  return Math.max(1, Math.floor(bytes / (1024 * 1024)));
}

/** Normalize a logical CPU count; rejects non-integer / non-positive input. */
export function normalizeLogicalCores(count: number | null | undefined): number | null {
  if (count === null || count === undefined) return null;
  if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) return null;
  return count;
}

/** Normalize a free-form CPU/GPU model string; blank becomes null. */
export function normalizeModelName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim().replace(/\s+/g, " ");
  return v === "" ? null : v;
}

/**
 * Normalize a VRAM value in MiB; accepts null (not discoverable) and
 * rejects non-finite / non-positive values as unknown.
 */
export function normalizeVramMb(mb: number | null | undefined): number | null {
  if (mb === null || mb === undefined) return null;
  if (typeof mb !== "number" || !Number.isFinite(mb) || mb <= 0) return null;
  return Math.floor(mb);
}

/**
 * Combine a tri-state detection outcome. Explicit errors carry a state:
 * probes report "unknown" when the check could not run (missing command,
 * timeout, unreadable output) and "unavailable" only when absence was
 * positively established (e.g. command ran and reported no such runtime).
 */
export function orUnknown(state: CapabilityState | null | undefined): CapabilityState {
  if (state === "available" || state === "unavailable" || state === "unknown") return state;
  return "unknown";
}
