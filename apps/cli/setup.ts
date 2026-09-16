/**
 * HR-02.5F UX (TASK-0008): interactive setup wizard.
 *
 * Detect -> Python/runtime check -> compatible STT/TTS pickers ->
 * explicit plan -> visible approval -> install+validate (shared stage
 * presenter) -> select -> final capability summary.
 *
 * Consumes existing catalog/compatibility/recommendation/install APIs;
 * no second detector/catalog/engine/store/installer. Never installs
 * before approval; never substitutes after approval; partial capability
 * (TTS-only / STT-only) is valid; zero-model machines exit non-success
 * with zero mutation.
 */

import type { CliIO } from './index';
import { CliExit } from '../../src/cli_exit';
import type { HardwareProfile } from '../../src/runtime/hardware/contracts';
import type { LocalModelDefinition, LocalModelKind } from '../../src/runtime/local-models/contracts';
import { evaluateCompatibility } from '../../src/runtime/local-models/compatibility';
import { recommendModel } from '../../src/runtime/local-models/recommendation';
import { SystemHardwareProbe } from '../../src/runtime/hardware/probe';
import { LocalModelStateStore } from '../../src/runtime/local-models/state_store';
import { getLocalModelCatalog } from '../../src/runtime/local-models/catalog';
import { discoverSystemPython, checkVersionSpec } from '../../src/runtime/local-models/provisioning/python';
import { runTrustedProcess, nodeSpawnFn } from '../../src/runtime/local-models/provisioning/process_runner';
import { buildStatus } from './models';
import type { ModelsContext, ModelsDeps } from './models';
import { runModelsInstall, runModelsSelect, runModelsValidate } from './models';
import type { Settings } from '../../src/config/settings';
import type { InstallationProgressEvent } from '../../src/runtime/local-models/install_contracts';
import {
  askConfirm,
  askSelection,
  createStagePresenter,
  friendlyName,
  hardwareSection,
  heading,
  keyValues,
  modelDetail,
  optionList,
  planSection,
  stageIndexForPhase,
  statusLine,
} from './setup_ui';

export interface SetupDeps extends ModelsDeps {
  readApprovalLine?: () => Promise<string>;
  /** TTY override for tests (default: process.stdout.isTTY via io). */
  tty?: boolean;
  clock?: () => number;
  pythonVersion?: string | null;
}

interface Pick {
  kind: LocalModelKind;
  def: LocalModelDefinition;
  via: 'recommended' | 'operator' | 'flag';
}

function compatibleOf(
  catalog: readonly LocalModelDefinition[],
  kind: LocalModelKind,
  hardware: HardwareProfile,
): LocalModelDefinition[] {
  return catalog.filter((d) => d.kind === kind && evaluateCompatibility(d, hardware).compatible);
}

