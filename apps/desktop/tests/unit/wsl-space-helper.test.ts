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

  it('resolves exactly the selected WSL2 registration, independent of shell-like text', async () => {
    expect(
      await run(
        fakeRegistration +
          String.raw`
if ((Get-SentryDisk 'Ubuntu') -cne $disk) { throw 'Wrong disk' }
foreach ($name in @('ubuntu', 'Ubuntu; Remove-Item C:', ("Ubuntu" + [char]10))) {
  $refused = $false
  try { $null = Get-SentryDisk $name } catch { $refused = $true }
  if (-not $refused) { throw 'Unsafe or unknown distro accepted' }
}
'registration-validated'
`,
      ),
    ).toBe('registration-validated');
  });

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
  try { Invoke-SentryNativeCompact $disk } catch {
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

  it('passes full WSL argv, trims before terminating only the selected distro and measures after UAC', async () => {
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
$expected = '-d|Ubuntu|-u|root|--|sync;-d|Ubuntu|-u|root|--|fstrim|-v|/;--terminate|Ubuntu;--list|--running|--quiet;uac'
if (($script:calls -join ';') -cne $expected) { throw ('Unexpected WSL argv/order: ' + ($script:calls -join ';')) }
if ($result.diskBytesBefore -ne $result.diskBytesAfter -or $result.windowsFreeBytesAfter -le 0) { throw 'Invalid measurements' }
'trim-terminate-uac-measure'
`,
      ),
    ).toBe('trim-terminate-uac-measure');
  });

  it('does not terminate WSL or request elevation after a trim failure', async () => {
    expect(
      await run(
        fakeRegistration +
          String.raw`
$script:count = 0
function Invoke-SentryWsl { param([string[]]$Arguments)
  $script:count++
  if ($script:count -eq 2) { throw 'fstrim failed' }
  if ($script:count -gt 2) { throw 'WSL termination should not happen' }
  return ''
}
function Start-Process { throw 'UAC should not happen' }
$refused = $false
try { $null = Invoke-SentryReclaim 'Ubuntu' $disk } catch {
  if ($_.Exception.Message -notmatch 'fstrim failed') { throw }
  $refused = $true
}
if (-not $refused -or $script:count -ne 2) { throw 'Trim error ignored' }
'trim-failure-refused'
`,
      ),
    ).toBe('trim-failure-refused');
  });
});
