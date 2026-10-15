// Execute the real packaged PowerShell entrypoint; only OS/process boundaries
// are fixtures. Never launch WSL/Electron or touch a real installation/profile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = fileURLToPath(new URL('../', import.meta.url));
const windows = { skip: process.platform !== 'win32' };
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";

async function invoke(t, command, failure = '') {
  const temporary = await mkdtemp(join(tmpdir(), 'sentry Windows setup '));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'archive with spaces');
  await mkdir(join(root, 'scripts/distribution'), { recursive: true });
  await mkdir(join(root, 'scripts/launcher'), { recursive: true });
  await cp(join(scripts, 'release.ps1'), join(root, 'sentry.ps1'));
  await writeFile(
    join(root, 'scripts/distribution/register-command.ps1'),
    "function Register-SentryDistributionCommand { param($Root) Write-FixtureCall 'shim' @($Root) }\n",
  );
  await writeFile(
    join(root, 'scripts/distribution/verify.ps1'),
    "function Get-SentryDistribution { param($Root) return @{ version = '1.0.0' } }\n",
  );
  await writeFile(
    join(root, 'scripts/distribution/maintenance.ps1'),
    "function Stop-DistributionDesktop { param($Executable) Write-FixtureCall 'stop' @($Executable) }\n",
  );
  await writeFile(join(root, 'scripts/launcher/prerequisites.ps1'), '');
  await writeFile(
    join(root, 'scripts/launcher/wsl-setup.ps1'),
    `function Ensure-SentryWslDistro {
  param($Explicit, $NonInteractive, $Previous)
  return @{ Distro = 'Ubuntu'; RebootRequired = $false }
}
`,
  );
  await writeFile(
    join(root, 'scripts/launcher/SentryLauncher.psm1'),
    `function Write-FixtureCall {
  param($Kind, $Values)
  $line = @{ kind = $Kind; values = @($Values) } | ConvertTo-Json -Compress
  [System.IO.File]::AppendAllText($env:SENTRY_FIXTURE_CALLS, $line + [Environment]::NewLine)
}
function Get-SentryLauncherConfig { return @{} }
function Set-SentryLauncherConfig { param($Configuration) Write-FixtureCall 'config' @($Configuration.selectedDistro) }
function Invoke-SentryWsl {
  param($Distro, $LinuxArgs, $TimeoutSec)
  Write-FixtureCall 'wsl' (@($Distro) + $LinuxArgs)
  if ($LinuxArgs[0] -eq 'wslpath') {
    if ($env:SENTRY_FIXTURE_FAILURE -eq 'translation') { return @{ ExitCode = 1; Stdout = ''; Stderr = 'fixture translation failure' } }
    return @{ ExitCode = 0; Stdout = '/fixture archive/scripts/distribution/' + [System.IO.Path]::GetFileName($LinuxArgs[-1]); Stderr = '' }
  }
  if ($LinuxArgs[1] -like '*bootstrap-runtime.sh') {
    if ($env:SENTRY_FIXTURE_FAILURE -eq 'bootstrap') { return @{ ExitCode = 1; Stdout = ''; Stderr = 'fixture bootstrap failure' } }
    if ($LinuxArgs.Count -ne 3 -or $LinuxArgs[2] -ne 'wsl') { return @{ ExitCode = 1; Stdout = ''; Stderr = 'native mode incorrectly selected' } }
  }
  return @{ ExitCode = 0; Stdout = ''; Stderr = '' }
}
function Invoke-SentryNative {
  param($FilePath, $Arguments, $TimeoutSec)
  Write-FixtureCall 'native' $Arguments
  return @{ ExitCode = 0; Stdout = ''; Stderr = '' }
}
function Invoke-SentryWslFile {
  param($Distro, $ScriptName, $ScriptArgs, $TimeoutSec)
  Write-FixtureCall 'tool' (@($ScriptName) + $ScriptArgs)
  return @{ ExitCode = 0; Stdout = ''; Stderr = '' }
}
function Start-Process {
  param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle)
  Write-FixtureCall 'launch' @($FilePath, $ArgumentList, $WorkingDirectory, [string]$WindowStyle)
}
Export-ModuleMember -Function *
`,
  );
  const calls = join(temporary, 'calls.jsonl');
  const runner = join(temporary, 'runner.ps1');
  await writeFile(
    runner,
    `function Get-CimInstance { param($ClassName) return @{ BuildNumber = '26200'; ProductType = 1 } }
& ${quote(join(root, 'sentry.ps1'))} ${quote(command)} -Distro Ubuntu
`,
  );
  const result = spawnSync('powershell.exe', ['-NoProfile', '-File', runner], {
    env: { ...process.env, SENTRY_FIXTURE_CALLS: calls, SENTRY_FIXTURE_FAILURE: failure },
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  const records = (
    await readFile(calls, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    })
  )
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { ...result, records };
}

