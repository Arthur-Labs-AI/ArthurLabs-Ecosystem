/**
 * SC-04 local browser capability adapter (spec sections 52-58).
 *
 * browser.open_url is NOT an HTTP client: the adapter hands a validated
 * http/https URL to a trusted OS launcher (fixed helper per platform)
 * with shell=false. The model never selects the launcher executable.
 */

import { spawn } from "node:child_process";

import { buildChildEnv } from "../child_env";
import { launchFailed } from "../capability_errors";

export interface LocalBrowserAdapter {
  openUrl(url: string): Promise<{ url: string; opened: boolean }>;
  /** Test seam: how many launcher calls were attempted. */
  openCalls(): number;
}

export interface BrowserAdapterOptions {
  launcher?: (url: string, env: NodeJS.ProcessEnv) => Promise<void>;
}

/**
 * Trusted OS launcher per platform (exported for F25/F29 test seams:
 * tests assert the Windows target is NOT cmd.exe and the URL travels as
 * one argv element with shell:false).
 */
export function platformLauncher(): { exe: string; args: (url: string) => string[] } {
  // Windows: rundll32 url.dll,FileProtocolHandler opens the validated URL in
  // the default browser with shell:false and NO cmd.exe parsing, so shell
  // metacharacters in the URL (& ; | $ ` " ') are inert data (SC-04 F25).
  // cmd /c start is deliberately NOT used: cmd would reinterpret those
  // characters even with shell:false because cmd IS the interpreter.
  if (process.platform === "win32") return { exe: "rundll32", args: (url) => ["url.dll,FileProtocolHandler", url] };
  if (process.platform === "darwin") return { exe: "/usr/bin/open", args: (url) => [url] };
  return { exe: "/usr/bin/xdg-open", args: (url) => [url] };
}

function defaultLauncher(url: string, env: NodeJS.ProcessEnv): Promise<void> {
  const target = platformLauncher();
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(target.exe, target.args(url), { shell: false, env: env, stdio: "ignore", detached: true });
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

export class NodeLocalBrowserAdapter implements LocalBrowserAdapter {
  private readonly launcher: (url: string, env: NodeJS.ProcessEnv) => Promise<void>;
  private calls = 0;

  constructor(opts: BrowserAdapterOptions = {}) {
    this.launcher = opts.launcher ?? defaultLauncher;
  }

  async openUrl(url: string): Promise<{ url: string; opened: boolean }> {
    this.calls += 1;
    const env = buildChildEnv(process.env);
    try {
      await this.launcher(url, env);
    } catch {
      throw launchFailed("browser");
    }
    return { url: url, opened: true };
  }

  openCalls(): number {
    return this.calls;
  }
}
