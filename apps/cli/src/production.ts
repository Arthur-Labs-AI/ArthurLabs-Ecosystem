import { commandHint, parseCommand } from './arguments.js';
import { executeFrontendCommand, frontendErrorEnvelope } from './frontend-application.js';
import { errorExitCode } from './exit-codes.js';
import {
  consoleIo,
  emitHumanError,
  emitHumanSuccess,
  emitMachine,
  successExitCode,
  type CliIo,
} from './output.js';

export function productionHelp(): string {
  return [
    'Usage: sentry cli <command> [--json]',
    'Desktop must be running: sentry open',
    '',
    '  capabilities',
    '  agent list | agent doctor opencode|deepseek|glm',
    '  project add <path> | list | show <id> | update <id> [path]',
    '  project revisions <id> | doctor <id> | delete <id> --yes',
    '  run start <project-id> --mode full --agents opencode,deepseek,glm [--wait]',
    '  run start <project-id> --mode targeted --paths src/auth,src/api [--wait]',
    '  run list <project-id> | show <run-id> | status <run-id> | cancel <run-id>',
    '  run result <run-id>',
    '  run export <run-id> --format json|log --out <path>',
    '',
    'Automation: use --json; stdout is one JSON document and stderr carries diagnostics.',
    'Run start executes real agents and may incur provider charges.',
    'Examples: see CLI.md. Install or upgrade: see INSTALL.md.',
  ].join('\n');
}

// Packaged automation is always a frontend of Desktop. No direct transport,
// local database, provider tooling or harness implementation is imported here.
export async function runProductionCli(
  argv: readonly string[],
  version: string,
  io: CliIo = consoleIo,
): Promise<number> {
  const original = argv.slice(2);
  const machine = original.includes('--json');
  const args = original.filter((a) => a !== '--json');
  if (!machine && (args.length === 0 || args.includes('--help') || args.includes('-h'))) {
    io.stdout(productionHelp());
    return 0;
  }
  if (!machine && (args.includes('--version') || args.includes('-V'))) {
    io.stdout('Sentry CLI ' + version);
    return 0;
  }
  let command: ReturnType<typeof commandHint> = commandHint(args);
  try {
    const parsed = parseCommand(args);
    command = parsed.command;
    const response = await executeFrontendCommand(parsed, { onDiagnostic: io.stderr });
    if (machine) emitMachine(response, io);
    else emitHumanSuccess(response, io);
    return successExitCode(response);
  } catch (cause) {
    const response = frontendErrorEnvelope(command, cause);
    if (machine) emitMachine(response, io);
    else emitHumanError(response, io);
    return errorExitCode(response.error);
  }
}
