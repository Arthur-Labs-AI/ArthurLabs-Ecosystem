/**
 * Built-in tools: composition/registration aggregator (SC-04 section 6).
 *
 * Phase-1 harness/echo tools stay inline; every SC-04 local capability
 * lives in its own pack module (packs/system, packs/filesystem,
 * packs/applications, packs/browser) over typed adapters bundled as a
 * LocalCapabilityHost. builtin.ts registers; it never implements OS
 * access itself. Default host (no injection) keeps the four legacy
 * tools working with inert local packs: filesystem scopes default to
 * the process working directory, catalogs default to empty.
 *
 * Registered surface (10 local tools + 3 legacy):
 *   system.echo, harness.status, harness.create_job (legacy);
 *   system.status, system.storage;
 *   filesystem.roots/list/stat/read_text/search;
 *   app.list, app.launch, browser.open_url.
 */

import { ArthurMode } from "../core/modes/mode";
import { ApprovalToken, HarnessAdapter, HarnessJobSpec, ToolExecutionContext } from "./contracts";
import { harnessCreateJobPresenter } from "./approval_presenters";
import { NodeLocalApplicationAdapter } from "./adapters/local_applications";
import { NodeLocalBrowserAdapter } from "./adapters/local_browser";
import { NodeLocalFilesystemAdapter } from "./adapters/local_filesystem";
import { LocalGitAdapter } from "./adapters/local_git";
import { LocalSystemAdapter, NodeLocalSystemAdapter } from "./adapters/local_system";
import { validateGitCapabilityConfig, type GitCapabilityConfig } from "./git/repository_catalog";
import { DEFAULT_FILESYSTEM_BOUNDS, validateLocalCapabilityConfig } from "./local_config";
import type { LocalCapabilityConfig } from "./local_config";
import type { LocalCapabilityHost } from "./local_host";
import { registerApplicationsPack } from "./packs/applications";
import { registerBrowserPack } from "./packs/browser";
import { registerFilesystemPack } from "./packs/filesystem";
import { registerGitPack } from "./packs/git";
import { registerSystemPack } from "./packs/system";
import { ToolRegistry } from "./registry";
import { FilesystemScopeRegistry } from "./scoped_path";

/** Back-compat: a bare LocalSystemAdapter still builds a full host. */
export interface BuiltinLocalDeps {
  system?: LocalSystemAdapter;
  host?: LocalCapabilityHost;
  localConfig?: LocalCapabilityConfig;
  /** SC-05 trusted git capability config (optional; invalid fails startup). */
  gitConfig?: GitCapabilityConfig;
}

export function buildDefaultLocalHost(
  system: LocalSystemAdapter = new NodeLocalSystemAdapter(),
  config?: LocalCapabilityConfig,
  gitConfig?: GitCapabilityConfig,
): LocalCapabilityHost {
  // SC-04 section 64: invalid security config fails startup (INVALID_CONFIG
  // semantics: throw out of buildApp). A merely-missing optional app only
  // flips app.available=false at launch/list time (section 65) and never
  // throws here. Validation runs before any adapter is constructed so there
  // is no fallback to unrestricted filesystem or arbitrary executables.
  if (config !== undefined) validateLocalCapabilityConfig(config);
  const roots = config?.filesystem_roots ?? [
    { id: "workspace", label: "Workspace", physical_root: process.cwd(), permissions: ["list", "stat", "read", "search"] as const },
  ];
  const scopes = new FilesystemScopeRegistry(
    roots.map((r) => ({ id: r.id, label: r.label, physical_root: r.physical_root, permissions: [...r.permissions] })),
  );
  const bounds = config?.filesystem_bounds ?? DEFAULT_FILESYSTEM_BOUNDS;
  if (gitConfig !== undefined) validateGitCapabilityConfig(gitConfig);
  const host: LocalCapabilityHost = {
    system: system,
    filesystem: new NodeLocalFilesystemAdapter(scopes, {
      searchBounds: {
        max_results: bounds.search_max_results,
        max_files_scanned: bounds.search_max_files,
        max_bytes_per_file: bounds.search_max_bytes_per_file,
        max_total_bytes: bounds.search_max_total_bytes,
      },
    }),
    applications: new NodeLocalApplicationAdapter(config?.applications ?? []),
    browser: new NodeLocalBrowserAdapter(),
  };
  if (gitConfig !== undefined) {
    host.git = new LocalGitAdapter(scopes, gitConfig);
  }
  return host;
}

