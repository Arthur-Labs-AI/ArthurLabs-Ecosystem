/**
 * HR-02.5D2: staging and atomic promotion for live model directories.
 *
 * Model files are NEVER written directly into the live directory.
 * Callers prepare into a staging area, verify/validate, then call
 * commitStagedDirectory() exactly once. Promotion sequence:
 *   1. rename live -> live.backup-<stamp> (when live exists)
 *   2. rename staging -> live (same filesystem: same managed root)
 *   3. remove backup; on step-2 failure, restore backup -> live.
 *
 * Windows semantics: renames use the platform rename (no EXDEV inside
 * one root; overwrite is never assumed — backup-then-move keeps every
 * step a pure rename). If promotion fails midway, recoverLiveFromBackup
 * restores the previous installation whenever a backup exists.
 *
 * All filesystem access flows through the injected ProvisioningFs seam
 * (tests use memoryProvisioningFs; production uses nodeProvisioningFs).
 * No operation may touch paths outside the managed root.
 */

import * as path from 'node:path';

import { ArthurError } from '../../../core/errors/errors';
import { assertInsideRoot, assertNoEscapeThroughLinks, canonicalizeRoot, type Pathoscopy } from './paths';
import type { CleanupReport, PromotionResult, RecoveryScan } from './contracts';

export interface PromotionOptions {
  scope?: Pathoscopy | null;
}

export interface CleanupOptions {
  scope?: Pathoscopy | null;
}

function linkScope(root: string, fs: ProvisioningFs, scope: Pathoscopy | null | undefined): { canonical: string; scope: Pathoscopy | null } {
  void fs;
  return { canonical: canonicalizeRoot(root, scope ?? null), scope: scope ?? null };
}

export interface ProvisioningFs {
  exists(path: string): boolean;
  mkdirp(path: string): void;
  rename(from: string, to: string): void;
  removeRecursive(path: string): void;
  listDir(path: string): string[];
  isDirectory(path: string): boolean;
}

