/**
 * SC-04 child environment sanitizer (spec sections 46-47).
 *
 * Application/browser launch adapters build the child process env from
 * an explicit allowlist of OS/session variables. ARTHUR secrets (API
 * keys, approval material) never inherit into launched GUI processes.
 */

/** Env names whose VALUES are always stripped (case-insensitive). */
const SECRET_NAME_RE = /api[_-]?key|apikey|secret|password|passwd|token|auth|private[_-]?key|credentials?|session[_-]?key/i;

/** Prefixes always stripped (ARTHUR/approval/service credentials). */
const SECRET_PREFIX_RE = /^(ARTHUR_|DEEPSEEK_|OPENAI_|ANTHROPIC_|APPROVAL_|SECRET_)/i;

/** Exact names always stripped. */
const STRIPPED_EXACT = new Set([
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "SUPER_SECRET_CANARY",
]);

/** OS/session variables a GUI child is allowed to keep. */
const ALLOWED_EXACT = new Set([
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PROGRAMDATA",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "DBUS_SESSION_BUS_ADDRESS",
  "LANG",
  "LC_ALL",
  "LC_MESSAGES",
  "LANGUAGE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
]);

/**
 * Prefixes a GUI child is allowed to keep (locale/session plumbing).
 * Anchored to real plumbing segments only: LC_* / XDG_* / WAYLAND_* /
 * DISPLAY / WAYLAND_DISPLAY / LANG / LANGUAGE. A loose /^(DISPLAY|LANG)/
 * would also keep attacker-adjacent names like DISPLAYFOO or LANGFOO.
 */
const ALLOWED_PREFIX_RE = /^(LC_[A-Z_]+|XDG_[A-Z_]+|WAYLAND_[A-Z_]+|DISPLAY|WAYLAND_DISPLAY|LANG|LANGUAGE)$/i;

function isAllowedKey(key: string): boolean {
  if (STRIPPED_EXACT.has(key.toUpperCase())) return false;
  if (SECRET_PREFIX_RE.test(key)) return false;
  if (SECRET_NAME_RE.test(key)) return false;
  if (ALLOWED_EXACT.has(key.toUpperCase())) return true;
  if (ALLOWED_PREFIX_RE.test(key)) return true;
  return false;
}

/**
 * Build the sanitized child environment from the current process env.
 * The tests inject a fake source env; production passes process.env.
 */
export function buildChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!isAllowedKey(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Test seam: assert a child env carries none of the given secrets. */
export function assertChildEnvClean(child: NodeJS.ProcessEnv, secrets: readonly string[]): void {
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    for (const value of Object.values(child) as Array<string | undefined>) {
      if (typeof value === "string" && value.includes(secret)) {
        throw new Error("child environment leaks an ARTHUR secret");
      }
    }
  }
  for (const key of Object.keys(child)) {
    if (STRIPPED_EXACT.has(key.toUpperCase())) {
      throw new Error("child environment carries a stripped variable: " + key);
    }
    if (SECRET_PREFIX_RE.test(key) || SECRET_NAME_RE.test(key)) {
      throw new Error("child environment carries a secret-like variable: " + key);
    }
  }
}
