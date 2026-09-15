/**
 * HR-02.5E1: Parakeet TDT 0.6B v3 trusted installer (STT, CUDA desktop).
 *
 * Trusted upstream identity: nvidia/parakeet-tdt-0.6b-v3 (Hugging Face,
 * resolved ONLY through the Transformers cache under a managed HF_HOME).
 * No arbitrary repo ids: the id is a code-owned literal below.
 *
 * Managed runtime: python/parakeet-v1 (Python 3.10–3.13), pinned from
 * the proven development venv (.venv-parakeet, torch 2.14.0+cu130 CUDA,
 * transformers 5.17.0, safetensors 0.8.0, numpy 2.5.3, Python 3.12.10):
 * torch is pinned to the validated CUDA build; transformers/safetensors
 * /numpy are pinned to the proven versions. The setup script's
 * keep-existing-torch rule is a DEV convenience, not reproducible
 * policy: production pins everything.
 *
 * Reuses tools/voice/parakeet_worker.py unchanged (copied into the
 * staged tree at install time so the live install is self-contained).
 * Smoke: bounded worker JSONL silence probe proving managed Python
 * starts, imports succeed, the model loads, inference executes, and a
 * structurally valid transcript response comes back. CUDA is required:
 * catalog compatibility demands cuda=available and PARAKEET_DEVICE=cuda
 * with no CUDA fails closed — a CPU pass NEVER validates this installer.
 *
 * Validated platform: windows-x64-cuda. Auth: public repo, none needed.
 */

import * as path from 'node:path';

import type { ModelInstallerId } from '../contracts';
import type { InstallerResult, ModelInstaller, ModelInstallContext } from '../install_contracts';
import { runTrustedProcess, type SpawnFn } from '../provisioning/process_runner';
import type { ProvisioningFs } from '../provisioning/staging';
import type { VenvFs } from '../provisioning/python';
import { SMOKE_REQUEST_ID, isValidSttSmokeResponse, smokeSttRequest } from './smoke_fixtures';
import {
  abortStaging,
  artifactFromDescriptor,
  beginStaging,
  checkAborted,
  ensureManagedVenv,
  hardwareSummary,
  nodeWriteFile,
  openStagedInstall,
  promoteOrFail,
  toDescriptor,
  writeInstallManifest,
  type WriteFileFn,
} from './shared';

export const PARAKEET_MODEL_ID = 'parakeet-tdt-0.6b-v3';
export const PARAKEET_HF_REPO = 'nvidia/parakeet-tdt-0.6b-v3';
export const PARAKEET_RUNTIME_ID = 'python/parakeet-v1';
export const PARAKEET_PYTHON_MIN = '3.10.0';
export const PARAKEET_PYTHON_MAX_EXCLUSIVE = '3.14.0';
export const PARAKEET_WORKER_FILE = 'parakeet_worker.py';

// Proven build evidence (dev venv .venv-parakeet, 2026-09): torch
// 2.14.0+cu130, CUDA Runtime 13.0, RTX 3060 Ti, transformers 5.17.0,
// safetensors 0.8.0, numpy 2.5.3, Python 3.12.10 — PLUS librosa 1.0.0
// with scipy 1.18.1/soundfile 0.14.0 (required by ParakeetFeatureExtractor
// at load; found missing by E1 acceptance 2026-09-14, added from the
// proven venv: audioread 3.1.0, librosa 1.0.0, numba 0.67.0, scipy
// 1.18.1, soundfile 0.14.0, soxr 1.1.0). The `+cu130` wheel is sourced
// from the code-owned PyTorch CUDA index below — bare `torch==2.14.0`
// from default PyPI is NOT trusted to reproduce it.
export const PARAKEET_CUDA_INDEX_URL = 'https://download.pytorch.org/whl/cu130';
export const PARAKEET_CUDA_PACKAGES = ['torch==2.14.0'];
export const PARAKEET_PACKAGES = ['transformers==5.17.0', 'safetensors==0.8.0', 'numpy==2.5.3', 'librosa==1.0.0', 'scipy==1.18.1', 'soundfile==0.14.0'];