test(
  'Windows archive setup registers the command only after successful preference activation',
  windows,
  async (t) => {
    const result = await invoke(t, 'setup');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.records.at(-1)?.kind, 'shim');
    assert.equal(result.records.at(-2)?.kind, 'config');
  },
);

test(
  'Windows archive can register the command without reinstalling or stopping Desktop',
  windows,
  async (t) => {
    const result = await invoke(t, 'register-command');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(
      result.records.map((r) => r.kind),
      ['shim'],
    );
  },
);

for (const command of ['setup', 'repair']) {
  test(
    `Windows archive ${command} passes explicit WSL mode before preference activation`,
    windows,
    async (t) => {
      const result = await invoke(t, command);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const bootstrap = result.records.find((r) => r.kind === 'wsl' && r.values[1] === 'bash');
      assert.deepEqual(bootstrap.values, [
        'Ubuntu',
        'bash',
        '/fixture archive/scripts/distribution/bootstrap-runtime.sh',
        'wsl',
      ]);
      assert.deepEqual(
        result.records.filter((r) => r.kind === 'native').map((r) => r.values),
        [['--sentry-setup-distro', 'Ubuntu']],
      );
      assert.deepEqual(result.records.at(-2), { kind: 'config', values: ['Ubuntu'] });
      assert.equal(result.records.at(-1).kind, 'shim');
      assert.equal(result.records[0].kind, 'stop');
    },
  );
}

test('Windows archive open requests a visible interactive Desktop', windows, async (t) => {
  const result = await invoke(t, 'open');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const launch = result.records.find((record) => record.kind === 'launch');
  assert.ok(launch);
  assert.deepEqual(launch.values[1], ['--sentry-app']);
  assert.equal(launch.values[3], 'Normal');
  assert.equal(launch.values[0], join(launch.values[2], 'Sentry.exe'));
});

test(
  'Windows archive tools preserves zero-argument maintenance and existing tool pins',
  windows,
  async (t) => {
    const result = await invoke(t, 'tools');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(
      result.records.find((r) => r.kind === 'wsl' && r.values[1] === 'bash').values,
      ['Ubuntu', 'bash', '/fixture archive/scripts/distribution/check-maintenance.sh'],
    );
    assert.deepEqual(
      result.records.filter((r) => r.kind === 'tool').map((r) => r.values),
      [
        ['install-opencode.sh', '1.18.32'],
        ['install-deepseek-tool.sh', '0.1.5-rc.2'],
        ['install-claude.sh', '2.1.270'],
      ],
    );
  },
);

for (const failure of ['translation', 'bootstrap']) {
  test(
    `Windows archive ${failure} failure refuses Desktop preference activation`,
    windows,
    async (t) => {
      const result = await invoke(t, 'setup', failure);
      assert.notEqual(result.status, 0);
      assert.equal(
        result.records.some((r) => r.kind === 'native' || r.kind === 'config' || r.kind === 'shim'),
        false,
      );
      assert.match(
        result.stdout + result.stderr,
        failure === 'translation' ? /WSL path translation failed/ : /Linux bootstrap failed/,
      );
    },
  );
}
