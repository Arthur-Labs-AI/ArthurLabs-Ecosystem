/**
 * Agent network policy shared by every harness.
 *
 * Package/module installs are always allowed so build, typecheck, lint and
 * tests can actually run; they reach only package-registry hosts. General
 * web access (agent fetch/search tools) is a per-run opt-in and defaults to
 * off. Host loopback, LAN and private addresses are never reachable.
 */

/** The only hosts agent shells may reach. One place; harnesses enforce it. */
export const PACKAGE_REGISTRY_HOSTS: readonly string[] = [
  // npm / JavaScript
  'registry.npmjs.org',
  'registry.npmjs.com',
  'registry.yarnpkg.com',
  'repo.yarnpkg.com',
  'npm.jsr.io',
  'jsr.io',
  'nodejs.org',
  // Python
  'pypi.org',
  'files.pythonhosted.org',
  // Rust
  'crates.io',
  'index.crates.io',
  'static.crates.io',
  // Go
  'proxy.golang.org',
  'sum.golang.org',
  // Ruby
  'rubygems.org',
  'index.rubygems.org',
  // JVM
  'repo.maven.apache.org',
  'repo1.maven.org',
  'plugins.gradle.org',
  'services.gradle.org',
  // .NET
  'api.nuget.org',
  // PHP
  'repo.packagist.org',
  // GitHub (release archives and git dependencies)
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
];

/**
 * Official download hosts of language toolchains and SDKs. Added to the registry list
 * only for runs that opt in to tool and SDK downloads; everything else stays blocked.
 */
export const SDK_DOWNLOAD_HOSTS: readonly string[] = [
  // Rust
  'static.rust-lang.org',
  'sh.rustup.rs',
  // .NET
  'dot.net',
  'dotnet.microsoft.com',
  'builds.dotnet.microsoft.com',
  'ci.dot.net',
  // Go
  'go.dev',
  'dl.google.com',
  // Python tooling
  'astral.sh',
  'bootstrap.pypa.io',
  // JVM
  'api.adoptium.net',
  'archive.apache.org',
  'downloads.apache.org',
  'dlcdn.apache.org',
];

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Case-insensitive exact or `*.suffix` match. A wildcard matches subdomains
 * only, and `registry.npmjs.org.evil.com` never matches `registry.npmjs.org`.
 */
export function hostMatchesAllowlist(host: string, patterns: readonly string[]): boolean {
  const candidate = normalizeHost(host);
  if (candidate.length === 0) return false;
  return patterns.some((raw) => {
    const pattern = normalizeHost(raw);
    if (pattern.startsWith('*.')) return candidate.endsWith(pattern.slice(1));
    return candidate === pattern;
  });
}

/** True only when the run explicitly opted in to general web access. */
export function webAccessEnabled(
  safeguards: { readonly webAccess?: boolean | undefined } | undefined,
): boolean {
  return safeguards?.webAccess === true;
}

/** True only when the run explicitly opted in to tool and SDK downloads. */
export function toolDownloadsEnabled(
  safeguards: { readonly toolDownloads?: boolean | undefined } | undefined,
): boolean {
  return safeguards?.toolDownloads === true;
}

/** The hosts an agent shell may reach for this run. */
export function allowedAgentHosts(
  safeguards: { readonly toolDownloads?: boolean | undefined } | undefined,
): readonly string[] {
  return toolDownloadsEnabled(safeguards)
    ? [...PACKAGE_REGISTRY_HOSTS, ...SDK_DOWNLOAD_HOSTS]
    : PACKAGE_REGISTRY_HOSTS;
}

/** Package-manager caches live inside the workspace, the only place shells may write. */
export const DEPENDENCY_CACHE_DIRNAME = '.sentry-cache';

/**
 * Packages that download a platform binary in a postinstall script (Electron,
 * Puppeteer, Playwright, Cypress) fetch it from hosts outside the registry
 * allowlist and from clients that ignore the proxy variables, so the install
 * fails on DNS. QA reads and probes source; it never needs those binaries.
 */
export const BINARY_DOWNLOAD_SKIP_ENVIRONMENT: Readonly<Record<string, string>> = {
  ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
  PUPPETEER_SKIP_DOWNLOAD: '1',
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  CYPRESS_INSTALL_BINARY: '0',
};

/**
 * Agent shells have no terminal. Without CI set, pnpm stops at an interactive
 * confirmation (for example "modules directories will be removed and
 * reinstalled") and exits 0 having installed nothing, which the ledger then
 * records as a successful install (run_01M6BWBR repeated every install).
 */
