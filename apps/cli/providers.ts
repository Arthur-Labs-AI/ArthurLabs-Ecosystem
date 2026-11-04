/**
 * FRS-02: temporary standalone provider onboarding surface.
 *
 *   arthur providers setup [--json]
 *   arthur providers status [--json]
 *
 * Deliberately NOT merged into 'arthur setup' (FRS-04 owns the unified
 * wizard); this module is shaped so FRS-04 can embed it later. Like
 * config.ts / model_branch.ts it never loads the App composition root or
 * SQLite stores: providers setup/status run on configuration alone and
 * create no databases or model state.
 *
 * Secrets never travel in argv (no --deepseek-key / --openai-key flags:
 * they would leak into shell history and process listings). setup is
 * interactive-TTY-only for secret entry with masked input; --json setup
 * never prompts and fails typed when interactive credential input would
 * be required. status performs no network calls.
 */

import * as fs from 'node:fs';

import { ArthurError } from '../../src/core/errors/errors';
import { CliExit } from '../../src/cli_exit';
import { loadConfigurationEnvironment, readMachineConfig, updateMachineConfig } from '../../src/config/machine_config';
import { DEFAULT_VOICE_SETTINGS } from '../../src/voice/config';
import { DEEPSEEK_DEFAULT_BASE_URL } from '../../src/models/providers/deepseek';
import { resolveCredentialState, type CredentialName } from '../../src/providers/credentials';
import { createNodeSecretTty, readSecret, type NodeSecretTtyHandle, type SecretTty } from '../../src/providers/secret_input';
import { buildProvidersStatus, providersStatusJson, renderProvidersStatus, type LayerSnapshot } from '../../src/providers/provider_status';
import { checkDeepSeekReadiness } from '../../src/providers/deepseek_readiness';
import { compileMachinePatch, DEEPSEEK_DEFAULT_MODEL, emptySetupPlan, isEmptyPlan, validatePlanSecrets, type EffectiveConfig, type SetupPlan } from '../../src/providers/setup_plan';
import type { CliIO } from './index';
import { askConfirm, readLine } from './setup_ui';
export { checkDeepSeekReadiness };
export { checkOpenAiSttReadiness, checkOpenAiTtsReadiness } from '../../src/providers/openai_voice_readiness';

export const PROVIDERS_HELP = [
  'ARTHUR providers - standalone provider onboarding (FRS-02)',
  '',
  'Usage:',
  '  arthur providers setup [--json]',
  '  arthur providers status [--json]',
  '',
  '  setup    Interactive provider onboarding (TTY only for secret entry).',
  '           Secrets are entered hidden, validated with the provider, then',
  '           saved once at the end. Cancel before Save = zero mutation.',
  '           Aborting with Ctrl+C / EOF prints an explicit cancellation',
  '           line and exits non-success (never silent success).',
  '  status   Safe effective provider/model status. No network calls, no',
  '           secret values (configured / not configured only).',
  '',
  'Secrets are never passed as command-line flags. There is deliberately no',
  '  --deepseek-key / --openai-key flag (shell history / process listing',
  '  leakage). The unified setup wizard arrives in FRS-04; audio hardware',
  '  setup arrives in FRS-03.',
  '',
].join('\n');

function isHelp(flags: Map<string, string>, positionals: string[]): boolean {
  return flags.get('help') === 'true' || positionals.includes('--help') || positionals.includes('-h');
}

/** Reject any secret-bearing CLI flag structurally (never read its value). */
function rejectSecretFlags(flags: Map<string, string>, io: CliIO): boolean {
  for (const key of flags.keys()) {
    const lower = key.toLowerCase();
    if (lower.includes('key') || lower.includes('secret') || lower.includes('token') || lower.includes('password')) {
      io.err('error [INVALID_REQUEST]: provider secrets must be entered interactively, never as command-line flags\n');
      return true;
    }
  }
  return false;
}

