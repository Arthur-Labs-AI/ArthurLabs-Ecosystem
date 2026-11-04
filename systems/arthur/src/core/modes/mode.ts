/**
 * Conversation mode (spec section 6.1).
 *
 * Every conversation has an explicit mode: personal or business. Mode is stored
 * server-side on the session; clients change it only through the explicit
 * mode-change operation.
 */

export const ArthurMode = {
  PERSONAL: "personal",
  BUSINESS: "business",
} as const;

export type ArthurMode = (typeof ArthurMode)[keyof typeof ArthurMode];

const ALL_MODES: readonly ArthurMode[] = [ArthurMode.PERSONAL, ArthurMode.BUSINESS];

export function isArthurMode(value: unknown): value is ArthurMode {
  return typeof value === "string" && (ALL_MODES as readonly string[]).includes(value);
}

export function parseArthurMode(value: unknown): ArthurMode {
  if (isArthurMode(value)) {
    return value;
  }
  throw new Error(`Invalid mode: ${String(value)} (expected "personal" or "business")`);
}

export function allModes(): readonly ArthurMode[] {
  return ALL_MODES;
}