export interface ParakeetInstallerDeps {
  run: SpawnFn;
  fs: ProvisioningFs;
  venvFs: VenvFs;
  systemPython: string;
  /** Repo checkout root containing tools/voice/parakeet_worker.py. */
  workerSourceDir?: string;
  smokeTimeoutMs?: number;
  readSourceFile?: (filePath: string) => string;
  writeFile?: WriteFileFn;
}

function workerSource(deps: ParakeetInstallerDeps): string {
  return deps.workerSourceDir ?? process.cwd();
}

async function copyWorkerIntoStaging(deps: ParakeetInstallerDeps, stagingDir: string): Promise<void> {
  const from = path.join(workerSource(deps), 'tools', 'voice', PARAKEET_WORKER_FILE);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('node:fs') as typeof import('node:fs');
  const raw = deps.readSourceFile ? deps.readSourceFile(from) : nodeFs.readFileSync(from, 'utf8');
  const write = deps.writeFile ?? nodeWriteFile();
  write(path.join(stagingDir, PARAKEET_WORKER_FILE), raw);
}

export function makeParakeetInstaller(deps: ParakeetInstallerDeps): ModelInstaller {
  const installerId: ModelInstallerId = 'parakeet-tdt-0.6b-v3';
  return {
    id: installerId,
    install: async (ctx: ModelInstallContext): Promise<InstallerResult> => {
      const stage = openStagedInstall(ctx, PARAKEET_RUNTIME_ID);
      // ARTHUR-managed model cache: every model-touching subprocess
      // receives these variables explicitly, so ambient HF_HOME /
      // home-directory caches can never redirect resolution outside
      // the managed root. Values are containment-checked managed paths.
      const modelEnv = stage.paths.modelCacheEnv();
      if (ctx.model.id !== PARAKEET_MODEL_ID) {
        return { outcome: 'failed', reason: 'parakeet installer cannot install ' + JSON.stringify(ctx.model.id) };
      }
      if (ctx.hardware.accelerators.cuda !== 'available') {
        return { outcome: 'failed', reason: 'parakeet requires CUDA available (observed ' + ctx.hardware.accelerators.cuda + ' on ' + hardwareSummary(ctx.hardware) + ')' };
      }
      if (checkAborted(ctx)) return { outcome: 'cancelled', reason: 'cancelled before staging' };
      stage.say('preparing', 'staging parakeet install');
      const stagingDir = beginStaging(ctx.managed_root, deps.fs, stage.liveDir, 'parakeet');
      try {
        stage.say('installing', 'provisioning managed python runtime');
        const venv = await ensureManagedVenv({
          root: ctx.managed_root,
          runtimeDir: stage.runtimeDir,
          runtimeId: PARAKEET_RUNTIME_ID,
          systemPython: deps.systemPython,
          packages: { packages: [...PARAKEET_CUDA_PACKAGES], indexUrl: PARAKEET_CUDA_INDEX_URL },
          extraPackageSets: [{ packages: [...PARAKEET_PACKAGES] }],
          signal: ctx.signal,
          run: deps.run,
          venvFs: deps.venvFs,
        });
        await copyWorkerIntoStaging(deps, stagingDir);
        stage.say('installing', 'caching model weights (managed HF cache)');
        const cacheWarm = await runTrustedProcess(deps.run, {
          executable: venv.python_executable,
          args: ['-c', 'from transformers import AutoProcessor, ParakeetForTDT; AutoProcessor.from_pretrained("' + PARAKEET_HF_REPO + '"); ParakeetForTDT.from_pretrained("' + PARAKEET_HF_REPO + '"); print("cached")'],
          timeoutMs: 600000,
          signal: ctx.signal,
          env: { ...modelEnv },
        });
        if (cacheWarm.exit_code !== 0 || cacheWarm.aborted || cacheWarm.timed_out) {
          return { outcome: 'failed', reason: 'model weight caching failed (exit ' + String(cacheWarm.exit_code) + '); check network and HF access' };
        }
        if (checkAborted(ctx)) return { outcome: 'cancelled', reason: 'cancelled before validation' };
        stage.say('validating', 'running worker smoke probe (CUDA)');
        // The D2 runner has no stdin channel, so the silence probe is
        // driven through a bounded inline python harness owned by this
        // installer (worker path is installer-resolved, never user data).
        // workerLit uses forward slashes: backslashes would corrupt the
        // python string literal (e.g. TAB in .tmp). Argv paths need no
        // such normalization (no escape processing on argv).
        // PARAKEET_DEVICE=cuda is forced in the harness env: the worker
        // fails closed (model_unavailable) without CUDA, so a CPU-only
        // box can never false-pass this smoke as CUDA-validated.
        // The 42KB probe travels via a staging request FILE, never argv
        // (Windows cmdline limits would break process creation).
        const workerLit = JSON.stringify(path.join(stagingDir, PARAKEET_WORKER_FILE).split(path.sep).join('/'));
        const requestLit = JSON.stringify((stagingDir + '/smoke_request.jsonl').split(path.sep).join('/'));
        (deps.writeFile ?? nodeWriteFile())(path.join(stagingDir, 'smoke_request.jsonl'), smokeSttRequest() + '\n');
        const probe = await runTrustedProcess(deps.run, {
          executable: venv.python_executable,
          args: ['-c', 'import base64, json, os, subprocess, sys; ' + 'os.environ["PARAKEET_DEVICE"] = "cuda"; ' + 'req = open(' + requestLit + ', "r", encoding="utf-8").read(); ' + 'p = subprocess.run([sys.executable, ' + workerLit + '], input=req, capture_output=True, text=True, timeout=240); ' + 'lines = [l.strip() for l in (p.stdout or "").splitlines() if l.strip()]; ' + 'match = [l for l in lines if ' + JSON.stringify(SMOKE_REQUEST_ID) + ' in l]; ' + 'print(match[0] if match else "NO_MATCH"); sys.exit(0 if match else 1)'],
          timeoutMs: deps.smokeTimeoutMs ?? 300000,
          signal: ctx.signal,
          env: { ...modelEnv },
        });
        if (probe.aborted) return { outcome: 'cancelled', reason: 'smoke probe aborted' };
        if (probe.timed_out || probe.exit_code !== 0) {
          return { outcome: 'failed', artifact: { installed: true, configured: true, validation: { status: 'failed', reason: 'parakeet smoke probe failed (exit ' + String(probe.exit_code) + ')' } }, reason: 'parakeet smoke probe failed' };
        }
        const line = probe.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => isValidSttSmokeResponse(l));
        if (!line) {
          return { outcome: 'failed', artifact: { installed: true, configured: true, validation: { status: 'failed', reason: 'smoke response was not a valid transcript envelope' } }, reason: 'parakeet smoke response invalid' };
        }
        try {
          deps.fs.removeRecursive(path.join(stagingDir, 'smoke_request.jsonl'));
        } catch {
          // Best effort; staging leftovers are recovery-visible.
        }
        stage.say('validating', 'promoting staged install');
        writeInstallManifest(deps.writeFile ?? nodeWriteFile(), stagingDir, {
          model_id: ctx.model.id,
          installer_id: 'parakeet-tdt-0.6b-v3',
          backend: 'python-worker',
          runtime_id: PARAKEET_RUNTIME_ID,
          repo: PARAKEET_HF_REPO,
          revision: null,
          snapshot_dir: null,
          source_archive_sha256: null,
        });
        const live = promoteOrFail({ root: ctx.managed_root, fs: deps.fs, stagingDir, liveDir: stage.liveDir });
        const desc = toDescriptor(ctx.model.id, PARAKEET_RUNTIME_ID, live.liveDir);
        return { outcome: 'succeeded', artifact: artifactFromDescriptor(desc, 'parakeet smoke passed on CUDA (' + hardwareSummary(ctx.hardware) + ')') };
      } catch (err) {
        if (checkAborted(ctx)) return { outcome: 'cancelled', reason: 'cancelled during install' };
        abortStaging(ctx.managed_root, deps.fs, stagingDir);
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('promotion failed')) return { outcome: 'failed', reason: msg };
        return { outcome: 'failed', reason: 'parakeet install failed: ' + msg };
      }
    },
  };
}
