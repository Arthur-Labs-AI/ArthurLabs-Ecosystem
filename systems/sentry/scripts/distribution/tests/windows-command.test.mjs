import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const windows = { skip: process.platform !== 'win32' };
const helper = fileURLToPath(new URL('../register-command.ps1', import.meta.url));
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";

async function fixture(t, initialPath = '') {
  const root = await mkdtemp(join(tmpdir(), 'sentry command '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = join(root, 'archive ü %literal% & space');
  const bin = join(root, 'bin ü with spaces');
  await mkdir(archive);
  await writeFile(
    join(archive, 'sentry.ps1'),
    `param([string]$Command, [string]$Distro)
@{ command = $Command; distro = $Distro; cwd = (Get-Location).Path } | ConvertTo-Json -Compress
if ($Command -eq 'fail') { exit 23 }
exit 0
`,
  );
  const registration = join(root, 'register.ps1');
  const receipt = join(root, 'registration.json');
  await writeFile(
    registration,
    `\uFEFF. ${quote(helper)}
$global:UserPathFixture = ${quote(initialPath)}
$read = { $global:UserPathFixture }
$write = { param($Value) $global:UserPathFixture = $Value }
Register-SentryDistributionCommand -Root ${quote(archive)} -BinDirectory ${quote(bin)} -ReadUserPath $read -WriteUserPath $write
Register-SentryDistributionCommand -Root ${quote(archive)} -BinDirectory ${quote(bin)} -ReadUserPath $read -WriteUserPath $write
@{ userPath = $global:UserPathFixture; processPath = $env:Path } | ConvertTo-Json | Set-Content -LiteralPath ${quote(receipt)} -Encoding UTF8
`,
  );
  const registrationResult = spawnSync('powershell.exe', ['-NoProfile', '-File', registration], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(registrationResult.status, 0, registrationResult.stdout + registrationResult.stderr);
  return {
    root,
    archive,
    bin,
    receipt: JSON.parse((await readFile(receipt, 'utf8')).replace(/^\uFEFF/, '')),
  };
}

test('packaged registration preserves only user PATH and is idempotent', windows, async (t) => {
  const f = await fixture(t, 'C:\\user tools;C:\\other');
  assert.equal(f.receipt.userPath, 'C:\\user tools;C:\\other;' + f.bin);
  assert.equal(f.receipt.processPath.split(';').filter((entry) => entry === f.bin).length, 1);
});

test(
  'empty user PATH does not copy machine/process entries into the user PATH',
  windows,
  async (t) => {
    const f = await fixture(t);
    assert.equal(f.receipt.userPath, f.bin);
  },
);

test(
  'registered sentry resolves from System32 in cmd and PowerShell and forwards arguments/exit codes',
  windows,
  async (t) => {
    const f = await fixture(t);
    const options = {
      cwd: join(process.env.SystemRoot, 'System32'),
      env: { ...process.env, PATH: f.bin + ';' + process.env.PATH },
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: true,
    };
    const cmd = spawnSync(
      'cmd.exe',
      ['/d', '/s', '/c', 'sentry status -Distro "Ubuntu Test"'],
      options,
    );
    assert.equal(cmd.status, 0, cmd.stdout + cmd.stderr);
    const result = JSON.parse(cmd.stdout.trim());
    assert.equal(result.command, 'status');
    assert.equal(result.distro, 'Ubuntu Test');
    assert.equal(result.cwd.toLowerCase(), options.cwd.toLowerCase());
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'sentry version'], options);
    assert.equal(ps.status, 0, ps.stdout + ps.stderr);
    assert.equal(JSON.parse(ps.stdout.trim()).command, 'version');
    const failure = spawnSync('cmd.exe', ['/d', '/s', '/c', 'sentry fail'], options);
    assert.equal(failure.status, 23, failure.stdout + failure.stderr);
    await rm(join(f.archive, 'sentry.ps1'));
    const missing = spawnSync('cmd.exe', ['/d', '/s', '/c', 'sentry open'], options);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /missing or moved.*register-command/);
  },
);
