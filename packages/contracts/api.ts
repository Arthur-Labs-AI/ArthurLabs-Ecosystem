/**
 * Contracts returned by an Arthur host to the product UI.
 *
 * Today the host is the native Tauri shell (IPC); later it also covers the
 * Home Node API. Payloads that cross a process boundary arrive as untyped JSON,
 * so each one ships with a runtime guard.
 */

export const ARTHUR_PLATFORMS = ["linux", "windows", "android", "macos", "ios", "unknown"] as const;

export type ArthurPlatform = (typeof ARTHUR_PLATFORMS)[number];

export function isArthurPlatform(value: unknown): value is ArthurPlatform {
  return typeof value === "string" && (ARTHUR_PLATFORMS as readonly string[]).includes(value);
}

export interface RuntimeInfo {
  /** Version of the native application shell. */
  appVersion: string;
  /** Operating system the native layer is running on. */
  platform: ArthurPlatform;
}

export function isRuntimeInfo(value: unknown): value is RuntimeInfo {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.appVersion === "string" &&
    candidate.appVersion.length > 0 &&
    isArthurPlatform(candidate.platform)
  );
}