export const NON_INTERACTIVE_ENVIRONMENT: Readonly<Record<string, string>> = {
  CI: 'true',
};

export function dependencyCacheEnvironment(workspacePath: string): Record<string, string> {
  const root = workspacePath.replace(/[\\/]+$/, '') + '/' + DEPENDENCY_CACHE_DIRNAME;
  return {
    npm_config_cache: root + '/npm',
    npm_config_store_dir: root + '/pnpm-store',
    YARN_CACHE_FOLDER: root + '/yarn',
    PIP_CACHE_DIR: root + '/pip',
    GOPATH: root + '/go',
    GOMODCACHE: root + '/go/pkg/mod',
    GRADLE_USER_HOME: root + '/gradle',
    COREPACK_HOME: root + '/corepack',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    ...BINARY_DOWNLOAD_SKIP_ENVIRONMENT,
    ...NON_INTERACTIVE_ENVIRONMENT,
    // CARGO_HOME is intentionally not set: it would break rustup proxies.
  };
}

/**
 * Setup commands: dependency installs and package builds. They prepare a check,
 * they never prove one. Leading environment assignments (`CI=true pnpm install`)
 * do not change that.
 */
export const DEPENDENCY_INSTALL_COMMAND =
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:(?:pnpm|npm|yarn|bun)\s+(?:install|i|ci|add|fetch)\b|(?:pnpm|npm|yarn|bun)\s+(?:(?:--filter|-F)\s+\S+\s+|--workspace-root\s+|-w\s+|--recursive\s+|-r\s+)*(?:run\s+)?build(?::\S+)?\b|(?:pnpm\s+exec\s+|npx\s+)?turbo\s+run\s+build\b|corepack\s+(?:enable|prepare)\b|pip3?\s+install\b|python3?\s+-m\s+pip\s+install\b|uv\s+(?:sync|pip\s+install)\b|cargo\s+(?:fetch|vendor)\b|go\s+mod\s+(?:download|tidy|vendor)\b|bundle\s+install\b|composer\s+install\b|dotnet\s+restore\b|mvn\s+dependency:|gradle\s+dependencies\b)/i;

export interface AgentNetworkPromptOptions {
  readonly webAccess: boolean;
  /** Tool and SDK download hosts are reachable for this run. */
  readonly toolDownloads?: boolean;
  /** False for harnesses without web tools (they must never be told to use them). */
  readonly webToolsAvailable?: boolean;
}

/** Identical network guidance for every agent's investigation prompt. */
export function agentNetworkPromptLines(options: AgentNetworkPromptOptions): string[] {
  const lines = [
    'Install the project’s dependencies inside this workspace with its own package manager and lockfile (for example `pnpm install --frozen-lockfile`, `npm ci`, `yarn install --immutable`, `pip install -r requirements.txt` into a `.venv`, `cargo fetch`, `go mod download`) BEFORE build, lint, typecheck or tests. An install only prepares a check; it is never proof of one. If an install fails inside a package lifecycle script (a postinstall that downloads a binary, for example), rerun it once with `--ignore-scripts` instead of debugging the script.',
    'Install ONCE per run: when the operation receipt already shows a successful install (exit 0) in this workspace, do not repeat it for later checks; the dependencies are still there.',
    'Build outputs (dist) are not part of the workspace. Before importing a package or running a suite that needs its build, build just what the probe needs, once (for example `pnpm --filter <package>... build`). A missing build is a setup step to do, never a reason to leave a check unproven.',
    options.toolDownloads === true
      ? 'Shell network access reaches package registries and the official download hosts of language toolchains (for example static.rust-lang.org, dot.net, go.dev, astral.sh, api.adoptium.net). You may install a missing toolchain or SDK from those hosts into this workspace; other hosts stay blocked and you must never work around that. If an install fails, record the exact failure as a limitation, continue statically, and never claim a check passed that could not run.'
      : 'Shell network access reaches package registries only. Never work around that restriction. If an install fails, record the exact failure as a limitation, continue statically, and never claim a check passed that could not run.',
    'Never run scripts that publish, deploy or contact production systems.',
  ];
  if (options.webAccess && options.webToolsAvailable !== false)
    lines.push(
      'Web access is enabled for this run: you may use web fetch/search for documentation, changelogs and security advisories, and must cite what you used. Never send source code, secrets or workspace contents to a website.',
    );
  else lines.push('Web access is disabled for this run: do not use web fetch or search tools.');
  return lines;
}
