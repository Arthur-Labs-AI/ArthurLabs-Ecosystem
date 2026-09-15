/**
 * HR-02.5E1: OmniVoice-BG trusted installer (TTS, CUDA desktop).
 *
 * Trusted upstream identity: preslaff/omnivoice-bg (Hugging Face). No
 * arbitrary repo ids: the id is a code-owned literal below.
 *
 * Managed runtime: python/omnivoice-bg-v1 (Python 3.10–3.13), pinned
 * from the proven standalone venv (D:\OmniVoice-Test: torch
 * 2.14.0+cu130, torchaudio 2.11.0+cu130, transformers 5.17.0,
 * omnivoice 0.2.1, librosa 1.0.0, soundfile 0.14.0, scipy 1.18.1,
 * huggingface_hub 1.31.0, numpy 2.5.3, Python 3.12.10). Only the
 * synthesis-necessary subset is pinned (UI deps like gradio/fastapi
 * are deliberately excluded from the production runtime).
 *
 * Auth: the repo may be gated. 401/403 or hub 'gated' errors map to
 * D1 auth_required with operator guidance (hf auth login). ARTHUR
 * never prompts for, stores, copies, logs, or writes tokens anywhere
 * (no .env writes, no models.json fields — enforced by absence).
 *
 * Reference voice: NEVER developer-local paths (D:\ reference.wav is
 * evidence only). Smoke conditioning uses the deterministic ARTHUR sine
 * fixture generated at smoke time; production reference selection is a
 * user-owned configuration boundary deferred to E2/CLI.
 *
 * Smoke: bounded synthesis of the ARTHUR BG fixture phrase; non-empty
 * PCM output proves imports, checkpoint access, CUDA init, conditioning
 * and generation. Temp wav is deleted afterwards. Quality is NOT judged.
 * Validated platform: windows-x64-cuda.
 */

import type { ModelInstallerId } from '../contracts';
import type { InstallerResult, ModelInstaller, ModelInstallContext } from '../install_contracts';
import { runTrustedProcess, type SpawnFn } from '../provisioning/process_runner';
import type { ProvisioningFs } from '../provisioning/staging';
import type { VenvFs } from '../provisioning/python';
import { SMOKE_BG_PHRASE, smokeReferenceToneBytes, SMOKE_TONE_RATE_HZ } from './smoke_fixtures';
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

function snapshotDirOf(resolve: { stdout: string }): string | null {
  const line = resolve.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0).pop() ?? '';
  return line === '' ? null : line;
}

export const OMNIVOICE_MODEL_ID = 'omnivoice-bg';
export const OMNIVOICE_HF_REPO = 'preslaff/omnivoice-bg';
export const OMNIVOICE_RUNTIME_ID = 'python/omnivoice-bg-v1';
export const OMNIVOICE_PYTHON_MIN = '3.10.0';
export const OMNIVOICE_PYTHON_MAX_EXCLUSIVE = '3.14.0';

// Proven build evidence (standalone D:\OmniVoice-Test venv, 2026-09):
// torch 2.14.0+cu130, torchaudio 2.11.0+cu130, CUDA available, RTX 3060
// Ti, transformers 5.17.0, omnivoice 0.2.1, librosa 1.0.0, soundfile
// 0.14.0, scipy 1.18.1, huggingface_hub 1.31.0, numpy 2.5.3, Python
// 3.12.10. torch/torchaudio come from the code-owned CUDA index (the
// `+cu130` qualifier is load-bearing); the remainder from default PyPI.
// UI stack (gradio/fastapi) intentionally excluded from production.
export const OMNIVOICE_CUDA_INDEX_URL = 'https://download.pytorch.org/whl/cu130';
export const OMNIVOICE_CUDA_PACKAGES = ['torch==2.14.0', 'torchaudio==2.11.0'];
export const OMNIVOICE_PACKAGES = [
  'transformers==5.17.0',
  'omnivoice==0.2.1',
  'librosa==1.0.0',
  'soundfile==0.14.0',
  'scipy==1.18.1',
  'huggingface_hub==1.31.0',
  'numpy==2.5.3',
];

