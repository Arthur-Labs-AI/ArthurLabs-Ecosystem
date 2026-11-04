/**
 * HR-01: provider execution-locality contract.
 *
 * `RuntimeMode` names WHERE a provider executes — not a global routing
 * policy or preference. Each router reports the actual locality of the
 * provider it wraps (trusted construction metadata from the composition
 * root): cloud = remote API (DeepSeek today), lan = local-network node
 * (future), local = on-device engine or in-process fake. A single ARTHUR
 * session routinely mixes localities (cloud model + local STT/TTS).
 *
 * HR-01 performs no provider selection, no connectivity inference, and no
 * automatic switching. Runtime routing policy (e.g. cloud_preferred,
 * local_only) belongs to later Hybrid Runtime phases when real fallback
 * exists — there is deliberately no ARTHUR_RUNTIME_MODE setting.
 */

export const RUNTIME_MODES = ["cloud", "lan", "local"] as const;

export type RuntimeMode = (typeof RUNTIME_MODES)[number];

export function isRuntimeMode(value: unknown): value is RuntimeMode {
  return typeof value === "string" && (RUNTIME_MODES as readonly string[]).includes(value);
}

export function parseRuntimeMode(value: string | undefined, fallback: RuntimeMode): RuntimeMode {
  if (value === undefined || value === "") return fallback;
  if (!isRuntimeMode(value)) {
    throw new Error(`Invalid runtime mode: "${value}" (expected one of ${RUNTIME_MODES.join(", ")})`);
  }
  return value;
}
