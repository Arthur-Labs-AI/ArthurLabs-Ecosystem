import { extractImports, resolveImport } from "./import_graph";

/**
 * Executable form of the hard architecture rules in the Cognitive Runtime
 * Repo Structure document (section 18). Paths are repo-relative POSIX paths
 * with the file extension stripped.
 */
export interface BoundaryRule {
  id: string;
  why: string;
  /** Repo-relative directories whose source files the rule applies to. */
  roots: string[];
  /** Repo-relative file paths exempt from the rule. */
  exempt?: RegExp[];
  /** Internal import targets that must not be imported. */
  forbidInternal?: RegExp[];
  /** Internal targets that stay importable even when they match `forbidInternal`. */
  allowInternal?: RegExp[];
  /** Bare package specifiers that must not be imported. */
  forbidPackages?: RegExp[];
  /** Only relative imports that stay inside this directory are allowed, and no packages at all. */
  confinedTo?: string;
  /** Source text that must not appear. */
  forbidText?: RegExp[];
}

export interface Violation {
  rule: string;
  file: string;
  detail: string;
}

const dir = (relative: string): RegExp => new RegExp(`^${relative.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|$)`);

/** Agentic features that are frozen for the competition. See docs/competition/FROZEN_SUBSYSTEMS.md. */
const FROZEN_AGENTIC = [dir("src/tools"), dir("src/runtime/hybrid/tools"), /^src\/runtime\/hybrid\/lan\/tool_/];

const NEW_DOMAINS = [dir("src/capture"), dir("src/cognitive"), dir("src/sync"), dir("src/devices"), dir("packages")];

const UI = "apps/arthur/src";
const UI_FEATURE_ROOTS = ["app", "features", "components", "hooks", "stores", "lib"].map((name) => `${UI}/${name}`);
const TEST_FILE = /\.test\.tsx?$/;

