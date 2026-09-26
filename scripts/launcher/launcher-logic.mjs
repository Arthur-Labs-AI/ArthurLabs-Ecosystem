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

export function classifyClaudeVersion(output) {
  const bad = KNOWN_BAD_CLAUDE_CODE_VERSIONS.some(function (b) {
    return versionContains(output, b);
  });
  if (bad) return 'incompatible';
  if (versionContains(output, PINNED_CLAUDE_CODE_VERSION)) return 'ready';
  return 'unverified';
}
