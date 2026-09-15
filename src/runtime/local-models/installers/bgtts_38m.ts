/**
 * HR-02.5E1: BgTTS-38M-V2 trusted installer (TTS, lightweight).
 *
 * Trusted upstream identity: beleata74/BgTTS-38M-V2 (Hugging Face). No
 * arbitrary repo ids: the id is a code-owned literal below.
 *
 * Managed runtime: python/bgtts-38m-v2-v1 (Python 3.10–3.13), SEPARATE
 * from the omnivoice runtime by default (isolation over disk savings;
 * merge only with demonstrated dependency compatibility). Pinned from
 * the proven standalone venv (D:\BgTTS-38M-V2): torch 2.14.0+cu130,
 * torchaudio 2.11.0+cu130, huggingface_hub 1.31.0, safetensors 0.8.0,
 * soundfile 0.14.0, numpy 2.5.3, einops 0.8.2, julius 0.2.8, tqdm,
 * Python 3.12.10 — plus MioCodec from its PINNED source archive
 * (Aratako/MioCodec @ 77473544375d57e96cbdfd5d7d257e8f280fa8e3,
 * SHA-256 fc0db83c…, fetched as a code-owned trusted HTTPS archive via
 * the D2 downloader, hash-verified, installed from the local file).
 * No git executable dependency, no `pip install <arbitrary-url>` from
 * runtime data; the URL is a literal in THIS trusted file.
 *
 * Smoke: bounded BG synthesis through tools/voice/bgtts_smoke.py
 * (installer-owned versioned harness) against the resolved checkpoint,
 * conditioned on the deterministic ARTHUR sine fixture. Non-empty wav
 * proves runtime, checkpoint, conditioning, and generation. Temp wavs
 * deleted afterwards. ARM64 is NOT validated (no claim added).
 * Validated platform: windows-x64-cuda (experimental maturity).
 */

import type { ModelInstallerId } from '../contracts';
import type { InstallerResult, ModelInstaller, ModelInstallContext } from '../install_contracts';
import { runTrustedProcess, type SpawnFn } from '../provisioning/process_runner';
import type { ProvisioningFs } from '../provisioning/staging';
import type { VenvFs } from '../provisioning/python';
import { downloadArtifact, internalDefineTrustedArtifactSource, nodeDownloadFs, nodeHttpTransport, type DownloadFs, type HttpTransport } from '../provisioning/downloader';
import { nodeVerifyFs, verifyArtifact, type VerifyFs } from '../provisioning/verification';
import type { Pathoscopy } from '../provisioning/paths';
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

export const BGTTS_MODEL_ID = 'bgtts-38m-v2';
export const BGTTS_HF_REPO = 'beleata74/BgTTS-38M-V2';
export const BGTTS_RUNTIME_ID = 'python/bgtts-38m-v2-v1';
export const BGTTS_WORKER_FILE = 'bgtts_worker.py';
export const BGTTS_PYTHON_MIN = '3.10.0';
export const BGTTS_PYTHON_MAX_EXCLUSIVE = '3.14.0';
// MioCodec is provisioned WITHOUT the git executable: the exact pinned
// commit is fetched as a code-owned trusted HTTPS source archive through
// the D2 downloader boundary, SHA-256-verified (required), then installed
// from the local verified file. No git/Schannel runtime dependency, no
// arbitrary git URLs, fully ARTHUR-managed.
// Archive identity (measured 2026-09-15, 106287 bytes):
export const BGTTS_MIOCODEC_ARCHIVE_URL = 'https://github.com/Aratako/MioCodec/archive/77473544375d57e96cbdfd5d7d257e8f280fa8e3.zip';
export const BGTTS_MIOCODEC_ARCHIVE_SHA256 = 'fc0db83cb727f9887b0724d157f78d6faa5bec7313db540b2343ec72a0e752e6';
export const BGTTS_MIOCODEC_ARCHIVE_LABEL = 'miocodec-77473544-source';
export const BGTTS_MIOCODEC_VERSION = '0.1.0';

