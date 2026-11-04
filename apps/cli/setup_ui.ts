/**
 * HR-02.5F UX (task TASK-0008): narrow CLI presentation abstraction.
 *
 * One small module owning every human-facing block the setup wizard and
 * direct installs render: headings, key/value sections, option lists,
 * prompts, stage progress, success/warning/error lines, final summary.
 * Command handlers stay orchestration-only; no ad-hoc console.log spread.
 *
 * Plain-text by design: symbols/colors may enhance but never define
 * semantics, so meaning survives non-ANSI terminals and log files.
 * JSON mode never touches this module (machine envelope only).
 */

import type { CliIO } from './index';
import type { HardwareProfile } from '../../src/runtime/hardware/contracts';

export interface SetupOption {
  id: string;
  title: string;
  detail: string;
  recommended: boolean;
}

export function heading(io: CliIO, title: string): void {
  io.out(title + '\n');
  io.out('─'.repeat(Math.min(44, Math.max(title.length, 12))) + '\n');
}

export function keyValues(io: CliIO, rows: Array<[string, string]>): void {
  for (const [key, value] of rows) {
    io.out('  ' + key.padEnd(8) + value + '\n');
  }
}

export function statusLine(io: CliIO, ok: boolean | 'warn', text: string): void {
  const mark = ok === true ? '\u2713' : ok === 'warn' ? '\u26A0' : '\u2717';
  io.out(mark + ' ' + text + '\n');
}

/** Concise hardware block. Never classifies UNKNOWN as AVAILABLE. */
export function hardwareSection(io: CliIO, hardware: HardwareProfile, pythonVersion: string | null): void {
  heading(io, 'ARTHUR Local Setup');
  io.out('\n\u2713 System detected\n\n');
  const ram = hardware.memory.total_mb === null ? 'unknown' : (hardware.memory.total_mb / 1024).toFixed(1) + ' GB';
  const gpu = hardware.gpus.length === 0
    ? 'none detected'
    : hardware.gpus.map((g: { name: string }) => g.name).join('; ');
  keyValues(io, [
    ['OS', hardware.os + ' ' + hardware.arch],
    ['CPU', String(hardware.cpu.model ?? 'unknown')],
    ['RAM', ram],
    ['GPU', gpu],
    ['CUDA', hardware.accelerators.cuda],
    ['Vulkan', hardware.accelerators.vulkan],
    ['Python', pythonVersion ?? 'unknown'],
  ]);
  io.out('\n');
}

/** Numbered model picker. Default on Enter is the recommendation. */
export function optionList(io: CliIO, title: string, options: SetupOption[], defIndex: number): void {
  io.out('\n' + title + '\n\n');
  options.forEach((opt, i) => {
    const marker = i === defIndex ? '>' : ' ';
    io.out('  ' + marker + ' [' + String(i + 1) + '] ' + opt.title + (opt.recommended ? ' (recommended)' : '') + '\n');
    io.out('      ' + opt.detail + '\n');
  });
  io.out('\n');
}

export function planSection(
  io: CliIO,
  rows: { stt: string; tts: string; python: string; runtime: string; root: string; state: string },
): void {
  heading(io, 'Setup plan');
  keyValues(io, [
    ['STT', rows.stt],
    ['TTS', rows.tts],
    ['Python', rows.python],
    ['Runtime', rows.runtime],
    ['Root', rows.root],
    ['State', rows.state],
  ]);
  io.out('\n');
}

/** Canonical setup-stage list shared by setup and direct install. */
export const SETUP_STAGES: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'preparing', label: 'Preparing Python runtime' },
  { key: 'installing_deps', label: 'Installing dependencies' },
  { key: 'installing_model', label: 'Downloading model' },
  { key: 'validating', label: 'Validating synthesis' },
  { key: 'promoting', label: 'Promoting installation' },
  { key: 'selecting', label: 'Selecting model' },
];

/** Map service/installer phases onto the 6 wizard stages. Shared by setup and direct install. */
export function stageIndexForPhase(phase: string, message: string): number {
  const msg = message.toLowerCase();
  if (phase === 'preflight') return 0;
  if (phase === 'preparing') return 0;
  if (phase === 'configuring') return 4;
  if (phase === 'validating' || phase === 'completed') return 3;
  if (phase === 'installing') {
    if (msg.includes('venv') || msg.includes('runtime') || msg.includes('python') || msg.includes('pip') || msg.includes('package') || msg.includes('miocodec')) return 1;
    if (msg.includes('snapshot') || msg.includes('download') || msg.includes('cache') || msg.includes('hugging')) return 2;
    return 1;
  }
  return 1;
}

const SPINNER = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'];

function elapsed(startedAt: number, now: number): string {
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return mm + ':' + ss;
}

function isTty(io: CliIO): boolean {
  const out = (io as { isTty?: boolean }).isTty;
  if (typeof out === 'boolean') return out;
  return Boolean(process.stdout.isTTY);
}

/**
 * Narrow stage presenter: deterministic stage ordering, plain lines on
 * non-TTY, dynamic spinner+elapsed on TTY. Symbols never carry meaning
 * alone — every state also prints a word (complete/active/pending).
 * No byte percentages anywhere: totals are unknown at this layer, so
 * only stage + elapsed time is rendered.
 */