export interface OmniVoiceInstallerDeps {
  run: SpawnFn;
  fs: ProvisioningFs;
  venvFs: VenvFs;
  systemPython: string;
  /** Repo checkout root containing tools/voice/omnivoice_smoke.py. */
  harnessSourceDir?: string;
  smokeTimeoutMs?: number;
  writeFile?: WriteFileFn;
}

function harnessSource(deps: OmniVoiceInstallerDeps): string {
  return (deps.harnessSourceDir ?? process.cwd()) + '/tools/voice/omnivoice_smoke.py';
}

// Deterministic non-personal reference wav for smoke conditioning only.
function writeSmokeRefWav(nodeFs: { writeFileSync(p: string, d: Uint8Array): void }, refWav: string): void {
  const pcm = smokeReferenceToneBytes();
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SMOKE_TONE_RATE_HZ, 24);
  header.writeUInt32LE(SMOKE_TONE_RATE_HZ * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  nodeFs.writeFileSync(refWav, Buffer.concat([header, Buffer.from(pcm)]));
}

export const OMNI_AUTH_GUIDANCE = 'omnivoice-bg requires Hugging Face access; run `hf auth login` (or `huggingface-cli login`) externally, then retry. ARTHUR never stores your token.';

function authFailureText(combined: string): boolean {
  return /401|403|gated|access denied|repository not found|unauthorized/i.test(combined);
}

