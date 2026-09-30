// Sentry launcher decision logic (pure, testable).
//
// This module contains NO machine mutations: no spawning, no installs, no
// file writes. The PowerShell launcher implements the effects; this module
// implements the decisions so they can be unit-tested without WSL.
// Run: node --test scripts/launcher/tests/

export const SENTRY_PRODUCT_VERSION = '0.1.0-beta.1';
export const SENTRY_RELEASE_TITLE = 'Sentry v0.1 Beta';
export const REQUIRED_NODE_MAJOR = 22;
export const PINNED_OPENCODE_VERSION = '1.18.32';
export const PINNED_DEEPSEEK_SDK_VERSION = '0.1.5-rc.2';
export const PINNED_CLAUDE_CODE_VERSION = '2.1.270';
export const KNOWN_BAD_CLAUDE_CODE_VERSIONS = ['2.1.276'];
export const UTILITY_DISTRO_PATTERN = /^docker-desktop/i;

/**
 * Parse wsl.exe --list --verbose output (UTF-16 with NULs possible).
 * Returns [{ name, state, version }]. Never throws: returns [] on garbage.
 */
export function parseWslListOutput(text) {
  if (typeof text !== 'string') return [];
  const cleaned = text.replace(/\0/g, '');
  const distros = [];
  for (const rawLine of cleaned.split('\n')) {
    const line = rawLine.trim().replace(/^\*\s*/, '');
    if (/^NAME\s+STATE/i.test(line)) continue;
    const match =
      /^(\S(?:.*?\S)?)\s+(Running|Stopped|Installing|Uninstalling|Converting)\s+(\d+)\s*$/.exec(
        line,
      );
    if (match && match[1] !== undefined) {
      distros.push({
        name: match[1].trim(),
        state: match[2] || 'Unknown',
        version: Number(match[3] || '2'),
      });
    }
  }
  return distros;
}

/** Usable distros: WSL2 only, skipping utility distros (docker-desktop*). */
export function filterUsableDistros(distros) {
  return (distros || []).filter(function (d) {
    return d.version === 2 && !UTILITY_DISTRO_PATTERN.test(d.name);
  });
}

/**
 * Select the distro Sentry should use.
 * Priority: explicit flag > previous Sentry choice > Ubuntu > running > first.
 * readySet: Set of names whose direct node --version works (optional).
 * Returns the name, or null when no compatible distro exists.
 */
export function selectDistro(input) {
  const distros = input.distros;
  const previous = input.previous;
  const explicit = input.explicit;
  const readySet = input.readySet;
  const usable = filterUsableDistros(distros);
  if (usable.length === 0) return null;
  const isReady = function (name) {
    return !readySet || readySet.has(name);
  };
  const findByName = function (n) {
    return usable.find(function (d) {
      return d.name.toLowerCase() === String(n).toLowerCase();
    });
  };
  if (explicit) {
    const match = findByName(explicit);
    if (match && isReady(match.name)) return match.name;
    return null;
  }
  if (previous) {
    const match = usable.find(function (d) {
      return d.name === previous;
    });
    if (match && isReady(match.name)) return match.name;
  }
  const ubuntu = findByName('ubuntu');
  if (ubuntu && isReady(ubuntu.name)) return ubuntu.name;
  const running = usable.find(function (d) {
    return d.state === 'Running' && isReady(d.name);
  });
  if (running) return running.name;
  const first =
    usable.find(function (d) {
      return isReady(d.name);
    }) || usable[0];
  return (first && first.name) || null;
}

/** Parse v22.14.0 / 22.14.0 to 22; null when unparseable. */
export function parseNodeMajor(text) {
  const match = /^v?(\d+)\./.exec(String(text === undefined || text === null ? '' : text).trim());
  return match && match[1] !== undefined ? Number(match[1]) : null;
}

export function nodeSatisfies(text, major) {
  const need = major === undefined ? REQUIRED_NODE_MAJOR : major;
  const found = parseNodeMajor(text);
  return found !== null && found >= need;
}