export interface StagePresenter {
  start(index: number): void;
  complete(index: number): void;
  fail(index: number, reason: string): void;
  tick(): void;
  finish(): void;
}

export function createStagePresenter(
  io: CliIO,
  opts: { title?: string; clock?: () => number; tty?: boolean },
): StagePresenter {
  const tty = opts.tty ?? isTty(io);
  const clock = opts.clock ?? Date.now;
  const total = SETUP_STAGES.length;
  const done: boolean[] = SETUP_STAGES.map(() => false);
  let active = -1;
  let startedAt = clock();
  let spin = 0;
  if (opts.title) heading(io, opts.title);
  const label = (i: number): string => {
    const stage = SETUP_STAGES[i];
    return stage ? stage.label : 'stage ' + String(i + 1);
  };
  const renderTty = (): void => {
    if (!tty) return;
    for (let i = 0; i < total; i += 1) {
      const n = '[' + String(i + 1) + '/' + String(total) + '] ';
      if (done[i]) io.out(n + '\u2713 ' + label(i) + '\n');
      else if (i === active) io.out(n + SPINNER[spin % SPINNER.length] + ' ' + label(i) + '... ' + elapsed(startedAt, clock()) + '\n');
      else io.out(n + '\u25CB ' + label(i) + '\n');
    }
  };
  const started: boolean[] = SETUP_STAGES.map(() => false);
  return {
    start(index: number): void {
      active = index;
      startedAt = clock();
      if (tty) renderTty();
      else if (!started[index]) { started[index] = true; io.out('[' + String(index + 1) + '/' + String(total) + '] ' + label(index) + '\n'); }
    },
    complete(index: number): void {
      if (done[index]) return;
      done[index] = true;
      if (!tty) io.out('[' + String(index + 1) + '/' + String(total) + '] ' + label(index) + ': complete\n');
    },
    fail(index: number, reason: string): void {
      if (!tty) io.out('[' + String(index + 1) + '/' + String(total) + '] ' + label(index) + ': failed (' + reason + ')\n');
      else io.out('\u2717 ' + label(index) + ': ' + reason + '\n');
    },
    tick(): void {
      spin += 1;
    },
    finish(): void {
      if (tty) {
        for (let i = 0; i < total; i += 1) {
          const n = '[' + String(i + 1) + '/' + String(total) + '] ';
          io.out(n + (done[i] ? '\u2713 ' + label(i) : '\u25CB ' + label(i)) + '\n');
        }
      }
    },
  };
}

/** Prompt helpers shared by pickers and confirmations. */
export async function readLine(deps: { readApprovalLine?: () => Promise<string> }): Promise<string> {
  if (deps.readApprovalLine) return deps.readApprovalLine();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const readline = require('node:readline') as typeof import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question('', resolve));
  } finally {
    rl.close();
  }
}

/** Numbered selection. Enter = default. Invalid input re-prompts. */
export async function askSelection(
  io: CliIO,
  deps: { readApprovalLine?: () => Promise<string> },
  prompt: string,
  count: number,
  defIndex: number,
): Promise<number> {
  for (;;) {
    io.out(prompt + ' [' + String(defIndex + 1) + ']: ');
    const raw = (await readLine(deps)).trim();
    if (raw === '') return defIndex;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= count) return n - 1;
    io.out('Please enter a number between 1 and ' + String(count) + ' (Enter for default ' + String(defIndex + 1) + ').\n');
  }
}

/**
 * Y/n confirmation. Flushes the prompt (out) BEFORE reading stdin, honors
 * the documented default on Enter, re-prompts on invalid answers.
 */
export async function askConfirm(
  io: CliIO,
  deps: { readApprovalLine?: () => Promise<string> },
  prompt: string,
  def: 'yes' | 'no',
): Promise<boolean> {
  const hint = def === 'yes' ? '[Y/n]' : '[y/N]';
  for (;;) {
    io.out(prompt + ' ' + hint + ' ');
    const raw = (await readLine(deps)).trim().toLowerCase();
    if (raw === '') return def === 'yes';
    if (raw === 'y' || raw === 'yes') return true;
    if (raw === 'n' || raw === 'no') return false;
    io.out('Please answer y/yes or n/no.\n');
  }
}

export function modelDetail(def: { quality_tier: string; requirements: { accelerator?: string }; support: { maturity: string } }, recommended: boolean): string {
  const tierWord = def.quality_tier === 'high' ? 'High quality' : def.quality_tier === 'balanced' ? 'Balanced' : 'Lightweight';
  const hw = def.requirements.accelerator === 'cpu' ? 'CPU' : String(def.requirements.accelerator ?? 'CPU').toUpperCase();
  const mat = def.support.maturity === 'validated' ? 'Validated' : 'Experimental';
  return tierWord + ' \u00B7 ' + hw + ' \u00B7 ' + mat + (recommended ? ' \u00B7 Recommended' : '');
}

export function friendlyName(id: string): string {
  if (id === 'parakeet-tdt-0.6b-v3') return 'Parakeet TDT 0.6B';
  if (id === 'omnivoice-bg') return 'OmniVoice BG';
  if (id === 'bgtts-38m-v2') return 'BgTTS 38M';
  return id;
}