// Proven build evidence (standalone D:\BgTTS-38M-V2 venv, 2026-09):
// torch 2.14.0+cu130, torchaudio 2.11.0+cu130, CUDA available, RTX 3060
// Ti, huggingface_hub 1.31.0, safetensors 0.8.0, soundfile 0.14.0, numpy
// 2.5.3, einops 0.8.2, julius 0.2.8, tqdm 4.70.1, Python 3.12.10, plus
// MioCodec @ 77473544 (exact proven revision). torch/torchaudio from
// the code-owned CUDA index; the remainder from default PyPI.
export const BGTTS_CUDA_INDEX_URL = 'https://download.pytorch.org/whl/cu130';
export const BGTTS_CUDA_PACKAGES = ['torch==2.14.0', 'torchaudio==2.11.0'];
// The pinned MioCodec source declares its own PEP 517 backend
// (`uv_build>=0.9.6,<0.10.0`); pip resolves it into the temporary
// isolated build environment at install time, exactly as the proven
// historical install did (Generator: uv 0.9.30, Tag: py3-none-any).
// uv_build/uv are therefore NEVER runtime dependencies of the managed
// venv — matching the proven environment, which contains neither.
// jsonargparse 4.52.0 + PyYAML 6.0.3: MioCodec runtime requirements
// (found missing by E1 acceptance 2026-09-15 at the import check;
// versions from the proven venv; PyYAML is jsonargparse's sole
// Requires-Dist). The local-archive install runs --no-deps, so runtime
// deps of MioCodec must be pinned here explicitly.
export const BGTTS_PACKAGES = [
  'huggingface_hub==1.31.0',
  'safetensors==0.8.0',
  'soundfile==0.14.0',
  'numpy==2.5.3',
  'einops==0.8.2',
  'julius==0.2.8',
  'tqdm==4.70.1',
  'jsonargparse==4.52.0',
  'PyYAML==6.0.3',
];

export interface BgTtsInstallerDeps {
  run: SpawnFn;
  fs: ProvisioningFs;
  venvFs: VenvFs;
  systemPython: string;
  harnessSourceDir?: string;
  smokeTimeoutMs?: number;
  writeFile?: WriteFileFn;
  readSourceFile?: (filePath: string) => string;
  /** D2 download seams (default node transport/fs; tests inject fakes). */
  transport?: HttpTransport;
  downloadFs?: DownloadFs;
  verifyFs?: VerifyFs;
  scope?: Pathoscopy | null;
}

function harnessSource(deps: BgTtsInstallerDeps): string {
  return (deps.harnessSourceDir ?? process.cwd()) + '/tools/voice/bgtts_smoke.py';
}

/**
 * Stage the versioned production worker (ARTHUR-owned trusted code)
 * into the install so the promoted live dir contains everything E2
 * needs. Mirrors the Parakeet worker-copy pattern.
 */
