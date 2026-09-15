/**
 * HR-02.5F9: `arthur setup` guided local-voice orchestrator.
 *
 * Detect -> compatible models -> recommend STT+TTS -> show plan ->
 * operator approval -> install -> validate -> select -> readiness
 * report. No new installer/router: delegates to the models command
 * layer (same functions, same exit semantics). Never installs before
 * approval; never substitutes a different model after approval;
 * reruns are idempotent via already-ready short-circuits.
 *
 * Approval: interactive stdin prompt, or `--yes` (standard CLI input
 * mechanism, also used by acceptance harnesses). `--model <id>` lets
 * the operator choose a compatible alternative to the recommendation.
 */

import type { CliIO } from './index';
import { CliExit } from '../../src/cli_exit';
import type { LocalModelKind } from '../../src/runtime/local-models/contracts';
import { recommendModel } from '../../src/runtime/local-models/recommendation';
import { SystemHardwareProbe } from '../../src/runtime/hardware/probe';
import { LocalModelStateStore } from '../../src/runtime/local-models/state_store';
import { getLocalModelCatalog } from '../../src/runtime/local-models/catalog';
import { buildStatus } from './models';
import type { ModelsContext, ModelsDeps } from './models';
import { runModelsInstall, runModelsSelect, runModelsValidate } from './models';
import type { App } from '../../src/app';

export interface SetupDeps extends ModelsDeps {
  readApprovalLine?: () => Promise<string>;
}

async function askApproval(ctx: ModelsContext, flags: Map<string, string>, deps: SetupDeps, planText: string): Promise<boolean> {
  // The plan is always displayed before any mutation, including --yes
  // runs (auditability) and confirm-seam runs (tests observe it).
  ctx.io.out(planText);
  if (flags.get('yes') === 'true') return true;
  if (deps.confirm) return deps.confirm(planText);
  ctx.io.out('proceed with this plan? [y/N] ');
  if (deps.readApprovalLine) {
    const line = (await deps.readApprovalLine()).trim().toLowerCase();
    return line === 'y' || line === 'yes';
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const readline = require('node:readline') as typeof import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer: string = await new Promise((resolve) => rl.question('', resolve));
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

export async function runSetup(app: App, ctx: ModelsContext, flags: Map<string, string>, deps: SetupDeps = {}): Promise<number> {
  void app;
  const catalog = deps.catalog ?? getLocalModelCatalog();
  const probe = deps.probe ?? new SystemHardwareProbe();
  const hardware = await probe.detect();
  const store = deps.store ?? LocalModelStateStore.load({ statePath: ctx.statePath });
  // 1. recommend per kind (advisory; operator may override via --model).
  const wanted: Array<{ kind: LocalModelKind; modelId: string }> = [];
  const planLines: string[] = ['local voice setup plan:', 'hardware: ' + hardware.os + '/' + hardware.arch + ' cuda=' + hardware.accelerators.cuda];
  for (const kind of ['stt', 'tts'] as const) {
    const rec = recommendModel({ kind, profile: 'quality', hardware, catalog });
    const override = flags.get(kind === 'stt' ? 'stt-model' : 'tts-model');
    let pick = rec.selected ? rec.selected.id : null;
    if (override) {
      const def = catalog.find((entry) => entry.id === override && entry.kind === kind) ?? null;
      if (!def) {
        ctx.io.err('error [USAGE]: unknown ' + kind + ' model ' + JSON.stringify(override) + '\n');
        return CliExit.USAGE;
      }
      pick = def.id;
    }
    if (!pick) {
      ctx.io.err('error [INCOMPATIBLE]: no compatible ' + kind + ' model for this hardware\n');
      return CliExit.INCOMPATIBLE;
    }
    wanted.push({ kind, modelId: pick });
    planLines.push('- ' + kind + ': ' + pick + (override ? ' (operator choice)' : ' (recommended)'));
  }
  // 2. idempotency preview: already-ready models need no install.
  const snapshot = store.snapshot();
  for (const item of wanted) {
    const entry = snapshot.models[item.modelId];
    if (entry && entry.installed && entry.configured && entry.ready) planLines.push('  ' + item.modelId + ': already ready (install skipped)');
    else planLines.push('  ' + item.modelId + ': will install + validate + select');
  }
  const planText = planLines.join('\n') + '\n';
  // 3. approval BEFORE any mutation.
  const approved = await askApproval(ctx, flags, deps, planText);
  if (!approved) {
    ctx.io.out('setup cancelled (no changes made)\n');
    return CliExit.SUCCESS;
  }
  // 4. install -> validate -> select, in order, no substitution.
  for (const item of wanted) {
    const installFlags = new Map<string, string>();
    const installExit = await runModelsInstall(app, ctx, item.modelId, installFlags, deps);
    if (installExit !== CliExit.SUCCESS) return installExit;
    const validateExit = await runModelsValidate(app, ctx, item.modelId, deps);
    if (validateExit !== CliExit.SUCCESS) return validateExit;
    const selectExit = await runModelsSelect(app, ctx, item.modelId, deps);
    if (selectExit !== CliExit.SUCCESS) return selectExit;
  }
  // 5. readiness report.
  const status = await buildStatus(app, ctx, deps);
  const ready = status.stt.runnable && status.tts.runnable;
  ctx.io.out('local voice ready: stt=' + String(status.stt.selected) + ' tts=' + String(status.tts.selected) + '\n');
  if (ctx.json) ctx.io.out(JSON.stringify({ ok: true, command: 'setup', data: status }, null, 2) + '\n');
  return ready ? CliExit.SUCCESS : CliExit.VALIDATION_FAILED;
}
