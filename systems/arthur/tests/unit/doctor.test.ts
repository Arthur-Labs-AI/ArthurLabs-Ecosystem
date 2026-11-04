/**
 * FRS-05: doctor diagnostics tests (matrix A-N).
 *
 * Deterministic: every layer (config/machine, repo, ambient, audio,
 * models, live probes) is injected — no network, no ffmpeg, no disk,
 * no mutation. Verifies the full §26 matrix against diagnoseDoctor and
 * the apps/cli/doctor adapter.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CliExit } from '../../src/cli_exit';
import { diagnoseDoctor, type DiagnoseArgs } from '../../src/doctor/diagnose';
import { aggregateDoctorStatus, exitCodeForDoctor, finalizeDoctorReport } from '../../src/doctor/aggregate';
import { runDoctor } from '../../apps/cli/doctor';
import type { CliIO } from '../../apps/cli/index';
import { readyResult, failedResult, notConfigured } from '../../src/providers/readiness';
import { defaultStateFile } from '../../src/runtime/local-models/state_contracts';
import { unknownAccelerators } from '../../src/runtime/hardware/contracts';
import type { HardwareProfile } from '../../src/runtime/hardware/contracts';
import type { LocalModelDefinition } from '../../src/runtime/local-models/contracts';

function capturingIo(): CliIO & { outText: string; errText: string } {
  const sink = { outText: '', errText: '' };
  return {
    outText: '',
    errText: '',
    out(text: string): void { sink.outText += text; (this as unknown as { outText: string }).outText += text; },
    err(text: string): void { sink.errText += text; (this as unknown as { errText: string }).errText += text; },
  } as CliIO & { outText: string; errText: string };
}

const TEST_HARDWARE: HardwareProfile = {
  os: 'windows',
  arch: 'x64',
  memory: { total_mb: 32768 },
  cpu: { logical_cores: 16, model: 'Test CPU' },
  gpus: [{ vendor: 'nvidia', name: 'RTX Test', vram_mb: 12288 }],
  accelerators: { cuda: 'available', rocm: 'unavailable', vulkan: 'available', directml: 'available', npu: 'unknown' },
};

const LINUX_HARDWARE: HardwareProfile = {
  os: 'linux',
  arch: 'x64',
  memory: { total_mb: 16384 },
  cpu: { logical_cores: 8, model: 'Linux CPU' },
  gpus: [],
  accelerators: { ...unknownAccelerators(), cuda: 'unavailable' },
};

const TEST_CATALOG: readonly LocalModelDefinition[] = [
  {
    id: 'test-stt-1',
    kind: 'stt',
    provider_id: 'test-stt',
    quality_tier: 'high',
    languages: ['en'],
    requirements: { architectures: ['x64'], operating_systems: ['windows', 'linux'], min_ram_mb: 1024, accelerator: 'cpu' },
    support: { maturity: 'validated', validated_platforms: ['windows-x64'] },
    installation: { installer_id: 'test-stt-1', backend: 'python-worker' },
  } as unknown as LocalModelDefinition,
  {
    id: 'test-tts-1',
    kind: 'tts',
    provider_id: 'test-tts',
    quality_tier: 'high',
    languages: ['en'],
    requirements: { architectures: ['x64'], operating_systems: ['windows', 'linux'], min_ram_mb: 1024, accelerator: 'cpu' },
    support: { maturity: 'validated', validated_platforms: ['windows-x64'] },
    installation: { installer_id: 'test-tts-1', backend: 'python-worker' },
  } as unknown as LocalModelDefinition,
];

function baseArgs(overrides: Partial<DiagnoseArgs> = {}): DiagnoseArgs {
  return {
    layers: {
      ambient: {},
      repo: {},
      machine: { DEEPSEEK_API_KEY: 'k', ARTHUR_MODEL_PROVIDER: 'deepseek', ARTHUR_MODEL_NAME: 'deepseek-chat' },
      machineConfigPath: '/data/config.env',
    },
    file: { configPath: '/data/config.env', present: true, readable: true, entryCount: 3 },
    audio: {
      info: { id: 'ffmpeg-dshow', platform: 'win32', available: true, captureExecutable: 'ffmpeg', playbackExecutable: 'ffplay', captureAvailable: true, playbackAvailable: true, captureVersion: 'v', playbackVersion: 'v' },
      inputs: [],
      discoverySupported: true,
    },
    models: { statePath: '/data/runtime/models.json', statePresent: false, snapshot: defaultStateFile(), hardware: TEST_HARDWARE, managedRoot: '/data/runtime/local-models', catalog: TEST_CATALOG, exists: () => true },
    live: false,
    interactive: false,
    ...overrides,
  };
}

function checkById(report: { checks: { id: string; status: string; required: boolean }[] }, id: string): { id: string; status: string; required: boolean } {
  const hit = report.checks.find((c) => c.id === id);
  assert.ok(hit, 'missing check ' + id);
  return hit as { id: string; status: string; required: boolean };
}

// ---- A. unconfigured ----------------------------------------------------------

test('A: missing config does not crash; UNCONFIGURED with arthur setup remediation', async () => {
  const report = await diagnoseDoctor(baseArgs({
    layers: { ambient: {}, repo: {}, machine: {}, machineConfigPath: '/data/config.env' },
    file: { configPath: '/data/config.env', present: false, readable: true },
  }));
  assert.equal(report.status, 'UNCONFIGURED');
  assert.equal(report.profile, 'unconfigured');
  assert.equal(report.ok, false);
  const present = report.checks.find((c) => c.id === 'config.present');
  assert.ok(present && present.status === 'fail' && present.required);
  assert.equal(present?.remediation, 'arthur setup');
  assert.equal(exitCodeForDoctor(report), CliExit.VALIDATION_FAILED);
});

// ---- B. profile graph -----------------------------------------------------------

test('B1: text only ignores audio/OpenAI/models', async () => {
  const report = await diagnoseDoctor(baseArgs({
    layers: {
      ambient: {},
      repo: {},
      machine: { DEEPSEEK_API_KEY: 'k', ARTHUR_MODEL_PROVIDER: 'deepseek', ARTHUR_VOICE_ENABLED: 'false' },
      machineConfigPath: '/data/config.env',
    },
  }));
  assert.equal(report.profile, 'text_only');
  assert.equal(report.status, 'READY');
  assert.equal(checkById(report, 'audio.backend.ffmpeg').status, 'skipped');
  assert.equal(checkById(report, 'provider.openai.credential').status, 'skipped');
  assert.equal(checkById(report, 'model.stt.ready').status, 'skipped');
  assert.equal(report.ok, true);
  assert.equal(exitCodeForDoctor(report), CliExit.SUCCESS);
});

test('B2: cloud voice requires DS + OpenAI + audio', async () => {
  const report = await diagnoseDoctor(baseArgs({
    layers: {
      ambient: {},
      repo: {},
      machine: {
        DEEPSEEK_API_KEY: 'k',
        OPENAI_API_KEY: 'k2',
        ARTHUR_MODEL_PROVIDER: 'deepseek',
        ARTHUR_VOICE_ENABLED: 'true',
        ARTHUR_STT_POLICY: 'cloud_preferred',
        ARTHUR_TTS_POLICY: 'cloud_preferred',
        ARTHUR_AUDIO_INPUT_DEVICE: 'Mic',
        ARTHUR_AUDIO_CAPTURE_COMMAND: 'ffmpeg -i mic',
        ARTHUR_AUDIO_PLAYBACK_COMMAND: 'ffplay -',
      },
      machineConfigPath: '/data/config.env',
    },
    audio: {
      info: { id: 'ffmpeg-dshow', platform: 'win32', available: true, captureExecutable: 'ffmpeg', playbackExecutable: 'ffplay', captureAvailable: true, playbackAvailable: true, captureVersion: 'v', playbackVersion: 'v' },
      inputs: [{ id: 'Mic', label: 'Mic', backend: 'ffmpeg-dshow' }],
      discoverySupported: true,
    },
  }));
  assert.equal(report.profile, 'cloud_voice');
  assert.equal(checkById(report, 'provider.deepseek.credential').status, 'pass');
  assert.equal(checkById(report, 'provider.openai.credential').status, 'pass');
  assert.equal(checkById(report, 'audio.input.device').status, 'pass');
  assert.equal(checkById(report, 'model.stt.ready').status, 'skipped');
  assert.equal(report.status, 'READY');
});

test('B3: local voice requires DS + audio + local models, NOT OpenAI', async () => {
  // Real catalog ids: fake ids have no runtime-target mapping (fail closed
  // by design), so the pass-path fixture uses parakeet + omnivoice.
  const { getLocalModelCatalog } = await import('../../src/runtime/local-models/catalog');
  const realCatalog = getLocalModelCatalog();
  const snapshot = defaultStateFile();
  snapshot.models['parakeet-tdt-0.6b-v3'] = { model_id: 'parakeet-tdt-0.6b-v3', installed: true, configured: true, ready: true };
  snapshot.models['omnivoice-bg'] = { model_id: 'omnivoice-bg', installed: true, configured: true, ready: true };
  snapshot.selections = { stt: { mode: 'manual', model_id: 'parakeet-tdt-0.6b-v3' }, tts: { mode: 'manual', model_id: 'omnivoice-bg' }, model: { mode: 'auto' } };
  const report = await diagnoseDoctor(baseArgs({
    layers: {
      ambient: {},
      repo: {},
      machine: {
        DEEPSEEK_API_KEY: 'k',
        ARTHUR_MODEL_PROVIDER: 'deepseek',
        ARTHUR_VOICE_ENABLED: 'true',
        ARTHUR_STT_POLICY: 'local_only',
        ARTHUR_TTS_POLICY: 'local_only',
        ARTHUR_AUDIO_INPUT_DEVICE: 'Mic',
        ARTHUR_AUDIO_CAPTURE_COMMAND: 'ffmpeg -i mic',
        ARTHUR_AUDIO_PLAYBACK_COMMAND: 'ffplay -',
      },
      machineConfigPath: '/data/config.env',
    },
    audio: {
      info: { id: 'ffmpeg-dshow', platform: 'win32', available: true, captureExecutable: 'ffmpeg', playbackExecutable: 'ffplay', captureAvailable: true, playbackAvailable: true, captureVersion: 'v', playbackVersion: 'v' },
      inputs: [{ id: 'Mic', label: 'Mic', backend: 'ffmpeg-dshow' }],
      discoverySupported: true,
    },
    models: { statePath: '/s', statePresent: true, snapshot, hardware: TEST_HARDWARE, managedRoot: '/m', catalog: realCatalog, exists: () => true },
  }));
  assert.equal(report.profile, 'local_voice');
  assert.equal(checkById(report, 'provider.openai.credential').status, 'skipped');
  assert.equal(checkById(report, 'model.stt.ready').status, 'pass');
  assert.equal(checkById(report, 'model.tts.ready').status, 'pass');
  assert.equal(report.status, 'READY');
  const human = (await import('../../apps/cli/doctor')).renderDoctorHuman(report);
  assert.match(human, /Speech: local/);
  assert.doesNotMatch(human, /offline/i);
});

test('B4: custom follows actual deps (openai STT + local TTS)', async () => {
  const report = await diagnoseDoctor(baseArgs({
    layers: {
      ambient: {},
      repo: {},
      machine: {
        DEEPSEEK_API_KEY: 'k',
        OPENAI_API_KEY: 'k2',
        ARTHUR_MODEL_PROVIDER: 'deepseek',
        ARTHUR_VOICE_ENABLED: 'true',
        ARTHUR_STT_POLICY: 'cloud_preferred',
        ARTHUR_TTS_POLICY: 'local_only',
        ARTHUR_AUDIO_INPUT_DEVICE: 'Mic',
        ARTHUR_AUDIO_CAPTURE_COMMAND: 'ffmpeg -i mic',
        ARTHUR_AUDIO_PLAYBACK_COMMAND: 'ffplay -',
      },
      machineConfigPath: '/data/config.env',
    },
    audio: {
      info: { id: 'ffmpeg-dshow', platform: 'win32', available: true, captureExecutable: 'ffmpeg', playbackExecutable: 'ffplay', captureAvailable: true, playbackAvailable: true, captureVersion: 'v', playbackVersion: 'v' },
      inputs: [{ id: 'Mic', label: 'Mic', backend: 'ffmpeg-dshow' }],
      discoverySupported: true,
    },
  }));
  assert.equal(report.profile, 'partial');
  assert.equal(checkById(report, 'provider.openai.credential').status, 'pass');
  assert.equal(checkById(report, 'model.tts.ready').status, 'fail');
  assert.equal(checkById(report, 'model.stt.ready').status, 'skipped');
});

// ---- C. config ---------------------------------------------------------------------

test('C: malformed config diagnosed; secrets never rendered', async () => {
  const report = await diagnoseDoctor(baseArgs({
    file: { configPath: '/data/config.env', present: true, readable: true, malformed: 'machine config is malformed' },
  }));
  const parse = checkById(report, 'config.parse');
  assert.equal(parse.status, 'fail');
  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /sk-live|super-secret-value/);
});

// ---- D. provider static ------------------------------------------------------------------

test('D: absent required credential fails; optional skipped', async () => {
  const missing = await diagnoseDoctor(baseArgs({
    layers: { ambient: {}, repo: {}, machine: { ARTHUR_MODEL_PROVIDER: 'deepseek' }, machineConfigPath: '/d' },
  }));
  assert.equal(checkById(missing, 'provider.deepseek.credential').status, 'fail');
  assert.equal(missing.status, 'NOT_READY');
  const textOnly = await diagnoseDoctor(baseArgs({
    layers: { ambient: {}, repo: {}, machine: { DEEPSEEK_API_KEY: 'k', ARTHUR_VOICE_ENABLED: 'false' }, machineConfigPath: '/d' },
  }));
  assert.equal(checkById(textOnly, 'provider.openai.credential').status, 'skipped');
});

// ---- E. provider live ----------------------------------------------------------------------

test('E1: live ready maps to pass', async () => {
  const report = await diagnoseDoctor(baseArgs({
    layers: {
      ambient: {},
      repo: {},
      machine: { DEEPSEEK_API_KEY: 'k', OPENAI_API_KEY: 'k2', ARTHUR_VOICE_ENABLED: 'false' },
      machineConfigPath: '/d',
    },
    live: true,
    seams: {
      probeDeepseek: async () => readyResult('deepseek', 'reasoning', ['completion']),
    },
  }));
  assert.equal(checkById(report, 'provider.deepseek.live').status, 'pass');
});

test('E2: auth failure maps to fail with remediation; one failure does not abort', async () => {
  const report = await diagnoseDoctor(baseArgs({
    layers: {
      ambient: {},
      repo: {},
      machine: { DEEPSEEK_API_KEY: 'k', ARTHUR_VOICE_ENABLED: 'false' },
      machineConfigPath: '/d',
    },
    live: true,
    seams: {
      probeDeepseek: async () => failedResult('deepseek', 'reasoning', 'auth_failed', 'auth'),
    },
  }));
  const live = report.checks.find((c) => c.id === 'provider.deepseek.live');
  assert.equal(live?.status, 'fail');
  assert.equal(live?.remediation, 'arthur providers setup');
  assert.ok(report.checks.length > 5);
  assert.equal(report.status, 'NOT_READY');
});

test('E3: timeout/unavailable/not-configured map safely', async () => {
  const report = await diagnoseDoctor(baseArgs({
    layers: { ambient: {}, repo: {}, machine: {}, machineConfigPath: '/d' },
    file: { configPath: '/d', present: false, readable: true },
    live: true,
    seams: {
      probeDeepseek: async () => failedResult('deepseek', 'reasoning', 'unavailable', 'timeout'),
    },
  }));
  assert.equal(checkById(report, 'provider.deepseek.live').status, 'fail');
  const nc = await diagnoseDoctor(baseArgs({
    layers: { ambient: {}, repo: {}, machine: {}, machineConfigPath: '/d' },
    file: { configPath: '/d', present: false, readable: true },
    live: true,
    seams: { probeDeepseek: async () => notConfigured('deepseek', 'reasoning') },
  }));
  assert.equal(checkById(nc, 'provider.deepseek.live').status, 'fail');
});

// ---- F. audio static --------------------------------------------------------------------------

test('F1: executables + commands + device presence/drift', async () => {
  const good = await diagnoseDoctor(baseArgs({
    layers: {
      ambient: {},
      repo: {},
      machine: {
        DEEPSEEK_API_KEY: 'k', OPENAI_API_KEY: 'k2', ARTHUR_VOICE_ENABLED: 'true',
        ARTHUR_STT_POLICY: 'cloud_preferred', ARTHUR_TTS_POLICY: 'cloud_preferred',
        ARTHUR_AUDIO_INPUT_DEVICE: 'Mic', ARTHUR_AUDIO_CAPTURE_COMMAND: 'ffmpeg x', ARTHUR_AUDIO_PLAYBACK_COMMAND: 'ffplay y',
      },
      machineConfigPath: '/d',
    },
    audio: {
      info: { id: 'b', platform: 'win32', available: true, captureExecutable: 'ffmpeg', playbackExecutable: 'ffplay', captureAvailable: true, playbackAvailable: true, captureVersion: '', playbackVersion: '' },
      inputs: [{ id: 'Mic', label: 'Mic', backend: 'b' }],
      discoverySupported: true,
    },
  }));
  assert.equal(checkById(good, 'audio.backend.ffmpeg').status, 'pass');
  assert.equal(checkById(good, 'audio.input.device').status, 'pass');
  const drift = await diagnoseDoctor(baseArgs({
    layers: {
      ambient: {},
      repo: {},
      machine: {
        DEEPSEEK_API_KEY: 'k', OPENAI_API_KEY: 'k2', ARTHUR_VOICE_ENABLED: 'true',
        ARTHUR_STT_POLICY: 'cloud_preferred', ARTHUR_TTS_POLICY: 'cloud_preferred',
        ARTHUR_AUDIO_INPUT_DEVICE: 'OldMic', ARTHUR_AUDIO_CAPTURE_COMMAND: 'ffmpeg x', ARTHUR_AUDIO_PLAYBACK_COMMAND: 'ffplay y',
      },
      machineConfigPath: '/d',
    },
    audio: {
      info: { id: 'b', platform: 'win32', available: true, captureExecutable: 'ffmpeg', playbackExecutable: 'ffplay', captureAvailable: true, playbackAvailable: true, captureVersion: '', playbackVersion: '' },
      inputs: [{ id: 'NewMic', label: 'NewMic', backend: 'b' }],
      discoverySupported: true,
    },
  }));
  const device = drift.checks.find((c) => c.id === 'audio.input.device');
  assert.equal(device?.status, 'fail');
  assert.equal(device?.remediation, 'arthur audio setup');
});

test('F2: unsupported platform distinguished from zero devices', async () => {
  const unsupported = await diagnoseDoctor(baseArgs({
    layers: {
      ambient: {},
      repo: {},
      machine: {
        DEEPSEEK_API_KEY: 'k', OPENAI_API_KEY: 'k2', ARTHUR_VOICE_ENABLED: 'true',
        ARTHUR_STT_POLICY: 'cloud_preferred', ARTHUR_TTS_POLICY: 'cloud_preferred',
        ARTHUR_AUDIO_INPUT_DEVICE: 'Mic', ARTHUR_AUDIO_CAPTURE_COMMAND: 'ffmpeg x', ARTHUR_AUDIO_PLAYBACK_COMMAND: 'ffplay y',
      },
      machineConfigPath: '/d',
    },
    audio: {
      info: { id: 'ffmpeg-dshow', platform: 'linux', available: false, captureExecutable: 'ffmpeg', playbackExecutable: 'ffplay', captureAvailable: true, playbackAvailable: true, captureVersion: '', playbackVersion: '' },
      inputs: [],
      discoverySupported: false,
    },
  }));
  const device = unsupported.checks.find((c) => c.id === 'audio.input.device');
  assert.equal(device?.status, 'skipped');
  assert.match(device?.message ?? '', /not supported/);
  const supportedZero = await diagnoseDoctor(baseArgs({
    layers: {
      ambient: {},
      repo: {},
      machine: {
        DEEPSEEK_API_KEY: 'k', OPENAI_API_KEY: 'k2', ARTHUR_VOICE_ENABLED: 'true',
        ARTHUR_STT_POLICY: 'cloud_preferred', ARTHUR_TTS_POLICY: 'cloud_preferred',
        ARTHUR_AUDIO_INPUT_DEVICE: 'Mic', ARTHUR_AUDIO_CAPTURE_COMMAND: 'ffmpeg x', ARTHUR_AUDIO_PLAYBACK_COMMAND: 'ffplay y',
      },
      machineConfigPath: '/d',
    },
    audio: {
      info: { id: 'b', platform: 'win32', available: true, captureExecutable: 'ffmpeg', playbackExecutable: 'ffplay', captureAvailable: true, playbackAvailable: true, captureVersion: '', playbackVersion: '' },
      inputs: [],
      discoverySupported: true,
    },
  }));
  assert.equal(checkById(supportedZero, 'audio.input.device').status, 'fail');
  assert.equal(checkById(supportedZero, 'audio.input.discovery').status, 'warn');
});

// ---- G. audio live -------------------------------------------------------------------------------

test('G1: capture frames pass; silence warns; no bytes fail', async () => {
  const mk = (result: { transportReady: boolean; signalDetected: boolean; frames: number; failure?: string }) => baseArgs({
    layers: {
      ambient: {},
      repo: {},
      machine: {
        DEEPSEEK_API_KEY: 'k', OPENAI_API_KEY: 'k2', ARTHUR_VOICE_ENABLED: 'true',
        ARTHUR_STT_POLICY: 'cloud_preferred', ARTHUR_TTS_POLICY: 'cloud_preferred',
        ARTHUR_AUDIO_INPUT_DEVICE: 'Mic', ARTHUR_AUDIO_CAPTURE_COMMAND: 'ffmpeg x', ARTHUR_AUDIO_PLAYBACK_COMMAND: 'ffplay y',
      },
      machineConfigPath: '/d',
    },
    audio: {
      info: { id: 'b', platform: 'win32', available: true, captureExecutable: 'ffmpeg', playbackExecutable: 'ffplay', captureAvailable: true, playbackAvailable: true, captureVersion: '', playbackVersion: '' },
      inputs: [{ id: 'Mic', label: 'Mic', backend: 'b' }],
      discoverySupported: true,
    },
    live: true,
    seams: {
      validateCapture: async () => ({
        transportReady: result.transportReady,
        signalDetected: result.signalDetected,
        metrics: { framesReceived: result.frames, bytesReceived: result.frames * 640, durationMs: 1500, peakLevel: 0, rmsLevel: result.signalDetected ? 500 : 5, signalDetected: result.signalDetected },
        ...(result.failure !== undefined ? { failure: result.failure } : {}),
      }),
    },
  });
  const loud = await diagnoseDoctor(mk({ transportReady: true, signalDetected: true, frames: 70 }));
  assert.equal(checkById(loud, 'audio.capture.transport').status, 'pass');
  assert.equal(checkById(loud, 'audio.capture.signal').status, 'pass');
  const silent = await diagnoseDoctor(mk({ transportReady: true, signalDetected: false, frames: 70 }));
  assert.equal(checkById(silent, 'audio.capture.transport').status, 'pass');
  assert.equal(checkById(silent, 'audio.capture.signal').status, 'warn');
  const empty = await diagnoseDoctor(mk({ transportReady: false, signalDetected: false, frames: 0, failure: 'no audio frames received within the capture window' }));
  assert.equal(checkById(empty, 'audio.capture.transport').status, 'fail');
});

test('G1b: non-interactive --live never plays sound (playback validator count 0, capture may run)', async () => {
  let playbackCalls = 0;
  let captureCalls = 0;
  const report = await diagnoseDoctor(baseArgs({
    layers: {
      ambient: {},
      repo: {},
      machine: {
        DEEPSEEK_API_KEY: 'k', OPENAI_API_KEY: 'k2', ARTHUR_VOICE_ENABLED: 'true',
        ARTHUR_STT_POLICY: 'cloud_preferred', ARTHUR_TTS_POLICY: 'cloud_preferred',
        ARTHUR_AUDIO_INPUT_DEVICE: 'Mic', ARTHUR_AUDIO_CAPTURE_COMMAND: 'ffmpeg x', ARTHUR_AUDIO_PLAYBACK_COMMAND: 'ffplay y',
      },
      machineConfigPath: '/d',
    },
    audio: {
      info: { id: 'b', platform: 'win32', available: true, captureExecutable: 'ffmpeg', playbackExecutable: 'ffplay', captureAvailable: true, playbackAvailable: true, captureVersion: '', playbackVersion: '' },
      inputs: [{ id: 'Mic', label: 'Mic', backend: 'b' }],
      discoverySupported: true,
    },
    live: true,
    seams: {
      validateCapture: async () => {
        captureCalls += 1;
        return { transportReady: true, signalDetected: true, metrics: { framesReceived: 42, bytesReceived: 26880, durationMs: 1500, peakLevel: 1000, rmsLevel: 500, signalDetected: true } };
      },
      validatePlayback: async () => {
        playbackCalls += 1;
        return { transportReady: true, chunksAccepted: 5, bytesAccepted: 1000 };
      },
    },
  }));
  assert.equal(playbackCalls, 0);
  assert.equal(captureCalls, 1);
  assert.equal(checkById(report, 'audio.capture.transport').status, 'pass');
  assert.equal(checkById(report, 'audio.playback.transport').status, 'skipped');
  assert.equal(checkById(report, 'audio.playback.audible').status, 'skipped');
  const transport = report.checks.find((c) => c.id === 'audio.playback.transport');
  assert.equal(transport?.message, 'Audible playback check requires --live --interactive');
  // Static ffplay/config availability still passes independently.
  assert.equal(checkById(report, 'audio.backend.ffplay').status, 'pass');
  assert.equal(checkById(report, 'audio.playback.command').status, 'pass');
});

test('G1c: interactive --live plays the tone exactly once; yes=>pass, no=>NOT_READY', async () => {
  const mk = (heard: boolean) => {
    let playbackCalls = 0;
    const args = baseArgs({
      layers: {
        ambient: {},
        repo: {},
        machine: {
          DEEPSEEK_API_KEY: 'k', OPENAI_API_KEY: 'k2', ARTHUR_VOICE_ENABLED: 'true',
          ARTHUR_STT_POLICY: 'cloud_preferred', ARTHUR_TTS_POLICY: 'cloud_preferred',
          ARTHUR_AUDIO_INPUT_DEVICE: 'Mic', ARTHUR_AUDIO_CAPTURE_COMMAND: 'ffmpeg x', ARTHUR_AUDIO_PLAYBACK_COMMAND: 'ffplay y',
        },
        machineConfigPath: '/d',
      },
      audio: {
        info: { id: 'b', platform: 'win32', available: true, captureExecutable: 'ffmpeg', playbackExecutable: 'ffplay', captureAvailable: true, playbackAvailable: true, captureVersion: '', playbackVersion: '' },
        inputs: [{ id: 'Mic', label: 'Mic', backend: 'b' }],
        discoverySupported: true,
      },
      live: true,
      interactive: true,
      seams: {
        validateCapture: async () => ({ transportReady: true, signalDetected: true, metrics: { framesReceived: 10, bytesReceived: 6400, durationMs: 500, peakLevel: 1000, rmsLevel: 500, signalDetected: true } }),
        validatePlayback: async () => {
          playbackCalls += 1;
          return { transportReady: true, chunksAccepted: 5, bytesAccepted: 1000 };
        },
        confirmHeard: async () => heard,
      },
    });
    return { args, calls: () => playbackCalls };
  };
  const yesCase = mk(true);
  const yesReport = await diagnoseDoctor(yesCase.args);
  assert.equal(yesCase.calls(), 1);
  assert.equal(checkById(yesReport, 'audio.playback.transport').status, 'pass');
  assert.equal(checkById(yesReport, 'audio.playback.audible').status, 'pass');
  const noCase = mk(false);
  const noReport = await diagnoseDoctor(noCase.args);
  assert.equal(noCase.calls(), 1);
  assert.equal(checkById(noReport, 'audio.playback.audible').status, 'fail');
  assert.equal(noReport.status, 'NOT_READY');
});

test('G1d: --live JSON never falsely passes playback transport without --interactive', async () => {
  const io = capturingIo();
  const code = await runDoctor(new Map([['live', 'true'], ['json', 'true']]), io, {
    layers: {
      ambient: {},
      repo: {},
      machine: {
        DEEPSEEK_API_KEY: 'k', OPENAI_API_KEY: 'k2', ARTHUR_VOICE_ENABLED: 'true',
        ARTHUR_STT_POLICY: 'cloud_preferred', ARTHUR_TTS_POLICY: 'cloud_preferred',
        ARTHUR_AUDIO_INPUT_DEVICE: 'Mic', ARTHUR_AUDIO_CAPTURE_COMMAND: 'ffmpeg x', ARTHUR_AUDIO_PLAYBACK_COMMAND: 'ffplay y',
      },
      machineConfigPath: '/d',
    },
    file: { configPath: '/d', present: true, readable: true, entryCount: 9 },
    audio: {
      info: { id: 'b', platform: 'win32', available: true, captureExecutable: 'ffmpeg', playbackExecutable: 'ffplay', captureAvailable: true, playbackAvailable: true, captureVersion: '', playbackVersion: '' },
      inputs: [{ id: 'Mic', label: 'Mic', backend: 'b' }],
      discoverySupported: true,
    },
    models: { statePath: '/s', statePresent: false, snapshot: defaultStateFile(), hardware: TEST_HARDWARE, managedRoot: '/m', catalog: TEST_CATALOG, exists: () => true },
    seams: {
      probeDeepseek: async () => readyResult('deepseek', 'reasoning', ['completion']),
      probeOpenaiStt: async () => readyResult('openai-stt', 'cloud_stt', ['transcription']),
      probeOpenaiTts: async () => readyResult('openai-tts', 'cloud_tts', ['synthesis']),
      validateCapture: async () => ({ transportReady: true, signalDetected: true, metrics: { framesReceived: 42, bytesReceived: 26880, durationMs: 1500, peakLevel: 1000, rmsLevel: 500, signalDetected: true } }),
      validatePlayback: async () => { throw new Error('must not be called without --interactive'); },
    },
  });
  void code;
  const parsed = JSON.parse(io.outText) as { live: boolean; checks: { id: string; status: string; message: string }[] };
  assert.equal(parsed.live, true);
  const transport = parsed.checks.find((c) => c.id === 'audio.playback.transport');
  assert.equal(transport?.status, 'skipped');
  assert.equal(transport?.message, 'Audible playback check requires --live --interactive');
});

test('G2: interactive playback confirmed / denied / transport fail', async () => {
  const mk = (playback: { transportReady: boolean; failure?: string }, heard?: boolean) => baseArgs({
    layers: {
      ambient: {},
      repo: {},
      machine: {
        DEEPSEEK_API_KEY: 'k', OPENAI_API_KEY: 'k2', ARTHUR_VOICE_ENABLED: 'true',
        ARTHUR_STT_POLICY: 'cloud_preferred', ARTHUR_TTS_POLICY: 'cloud_preferred',
        ARTHUR_AUDIO_INPUT_DEVICE: 'Mic', ARTHUR_AUDIO_CAPTURE_COMMAND: 'ffmpeg x', ARTHUR_AUDIO_PLAYBACK_COMMAND: 'ffplay y',
      },
      machineConfigPath: '/d',
    },
    audio: {
      info: { id: 'b', platform: 'win32', available: true, captureExecutable: 'ffmpeg', playbackExecutable: 'ffplay', captureAvailable: true, playbackAvailable: true, captureVersion: '', playbackVersion: '' },
      inputs: [{ id: 'Mic', label: 'Mic', backend: 'b' }],
      discoverySupported: true,
    },
    live: true,
    interactive: true,
    seams: {
      validateCapture: async () => ({ transportReady: true, signalDetected: true, metrics: { framesReceived: 10, bytesReceived: 6400, durationMs: 500, peakLevel: 1000, rmsLevel: 500, signalDetected: true } }),
      validatePlayback: async () => ({ transportReady: playback.transportReady, chunksAccepted: playback.transportReady ? 5 : 0, bytesAccepted: playback.transportReady ? 1000 : 0, ...(playback.failure !== undefined ? { failure: playback.failure } : {}) }),
      ...(heard !== undefined ? { confirmHeard: async () => heard } : {}),
    },
  });
  const yes = await diagnoseDoctor(mk({ transportReady: true }, true));
  assert.equal(checkById(yes, 'audio.playback.transport').status, 'pass');
  assert.equal(checkById(yes, 'audio.playback.audible').status, 'pass');
  const no = await diagnoseDoctor(mk({ transportReady: true }, false));
  assert.equal(checkById(no, 'audio.playback.audible').status, 'fail');
  assert.equal(no.status, 'NOT_READY');
  const broken = await diagnoseDoctor(mk({ transportReady: false, failure: 'player error' }, true));
  assert.equal(checkById(broken, 'audio.playback.transport').status, 'fail');
});

// ---- H. models --------------------------------------------------------------------------------------

test('H: required model missing fails without installing; not-required skipped', async () => {
  const missing = await diagnoseDoctor(baseArgs({
    layers: {
      ambient: {},
      repo: {},
      machine: { DEEPSEEK_API_KEY: 'k', ARTHUR_VOICE_ENABLED: 'true', ARTHUR_STT_POLICY: 'local_only', ARTHUR_TTS_POLICY: 'local_only', ARTHUR_AUDIO_INPUT_DEVICE: 'Mic', ARTHUR_AUDIO_CAPTURE_COMMAND: 'c', ARTHUR_AUDIO_PLAYBACK_COMMAND: 'p' },
      machineConfigPath: '/d',
    },
    audio: {
      info: { id: 'b', platform: 'win32', available: true, captureExecutable: 'ffmpeg', playbackExecutable: 'ffplay', captureAvailable: true, playbackAvailable: true, captureVersion: '', playbackVersion: '' },
      inputs: [{ id: 'Mic', label: 'Mic', backend: 'b' }],
      discoverySupported: true,
    },
  }));
  assert.equal(checkById(missing, 'model.stt.ready').status, 'fail');
  assert.equal(checkById(missing, 'model.stt.ready').status, 'fail');
  const textOnly = await diagnoseDoctor(baseArgs({
    layers: { ambient: {}, repo: {}, machine: { DEEPSEEK_API_KEY: 'k', ARTHUR_VOICE_ENABLED: 'false' }, machineConfigPath: '/d' },
  }));
  assert.equal(checkById(textOnly, 'model.stt.ready').status, 'skipped');
});

test('H2: installed-but-artifacts-missing fails accurately', async () => {
  const snapshot = defaultStateFile();
  snapshot.models['test-stt-1'] = { model_id: 'test-stt-1', installed: true, configured: true, ready: true };
  snapshot.models['test-tts-1'] = { model_id: 'test-tts-1', installed: true, configured: true, ready: true };
  snapshot.selections = { stt: { mode: 'manual', model_id: 'test-stt-1' }, tts: { mode: 'manual', model_id: 'test-tts-1' }, model: { mode: 'auto' } };
  const report = await diagnoseDoctor(baseArgs({
    layers: {
      ambient: {},
      repo: {},
      machine: { DEEPSEEK_API_KEY: 'k', ARTHUR_VOICE_ENABLED: 'true', ARTHUR_STT_POLICY: 'local_only', ARTHUR_TTS_POLICY: 'local_only', ARTHUR_AUDIO_INPUT_DEVICE: 'Mic', ARTHUR_AUDIO_CAPTURE_COMMAND: 'c', ARTHUR_AUDIO_PLAYBACK_COMMAND: 'p' },
      machineConfigPath: '/d',
    },
    audio: {
      info: { id: 'b', platform: 'win32', available: true, captureExecutable: 'ffmpeg', playbackExecutable: 'ffplay', captureAvailable: true, playbackAvailable: true, captureVersion: '', playbackVersion: '' },
      inputs: [{ id: 'Mic', label: 'Mic', backend: 'b' }],
      discoverySupported: true,
    },
    models: { statePath: '/s', statePresent: true, snapshot, hardware: TEST_HARDWARE, managedRoot: '/m', catalog: TEST_CATALOG, exists: () => false },
  }));
  assert.equal(checkById(report, 'model.stt.ready').status, 'fail');
});

// ---- I. policy consistency -------------------------------------------------------------------------------

test('I1: local_only without local model fails', async () => {
  const report = await diagnoseDoctor(baseArgs({
    layers: {
      ambient: {},
      repo: {},
      machine: { DEEPSEEK_API_KEY: 'k', ARTHUR_VOICE_ENABLED: 'true', ARTHUR_STT_POLICY: 'local_only', ARTHUR_TTS_POLICY: 'cloud_preferred', ARTHUR_AUDIO_INPUT_DEVICE: 'Mic', ARTHUR_AUDIO_CAPTURE_COMMAND: 'c', ARTHUR_AUDIO_PLAYBACK_COMMAND: 'p', OPENAI_API_KEY: 'k2' },
      machineConfigPath: '/d',
    },
    audio: {
      info: { id: 'b', platform: 'win32', available: true, captureExecutable: 'ffmpeg', playbackExecutable: 'ffplay', captureAvailable: true, playbackAvailable: true, captureVersion: '', playbackVersion: '' },
      inputs: [{ id: 'Mic', label: 'Mic', backend: 'b' }],
      discoverySupported: true,
    },
  }));
  const stt = report.checks.find((c) => c.id === 'policy.stt.local');
  assert.equal(stt?.status, 'fail');
});

test('I2: stale audio keys on text-only warn only', async () => {
  const report = await diagnoseDoctor(baseArgs({
    layers: {
      ambient: {},
      repo: {},
      machine: { DEEPSEEK_API_KEY: 'k', ARTHUR_VOICE_ENABLED: 'false', ARTHUR_AUDIO_INPUT_DEVICE: 'Mic' },
      machineConfigPath: '/d',
    },
  }));
  const stale = report.checks.find((c) => c.id === 'policy.audio.stale');
  assert.equal(stale?.status, 'warn');
  assert.equal(stale?.required, false);
  assert.equal(report.status, 'DEGRADED');
});

// ---- J. aggregation --------------------------------------------------------------------------------------------

test('J: READY / DEGRADED / NOT_READY / UNCONFIGURED + deterministic exits', () => {
  const ready = finalizeDoctorReport({ ok: false, status: 'NOT_READY', profile: 'text_only', live: false, interactive: false, checks: [{ id: 'a', area: 'reasoning', status: 'pass', required: true, message: 'ok' }] });
  assert.equal(ready.status, 'READY');
  assert.equal(exitCodeForDoctor(ready), CliExit.SUCCESS);
  const degraded = finalizeDoctorReport({ ok: false, status: 'NOT_READY', profile: 'text_only', live: false, interactive: false, checks: [{ id: 'a', area: 'reasoning', status: 'pass', required: true, message: 'ok' }, { id: 'b', area: 'policy', status: 'warn', required: false, message: 'stale' }] });
  assert.equal(degraded.status, 'DEGRADED');
  assert.equal(exitCodeForDoctor(degraded), CliExit.SUCCESS);
  const notReady = finalizeDoctorReport({ ok: false, status: 'READY', profile: 'text_only', live: false, interactive: false, checks: [{ id: 'a', area: 'reasoning', status: 'fail', required: true, message: 'bad' }] });
  assert.equal(notReady.status, 'NOT_READY');
  assert.equal(exitCodeForDoctor(notReady), CliExit.VALIDATION_FAILED);
  assert.equal(aggregateDoctorStatus([]), 'UNCONFIGURED');
});

// ---- K. JSON -----------------------------------------------------------------------------------------------------

test('K: JSON contract — one document, stable ids, no ANSI, no secrets', async () => {
  const io = capturingIo();
  const code = await runDoctor(new Map([['json', 'true']]), io, {
    layers: { ambient: { DEEPSEEK_API_KEY: 'sk-live-should-never-render' }, repo: {}, machine: {}, machineConfigPath: '/d/config.env' },
    file: { configPath: '/d/config.env', present: false, readable: true },
    audio: { info: { id: 'b', platform: 'win32', available: false, captureExecutable: 'ffmpeg', playbackExecutable: 'ffplay', captureAvailable: false, playbackAvailable: false, captureVersion: '', playbackVersion: '' }, inputs: [], discoverySupported: true },
    models: { statePath: '/s', statePresent: false, snapshot: defaultStateFile(), hardware: LINUX_HARDWARE, managedRoot: '/m', catalog: TEST_CATALOG, exists: () => true },
  });
  assert.equal(code, CliExit.VALIDATION_FAILED);
  const parsed = JSON.parse(io.outText) as { ok: boolean; status: string; profile: string; checks: { id: string }[] };
  assert.equal(parsed.status, 'UNCONFIGURED');
  assert.ok(Array.isArray(parsed.checks));
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(io.outText, /\u001b\[/);
  assert.doesNotMatch(io.outText, /sk-live-should-never-render/);
  const ids = parsed.checks.map((c) => c.id);
  assert.ok(ids.includes('config.present'));
  assert.ok(ids.includes('provider.deepseek.credential'));
});

// ---- M. CLI ---------------------------------------------------------------------------------------------------------

test('M1: help, invalid flags, interactive requires live', async () => {
  const helpIo = capturingIo();
  assert.equal(await runDoctor(new Map([['help', 'true']]), helpIo), CliExit.SUCCESS);
  assert.match(helpIo.outText, /arthur doctor/);
  const badIo = capturingIo();
  assert.equal(await runDoctor(new Map([['fix', 'true']]), badIo), CliExit.USAGE);
  const interIo = capturingIo();
  assert.equal(await runDoctor(new Map([['interactive', 'true']]), interIo), CliExit.USAGE);
});

test('M2: human output renders sections and remediation', async () => {
  const io = capturingIo();
  const code = await runDoctor(new Map(), io, {
    layers: {
      ambient: {},
      repo: {},
      machine: { DEEPSEEK_API_KEY: 'k', OPENAI_API_KEY: 'k2', ARTHUR_VOICE_ENABLED: 'true', ARTHUR_STT_POLICY: 'cloud_preferred', ARTHUR_TTS_POLICY: 'cloud_preferred', ARTHUR_AUDIO_INPUT_DEVICE: 'Old', ARTHUR_AUDIO_CAPTURE_COMMAND: 'c', ARTHUR_AUDIO_PLAYBACK_COMMAND: 'p' },
      machineConfigPath: '/d/config.env',
    },
    file: { configPath: '/d/config.env', present: true, readable: true, entryCount: 8 },
    audio: {
      info: { id: 'b', platform: 'win32', available: true, captureExecutable: 'ffmpeg', playbackExecutable: 'ffplay', captureAvailable: true, playbackAvailable: true, captureVersion: '', playbackVersion: '' },
      inputs: [{ id: 'New', label: 'New', backend: 'b' }],
      discoverySupported: true,
    },
    models: { statePath: '/s', statePresent: false, snapshot: defaultStateFile(), hardware: TEST_HARDWARE, managedRoot: '/m', catalog: TEST_CATALOG, exists: () => true },
  });
  assert.equal(code, CliExit.VALIDATION_FAILED);
  assert.match(io.outText, /ARTHUR Doctor/);
  assert.match(io.outText, /Result/);
  assert.match(io.outText, /arthur audio setup/);
});

// ---- N. regressions ----------------------------------------------------------------------------------------------------

test('N: normal startup performs no live probes (static default skips)', async () => {
  let probed = 0;
  const report = await diagnoseDoctor(baseArgs({ live: false, seams: { probeDeepseek: async () => { probed += 1; return readyResult('deepseek', 'reasoning'); } } }));
  assert.equal(probed, 0);
  assert.equal(checkById(report, 'provider.deepseek.live').status, 'skipped');
});
