import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredFiles } from '../contract.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const quote = (s) => "'" + s.replaceAll("'", "''") + "'";

test('Windows archive requires its CLI frontend even when a missing payload is resealed', () => {
  assert.ok(requiredFiles('windows-x64').includes('cli/sentry-cli.cjs'));
});

test(
  'archive CLI accepts all arguments and forwards machine streams/exit status',
  {
    skip: process.platform !== 'win32',
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'sentry packaged cli '));
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'scripts/distribution'), { recursive: true });
    await mkdir(join(root, 'scripts/launcher'), { recursive: true });
    await cp(join(repo, 'scripts/distribution/release.ps1'), join(root, 'sentry.ps1'));
    await cp(
      join(repo, 'scripts/launcher/SentryLauncher.psm1'),
      join(root, 'scripts/launcher/SentryLauncher.psm1'),
    );
    await writeFile(
      join(root, 'scripts/distribution/verify.ps1'),
      'function Get-SentryDistribution { param($Root) return @{} }',
    );
    for (const path of [
      'scripts/launcher/prerequisites.ps1',
      'scripts/launcher/wsl-setup.ps1',
      'scripts/distribution/maintenance.ps1',
      'scripts/distribution/register-command.ps1',
    ])
      await writeFile(join(root, path), '');
    await writeFile(
      join(root, 'scripts/distribution/cli.ps1'),
      `function Invoke-DistributionCli {
  param($Root, $CliArguments)
  [Console]::Out.WriteLine((@{ forwarded = @($CliArguments) } | ConvertTo-Json -Compress))
  [Console]::Error.WriteLine('fixture diagnostic')
  return 23
}`,
    );
    const runner = join(root, 'runner.ps1');
    await writeFile(
      runner,
      `\uFEFF[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Get-CimInstance { return @{ BuildNumber = '26200'; ProductType = 1 } }
& ${quote(join(root, 'sentry.ps1'))} cli project add 'C:\\Projects\\Sample ü\\' --json
exit $LASTEXITCODE
`,
    );
    const r = spawnSync('powershell.exe', ['-NoProfile', '-File', runner], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
    });
    assert.ifError(r.error);
    assert.equal(r.status, 23, r.stdout + r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).forwarded, [
      'project',
      'add',
      'C:\\Projects\\Sample ü\\',
      '--json',
    ]);
    assert.equal(r.stderr.trim(), 'fixture diagnostic');
  },
);