function rankForPicker(
  catalog: readonly LocalModelDefinition[],
  kind: LocalModelKind,
  hardware: HardwareProfile,
): { options: LocalModelDefinition[]; recommendedId: string | null } {
  const rec = recommendModel({ kind, profile: 'quality', hardware, catalog });
  const compatible = compatibleOf(catalog, kind, hardware);
  const recId = rec.selected ? rec.selected.id : null;
  const options = [...compatible].sort((a, b) => {
    if (a.id === recId) return -1;
    if (b.id === recId) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return { options, recommendedId: recId };
}

function validateFlagModel(
  catalog: readonly LocalModelDefinition[],
  kind: LocalModelKind,
  hardware: HardwareProfile,
  modelId: string,
): { def?: LocalModelDefinition; error?: string } {
  const def = catalog.find((e) => e.id === modelId && e.kind === kind) ?? null;
  if (!def) {
    const sameId = catalog.find((e) => e.id === modelId) ?? null;
    if (sameId) return { error: 'model ' + JSON.stringify(modelId) + ' is a ' + sameId.kind + ' model, not an ' + kind + ' model' };
    return { error: 'unknown ' + kind + ' model ' + JSON.stringify(modelId) };
  }
  const compat = evaluateCompatibility(def, hardware);
  if (!compat.compatible) {
    const blocking = compat.reasons.filter((r) => r.result === 'fail').map((r) => r.requirement + ' | ' + r.observed).join('; ');
    return { error: 'model ' + JSON.stringify(modelId) + ' is incompatible: ' + blocking };
  }
  return { def };
}

async function detectPython(deps: SetupDeps): Promise<string | null> {
  if (deps.pythonVersion !== undefined) return deps.pythonVersion;
  try {
    const found = await discoverSystemPython(async (exe, args) => {
      const r = await runTrustedProcess(nodeSpawnFn(), { executable: exe, args, timeoutMs: 30000 });
      return { exit_code: r.exit_code, signal: r.signal, timed_out: r.timed_out, aborted: r.aborted, stdout: r.stdout, stderr: r.stderr };
    }, {});
    return found.version ?? null;
  } catch {
    return null;
  }
}

function checkPythonSupported(version: string | null): { ok: boolean; note: string } {
  if (!version) return { ok: true, note: 'unknown (validated per-model at install)' };
  const ok = checkVersionSpec(version, { minVersion: '3.10.0', maxVersionExclusive: '3.15.0' });
  return ok ? { ok: true, note: version } : { ok: false, note: version + ' (unsupported; requires 3.10-<3.15)' };
}


async function installWithStages(
  app: { config: Settings },
  ctx: ModelsContext,
  modelId: string,
  flags: Map<string, string>,
  deps: SetupDeps,
  presenter: ReturnType<typeof createStagePresenter>,
  stageOffsetNote: (phase: string) => void,
): Promise<number> {
  void stageOffsetNote;
  const started: boolean[] = [false, false, false, false, false, false];
  const done: boolean[] = [false, false, false, false, false, false];
  const begin = (i: number): void => { if (!started[i]) { started[i] = true; presenter.start(i); } };
  const finish = (i: number): void => { if (started[i] && !done[i]) { done[i] = true; presenter.complete(i); } };
  begin(0);
  const progress = (event: { model_id: string; phase: string; message: string }): void => {
    const idx = stageIndexForPhase(event.phase, event.message);
    // Advance monotonically: complete skipped stages implicitly.
    for (let i = 0; i < idx; i += 1) { begin(i); finish(i); }
    begin(idx);
    if (event.phase === 'completed') { for (let i = 0; i < 4; i += 1) { begin(i); finish(i); } }
    if (event.phase === 'failed' || event.phase === 'cancelled') presenter.fail(idx, event.message);
  };
  const installFlags = new Map<string, string>();
  const py = flags.get('python');
  if (py) installFlags.set('python', py);
  const code = await runModelsInstall(app, ctx, modelId, installFlags, { ...deps, onProgress: progress });
  if (code !== CliExit.SUCCESS) {
    // Close any open stage with failure context from the install result.
    for (let i = 0; i < 4; i += 1) if (started[i] && !done[i]) { presenter.fail(i, 'see error above'); break; }
    return code;
  }
  for (let i = 0; i < 4; i += 1) { begin(i); finish(i); }
  return CliExit.SUCCESS;
}

export function failureBlock(modelId: string, stage: string, reason: string, preserved: boolean): string {
  const lines = [
    '',
    friendlyName(modelId) + ' installation failed',
    'Stage: ' + stage,
    'Reason: ' + reason,
    '',
    preserved ? 'No existing installation was modified.' : 'Partial state preserved honestly (see status).',
    '',
    'Recovery: arthur models install ' + modelId + ' --reinstall',
  ];
  return lines.join('\n') + '\n';
}

/** HR-02.5F: setup reuses the canonical ModelsContext paths. No separate path policy here. */
export async function runSetup(app: { config: Settings }, ctx: ModelsContext, flags: Map<string, string>, deps: SetupDeps = {}): Promise<number> {
  const catalog = deps.catalog ?? getLocalModelCatalog();
  const probe = deps.probe ?? new SystemHardwareProbe();
  const hardware = await probe.detect();
  const store = deps.store ?? LocalModelStateStore.load({ statePath: ctx.statePath });
  const json = ctx.json;
  const yes = flags.get('yes') === 'true';
  const io: CliIO = ctx.io;

  const fail = (code: string, message: string, details: unknown, exit: number): number => {
    if (json) ctx.io.out(JSON.stringify({ ok: false, command: 'setup', code, message, details }, null, 2) + '\n');
    else ctx.io.err('error [' + code + ']: ' + message + '\n');
    return exit;
  };

  // JSON mode must be non-interactive: approval/pickers need --yes.
  if (json && !yes) {
    return fail('USAGE', 'setup --json requires --yes (non-interactive; no prompts on stdout)', { approval_required: true }, CliExit.USAGE);
  }

  // 1. Hardware + Python.
  const pythonVersion = await detectPython(deps);
  const pyCheck = checkPythonSupported(pythonVersion);
  if (!json) hardwareSection(io, hardware, pythonVersion);
  if (!pyCheck.ok) {
    return fail('INCOMPATIBLE', 'Python ' + pyCheck.note, { python: pythonVersion }, CliExit.INCOMPATIBLE);
  }

  // 2. Resolve compatible options per kind.
  const sttOpts = rankForPicker(catalog, 'stt', hardware);
  const ttsOpts = rankForPicker(catalog, 'tts', hardware);

  if (sttOpts.options.length === 0 && ttsOpts.options.length === 0) {
    if (!json) {
      ctx.io.out('\nNo compatible local model is available for this hardware.\n');
      ctx.io.out('Local offline voice is not available; cloud/LAN is still required.\n');
      ctx.io.out('Zero changes were made.\n');
    }
    return fail('INCOMPATIBLE', 'no compatible local STT or TTS model for this hardware', { stt: null, tts: null }, CliExit.INCOMPATIBLE);
  }

  // 3. Model selection: flags authoritative; else interactive picker or --yes default.
  const picks: Pick[] = [];
  const interactive = !yes && !json;
  for (const [kind, ranked] of [['stt', sttOpts], ['tts', ttsOpts]] as Array<[LocalModelKind, { options: LocalModelDefinition[]; recommendedId: string | null }]>) {
    const flagId = flags.get(kind === 'stt' ? 'stt-model' : 'tts-model');
    if (flagId !== undefined) {
      const v = validateFlagModel(catalog, kind, hardware, flagId);
      if (v.error) return fail('USAGE', v.error, { kind }, CliExit.USAGE);
      picks.push({ kind, def: v.def as LocalModelDefinition, via: 'flag' });
      continue;
    }
    if (ranked.options.length === 0) continue; // partial capability: other kind may exist
    const recId = ranked.recommendedId;
    if (!interactive) {
      const def = ranked.options.find((o) => o.id === recId) ?? ranked.options[0];
      if (def) picks.push({ kind, def, via: 'recommended' });
      continue;
    }
    // Interactive picker (skipped silently in JSON/--yes). A legacy
    // `confirm` seam without a line reader means a non-interactive
    // harness: fall back to the deterministic recommendation default.
    if (!deps.readApprovalLine && deps.confirm) {
      const def = ranked.options.find((o) => o.id === recId) ?? ranked.options[0];
      if (def) picks.push({ kind, def, via: 'recommended' });
      continue;
    }
    const title = kind === 'stt' ? 'Speech-to-text' : 'Text-to-speech';
    if (ranked.options.length === 1) {
      const only = ranked.options[0] as LocalModelDefinition;
      ctx.io.out('\n' + title + '\n  ' + friendlyName(only.id) + ' \u00B7 ' + modelDetail(only, true) + ' (only compatible option)\n');
      picks.push({ kind, def: only, via: 'recommended' });
      continue;
    }
    const defIdx = Math.max(0, ranked.options.findIndex((o) => o.id === recId));
    optionList(io, title, ranked.options.map((o) => ({
      id: o.id,
      title: friendlyName(o.id),
      detail: modelDetail(o, o.id === recId),
      recommended: o.id === recId,
    })), defIdx);
    const chosen = await askSelection(io, deps, kind === 'stt' ? 'Select STT' : 'Select TTS', ranked.options.length, defIdx);
    const def = ranked.options[chosen] as LocalModelDefinition;
    picks.push({ kind, def, via: def.id === recId ? 'recommended' : 'operator' });
  }

  const sttPick = picks.find((p) => p.kind === 'stt') ?? null;
  const ttsPick = picks.find((p) => p.kind === 'tts') ?? null;

  // Partial-capability explanation (real CachyOS case: TTS-only).
  if (!json && (!sttPick || !ttsPick)) {
    ctx.io.out('\nSpeech-to-text\n');
    ctx.io.out(sttPick ? '  ' + friendlyName(sttPick.def.id) + '\n' : '  No compatible local STT model is available.\n');
    ctx.io.out('\nText-to-speech\n');
    ctx.io.out(ttsPick ? '  ' + friendlyName(ttsPick.def.id) + ' \u00B7 ' + modelDetail(ttsPick.def, sttPick === null || ttsPick.via !== 'operator') + '\n' : '  No compatible local TTS model is available.\n');
    ctx.io.out('\n');
    if (sttPick && !ttsPick) ctx.io.out('Local setup will provide STT only.\nTTS will continue to require cloud/LAN until a compatible local model exists.\n');
    else if (!sttPick && ttsPick) ctx.io.out('Local setup will provide TTS only.\nSTT will continue to require cloud/LAN until a compatible local model exists.\n');
    if (!yes) {
      const cont = await askConfirm(io, deps, 'Continue with ' + (sttPick ? 'STT-only' : 'TTS-only') + ' setup?', 'yes');
      if (!cont) {
        ctx.io.out('setup cancelled (no changes made)\n');
        return CliExit.SUCCESS;
      }
    }
  }

  // 4. Concrete plan (always printed before mutation, incl. --yes and JSON-human? no: JSON stays silent).
  const snapshot = store.snapshot();
  const planRows: Array<{ kind: string; modelId: string; note: string; ready: boolean }> = picks.map((p) => {
    const entry = snapshot.models[p.def.id];
    const ready = Boolean(entry && entry.installed && entry.configured && entry.ready);
    const via = p.via === 'recommended' ? 'recommended' : 'operator choice';
    return { kind: p.kind, modelId: p.def.id, note: via, ready };
  });
  if (!json) {
    ctx.io.out('local voice setup plan:\n');
    planSection(io, {
      stt: sttPick ? friendlyName(sttPick.def.id) + ' (' + sttPick.def.id + ')' : 'Not available locally',
      tts: ttsPick ? friendlyName(ttsPick.def.id) + ' (' + ttsPick.def.id + ')' : 'Not available locally',
      python: pythonVersion ?? 'unknown',
      runtime: picks.map((p) => p.kind.toUpperCase() + ' ' + (p.def.requirements.accelerator === 'cpu' ? 'CPU' : String(p.def.requirements.accelerator ?? 'unknown').toUpperCase())).join(' / ') || 'none',
      root: ctx.managedRoot,
      state: ctx.statePath,
    });
    for (const row of planRows) {
      ctx.io.out('  ' + row.modelId + ' (' + row.note + '): ' + (snapshot.models[row.modelId]?.ready ? 'already ready (install skipped)' : 'will install + validate + select') + '\n');
    }
    ctx.io.out('\n');
  }

  // 5. Visible approval. The prompt text is always emitted on stdout
  // BEFORE any stdin read, so the operator sees the confirmation.
  if (!yes) {
    if (json) {
      return fail('USAGE', 'setup --json requires --yes (non-interactive; no prompts on stdout)', { approval_required: true }, CliExit.USAGE);
    }
    let approved: boolean;
    if (deps.confirm) { io.out('Proceed? [Y/n] '); approved = await deps.confirm('Proceed? [Y/n] '); }
    else approved = await askConfirm(io, deps, 'Proceed?', 'yes');
    if (!approved) {
      ctx.io.out('setup cancelled (no changes made)\n');
      return CliExit.SUCCESS;
    }
    ctx.io.out('\nStarting setup...\n');
  } else if (!json) {
    ctx.io.out('Proceed? [Y/n] --yes: approved non-interactively\n\nStarting setup...\n');
  }

  // 6. Install -> validate -> select per pick, sharing one presenter.
  // JSON mode: inner commands run against a muted non-JSON child context
  // so stdout carries exactly ONE machine envelope (the final result).
  const mute: CliIO = { out: () => undefined, err: () => undefined };
  const inner: ModelsContext = json ? { managedRoot: ctx.managedRoot, statePath: ctx.statePath, json: false, io: mute } : ctx;
  const presenter = json ? null : createStagePresenter(io, { title: 'Installing local voice', clock: deps.clock, tty: deps.tty });
  const failures: Array<{ modelId: string; stage: string; reason: string }> = [];
  for (const pick of picks) {
    const entry = store.snapshot().models[pick.def.id];
    const alreadyReady = Boolean(entry && entry.installed && entry.configured && entry.ready);
    if (!alreadyReady) {
      if (presenter) {
        ctx.io.out('\nInstalling ' + friendlyName(pick.def.id) + ' (' + pick.def.id + ')\n');
      }
      const code = presenter
        ? await installWithStages(app, ctx, pick.def.id, flags, deps, presenter, () => undefined)
        : await runModelsInstall(app, inner, pick.def.id, flags.get('python') ? new Map([['python', flags.get('python') as string]]) : new Map(), { ...deps });
      if (code !== CliExit.SUCCESS) {
        // Derive failure context from fresh store state (never invent).
        const st = store.snapshot().models[pick.def.id];
        const reason = st?.last_validation?.reason ?? 'install step failed (see output above)';
        failures.push({ modelId: pick.def.id, stage: 'installation', reason });
        if (!json) ctx.io.out(failureBlock(pick.def.id, 'installation', reason, true));
        else return fail('FAILED', reason, { model_id: pick.def.id, failures }, CliExit.VALIDATION_FAILED);
        return code;
      }
      const validateExit = await runModelsValidate(app, inner, pick.def.id, deps);
      if (validateExit !== CliExit.SUCCESS) {
        const st = store.snapshot().models[pick.def.id];
        const reason = st?.last_validation?.reason ?? 'validation failed';
        failures.push({ modelId: pick.def.id, stage: 'validating synthesis', reason });
        if (!json) ctx.io.out(failureBlock(pick.def.id, 'validating synthesis', reason, true));
        else return fail('FAILED', reason, { model_id: pick.def.id, failures }, CliExit.VALIDATION_FAILED);
        return validateExit;
      }
      if (presenter) { presenter.start(5); }
      const selectExit = await runModelsSelect(app, inner, pick.def.id, deps);
      if (presenter) { presenter.complete(5); }
      if (selectExit !== CliExit.SUCCESS) {
        if (json) return fail('FAILED', 'selection failed for ' + pick.def.id, { model_id: pick.def.id }, selectExit);
        return selectExit;
      }
      if (presenter) presenter.finish();
    } else {
      if (!json) ctx.io.out('\n' + friendlyName(pick.def.id) + ' already ready (install skipped)\n');
      // Still ensure selection slot points at the ready model.
      const selectExit = await runModelsSelect(app, inner, pick.def.id, deps);
      if (selectExit !== CliExit.SUCCESS) {
        if (json) return fail('FAILED', 'selection failed for ' + pick.def.id, { model_id: pick.def.id }, selectExit);
        return selectExit;
      }
    }
  }

  // 7. Final capability summary from ACTUAL lifecycle state (never inferred).
  const status = await buildStatus(app, ctx, deps);
  if (json) {
    ctx.io.out(JSON.stringify({ ok: true, command: 'setup', data: { ...status, picks: planRows } }, null, 2) + '\n');
  } else {
    heading(io, 'ARTHUR local setup complete');
    const sttLine = status.stt.runnable && status.stt.selected
      ? '\u2713 STT  ' + friendlyName(status.stt.selected) + '  READY'
      : '\u26A0 STT  No compatible local model';
    const ttsLine = status.tts.runnable && status.tts.selected
      ? '\u2713 TTS  ' + friendlyName(status.tts.selected) + '  READY'
      : '\u26A0 TTS  No compatible local model';
    ctx.io.out(sttLine + '\n' + ttsLine + '\n\n');
    keyValues(io, [
      ['STT src', status.stt.selection_source],
      ['TTS src', status.tts.selection_source],
    ]);
    ctx.io.out('local voice ready: stt=' + String(status.stt.selected) + ' tts=' + String(status.tts.selected) + '\n');
    if (status.stt.runnable && status.tts.runnable) ctx.io.out('\nFull local voice is ready.\n');
    else if (status.tts.runnable && !status.stt.runnable) ctx.io.out('\nLocal TTS is ready.\nSTT still requires cloud/LAN.\n');
    else if (status.stt.runnable && !status.tts.runnable) ctx.io.out('\nLocal STT is ready.\nTTS still requires cloud/LAN.\n');
    else ctx.io.out('\nLocal voice is not ready. See status above.\n');
  }
  void failures;
  // Full setup: both picks runnable. Partial (TTS-only/STT-only): the
  // available pick runnable and the missing kind genuinely absent.
  const sttOk = sttPick === null ? !status.stt.runnable : status.stt.runnable;
  const ttsOk = ttsPick === null ? !status.tts.runnable : status.tts.runnable;
  if (sttOk && ttsOk && (status.stt.runnable || status.tts.runnable)) return CliExit.SUCCESS;
  return CliExit.VALIDATION_FAILED;
}