export function makeOmniVoiceBgInstaller(deps: OmniVoiceInstallerDeps): ModelInstaller {
  const installerId: ModelInstallerId = 'omnivoice-bg';
  return {
    id: installerId,
    install: async (ctx: ModelInstallContext): Promise<InstallerResult> => {
      const stage = openStagedInstall(ctx, OMNIVOICE_RUNTIME_ID);
      // ARTHUR-managed model cache (see parakeet.ts): ambient HF_HOME /
      // home caches can never redirect resolution outside managed root.
      const modelEnv = stage.paths.modelCacheEnv();
      if (ctx.model.id !== OMNIVOICE_MODEL_ID) {
        return { outcome: 'failed', reason: 'omnivoice installer cannot install ' + JSON.stringify(ctx.model.id) };
      }
      if (ctx.hardware.accelerators.cuda !== 'available') {
        return { outcome: 'failed', reason: 'omnivoice-bg requires CUDA available (observed ' + ctx.hardware.accelerators.cuda + ')' };
      }
      if (checkAborted(ctx)) return { outcome: 'cancelled', reason: 'cancelled before staging' };
      stage.say('preparing', 'staging omnivoice-bg install');
      const stagingDir = beginStaging(ctx.managed_root, deps.fs, stage.liveDir, 'omnivoice');
      try {
        stage.say('installing', 'provisioning managed python runtime');
        const venv = await ensureManagedVenv({
          root: ctx.managed_root,
          runtimeDir: stage.runtimeDir,
          runtimeId: OMNIVOICE_RUNTIME_ID,
          systemPython: deps.systemPython,
          packages: { packages: [...OMNIVOICE_CUDA_PACKAGES], indexUrl: OMNIVOICE_CUDA_INDEX_URL },
          extraPackageSets: [{ packages: [...OMNIVOICE_PACKAGES] }],
          signal: ctx.signal,
          run: deps.run,
          venvFs: deps.venvFs,
        });
        stage.say('installing', 'resolving model snapshot (managed cache)');
        const resolve = await runTrustedProcess(deps.run, {
          executable: venv.python_executable,
          args: ['-c', 'from huggingface_hub import snapshot_download; print(snapshot_download(repo_id="' + OMNIVOICE_HF_REPO + '"))'],
          timeoutMs: 600000,
          signal: ctx.signal,
          env: { ...modelEnv },
        });
        if (resolve.aborted) return { outcome: 'cancelled', reason: 'cancelled during snapshot resolve' };
        if (resolve.exit_code !== 0 || resolve.timed_out) {
          if (authFailureText(resolve.stdout + resolve.stderr)) {
            return { outcome: 'auth_required', reason: OMNI_AUTH_GUIDANCE };
          }
          return { outcome: 'failed', reason: 'model snapshot resolve failed (exit ' + String(resolve.exit_code) + ')' };
        }
        if (checkAborted(ctx)) return { outcome: 'cancelled', reason: 'cancelled before validation' };
        stage.say('validating', 'running synthesis smoke (BG fixture phrase)');
        // Real synthesis path through tools/voice/omnivoice_smoke.py
        // (installer-owned versioned harness, argv path, no shell),
        // conditioned on the deterministic ARTHUR sine fixture written to
        // the staging dir (never a personal reference file). Requires a
        // positive SMOKE_BYTES count, then deletes both temp wavs.
        const writeFile = deps.writeFile ?? nodeWriteFile();
        const refWav = stagingDir + '/smoke_ref.wav';
        const outWav = stagingDir + '/smoke_out.wav';
        writeSmokeRefWav({ writeFileSync: (p: string, d: Uint8Array) => writeFile(p, d) }, refWav);
        const harness = harnessSource(deps);
        const synth = await runTrustedProcess(deps.run, {
          executable: venv.python_executable,
          args: [harness, refWav, SMOKE_BG_PHRASE, outWav],
          timeoutMs: deps.smokeTimeoutMs ?? 300000,
          signal: ctx.signal,
          env: { ...modelEnv },
        });
        try {
          deps.fs.removeRecursive(refWav);
        } catch {
          // best effort.
        }
        try {
          deps.fs.removeRecursive(outWav);
        } catch {
          // best effort.
        }
        if (synth.aborted) return { outcome: 'cancelled', reason: 'smoke synthesis aborted' };
        if (synth.timed_out || synth.exit_code !== 0) {
          return { outcome: 'failed', artifact: { installed: true, configured: true, validation: { status: 'failed', reason: 'omnivoice-bg smoke synthesis failed (exit ' + String(synth.exit_code) + ')' } }, reason: 'omnivoice-bg smoke synthesis failed' };
        }
        if (!/SMOKE_BYTES=[1-9][0-9]*/.test(synth.stdout)) {
          return { outcome: 'failed', artifact: { installed: true, configured: true, validation: { status: 'failed', reason: 'smoke produced no audio bytes' } }, reason: 'omnivoice-bg smoke produced no audio' };
        }
        stage.say('validating', 'promoting staged install');
        writeInstallManifest(deps.writeFile ?? nodeWriteFile(), stagingDir, {
          model_id: ctx.model.id,
          installer_id: 'omnivoice-bg',
          backend: 'huggingface-snapshot',
          runtime_id: OMNIVOICE_RUNTIME_ID,
          repo: OMNIVOICE_HF_REPO,
          revision: null,
          snapshot_dir: snapshotDirOf(resolve),
          source_archive_sha256: null,
        });
        const live = promoteOrFail({ root: ctx.managed_root, fs: deps.fs, stagingDir, liveDir: stage.liveDir });
        const desc = toDescriptor(ctx.model.id, OMNIVOICE_RUNTIME_ID, live.liveDir);
        return { outcome: 'succeeded', artifact: artifactFromDescriptor(desc, 'omnivoice-bg smoke synthesis passed on CUDA (' + hardwareSummary(ctx.hardware) + ')') };
      } catch (err) {
        if (checkAborted(ctx)) return { outcome: 'cancelled', reason: 'cancelled during install' };
        abortStaging(ctx.managed_root, deps.fs, stagingDir);
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('promotion failed')) return { outcome: 'failed', reason: msg };
        return { outcome: 'failed', reason: 'omnivoice-bg install failed: ' + msg };
      }
    },
  };
}
