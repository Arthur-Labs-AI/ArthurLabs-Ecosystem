import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLI_BROKER_COMMANDS } from '@qa/shared';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Regression: the frontend once called the WSL RPC name 'runs:exportContent'
// where the Desktop broker only knows 'runs:export-content', and the two
// mocked halves passed independently. This test pins the exact broker
// vocabulary the production frontend may use: every broker.request literal
// must be a member of the shared CLI_BROKER_COMMANDS list, which the broker
// allowlist derives from by construction.
describe('cli broker surface', () => {
  it('routes every frontend broker call through the shared external vocabulary', () => {
    const source = readFileSync(join(root, 'src', 'frontend-application.ts'), 'utf8');
    const found = new Set<string>();
    for (const match of source.matchAll(/broker\.request\(\s*['"]([^'"]+)['"]/g)) {
      const command = match[1];
      if (command !== undefined) found.add(command);
    }
    expect(found.size).toBeGreaterThan(10);
    const unknown = [...found].filter(
      (command) => !(CLI_BROKER_COMMANDS as readonly string[]).includes(command),
    );
    expect(unknown).toEqual([]);
  });

  it('never confuses WSL runtime RPC names with Desktop broker channels', () => {
    const source = readFileSync(join(root, 'src', 'frontend-application.ts'), 'utf8');
    for (const rpc of [
      'runs.exportContent',
      'runs.export',
      'runs.start',
      'projects.delete',
      'production.preRunGate',
    ]) {
      expect(source).not.toContain("broker.request('" + rpc + "'");
      expect(source).not.toContain('broker.request("' + rpc + '")');
    }
  });

  it('keeps the shared vocabulary free of WSL dotted names', () => {
    expect(CLI_BROKER_COMMANDS.every((command) => !command.includes('.'))).toBe(true);
  });
});
