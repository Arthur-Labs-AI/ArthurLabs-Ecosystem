/**
 * SC-04 local application capability adapter (spec sections 41-49).
 *
 * Launch is catalog-bound: the model supplies only app_id, the adapter
 * resolves a trusted executable + fixed args and spawns with
 * shell=false. No model-controlled executable, args, env, or cwd ever
 * reaches the OS. Child env is rebuilt from the sanitized allowlist.
 * Success = the OS accepted the launch request, not GUI readiness.
 * Cancellation after dispatch is unsupported; retry is never blind.
 */

import { spawn } from "node:child_process";
import { constants as fsConstants, promises as fsp } from "node:fs";

import { buildChildEnv } from "../child_env";
import { capabilityUnavailable, launchFailed } from "../capability_errors";
import type { ApplicationEntry } from "../local_config";

export interface ApplicationSummary {
  id: string;
  name: string;
  available: boolean;
}

export interface LocalApplicationAdapter {
  list(): Promise<ApplicationSummary[]>;
  launch(appId: string): Promise<{ app_id: string; launched: boolean }>;
  /** Test seam: how many spawn calls were attempted. */
  spawnCalls(): number;
}

export interface ApplicationAdapterOptions {
  /** Override spawn for deterministic tests (fake launcher). */
  launcher?: (exe: string, args: string[], env: NodeJS.ProcessEnv) => Promise<void>;
  /** Override availability probing (tests control installed/missing). */
  availability?: (entry: ApplicationEntry) => Promise<boolean>;
}

async function defaultAvailability(entry: ApplicationEntry): Promise<boolean> {
  try {
    await fsp.access(entry.executable, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultLauncher(exe: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, args, { shell: false, env: env, stdio: "ignore", detached: true });
    } catch (err) {
      reject(err);
      return;
    }
    const onError = (err: Error): void => {
      child.off("spawn", onSpawn);
      reject(err);
    };
    const onSpawn = (): void => {
      child.off("error", onError);
      child.unref();
      resolve();
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
}

export class NodeLocalApplicationAdapter implements LocalApplicationAdapter {
  private readonly entries = new Map<string, ApplicationEntry>();
  private readonly launcher: (exe: string, args: string[], env: NodeJS.ProcessEnv) => Promise<void>;
  private readonly availability: (entry: ApplicationEntry) => Promise<boolean>;
  private calls = 0;

  constructor(entries: ApplicationEntry[], opts: ApplicationAdapterOptions = {}) {
    for (const entry of entries) {
      this.entries.set(entry.id, { ...entry, args: [...entry.args] });
    }
    this.launcher = opts.launcher ?? defaultLauncher;
    this.availability = opts.availability ?? defaultAvailability;
  }

  async list(): Promise<ApplicationSummary[]> {
    const out: ApplicationSummary[] = [];
    const sorted = [...this.entries.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const entry of sorted) {
      let available = false;
      try {
        available = await this.availability(entry);
      } catch {
        available = false;
      }
      out.push({ id: entry.id, name: entry.display_name, available: available });
    }
    return out;
  }

  async launch(appId: string): Promise<{ app_id: string; launched: boolean }> {
    const entry = this.entries.get(appId);
    if (!entry) {
      throw capabilityUnavailable("app.launch", "unknown application");
    }
    this.calls += 1;
    const env = buildChildEnv(process.env);
    try {
      await this.launcher(entry.executable, [...entry.args], env);
    } catch {
      throw launchFailed(entry.id);
    }
    return { app_id: entry.id, launched: true };
  }

  spawnCalls(): number {
    return this.calls;
  }
}
