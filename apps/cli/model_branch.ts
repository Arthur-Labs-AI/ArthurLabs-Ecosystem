/**
 * HR-02.5F model/setup branch: runs on validated settings alone, with no
 * session/memory database initialization.
 *
 * Split out of apps/cli/index.ts so the lazy boundary is a module
 * boundary: this module (and apps/cli/models.ts + apps/cli/setup.ts)
 * must never load the App composition root or the SQLite stores,
 * even transitively.
 * It receives the narrow settings holder (never a full App) so the type
 * system forbids DB access here.
 */

import type { Settings } from "../../src/config/settings";
import type { CliIO } from "./index";

export const MODELS_HELP = [
  'ARTHUR models - local voice model commands',
  '',
  'Local model setup moved here from top-level setup: arthur models setup ...',
  '',
  'Usage:',
  '  arthur models detect [--json] [--root <path>] [--state <path>]',
  '  arthur models list [--json] [--root <path>] [--state <path>]',
  '  arthur models recommend [--profile quality|balanced|lightweight] [--kind stt|tts] [--json]',
  '  arthur models install <model-id> [--reinstall] [--python <exe>] [--root <path>] [--state <path>] [--json]',
  '  arthur models select <model-id> [--json]',
  '  arthur models status [--json]',
  '  arthur models validate [model-id] [--json]',
  '  arthur models remove <model-id> [--yes] [--json]',
  '  arthur models setup [--yes] [--stt-model <id>] [--tts-model <id>] [--root <path>] [--state <path>] [--python <exe>] [--json]',
  '',
].join('\n');

export const MODELS_INSTALL_HELP = [
  'ARTHUR models install - install one local model',
  '',
  'Usage:',
  '  arthur models install <model-id> [--reinstall] [--python <exe>] [--root <path>] [--state <path>] [--json]',
  '',
  'Options:',
  '  --reinstall   Force reinstallation even when already ready',
  '  --python      Bootstrap Python executable (single path, never a command line)',
  '  --root        Managed model root (default: stable OS user-data root)',
  '  --state       Model state file (default: stable OS user-data root)',
  '  --json        Machine-readable JSON envelope on stdout (no human text)',
  '',
].join('\n');

export const SETUP_HELP = [
  'ARTHUR models setup - interactive local-voice model setup wizard',
  '',
  'Usage:',
  '  arthur models setup [--yes] [--stt-model <id>] [--tts-model <id>] [--root <path>] [--state <path>] [--python <exe>] [--json]',
  '',
  'Options:',
  '  --yes         Skip interactive pickers/approval (deterministic defaults)',
  '  --stt-model   Explicit STT model id (validated, never substituted)',
  '  --tts-model   Explicit TTS model id (validated, never substituted)',
  '  --root        Managed model root (default: stable OS user-data root)',
  '  --state       Model state file (default: stable OS user-data root)',
  '  --python      Bootstrap Python executable where supported',
  '  --json        Machine-readable JSON envelope on stdout (requires --yes)',
  '',
].join('\n');

function isHelp(flags: Map<string, string>, positionals: string[]): boolean {
  return flags.get('help') === 'true' || positionals.includes('--help') || positionals.includes('-h');
}

export async function runModelsOrSetup(
  holder: { config: Settings },
  command: string,
  flags: Map<string, string>,
  positionals: string[],
  io: CliIO,
): Promise<number> {
  // FRS-04: top-level `arthur setup` is the unified wizard (see
  // apps/cli/setup_unified.ts). The local-model wizard lives on as
  // `arthur models setup` — same implementation, same flags, no duplication.
  if (command === 'setup') {
    if (isHelp(flags, positionals)) { io.out(SETUP_HELP); return 0; }
    const { modelsContext } = await import('./models');
    const { runSetup } = await import('./setup');
    return runSetup(holder, modelsContext(holder, flags, io), flags);
  }
  const { modelsContext, runModelsDetect, runModelsList, runModelsRecommend, runModelsInstall, runModelsSelect, runModelsStatus, runModelsValidate, runModelsRemove } = await import('./models');
  const ctx = modelsContext(holder, flags, io);
  const sub = positionals[1];
  if ((sub === undefined || sub === 'help') && isHelp(flags, positionals)) { io.out(MODELS_HELP); return 0; }
  switch (sub) {
    case 'detect': return runModelsDetect(holder, ctx);
    case 'list': return runModelsList(holder, ctx);
    case 'recommend': return runModelsRecommend(holder, ctx, flags);
    case 'install':
      if (isHelp(flags, positionals)) { io.out(MODELS_INSTALL_HELP); return 0; }
      return runModelsInstall(holder, ctx, positionals[2] ?? '', flags);
    case 'select': return runModelsSelect(holder, ctx, positionals[2] ?? '');
    case 'status': return runModelsStatus(holder, ctx);
    case 'validate': return runModelsValidate(holder, ctx, positionals[2]);
    case 'remove': return runModelsRemove(holder, ctx, positionals[2] ?? '', flags);
    case 'setup': {
      if (isHelp(flags, positionals)) { io.out(SETUP_HELP); return 0; }
      const { runSetup } = await import('./setup');
      return runSetup(holder, ctx, flags);
    }
    default:
      io.err('usage: arthur models <detect|list|recommend|install|select|status|validate|remove|setup> [--json]\n');
      return 2;
  }
}