/** Parse repo .env WITHOUT touching process.env (providers never re-apply layers). */
function readRepoEnvRecord(repoPath: string | null): Record<string, string> {
  if (repoPath === null) return {};
  let text: string;
  try {
    text = fs.readFileSync(repoPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new ArthurError('INVALID_CONFIG', 'cannot read repo .env: ' + (err instanceof Error ? err.message : String(err)));
  }
  if (text.indexOf(String.fromCharCode(0)) !== -1) {
    throw new ArthurError('INVALID_CONFIG', 'repo .env contains NUL');
  }
  try {
    const { parseEnv } = require('node:util') as typeof import('node:util');
    return parseEnv(text) as Record<string, string>;
  } catch (err) {
    throw new ArthurError('INVALID_CONFIG', 'repo .env is malformed: ' + (err instanceof Error ? err.message.split('\n')[0] : String(err)));
  }
}

export function snapshotLayers(deps: { machineConfigPath?: string; repoEnvPath?: string | null } = {}): LayerSnapshot & { machineConfigPath: string } {
  const probe: NodeJS.ProcessEnv = {};
  const { machineConfigPath } = loadConfigurationEnvironment({ machineConfigPath: deps.machineConfigPath, repoEnvPath: null, env: probe });
  const repoEnvPath = deps.repoEnvPath === undefined ? '.env' : deps.repoEnvPath;
  const repo = readRepoEnvRecord(repoEnvPath);
  const machine = readMachineConfig(machineConfigPath);
  return { ambient: { ...process.env }, repo, machine, machineConfigPath };
}

function effectiveOf(layers: LayerSnapshot): EffectiveConfig {
  const pick = (name: string, fallback: string): string => {
    const ambient = (layers.ambient as Record<string, string | undefined>)[name];
    if (typeof ambient === 'string' && ambient !== '') return ambient;
    const repo = layers.repo[name];
    if (typeof repo === 'string' && repo !== '') return repo;
    const machine = layers.machine[name];
    if (typeof machine === 'string' && machine !== '') return machine;
    return fallback;
  };
  return {
    deepseekApiKey: pick('DEEPSEEK_API_KEY', ''),
    openaiApiKey: pick('OPENAI_API_KEY', ''),
    modelProvider: pick('ARTHUR_MODEL_PROVIDER', 'fake'),
    modelName: pick('ARTHUR_MODEL_NAME', ''),
    deepseekBaseUrl: pick('DEEPSEEK_BASE_URL', DEEPSEEK_DEFAULT_BASE_URL),
    cloudSttModel: pick('ARTHUR_CLOUD_STT_MODEL', DEFAULT_VOICE_SETTINGS.cloudSttModel),
    cloudTtsModel: pick('ARTHUR_CLOUD_TTS_MODEL', DEFAULT_VOICE_SETTINGS.cloudTtsModel),
    cloudTtsVoice: pick('ARTHUR_CLOUD_TTS_VOICE', DEFAULT_VOICE_SETTINGS.cloudTtsVoice),
  };
}

export function runProvidersStatus(flags: Map<string, string>, io: CliIO, layersOverride?: LayerSnapshot): number {
  if (rejectSecretFlags(flags, io)) return CliExit.USAGE;
  const json = flags.get('json') === 'true';
  const layers = layersOverride ?? snapshotLayers();
  const status = buildProvidersStatus(layers);
  if (json) {
    io.out(JSON.stringify({ ok: true, command: 'providers status', data: providersStatusJson(status) }, null, 2) + '\n');
  } else {
    io.out(renderProvidersStatus(status));
  }
  return CliExit.SUCCESS;
}

export interface ProvidersSetupDeps {
  readApprovalLine?: () => Promise<string>;
  tty?: boolean;
  secretTty?: SecretTty;
  layers?: LayerSnapshot & { machineConfigPath?: string };
  fetchFn?: typeof fetch;
  commitPatch?: (patch: { set: Record<string, string>; remove: string[] }) => void;
}

function isInteractive(deps: ProvidersSetupDeps): boolean {
  if (deps.tty !== undefined) return deps.tty;
  if (deps.secretTty !== undefined) return deps.secretTty.isTTY;
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/**
 * FRS-02 Windows fix: the production secret TTY is a persistent buffered
 * stdin tap (createNodeSecretTty), NOT a per-key stdin.once('data'). The
 * tap resumes stdin (paused after readline/askConfirm closes), buffers
 * whole pasted/line-buffered Windows chunks, and tokenizes CR/LF/CRLF.
 * Its handle MUST be closed in finally (see withSecretTty). Test fakes
 * via deps.secretTty keep working unchanged.
 */
/**
 * Cancellation: user abort (Ctrl+C), EOF, or input failure during secret
 * entry. All three print ONE explicit line and exit non-success
 * (CliExit.INTERNAL via the numeric return) — a cancelled setup must
 * never look like success. No stack trace: ordinary cancellation is an
 * operator decision, not a crash. Zero writes before Save still holds:
 * every path below returns before the final commit.
 */
export class ProvidersSetupCancelled extends Error {
  constructor() {
    super('Setup cancelled. No changes were saved.');
    this.name = 'ProvidersSetupCancelled';
  }
}

function secretTtyOf(deps: ProvidersSetupDeps): SecretTty {
  if (deps.secretTty) return deps.secretTty;
  // Production backend: persistent buffered tap. Created lazily per setup
  // run and closed in the setup finally block (see runProvidersSetup).
  const owned = sharedTap(deps);
  return owned.tty;
}

/** Per-run shared tap so every secret prompt reuses ONE stdin tap. */
const TAP_KEY = '__frs02_secret_tap__';

function sharedTap(deps: ProvidersSetupDeps): NodeSecretTtyHandle {
  const bag = deps as Record<string, unknown>;
  const existing = bag[TAP_KEY] as NodeSecretTtyHandle | undefined;
  if (existing && !existing.closed) return existing;
  const handle = createNodeSecretTty();
  bag[TAP_KEY] = handle;
  return handle;
}

function closeSharedTap(deps: ProvidersSetupDeps): void {
  const bag = deps as Record<string, unknown>;
  const existing = bag[TAP_KEY] as NodeSecretTtyHandle | undefined;
  if (existing) {
    try { existing.close(); } catch { /* cleanup best effort */ }
    delete bag[TAP_KEY];
  }
}

function promptSecret(io: CliIO, deps: ProvidersSetupDeps, label: string): Promise<{ kind: 'submitted'; value: string } | { kind: 'cancelled' } | { kind: 'empty' }> {
  const tty = secretTtyOf(deps);
  io.out('\n');
  return readSecret(tty, { label });
}

function credentialSummary(name: CredentialName, layers: LayerSnapshot): string {
  const state = resolveCredentialState(name, layers);
  if (!state.configured) return 'not configured';
  if (state.source === 'process_env') return 'configured (source: environment)';
  if (state.source === 'repo_env') return 'configured (source: repo .env)';
  return 'configured (source: machine config)';
}

export async function runProvidersSetup(holder: { config?: unknown }, flags: Map<string, string>, io: CliIO, deps: ProvidersSetupDeps = {}): Promise<number> {
  void holder;
  if (rejectSecretFlags(flags, io)) return CliExit.USAGE;
  const json = flags.get('json') === 'true';
  const snap = deps.layers ?? snapshotLayers();
  const layers: LayerSnapshot = { ambient: snap.ambient, repo: snap.repo, machine: snap.machine };
  const machineConfigPath = (snap as { machineConfigPath?: string }).machineConfigPath;
  const effective = effectiveOf(layers);
  if (json) {
    const needsDeepseek = effective.deepseekApiKey === '';
    const needsOpenai = effective.openaiApiKey === '';
    if (needsDeepseek || needsOpenai) {
      io.out(JSON.stringify({ ok: false, command: 'providers setup', code: 'INTERACTIVE_REQUIRED', message: 'provider credential entry requires an interactive terminal; rerun without --json on a TTY', details: { needs_deepseek_credential: needsDeepseek, needs_openai_credential: needsOpenai } }, null, 2) + '\n');
      return CliExit.USAGE;
    }
    io.out(JSON.stringify({ ok: true, command: 'providers setup', data: { plan: 'no credential input required', writes: 0, providers: ['deepseek', 'openai-stt', 'openai-tts'] } }, null, 2) + '\n');
    return CliExit.SUCCESS;
  }
  if (!isInteractive(deps)) {
    io.err('error [INVALID_REQUEST]: providers setup requires an interactive terminal for credential entry\n');
    return CliExit.USAGE;
  }
  // The shared stdin tap (if created) MUST close even when a prompt throws
  // or the operator cancels: terminal state restoration lives in finally.
  try {
    return await runProvidersSetupInteractive(io, deps, layers, effective, machineConfigPath);
  } catch (err) {
    if (err instanceof ProvidersSetupCancelled) {
      // Explicit cancellation: visible line, non-success exit, zero writes.
      // No stack trace — ordinary operator abort, not a crash.
      io.out(err.message + '\n');
      return CliExit.INTERNAL;
    }
    throw err;
  } finally {
    closeSharedTap(deps);
  }
}

async function runProvidersSetupInteractive(io: CliIO, deps: ProvidersSetupDeps, layers: LayerSnapshot, effective: EffectiveConfig, machineConfigPath: string | undefined): Promise<number> {
  const plan: SetupPlan = emptySetupPlan();
  const ioDeps = deps.readApprovalLine !== undefined ? { readApprovalLine: deps.readApprovalLine } : {};
  io.out('ARTHUR Provider Setup\n\n');
  io.out('Reasoning\n---------\nDeepSeek\n\n');
  io.out('Current:\n');
  io.out('  provider: ' + (effective.modelProvider !== '' ? effective.modelProvider : '(not configured)') + '\n');
  io.out('  model:    ' + (effective.modelName !== '' ? effective.modelName : '(default: ' + DEEPSEEK_DEFAULT_MODEL + ')') + '\n');
  io.out('  API key:  ' + credentialSummary('DEEPSEEK_API_KEY', layers) + '\n\n');
  const wantDeepseek = await askConfirm(io, ioDeps, 'Configure DeepSeek reasoning?', 'yes');
  let deepseekValidated: string = 'not_attempted';
  if (wantDeepseek) {
    const state = resolveCredentialState('DEEPSEEK_API_KEY', layers);
    let entered: string | undefined;
    if (!state.configured) {
      const first = await promptSecret(io, deps, 'DeepSeek API key');
      if (first.kind === 'cancelled') throw new ProvidersSetupCancelled();
      if (first.kind === 'empty') { io.out('No key entered; DeepSeek left unconfigured.\n'); }
      else { entered = first.value; }
    } else if (!state.machinePersisted) {
      const keep = await askConfirm(io, ioDeps, 'Keep using the current external credential (not saved to machine config)?', 'yes');
      if (!keep) {
        const replacement = await promptSecret(io, deps, 'DeepSeek API key');
        if (replacement.kind === 'cancelled') throw new ProvidersSetupCancelled();
        if (replacement.kind !== 'empty') entered = replacement.value;
      }
    } else {
      const replace = await askConfirm(io, ioDeps, 'Replace the saved machine credential?', 'no');
      if (replace) {
        const replacement = await promptSecret(io, deps, 'DeepSeek API key');
        if (replacement.kind === 'cancelled') throw new ProvidersSetupCancelled();
        if (replacement.kind !== 'empty') entered = replacement.value;
      }
    }
    // validateDeepseekEntry throws ProvidersSetupCancelled on abort; it
    // propagates to the outer catch (explicit message + non-success exit).
    if (entered !== undefined) {
      const validated = await validateDeepseekEntry(io, ioDeps, deps, effective, entered);
      if (validated !== undefined) { plan.secrets.deepseekApiKey = validated; deepseekValidated = 'ready'; }
    } else if (state.configured) { deepseekValidated = 'skipped'; }
    if (plan.secrets.deepseekApiKey !== undefined || state.configured) {
      if (effective.modelProvider !== 'deepseek') plan.choices.modelProvider = 'deepseek';
      if (effective.modelName === '') plan.choices.modelName = DEEPSEEK_DEFAULT_MODEL;
    }
  }
  // runVoiceSection throws ProvidersSetupCancelled on abort; it propagates
  // to the outer catch (explicit message + non-success exit + tap cleanup).
  const voice = await runVoiceSection(io, ioDeps, deps, layers, effective, plan);
  return finalizeSetup(io, ioDeps, deps, layers, effective, plan, deepseekValidated, voice);
}

async function validateDeepseekEntry(io: CliIO, ioDeps: { readApprovalLine?: () => Promise<string> }, deps: ProvidersSetupDeps, effective: EffectiveConfig, entered: string): Promise<string | undefined> {
  io.out('Checking DeepSeek...\n');
  const probe = await checkDeepSeekReadiness({ apiKey: entered, model: effective.modelName !== '' ? effective.modelName : DEEPSEEK_DEFAULT_MODEL, baseUrl: effective.deepseekBaseUrl }, deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {});
  if (probe.ready) {
    io.out('ok authentication\n');
    io.out('ok basic completion\n');
    io.out('ok tool-capable response path\n');
    return entered;
  }
  const category = probe.diagnostics[0]?.category ?? 'network';
  io.out('DeepSeek validation failed (' + category + '). The key was NOT saved.\n');
  const retry = await askConfirm(io, ioDeps, 'Retry DeepSeek key entry?', 'yes');
  if (!retry) return undefined;
  const second = await promptSecret(io, deps, 'DeepSeek API key');
  if (second.kind === 'cancelled') throw new ProvidersSetupCancelled();
  if (second.kind === 'empty') return undefined;
  io.out('Checking DeepSeek...\n');
  const retryProbe = await checkDeepSeekReadiness({ apiKey: second.value, model: effective.modelName !== '' ? effective.modelName : DEEPSEEK_DEFAULT_MODEL, baseUrl: effective.deepseekBaseUrl }, deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {});
  if (retryProbe.ready) {
    io.out('ok authentication\n');
    io.out('ok basic completion\n');
    io.out('ok tool-capable response path\n');
    return second.value;
  }
  io.out('DeepSeek validation failed again; DeepSeek left unconfigured.\n');
  return undefined;
}

async function validateOpenaiEntry(io: CliIO, ioDeps: { readApprovalLine?: () => Promise<string> }, deps: ProvidersSetupDeps, effective: EffectiveConfig, entered: string): Promise<{ value?: string; sttReady: boolean; ttsReady: boolean }> {
  io.out('Checking OpenAI...\n');
  const probes = await validatePlanSecrets({ secrets: { openaiApiKey: entered }, choices: {} }, effective, deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {});
  const sttReady = probes.stt?.ready === true;
  const ttsReady = probes.tts?.ready === true;
  io.out((sttReady ? 'ok' : 'xx') + ' STT provider\n');
  io.out((ttsReady ? 'ok' : 'xx') + ' TTS provider\n');
  if (sttReady && ttsReady) return { value: entered, sttReady: true, ttsReady: true };
  io.out('OpenAI validation failed; the key was NOT saved.\n');
  const retry = await askConfirm(io, ioDeps, 'Retry OpenAI key entry?', 'yes');
  if (!retry) return { sttReady: false, ttsReady: false };
  const second = await promptSecret(io, deps, 'OpenAI API key');
  if (second.kind === 'cancelled') throw new ProvidersSetupCancelled();
  if (second.kind === 'empty') return { sttReady: false, ttsReady: false };
  io.out('Checking OpenAI...\n');
  const retryProbes = await validatePlanSecrets({ secrets: { openaiApiKey: second.value }, choices: {} }, effective, deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {});
  const sttOk = retryProbes.stt?.ready === true;
  const ttsOk = retryProbes.tts?.ready === true;
  io.out((sttOk ? 'ok' : 'xx') + ' STT provider\n');
  io.out((ttsOk ? 'ok' : 'xx') + ' TTS provider\n');
  if (sttOk && ttsOk) return { value: second.value, sttReady: true, ttsReady: true };
  io.out('OpenAI validation failed again; cloud voice left unconfigured.\n');
  return { sttReady: false, ttsReady: false };
}

async function runVoiceSection(io: CliIO, ioDeps: { readApprovalLine?: () => Promise<string> }, deps: ProvidersSetupDeps, layers: LayerSnapshot, effective: EffectiveConfig, plan: SetupPlan): Promise<{ sttReady: boolean; ttsReady: boolean }> {
  io.out('\nCloud Voice\n-----------\nOpenAI\n\n');
  io.out('Current:\n  OpenAI key: ' + credentialSummary('OPENAI_API_KEY', layers) + '\n\n');
  const wantVoice = await askConfirm(io, ioDeps, 'Configure cloud voice?', 'yes');
  let sttReady = false;
  let ttsReady = false;
  resolveCredentialState('OPENAI_API_KEY', layers);
  if (wantVoice) {
    const state = resolveCredentialState('OPENAI_API_KEY', layers);
    let enteredVoice: string | undefined;
    if (!state.configured) {
      const first = await promptSecret(io, deps, 'OpenAI API key');
      if (first.kind === 'cancelled') throw new ProvidersSetupCancelled();
      if (first.kind === 'empty') { io.out('No key entered; cloud voice left unconfigured.\n'); }
      else { enteredVoice = first.value; }
    } else if (!state.machinePersisted) {
      const keep = await askConfirm(io, ioDeps, 'Keep using the current external credential (not saved to machine config)?', 'yes');
      if (!keep) {
        const replacement = await promptSecret(io, deps, 'OpenAI API key');
        if (replacement.kind === 'cancelled') throw new ProvidersSetupCancelled();
        if (replacement.kind !== 'empty') enteredVoice = replacement.value;
      }
    } else {
      const replace = await askConfirm(io, ioDeps, 'Replace the saved machine credential?', 'no');
      if (replace) {
        const replacement = await promptSecret(io, deps, 'OpenAI API key');
        if (replacement.kind === 'cancelled') throw new ProvidersSetupCancelled();
        if (replacement.kind !== 'empty') enteredVoice = replacement.value;
      }
    }
    // validateOpenaiEntry throws ProvidersSetupCancelled on abort; it
    // propagates to the outer catch (explicit message + non-success exit).
    if (enteredVoice !== undefined) {
      const validated = await validateOpenaiEntry(io, ioDeps, deps, effective, enteredVoice);
      if (validated.value !== undefined) { plan.secrets.openaiApiKey = validated.value; }
      sttReady = validated.sttReady;
      ttsReady = validated.ttsReady;
    } else if (state.configured) { sttReady = true; ttsReady = true; }
  }
  return { sttReady, ttsReady };
}

async function finalizeSetup(io: CliIO, ioDeps: { readApprovalLine?: () => Promise<string> }, deps: ProvidersSetupDeps, layers: LayerSnapshot, effective: EffectiveConfig, plan: SetupPlan, deepseekValidated: string, voice: { sttReady: boolean; ttsReady: boolean }): Promise<number> {
  const machineConfigPath = (deps.layers as { machineConfigPath?: string } | undefined)?.machineConfigPath;
  const sttReady = voice.sttReady;
  const ttsReady = voice.ttsReady;
  io.out('\nReview\n------\n');
  const dsKey = plan.secrets.deepseekApiKey !== undefined || resolveCredentialState('DEEPSEEK_API_KEY', layers).configured;
  io.out('Reasoning:\n  DeepSeek / ' + (effective.modelName !== '' ? effective.modelName : DEEPSEEK_DEFAULT_MODEL) + '  ' + (dsKey ? (deepseekValidated === 'ready' || deepseekValidated === 'skipped' ? 'READY' : 'CONFIGURED') : 'NOT CONFIGURED') + '\n');
  const oaKey = plan.secrets.openaiApiKey !== undefined || resolveCredentialState('OPENAI_API_KEY', layers).configured;
  const voiceMark = (ready: boolean): string => (oaKey ? (ready ? 'READY' : 'CONFIGURED') : 'NOT CONFIGURED');
  const voiceAlready = plan.secrets.openaiApiKey === undefined && oaKey;
  io.out('Cloud voice:\n  OpenAI STT  ' + voiceMark(sttReady || voiceAlready) + '\n');
  io.out('  OpenAI TTS  ' + voiceMark(ttsReady || voiceAlready) + '\n\n');
  if (isEmptyPlan(plan)) {
    io.out('Nothing to save: configuration already matches the requested state.\n');
    return CliExit.SUCCESS;
  }
  const save = await askConfirm(io, ioDeps, 'Save configuration?', 'yes');
  if (!save) { io.out('Discarded. No changes were made.\n'); return CliExit.SUCCESS; }
  const patch = compileMachinePatch(plan);
  try {
    if (deps.commitPatch) { deps.commitPatch(patch); }
    else if (machineConfigPath !== undefined) { updateMachineConfig({ set: patch.set, remove: patch.remove.length > 0 ? patch.remove : undefined }, machineConfigPath); }
    else { updateMachineConfig({ set: patch.set, remove: patch.remove.length > 0 ? patch.remove : undefined }); }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.err('error [INVALID_CONFIG]: could not save provider configuration: ' + message + '\n');
    return CliExit.INTERNAL;
  }
  io.out('Saved provider configuration.\n');
  return CliExit.SUCCESS;
}

export async function runProviders(holder: { config?: unknown }, command: string, flags: Map<string, string>, positionals: string[], io: CliIO, deps: ProvidersSetupDeps = {}): Promise<number> {
  void command;
  const sub = positionals[1];
  if (sub === undefined || isHelp(flags, positionals)) {
    if (sub === undefined && !isHelp(flags, positionals)) { io.err('usage: arthur providers <setup|status> [--json]\n'); return CliExit.USAGE; }
    io.out(PROVIDERS_HELP);
    return CliExit.SUCCESS;
  }
  switch (sub) {
    case 'status': return runProvidersStatus(flags, io, deps.layers);
    case 'setup': return runProvidersSetup(holder, flags, io, deps);
    default: io.err('usage: arthur providers <setup|status> [--json]\n'); return CliExit.USAGE;
  }
}

export async function readApprovalLineDefault(): Promise<string> {
  return readLine({});
}
/*FLOWC*/