/**
 * FRS-01: `arthur config path|show` - secret-safe machine-config introspection.
 *
 * Thin adapters over src/config/machine_config.ts. This module (like
 * model_branch.ts) must never load the App composition root or SQLite
 * stores, even transitively: `config path` and `config show` run on
 * configuration alone and create no databases or model state.
 *
 * Secret handling: human and JSON output render secret-like names as
 * "configured"/"not configured" and NEVER contain secret values -
 * structurally (values are never interpolated first and redacted after).
 * There is deliberately no `config set <secret-on-command-line>`: FRS-02
 * will provide interactive masked credential input so secrets never land
 * in shell history.
 */

import { CliExit } from '../../src/cli_exit';
import { describeConfigurationEnvironment, loadConfigurationEnvironment, resolveMachineConfigPath } from '../../src/config/machine_config';
import type { CliIO } from './index';

export const CONFIG_HELP = [
  'ARTHUR config - canonical machine configuration introspection',
  '',
  'Usage:',
  '  arthur config path [--json]',
  '  arthur config show [--json]',
  '',
  '  path   Print the canonical machine config path (<app-data>/config.env).',
  '         CWD-independent; creates no databases or model state.',
  '  show   Safe inspection of effective configuration. Secret values are',
  '         never printed (configured / not configured only).',
  '',
].join('\n');

function isHelp(flags: Map<string, string>, positionals: string[]): boolean {
  return flags.get('help') === 'true' || positionals.includes('--help') || positionals.includes('-h');
}

/** `arthur config path`: print the canonical path. No file IO, no DB. */
export function runConfigPath(flags: Map<string, string>, io: CliIO): number {
  const json = flags.get('json') === 'true';
  const configPath = resolveMachineConfigPath();
  if (json) {
    io.out(JSON.stringify({ ok: true, command: 'config path', data: { path: configPath } }, null, 2) + '\n');
  } else {
    io.out(configPath + '\n');
  }
  return CliExit.SUCCESS;
}

export interface ConfigShowData {
  path: string;
  entries: { name: string; configured: boolean; secret: boolean; display: string }[];
}

/** `arthur config show`: bootstrap once, then render the safe snapshot. */
export function runConfigShow(flags: Map<string, string>, io: CliIO): number {
  const json = flags.get('json') === 'true';
  // ONE bootstrap policy: ambient env > repo .env > machine config.env.
  // Effective values land in process.env; describeConfigurationEnvironment
  // then renders them without ever exposing secret values.
  const { machineConfigPath } = loadConfigurationEnvironment();
  const rows = describeConfigurationEnvironment(process.env);
  const entries: ConfigShowData['entries'] = rows.map((row) => ({
    name: row.name,
    configured: row.configured,
    secret: row.secret,
    display: row.display,
  }));
  if (json) {
    io.out(JSON.stringify({ ok: true, command: 'config show', data: { path: machineConfigPath, entries } }, null, 2) + '\n');
  } else {
    const width = entries.reduce((max, entry) => Math.max(max, entry.name.length), 0);
    const lines = entries.map((entry) => entry.name.padEnd(width + 2) + entry.display);
    io.out(lines.length > 0 ? lines.join('\n') + '\n' : '\n');
  }
  return CliExit.SUCCESS;
}

/** Dispatch `arthur config <path|show>` over injected IO (deterministic tests). */
export function runConfig(command: string, flags: Map<string, string>, positionals: string[], io: CliIO): number {
  const sub = positionals[1];
  if (sub === undefined || isHelp(flags, positionals)) {
    if (sub === undefined && !isHelp(flags, positionals)) {
      io.err('usage: arthur config <path|show> [--json]\n');
      return CliExit.USAGE;
    }
    io.out(CONFIG_HELP);
    return CliExit.SUCCESS;
  }
  switch (sub) {
    case 'path': return runConfigPath(flags, io);
    case 'show': return runConfigShow(flags, io);
    default:
      io.err('usage: arthur config <path|show> [--json]\n');
      return CliExit.USAGE;
  }
}