/** 9.12.3 to [9,12,3]; null when unparseable. */
export function parseSemver(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(
    String(text === undefined || text === null ? '' : text).trim(),
  );
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Versioned runtime directory: <product-version>-<short-sha>. */
export function runtimeDirName(productVersion, shortSha) {
  const sha =
    String(shortSha === undefined || shortSha === null ? 'unknown' : shortSha).trim() || 'unknown';
  return productVersion + '-' + sha;
}

/** True when output contains the exact tested version token. */
export function versionContains(output, version) {
  return String(output === undefined || output === null ? '' : output).includes(version);
}

/**
 * Native Linux (CachyOS) decisions. Pure and testable; the bash launcher
 * implements the effects. os-release parsing mirrors
 * scripts/launcher/linux/lib/host-gate.sh; the package table mirrors
 * scripts/launcher/linux/distros/cachyos.sh. Both sides cross-check the
 * table in scripts/launcher/tests/test-package-map-sync.sh.
 */

/** Parse /etc/os-release content into { id, idLike, prettyName }. */
export function parseOsRelease(content) {
  const fields = {};
  if (typeof content !== 'string') return { id: '', idLike: '', prettyName: 'unknown' };
  for (const line of content.split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    let raw = match[2].trim();
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      raw = raw.slice(1, -1);
    }
    fields[match[1]] = raw;
  }
  const id = String(fields.ID || '').toLowerCase();
  const idLike = String(fields.ID_LIKE || '').toLowerCase();
  const prettyName = fields.PRETTY_NAME || fields.NAME || id || 'unknown';
  return { id, idLike, prettyName };
}

/** Product support: ID=cachyos only. ID_LIKE is never sufficient. */
export function isCachyOsSupported(osRelease) {
  return osRelease !== null && osRelease !== undefined && osRelease.id === 'cachyos';
}

/**
 * CachyOS/Arch (pacman) package names for Sentry's Linux prerequisites,
 * keyed by the executable (or capability) the checks probe. Verified
 * against the Arch extra/core repositories; the bash adapter owns runtime
 * installation from this same table.
 */
export const CACHYOS_PACKAGES = {
  git: 'git',
  curl: 'curl',
  'ca-certificates': 'ca-certificates',
  node: 'nodejs',
  npm: 'npm',
  bwrap: 'bubblewrap',
  socat: 'socat',
};

/** Map missing executables/capabilities to pacman package names. */
export function cachyosPackagesFor(missing) {
  const pkgs = [];
  for (const name of missing || []) {
    const pkg = CACHYOS_PACKAGES[name];
    if (pkg && !pkgs.includes(pkg)) pkgs.push(pkg);
  }
  return pkgs;
}

/** Ordered native setup phases (mirrors commands/setup.sh sections). */
export function setupPhaseNames() {
  return [
    'host',
    'base',
    'packages',
    'node',
    'pnpm',
    'systemd-sandbox',
    'dependencies',
    'build',
    'deploy',
    'verify',
    'agents',
    'shim',
  ];
}

/**
 * Validate one runtime.hello response line (setup/update gate, no providers).
 * Returns { ok: true, nodeVersion, dataRoot } or { ok: false, reason }.
 */
export function validateRuntimeHelloLine(line) {
  let msg;
  try {
    msg = JSON.parse(String(line === undefined || line === null ? '' : line));
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  const h = (msg && msg.result) || msg || {};
  const bad = [];
  if (h.protocolVersion !== 1) bad.push('protocol=' + h.protocolVersion);
  if (h.platform !== 'linux') bad.push('platform=' + h.platform);
  if (h.isWsl !== false) bad.push('isWsl=' + h.isWsl);
  if (h.isElectron !== false) bad.push('isElectron=' + h.isElectron);
  if (typeof h.processExecPath === 'string' && /electron/i.test(h.processExecPath)) {
    bad.push('execPath');
  }
  if (bad.length > 0) return { ok: false, reason: bad.join(';') };
  return { ok: true, nodeVersion: h.nodeVersion, dataRoot: h.dataRoot };
}

export function classifyClaudeVersion(output) {
  const bad = KNOWN_BAD_CLAUDE_CODE_VERSIONS.some(function (b) {
    return versionContains(output, b);
  });
  if (bad) return 'incompatible';
  if (versionContains(output, PINNED_CLAUDE_CODE_VERSION)) return 'ready';
  return 'unverified';
}
