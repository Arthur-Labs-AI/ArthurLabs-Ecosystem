// Canonical per-run timeout bounds shared by the CLI parser, the Desktop
// command router, and the WSL runtime schemas. The engine persists the
// value into executionSafeguards and falls back to its production default
// (30 minutes) when the field is omitted, so UI-started runs are unaffected.
export const RUN_TIMEOUT_MS_MIN = 1000 as const;
export const RUN_TIMEOUT_MS_MAX = 43_200_000 as const;