export const BOUNDARY_RULES: BoundaryRule[] = [
  {
    id: "contracts-are-pure",
    why: "packages/contracts stays free of React, Tauri, Rust, database access and Node-specific dependencies (Repo Structure 4.1).",
    roots: ["packages/contracts"],
    confinedTo: "packages/contracts",
  },
  {
    id: "frozen-agentic-does-not-host-new-domains",
    why: "New competition features must not be implemented inside frozen agentic subsystems by convenience (Rule 1).",
    roots: ["src/tools", "src/runtime/hybrid"],
    forbidInternal: [...NEW_DOMAINS, dir("apps/arthur")],
  },
  {
    id: "capture-does-not-reach-cognition",
    why: "No input source manipulates the Cognitive Store or Graph; capture stays platform-independent (Rule 3).",
    roots: ["src/capture"],
    forbidInternal: [dir("src/cognitive"), dir("src/sync"), dir("src/devices"), dir("apps"), ...FROZEN_AGENTIC],
  },
  {
    id: "devices-do-not-reach-cognition",
    why: "Devices emit capture/intent events and never write knowledge directly; EMG is not a generic Arthur tool (Rules 1 and 3).",
    roots: ["src/devices"],
    forbidInternal: [dir("src/cognitive"), dir("apps"), ...FROZEN_AGENTIC],
  },
  {
    id: "cognitive-works-without-agentic-layer",
    why: "If the entire agentic layer were disabled, the Cognitive Core must still work (Repo Structure 7).",
    roots: ["src/cognitive"],
    forbidInternal: [dir("src/sync"), dir("src/devices"), dir("apps"), ...FROZEN_AGENTIC],
  },
  {
    id: "sync-is-not-agentic",
    why: "Home Node sync does not live in the hybrid tool protocol (Rule 1).",
    roots: ["src/sync"],
    forbidInternal: [dir("apps"), ...FROZEN_AGENTIC],
  },
  {
    id: "sync-protocol-is-transport-independent",
    why: "The sync protocol sees only transport/contracts, never a concrete transport or Tailscale (Rule 4).",
    roots: ["src/sync"],
    exempt: [/^src\/sync\/transport\//],
    forbidInternal: [dir("src/sync/transport")],
    allowInternal: [/^src\/sync\/transport\/contracts$/],
    forbidPackages: [/tailscale/i, /wireguard/i],
  },
  {
    id: "core-does-not-import-product-app",
    why: "Arthur Core and the API/CLI surfaces never depend on the Tauri UI.",
    roots: ["src", "apps/api", "apps/cli"],
    forbidInternal: [dir("apps/arthur")],
  },
  {
    id: "ui-does-not-import-core-or-node",
    why: "The product UI reaches Arthur only through ArthurClient, never Arthur Core, SQLite or Node (Rule 5).",
    roots: [UI],
    forbidInternal: [dir("src"), dir("apps/api"), dir("apps/cli"), dir("hardware"), dir("tests")],
    forbidPackages: [/^node:/, /^(fs|path|os|child_process|net|http|https|crypto)(\/|$)/, /^(better-)?sqlite3?$/],
  },
  {
    id: "tauri-api-stays-inside-client-ipc",
    why: "Platform details live behind the client layer; only tauri-ipc.ts may import @tauri-apps/* (Rule 5).",
    roots: [UI],
    exempt: [/^apps\/arthur\/src\/client\/tauri-ipc\.ts$/],
    forbidPackages: [/^@tauri-apps\//],
  },
  {
    id: "ui-uses-the-client-interface-only",
    why: "Components depend on the ArthurClient interface; implementations are chosen once in app/providers (Rule 5).",
    roots: UI_FEATURE_ROOTS,
    exempt: [/^apps\/arthur\/src\/app\/providers\.tsx$/, TEST_FILE],
    forbidInternal: [dir("apps/arthur/src/client")],
    allowInternal: [/^apps\/arthur\/src\/client\/arthur-client$/],
  },
  {
    id: "ui-does-not-detect-platform",
    why: "Platform selection happens once, inside the client layer; components never branch on Android or the build environment (Rule 5).",
    roots: UI_FEATURE_ROOTS,
    exempt: [TEST_FILE],
    forbidText: [/\bandroid\b/i, /\bios\b/i, /userAgent/, /TAURI_ENV/, /import\.meta\.env/, /\bisTauri\b/],
  },
  {
    id: "ui-has-no-audio-or-provider-details",
    why: "Microphone access, speech providers and credentials stay behind ArthurClient and the native layer (Rule 5, M01C).",
    roots: UI_FEATURE_ROOTS,
    exempt: [TEST_FILE],
    forbidText: [
      /getUserMedia/,
      /\bMediaRecorder\b/,
      /mediaDevices/,
      /\bAudioContext\b/,
      /openai/i,
      /api[_-]?key/i,
      /\bBearer\b/,
      /\bwhisper\b/i,
      /audio\/transcriptions/,
    ],
  },
  {
    id: "ui-has-no-network-details",
    why: "React code must not talk to localhost HTTP, Tailscale addresses or raw sockets directly (Rule 5).",
    roots: UI_FEATURE_ROOTS,
    exempt: [TEST_FILE],
    forbidText: [/\blocalhost\b/i, /127\.0\.0\.1/, /\.ts\.net\b/, /\bfetch\s*\(/, /\bnew\s+WebSocket\b/, /\bXMLHttpRequest\b/],
  },
];

function isWithin(target: string, directory: string): boolean {
  return target === directory || target.startsWith(`${directory}/`);
}

export function checkFile(rule: BoundaryRule, file: string, source: string): Violation[] {
  if (rule.exempt?.some((pattern) => pattern.test(file))) return [];

  const violations: Violation[] = [];
  const report = (detail: string): void => {
    violations.push({ rule: rule.id, file, detail });
  };

  for (const specifier of extractImports(source, file)) {
    const resolved = resolveImport(file, specifier);
    if (rule.confinedTo !== undefined) {
      if (resolved.kind === "package") report(`imports package "${resolved.name}"`);
      else if (!isWithin(resolved.path, rule.confinedTo)) report(`imports "${specifier}", which is outside ${rule.confinedTo}`);
    } else if (resolved.kind === "package") {
      if (rule.forbidPackages?.some((pattern) => pattern.test(resolved.name))) report(`imports package "${resolved.name}"`);
    } else if (
      rule.forbidInternal?.some((pattern) => pattern.test(resolved.path)) &&
      !rule.allowInternal?.some((pattern) => pattern.test(resolved.path))
    ) {
      report(`imports "${specifier}" (${resolved.path})`);
    }
  }

  for (const pattern of rule.forbidText ?? []) {
    if (pattern.test(source)) report(`contains text matching ${pattern}`);
  }
  return violations;
}