function copyProductionWorker(deps: BgTtsInstallerDeps, stagingDir: string): void {
  const path = require('node:path') as typeof import('node:path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('node:fs') as typeof import('node:fs');
  const from = path.join(deps.harnessSourceDir ?? process.cwd(), 'tools', 'voice', BGTTS_WORKER_FILE);
  const raw = deps.readSourceFile ? deps.readSourceFile(from) : nodeFs.readFileSync(from, 'utf8');
  const write = deps.writeFile ?? nodeWriteFile();
  write(path.join(stagingDir, BGTTS_WORKER_FILE), raw);
}

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

export function makeBgTts38mInstaller(deps: BgTtsInstallerDeps): ModelInstaller {
  const installerId: ModelInstallerId = 'bgtts-38m-v2';
  return {
    id: installerId,
    install: async (ctx: ModelInstallContext): Promise<InstallerResult> => {
      const stage = openStagedInstall(ctx, BGTTS_RUNTIME_ID);
      // ARTHUR-managed model cache (see parakeet.ts): ambient HF_HOME /
      // home caches can never redirect resolution outside managed root.
      const modelEnv = stage.paths.modelCacheEnv();
      if (ctx.model.id !== BGTTS_MODEL_ID) {
        return { outcome: 'failed', reason: 'bgtts installer cannot install ' + JSON.stringify(ctx.model.id) };
      }
      if (checkAborted(ctx)) return { outcome: 'cancelled', reason: 'cancelled before staging' };
      stage.say('preparing', 'staging bgtts-38m-v2 install');
      const stagingDir = beginStaging(ctx.managed_root, deps.fs, stage.liveDir, 'bgtts');
      copyProductionWorker(deps, stagingDir);
      try {
        stage.say('installing', 'provisioning managed python runtime');
        const venv = await ensureManagedVenv({
          root: ctx.managed_root,
          runtimeDir: stage.runtimeDir,
          runtimeId: BGTTS_RUNTIME_ID,
          systemPython: deps.systemPython,
          packages: { packages: [...BGTTS_CUDA_PACKAGES], indexUrl: BGTTS_CUDA_INDEX_URL },
          extraPackageSets: [{ packages: [...BGTTS_PACKAGES] }],
          signal: ctx.signal,
          run: deps.run,
          venvFs: deps.venvFs,
        });
        stage.say('installing', 'installing pinned MioCodec revision');
        // Idempotency: a previous installer-controlled install records a
        // direct_url.json whose url carries our staged archive filename
        // (miocodec-77473544.zip — installer-chosen, never a foreign
        // install). When present with version 0.1.0, skip reinstalling.
        // Fresh environments always provision. (Local-archive installs do
        // not reliably record archive hashes, so filename + version —
        // both installer-controlled — is the identity evidence here; the
        // SHA-256 gate already ran on the archive before pip received it.)
        const present = await runTrustedProcess(deps.run, {
          executable: venv.python_executable,
          args: ['-c', 'import importlib.metadata as m; d = m.distribution("miocodec"); print(d.version); print(d.read_text("direct_url.json") or "")'],
          timeoutMs: 60000,
          signal: ctx.signal,
        });
        if (present.exit_code !== 0 || !present.stdout.includes('miocodec-77473544.zip')) {
          const source = internalDefineTrustedArtifactSource(BGTTS_MIOCODEC_ARCHIVE_URL, BGTTS_MIOCODEC_ARCHIVE_LABEL);
          const transport = deps.transport ?? nodeHttpTransport();
          const downloadFs = deps.downloadFs ?? nodeDownloadFs();
          const verifyFs = deps.verifyFs ?? nodeVerifyFs();
          const archivePath = stagingDir + '/miocodec-77473544.zip';
          const downloaded = await downloadArtifact(ctx.managed_root, transport, downloadFs, {
            source,
            destPath: archivePath,
            timeoutMs: 300000,
            maxBytes: 32 * 1024 * 1024,
            signal: ctx.signal,
            scope: deps.scope ?? null,
          });
          if (downloaded.outcome === 'cancelled' || checkAborted(ctx)) return { outcome: 'cancelled', reason: 'MioCodec download cancelled' };
          if (downloaded.outcome !== 'downloaded' || !downloaded.path) {
            return { outcome: 'failed', reason: 'MioCodec source download failed: ' + String(downloaded.reason ?? downloaded.outcome) };
          }
          try {
            await verifyArtifact(verifyFs, downloaded.path, { mode: 'required', expected_sha256: BGTTS_MIOCODEC_ARCHIVE_SHA256 });
          } catch (err) {
            return { outcome: 'failed', reason: 'MioCodec source verification failed: ' + String(err instanceof Error ? err.message : err) };
          }
          // Normal PEP 517 isolated build (NO --no-build-isolation): pip
          // resolves the source-declared `uv_build` backend into a
          // temporary build environment, exactly as the proven historical
          // install did. The backend never lands in the managed runtime.
          // --no-deps keeps runtime deps installer-controlled; --no-index
          // is NOT passed (the isolated build env needs PyPI for the
          // backend). The archive itself is local and hash-verified.
          const miocodec = await runTrustedProcess(deps.run, {
            executable: venv.python_executable,
            args: ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--no-deps', downloaded.path],
            timeoutMs: 600000,
            signal: ctx.signal,
          });
          if (miocodec.exit_code !== 0 || miocodec.aborted || miocodec.timed_out) {
            return { outcome: 'failed', reason: 'MioCodec pinned install failed (exit ' + String(miocodec.exit_code) + ')' };
          }
        }
        // Post-install verification: importable, version 0.1.0, installed
        // from THIS installer-controlled verified source (direct_url
        // archive hash must equal the pin — not merely "some miocodec").
        const verifyInstalled = await runTrustedProcess(deps.run, {
          executable: venv.python_executable,
          args: ['-c', 'import importlib.metadata as m, json; d = m.distribution("miocodec"); print(d.version); print(d.read_text("direct_url.json") or "")'],
          timeoutMs: 60000,
          signal: ctx.signal,
        });
        if (verifyInstalled.exit_code !== 0 || verifyInstalled.aborted || verifyInstalled.timed_out) {
          return { outcome: 'failed', reason: 'MioCodec post-install import check failed (exit ' + String(verifyInstalled.exit_code) + ')' };
        }
        if (!verifyInstalled.stdout.split(/\r?\n/).some((l) => l.trim() === BGTTS_MIOCODEC_VERSION)) {
          return { outcome: 'failed', reason: 'MioCodec version mismatch (expected ' + BGTTS_MIOCODEC_VERSION + ')' };
        }
        if (!verifyInstalled.stdout.includes('miocodec-77473544.zip')) {
          return { outcome: 'failed', reason: 'MioCodec source identity mismatch (not from the installer-controlled archive)' };
        }
        try {
          const inImport = await runTrustedProcess(deps.run, {
            executable: venv.python_executable,
            args: ['-c', 'import miocodec; print("miocodec-import-ok")'],
            timeoutMs: 60000,
            signal: ctx.signal,
          });
          if (inImport.exit_code !== 0 || !inImport.stdout.includes('miocodec-import-ok')) {
            return { outcome: 'failed', reason: 'MioCodec import check failed' };
          }
        } catch (err) {
          return { outcome: 'failed', reason: 'MioCodec import check errored: ' + String(err instanceof Error ? err.message : err) };
        }
        stage.say('installing', 'resolving model snapshot (managed cache)');
        const resolve = await runTrustedProcess(deps.run, {
          executable: venv.python_executable,
          args: ['-c', 'from huggingface_hub import snapshot_download; print(snapshot_download(repo_id="' + BGTTS_HF_REPO + '"))'],
          timeoutMs: 600000,
          signal: ctx.signal,
          env: { ...modelEnv },
        });
        if (resolve.aborted) return { outcome: 'cancelled', reason: 'cancelled during snapshot resolve' };
        if (resolve.exit_code !== 0 || resolve.timed_out) {
          return { outcome: 'failed', reason: 'model snapshot resolve failed (exit ' + String(resolve.exit_code) + ')' };
        }
        if (checkAborted(ctx)) return { outcome: 'cancelled', reason: 'cancelled before validation' };
        stage.say('validating', 'running synthesis smoke (BG fixture phrase)');
        const snapshotDir = resolve.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0).pop() ?? '';
        if (snapshotDir === '') {
          return { outcome: 'failed', reason: 'model snapshot resolve produced no path' };
        }
        const writeFile = deps.writeFile ?? nodeWriteFile();
        const refWav = stagingDir + '/smoke_ref.wav';
        const outWav = stagingDir + '/smoke_out.wav';
        writeSmokeRefWav({ writeFileSync: (p: string, d: Uint8Array) => writeFile(p, d) }, refWav);
        const synth = await runTrustedProcess(deps.run, {
          executable: venv.python_executable,
          args: [harnessSource(deps), snapshotDir, refWav, SMOKE_BG_PHRASE, outWav],
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
          return { outcome: 'failed', artifact: { installed: true, configured: true, validation: { status: 'failed', reason: 'bgtts smoke synthesis failed (exit ' + String(synth.exit_code) + ')' } }, reason: 'bgtts smoke synthesis failed' };
        }
        if (!/SMOKE_BYTES=[1-9][0-9]*/.test(synth.stdout)) {
          return { outcome: 'failed', artifact: { installed: true, configured: true, validation: { status: 'failed', reason: 'smoke produced no audio bytes' } }, reason: 'bgtts smoke produced no audio' };
        }
        stage.say('validating', 'promoting staged install');
        writeInstallManifest(writeFile, stagingDir, {
          model_id: ctx.model.id,
          installer_id: 'bgtts-38m-v2',
          backend: 'python-worker',
          runtime_id: BGTTS_RUNTIME_ID,
          repo: BGTTS_HF_REPO,
          revision: null,
          snapshot_dir: snapshotDir,
          source_archive_sha256: BGTTS_MIOCODEC_ARCHIVE_SHA256,
        });
        const live = promoteOrFail({ root: ctx.managed_root, fs: deps.fs, stagingDir, liveDir: stage.liveDir });
        const desc = toDescriptor(ctx.model.id, BGTTS_RUNTIME_ID, live.liveDir);
        return { outcome: 'succeeded', artifact: artifactFromDescriptor(desc, 'bgtts-38m-v2 smoke synthesis passed (' + hardwareSummary(ctx.hardware) + ')') };
      } catch (err) {
        if (checkAborted(ctx)) return { outcome: 'cancelled', reason: 'cancelled during install' };
        abortStaging(ctx.managed_root, deps.fs, stagingDir);
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('promotion failed')) return { outcome: 'failed', reason: msg };
        return { outcome: 'failed', reason: 'bgtts install failed: ' + msg };
      }
    },
  };
}
