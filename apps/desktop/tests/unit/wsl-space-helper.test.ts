import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WSL_SPACE_HELPER } from '../../src/main/platform/windows/wsl-space-helper.js';

const windows = describe.skipIf(process.platform !== 'win32');
const psQuote = (value: string): string => "'" + value.replaceAll("'", "''") + "'";

/** Real Windows PowerShell; only OS mutations are substituted, not parsing or control flow. */
async function run(body: string) {
  const dir = await mkdtemp(join(tmpdir(), 'sentry-wsl-helper-test-'));
  try {
    const helper = join(dir, 'helper.ps1');
    const runner = join(dir, 'test.ps1');
    await writeFile(helper, WSL_SPACE_HELPER);
    await writeFile(
      runner,
      '. ' + psQuote(helper) + ' -LibraryOnly\n$fixtureRoot = ' + psQuote(dir) + '\n' + body,
    );
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner],
      { encoding: 'utf8', timeout: 30000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const fakeRegistration = String.raw`
$disk = Join-Path $fixtureRoot 'ext4.vhdx'
[IO.File]::WriteAllText($disk, 'fixture; not a virtual disk')
$script:registration = [pscustomobject]@{ DistributionName = 'Ubuntu'; Version = 2; BasePath = $fixtureRoot; VhdFileName = 'ext4.vhdx' }
function Get-ChildItem { param([string]$LiteralPath) return [pscustomobject]@{ PSPath = 'fixture' } }
function Get-ItemProperty { param([string]$LiteralPath) return $script:registration }
`;

windows('WSL PowerShell helper', () => {
  it('refuses another running distro before any trim or shutdown', async () => {
    expect(
      await run(
        fakeRegistration +
          String.raw`
$script:calls = [Collections.Generic.List[string]]::new()
function Invoke-SentryWsl { param([string[]]$Arguments)
  $script:calls.Add(($Arguments -join '|'))
  if ($Arguments[0] -eq '--list') { return "Ubuntu" + [Environment]::NewLine + 'docker-desktop' }
  throw 'Unsafe: trim or shutdown reached while another distro is running'
}
function Start-Process { throw 'Elevation should not happen' }
try { $null = Invoke-SentryReclaim 'Ubuntu' $disk; throw 'Other distro accepted' } catch {
  if ($_.Exception.Message -notmatch 'Another WSL distribution is running') { throw }
}
if (($script:calls -join ';') -cne '--list|--running|--quiet') { throw 'Guard did not run first' }
'other-distro-refused-before-trim'
`,
      ),
    ).toBe('other-distro-refused-before-trim');
  });

  it('waits for a real transient sharing lock before entering native compaction', async () => {
    expect(
      await run(
        fakeRegistration +
          String.raw`
$eventName = 'Local\SentryFileLockTest' + [Guid]::NewGuid().ToString('N')
$ready = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset, $eventName + 'Ready')
$release = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset, $eventName + 'Release')
$holderCode = '$lock = [IO.File]::Open(''' + $disk.Replace("'", "''") + ''', [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); ' +
  '$ready = [Threading.EventWaitHandle]::OpenExisting(''' + $eventName + 'Ready''); $release = [Threading.EventWaitHandle]::OpenExisting(''' + $eventName + 'Release''); ' +
  'try { $null = $ready.Set(); if (-not $release.WaitOne(15000)) { exit 2 } } finally { $lock.Dispose(); $ready.Dispose(); $release.Dispose() }'
$holder = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile', '-EncodedCommand', [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($holderCode)))
try {
  if (-not $ready.WaitOne(10000)) { throw 'Fixture lock did not become ready' }
  $script:probes = 0
  function Test-SentryDiskAvailable([string]$Disk) {
    $script:probes++
    try {
      $handle = [IO.File]::Open($Disk, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
      $handle.Dispose()
      return $true
    } catch {
      $null = $release.Set()
      return $false
    }
  }
  function Initialize-SentryVirtualDiskApi { throw 'native-reached-after-release' }
  try { Invoke-SentryNativeCompact $disk; throw 'Missing native call' } catch {
    if ($_.Exception.Message -ne 'native-reached-after-release') { throw }
  }
  if ($script:probes -lt 2) { throw 'Sharing lock was not observed and retried' }
  'transient-lock-waited'
} finally {
  $null = $release.Set()
  $null = $holder.WaitForExit(10000)
  $ready.Dispose(); $release.Dispose(); $holder.Dispose()
}
`,
      ),
    ).toBe('transient-lock-waited');
  });

  it('parses in Windows PowerShell 5.1 and compiles the real native interop', async () => {
    const output = await run(String.raw`
Initialize-SentryVirtualDiskApi
if ([Runtime.InteropServices.Marshal]::SizeOf([type][SentryVirtualDisk+StorageType]) -ne 20) { throw 'Invalid storage type layout' }
if ([Runtime.InteropServices.Marshal]::SizeOf([type][SentryVirtualDisk+OpenParameters]) -ne 8) { throw 'Invalid version 1 layout' }
$status = [SentryVirtualDisk]::Compact((Join-Path $fixtureRoot 'does-not-exist.vhdx'))
if ($status -eq 0) { throw 'Nonexistent disk unexpectedly compacted' }
'native-interop-compiled-invalid-path-refused'
`);
    expect(output).toBe('native-interop-compiled-invalid-path-refused');
  });

  it.each(['native', 'dot-segment'])(
    'resolves exactly the selected WSL2 registration, independent of shell-like text (%s path)',
    async (pathForm) => {
      expect(
        await run(
          (pathForm === 'dot-segment' ? "$fixtureRoot = Join-Path $fixtureRoot '.'\n" : '') +
            fakeRegistration +
            String.raw`
# The temp path may contain a short-name alias or dot segment. Compare the
# fixture's canonical filesystem path, not Node's unnormalized spelling.
$expectedDisk = (Get-Item -LiteralPath $disk).FullName
$actualDisk = Get-SentryDisk 'Ubuntu'
if ($actualDisk -cne $expectedDisk) { throw "Wrong disk: expected '$expectedDisk', received '$actualDisk'" }
foreach ($name in @('ubuntu', 'Ubuntu; Remove-Item C:', ("Ubuntu" + [char]10))) {
  $refused = $false
  try { $null = Get-SentryDisk $name } catch { $refused = $true }
  if (-not $refused) { throw 'Unsafe or unknown distro accepted' }
}
'registration-validated'
`,
        ),
      ).toBe('registration-validated');
    },
  );

  it.each([
    '$script:registration.Version = 1',
    "$script:registration.VhdFileName = '../other.vhdx'",
    "$script:registration.BasePath = '\\\\server\\share'",
  ])('refuses unsupported registrations: %s', async (mutation) => {
    expect(
      await run(
        fakeRegistration +
          '\n' +
          mutation +
          String.raw`
$refused = $false
try { $null = Get-SentryDisk 'Ubuntu' } catch { $refused = $true }
if (-not $refused) { throw 'Unsupported registration accepted' }
'refused'
`,
      ),
    ).toBe('refused');
  });

  it('does not call native compaction while a file is held open', async () => {
    expect(
      await run(
        fakeRegistration +
          String.raw`
function Initialize-SentryVirtualDiskApi { throw 'Native initialization must not be reached' }
$lock = [IO.File]::Open($disk, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  $refused = $false
  try { Invoke-SentryNativeCompact -Disk $disk -WaitTimeoutMilliseconds 0 } catch {
    if ($_.Exception.Message -match 'initialization') { throw }
    $refused = $true
  }
  if (-not $refused) { throw 'In-use disk accepted' }
} finally { $lock.Dispose() }
'in-use-disk-refused'
`,
      ),
    ).toBe('in-use-disk-refused');
  });

  it('passes full WSL argv, checks other distros before trim and measures after UAC', async () => {
    expect(
      await run(
        fakeRegistration +
          String.raw`
$script:calls = [Collections.Generic.List[string]]::new()
function Invoke-SentryWsl { param([string[]]$Arguments)
  $script:calls.Add(($Arguments -join '|'))
  return ''
}
function Start-Process { param($FilePath, $Verb, $WindowStyle, [switch]$PassThru, [switch]$Wait, $ArgumentList)
  if ($Verb -ne 'RunAs' -or $WindowStyle -ne 'Hidden' -or -not $Wait) { throw 'Unsafe elevation launch' }
  $index = [Array]::IndexOf($ArgumentList, '-ResultFile')
  $receipt = $ArgumentList[$index + 1].Trim('"')
  [IO.File]::WriteAllText($receipt, '{"ok":true}')
  $script:calls.Add('uac')
  return [pscustomobject]@{ ExitCode = 0 }
}
$result = Invoke-SentryReclaim 'Ubuntu' $disk
$expected = '--list|--running|--quiet;-d|Ubuntu|-u|root|--|sync;-d|Ubuntu|-u|root|--|fstrim|-v|/;uac'
if (($script:calls -join ';') -cne $expected) { throw ('Unexpected WSL argv/order: ' + ($script:calls -join ';')) }
if ($result.diskBytesBefore -ne $result.diskBytesAfter -or $result.windowsFreeBytesAfter -le 0) { throw 'Invalid measurements' }
'guard-trim-uac-measure'
`,
      ),
    ).toBe('guard-trim-uac-measure');
  });

  it('does not terminate WSL or request elevation after a trim failure', async () => {
    expect(
      await run(
        fakeRegistration +
          String.raw`
$script:count = 0
function Invoke-SentryWsl { param([string[]]$Arguments)
  $script:count++
  if ($Arguments -contains 'fstrim') { throw 'fstrim failed' }
  if ($script:count -gt 3) { throw 'WSL shutdown should not happen' }
  return ''
}
function Start-Process { throw 'UAC should not happen' }
$refused = $false
try { $null = Invoke-SentryReclaim 'Ubuntu' $disk } catch {
  if ($_.Exception.Message -notmatch 'fstrim failed') { throw }
  $refused = $true
}
if (-not $refused -or $script:count -ne 3) { throw 'Trim error ignored' }
'trim-failure-refused'
`,
      ),
    ).toBe('trim-failure-refused');
  });

  it('shuts down the VM only after rechecking other distributions and never polls WSL afterward', async () => {
    expect(
      await run(
        fakeRegistration +
          String.raw`
$script:calls = [Collections.Generic.List[string]]::new()
function Invoke-SentryWsl { param([string[]]$Arguments)
  $script:calls.Add(($Arguments -join '|'))
  if ($Arguments[0] -eq '--list') { return 'Ubuntu' }
  if ($Arguments[0] -ne '--shutdown') { throw 'Unexpected WSL command' }
  return ''
}
Stop-SentryWslForCompaction 'Ubuntu'
if (($script:calls -join ';') -cne '--list|--running|--quiet;--shutdown') { throw 'Incorrect shutdown ordering' }
'vm-shutdown-no-wsl-repoll'
`,
      ),
    ).toBe('vm-shutdown-no-wsl-repoll');
  });

  it('refuses shutdown if another distro started while UAC was pending', async () => {
    expect(
      await run(
        fakeRegistration +
          String.raw`
function Invoke-SentryWsl { param([string[]]$Arguments)
  if ($Arguments[0] -eq '--list') { return 'docker-desktop' }
  throw 'Shutdown must not happen'
}
try { Stop-SentryWslForCompaction 'Ubuntu'; throw 'Other distro accepted' } catch {
  if ($_.Exception.Message -notmatch 'Another WSL distribution is running') { throw }
}
'late-distro-refused'
`,
      ),
    ).toBe('late-distro-refused');
  });

  it('times out a persistent sharing lock without reaching native compaction', async () => {
    expect(
      await run(
        fakeRegistration +
          String.raw`
$script:clock = [DateTime]::UtcNow
$script:probes = 0
function Get-SentryTime { return $script:clock }
function Start-Sleep { param($Milliseconds) $script:clock = $script:clock.AddMilliseconds($Milliseconds) }
function Test-SentryDiskAvailable { $script:probes++; return $false }
function Initialize-SentryVirtualDiskApi { throw 'Native must not be reached' }
try { Invoke-SentryNativeCompact -Disk $disk -WaitTimeoutMilliseconds 400; throw 'Lock accepted' } catch {
  if ($_.Exception.Message -notmatch 'still in use after shutdown') { throw }
}
if ($script:probes -ne 3) { throw 'Wait was not bounded by its deadline' }
'persistent-lock-times-out'
`,
      ),
    ).toBe('persistent-lock-times-out');
  });

  it('does not retry a non-sharing I/O error', async () => {
    expect(
      await run(
        fakeRegistration +
          String.raw`
function Start-Sleep { throw 'Non-sharing failure must not be retried' }
try { Wait-SentryDiskAvailable (Join-Path $fixtureRoot 'missing.vhdx'); throw 'Missing disk accepted' } catch {
  if ($_.Exception.GetBaseException() -isnot [IO.FileNotFoundException]) { throw }
}
'non-sharing-error-not-retried'
`,
      ),
    ).toBe('non-sharing-error-not-retried');
  });

  it('does not shut down WSL when UAC is cancelled', async () => {
    expect(
      await run(
        fakeRegistration +
          String.raw`
function Invoke-SentryWsl { param([string[]]$Arguments)
  if ($Arguments[0] -eq '--shutdown' -or $Arguments[0] -eq '--terminate') { throw 'Cancellation must not shut down WSL' }
  return ''
}
function Start-Process { throw [ComponentModel.Win32Exception]::new(1223) }
try { $null = Invoke-SentryReclaim 'Ubuntu' $disk; throw 'Cancellation accepted' } catch {
  if ($_.Exception.Message -notmatch 'approval was cancelled') { throw }
}
'cancel-keeps-wsl-running'
`,
      ),
    ).toBe('cancel-keeps-wsl-running');
  });
});