export function nodeProvisioningFs(): ProvisioningFs {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  return {
    exists(p: string): boolean {
      try {
        fs.accessSync(p);
        return true;
      } catch {
        return false;
      }
    },
    mkdirp(p: string): void {
      fs.mkdirSync(p, { recursive: true });
    },
    rename(from: string, to: string): void {
      fs.renameSync(from, to);
    },
    removeRecursive(p: string): void {
      fs.rmSync(p, { recursive: true, force: true });
    },
    listDir(p: string): string[] {
      return fs.readdirSync(p);
    },
    isDirectory(p: string): boolean {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
  };
}

// Deterministic in-memory seam. renameTargets can inject a failure for
// one exact source path to simulate mid-promotion crashes.
export function memoryProvisioningFs(initialDirs: string[] = [], renameTargets: Record<string, 'ok' | 'fail'> = {}): ProvisioningFs & { dirs: Set<string>; files: Map<string, string> } {
  const dirs = new Set<string>();
  const files = new Map<string, string>();
  const normalize = (p: string): string => path.normalize(p);
  const addAncestors = (p: string): void => {
    let cur = normalize(p);
    for (let i = 0; i < 64; i += 1) {
      dirs.add(cur);
      const parent = path.dirname(cur);
      if (parent === cur) return;
      cur = parent;
    }
  };
  for (const d of initialDirs) addAncestors(d);
  return {
    dirs,
    files,
    exists(p: string): boolean {
      const n = normalize(p);
      if (dirs.has(n)) return true;
      if (files.has(n)) return true;
      // A file directly under a known dir counts (needed for live-tree
      // reads); unknown nested paths do NOT (no prefix inference, so a
      // never-created live dir is correctly reported missing).
      if (files.size > 0) {
        for (const k of files.keys()) {
          if (k.startsWith(n + path.sep)) return true;
        }
      }
      return false;
    },
    mkdirp(p: string): void {
      addAncestors(p);
    },
    rename(from: string, to: string): void {
      const mode = renameTargets[path.normalize(from)];
      if (mode === 'fail') throw new Error('injected rename failure for ' + from);
      const f = normalize(from);
      const t = normalize(to);
      if (!dirs.has(f) && !files.has(f)) throw new Error('ENOENT: ' + from);
      // Move dir subtree (or single file) atomically in the model.
      const moved: string[] = [];
      for (const d of dirs) {
        if (d === f || d.startsWith(f + path.sep)) moved.push(d);
      }
      for (const d of moved) {
        dirs.delete(d);
        dirs.add(t + d.slice(f.length));
      }
      const movedFiles: Array<[string, string]> = [];
      for (const [k, v] of files) {
        if (k === f || k.startsWith(f + path.sep)) movedFiles.push([k, v]);
      }
      for (const [k, v] of movedFiles) {
        files.delete(k);
        files.set(t + k.slice(f.length), v);
      }
      if (moved.length === 0 && movedFiles.length === 0) throw new Error('ENOENT: ' + from);
    },
    removeRecursive(p: string): void {
      const n = normalize(p);
      for (const d of [...dirs]) {
        if (d === n || d.startsWith(n + path.sep)) dirs.delete(d);
      }
      for (const k of [...files.keys()]) {
        if (k === n || k.startsWith(n + path.sep)) files.delete(k);
      }
    },
    listDir(p: string): string[] {
      const n = normalize(p);
      const out = new Set<string>();
      for (const d of dirs) {
        if (d.startsWith(n + path.sep)) out.add(d.slice(n.length + 1).split(path.sep)[0] as string);
      }
      for (const k of files.keys()) {
        if (k.startsWith(n + path.sep)) out.add(k.slice(n.length + 1).split(path.sep)[0] as string);
      }
      return [...out];
    },
    isDirectory(p: string): boolean {
      return dirs.has(normalize(p));
    },
  };
}

export interface StagingArea {
  stagingDir: string;
  liveDir: string;
}

let stagingCounter = 0;

export function createStagingArea(root: string, fs: ProvisioningFs, liveDir: string, hint: string): StagingArea {
  const safeHint = hint.replace(/[^a-z0-9\-_]/gi, '').slice(0, 32) || 'stage';
  stagingCounter += 1;
  const stagingDir = assertInsideRoot(root, path.join(path.dirname(liveDir), 'staging-' + safeHint + '-' + String(Date.now()) + '-' + String(stagingCounter)), 'staging dir');
  fs.mkdirp(stagingDir);
  return { stagingDir, liveDir };
}

export function discardStagingArea(root: string, fs: ProvisioningFs, stagingDir: string, options: CleanupOptions = {}): void {
  const inside = assertInsideRoot(root, stagingDir, 'staging dir');
  if (!inside.includes('staging')) {
    throw new ArthurError('INVALID_CONFIG', 'refusing to discard non-staging directory');
  }
  const link = linkScope(root, fs, options.scope);
  if (link.scope) assertNoEscapeThroughLinks(link.canonical, inside, 'staging dir', link.scope);
  fs.removeRecursive(inside);
}

function backupName(liveDir: string): string {
  return liveDir + '.backup-' + String(Date.now());
}

// Explicit promotion: caller has verified + validated the staged tree.
// On staged->live failure with a backup present, the backup is restored
// so the previous installation survives.
export function commitStagedDirectory(root: string, fs: ProvisioningFs, stagingDir: string, liveDir: string, options: PromotionOptions = {}): PromotionResult {
  const link = linkScope(root, fs, options.scope);
  const fail = (reason: string, previous_preserved: boolean): PromotionResult => ({ outcome: 'failed', live_path: assertInsideRoot(root, liveDir, 'live dir'), previous_preserved, reason });
  let staged = '';
  let live = '';
  try {
    staged = assertInsideRoot(root, stagingDir, 'staging dir');
    live = assertInsideRoot(root, liveDir, 'live dir');
    if (link.scope) {
      // Promotion target and its parent must not escape through links:
      // renaming through a linked parent would write outside the root.
      assertNoEscapeThroughLinks(link.canonical, staged, 'staging dir', link.scope);
      assertNoEscapeThroughLinks(link.canonical, live, 'live dir', link.scope);
      assertNoEscapeThroughLinks(link.canonical, root, 'managed root', link.scope);
    }
  } catch (err) {
    return fail('promotion refused: ' + String(err instanceof Error ? err.message : err), false);
  }
  if (!fs.exists(staged)) {
    return { outcome: 'failed', live_path: live, previous_preserved: fs.exists(live), reason: 'staging directory does not exist' };
  }
  const hadLive = fs.exists(live);
  let backup = '';
  try {
    if (hadLive) {
      backup = assertInsideRoot(root, backupName(live), 'backup dir');
      fs.rename(live, backup);
    }
    fs.rename(staged, live);
  } catch (err) {
    // Step-2 failure: restore the backup when one was taken.
    if (backup !== '' && fs.exists(backup) && !fs.exists(live)) {
      try {
        fs.rename(backup, live);
        return { outcome: 'failed', live_path: live, previous_preserved: true, reason: 'promotion failed and previous installation was restored: ' + String(err instanceof Error ? err.message : err) };
      } catch {
        return { outcome: 'failed', live_path: live, previous_preserved: false, reason: 'promotion failed AND backup restore failed; recovery needed: ' + String(err instanceof Error ? err.message : err) };
      }
    }
    return { outcome: 'failed', live_path: live, previous_preserved: backup === '' ? !hadLive || fs.exists(live) : fs.exists(backup), reason: 'promotion failed: ' + String(err instanceof Error ? err.message : err) };
  }
  try {
    if (backup !== '') fs.removeRecursive(backup);
  } catch (err) {
    return { outcome: 'promoted', live_path: live, previous_preserved: true, reason: 'promoted; backup cleanup failed and needs sweeping: ' + String(err instanceof Error ? err.message : err) };
  }
  return { outcome: 'promoted', live_path: live, previous_preserved: true };
}

export function recoverLiveFromBackup(root: string, fs: ProvisioningFs, liveDir: string): PromotionResult {
  const live = assertInsideRoot(root, liveDir, 'live dir');
  if (fs.exists(live)) {
    return { outcome: 'promoted', live_path: live, previous_preserved: true, reason: 'live installation present; nothing to recover' };
  }
  const parent = path.dirname(live);
  let backups: string[] = [];
  try {
    backups = fs.listDir(parent).filter((name) => name.startsWith(path.basename(live) + '.backup-')).map((name) => path.join(parent, name));
  } catch {
    return { outcome: 'failed', live_path: live, previous_preserved: false, reason: 'cannot list parent for backups' };
  }
  // Ambiguity guard: never guess between multiple backups.
  if (backups.length !== 1 || !backups[0]) {
    return { outcome: 'failed', live_path: live, previous_preserved: false, reason: backups.length === 0 ? 'no backup available; recovery needed' : 'multiple backups; operator decision required' };
  }
  try {
    fs.rename(backups[0] as string, live);
    return { outcome: 'promoted', live_path: live, previous_preserved: true, reason: 'previous installation restored from backup' };
  } catch (err) {
    return { outcome: 'failed', live_path: live, previous_preserved: false, reason: 'backup restore failed: ' + String(err instanceof Error ? err.message : err) };
  }
}

// Conservative leftover scan: report-only. Never deletes live installs,
// never resolves ambiguity silently.
export function scanRecoveryNeeded(root: string, fs: ProvisioningFs, modelDirs: string[]): RecoveryScan {
  const staging_dirs: string[] = [];
  const backup_dirs: string[] = [];
  const partial_files: string[] = [];
  const visit = (dir: string): void => {
    let entries: string[] = [];
    try {
      entries = fs.listDir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (entry.includes('staging')) staging_dirs.push(full);
      else if (entry.includes('.backup-')) backup_dirs.push(full);
      else if (entry.endsWith('.part')) partial_files.push(full);
      let isDir = false;
      try {
        isDir = fs.isDirectory(full);
      } catch {
        isDir = false;
      }
      if (isDir && !entry.includes('staging') && !entry.includes('.backup-')) visit(full);
    }
  };
  for (const dir of modelDirs) {
    try {
      visit(assertInsideRoot(root, dir, 'scan dir'));
    } catch {
      // Unresolvable scan dirs are skipped, never fatal.
    }
  }
  return { staging_dirs, backup_dirs, partial_files, needs_attention: staging_dirs.length + backup_dirs.length + partial_files.length > 0 };
}

// Root-bounded cleanup: every target must resolve inside root AND must
// not escape through symlinks/junctions. Failures are collected (never
// thrown) so one bad entry cannot corrupt the rest. Recursive deletion
// never follows an external link: link targets are refused up front.
export function cleanupPaths(root: string, fs: ProvisioningFs, targets: string[], options: CleanupOptions = {}): CleanupReport {
  const report: CleanupReport = { removed: [], kept: [], errors: [] };
  const link = linkScope(root, fs, options.scope);
  for (const target of targets) {
    let inside = '';
    try {
      inside = assertInsideRoot(root, target, 'cleanup target');
      if (link.scope) assertNoEscapeThroughLinks(link.canonical, inside, 'cleanup target', link.scope);
    } catch (err) {
      report.kept.push(target);
      report.errors.push('refused (outside root): ' + target);
      void err;
      continue;
    }
    try {
      fs.removeRecursive(inside);
      report.removed.push(target);
    } catch (err) {
      report.kept.push(target);
      report.errors.push('remove failed: ' + target + ': ' + String(err instanceof Error ? err.message : err));
    }
  }
  return report;
}
