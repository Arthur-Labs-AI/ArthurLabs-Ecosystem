import type { RuntimeInfo } from "@arthur/contracts";

/**
 * Which implementation backs the UI.
 * - `desktop`: Tauri shell on Linux/Windows (later macOS).
 * - `mobile`: Tauri shell on Android (later iOS).
 * - `preview`: plain browser or tests, no native layer.
 */
export type ArthurClientKind = "desktop" | "mobile" | "preview";

/**
 * The only way the product UI talks to Arthur.
 *
 * Components must not reach for localhost HTTP, Tailscale addresses, SQLite,
 * Android native APIs or Node processes (Repo Structure, Rule 5). Anything the
 * UI needs is added here and implemented per platform behind this interface.
 */
export interface ArthurClient {
  readonly kind: ArthurClientKind;
  getRuntimeInfo(): Promise<RuntimeInfo>;
}