export function resolveLocalHost(
  deps: LocalSystemAdapter | BuiltinLocalDeps | undefined,
  config?: LocalCapabilityConfig,
  gitConfig?: GitCapabilityConfig,
): LocalCapabilityHost {
  if (deps !== undefined && typeof deps === "object" && "getStatus" in (deps as Record<string, unknown>)) {
    return buildDefaultLocalHost(deps as LocalSystemAdapter, config, gitConfig);
  }
  const d = (deps ?? {}) as BuiltinLocalDeps;
  if (d.host) return d.host;
  return buildDefaultLocalHost(d.system ?? new NodeLocalSystemAdapter(), d.localConfig ?? config, d.gitConfig ?? gitConfig);
}

export function registerBuiltinTools(
  registry: ToolRegistry,
  harness: HarnessAdapter,
  depsOrSystem?: LocalSystemAdapter | BuiltinLocalDeps,
  config?: LocalCapabilityConfig,
  gitConfig?: GitCapabilityConfig,
): void {
  registerLegacyPacks(registry, harness);
  const host = resolveLocalHost(depsOrSystem, config, gitConfig);
  registerSystemPack(registry, host);
  registerFilesystemPack(registry, host, {
    list_limit_max: DEFAULT_FILESYSTEM_BOUNDS.list_limit_max,
    read_max_lines: DEFAULT_FILESYSTEM_BOUNDS.read_max_lines,
    read_max_bytes: DEFAULT_FILESYSTEM_BOUNDS.read_max_bytes,
    search_max_results: DEFAULT_FILESYSTEM_BOUNDS.search_max_results,
  });
  registerApplicationsPack(registry, host);
  registerBrowserPack(registry, host);
  registerGitPack(registry, host);
}

function registerLegacyPacks(registry: ToolRegistry, harness: HarnessAdapter): void {
  registry.register(
    {
      name: "system.echo",
      version: "1.0.0",
      description: "Echo the supplied text back. Used for contract and integration testing.",
      input_schema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      output_schema: {
        type: "object",
        properties: { echo: { type: "string" } },
        required: ["echo"],
        additionalProperties: false,
      },
      risk: "read",
      allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
    },
    (args) => {
      const text = String(args.text ?? "");
      return { ok: true, summary: text, data: { echo: text } };
    },
  );

  registry.register(
    {
      name: "harness.status",
      version: "1.0.0",
      description: "Return the current AI Harness status (stub).",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      output_schema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["online", "offline", "degraded"] },
          version: { type: "string" },
          jobs_active: { type: "integer", minimum: 0 },
        },
        required: ["status", "version", "jobs_active"],
        additionalProperties: false,
      },
      risk: "read",
      allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
    },
    async () => {
      const status = await harness.getStatus();
      return {
        ok: true,
        summary: "harness " + status.status + " (v" + status.version + ", " + status.jobs_active + " active jobs)",
        data: status,
      };
    },
  );

  registry.register(
    {
      name: "harness.create_job",
      version: "1.0.0",
      description: "Create a job on the AI Harness. Requires explicit approval.",
      input_schema: {
        type: "object",
        properties: {
          kind: { type: "string" },
          payload: { type: "object" },
        },
        required: ["kind"],
        additionalProperties: false,
      },
      output_schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["queued", "running", "succeeded", "failed", "cancelled"] },
          spec: {
            type: "object",
            properties: {
              kind: { type: "string" },
              payload: { type: "object" },
            },
            required: ["kind"],
            additionalProperties: false,
          },
        },
        required: ["id", "status", "spec"],
        additionalProperties: false,
      },
      risk: "approval_required",
      allowed_modes: [ArthurMode.BUSINESS],
    },
    harnessCreateJobPresenter(),
    async (args, ctx: ToolExecutionContext) => {
      if (!ctx.authorization && (!ctx.approved || !ctx.approvalToken)) {
        throw new Error("harness.create_job requires explicit approval");
      }
      const token: ApprovalToken = ctx.approvalToken as ApprovalToken;
      const spec: HarnessJobSpec = { kind: String(args.kind ?? "") };
      if (args.payload !== undefined) {
        spec.payload = args.payload as Record<string, unknown>;
      }
      const job = await harness.createJob(spec, token);
      return { ok: true, summary: "job created: " + job.id + " (" + job.status + ")", data: job };
    },
  );
}
