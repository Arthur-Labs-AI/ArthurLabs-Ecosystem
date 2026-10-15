import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WSL_SPACE_HELPER } from '../../src/main/platform/windows/wsl-space-helper.js';
import { verifyWslSpaceReceipt } from '../../src/main/platform/windows/wsl-space-command.js';

const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
async function run(body: string) {
  const root = await mkdtemp(join(homedir(), '.sentry-elevation-integrity-'));
  try {
    const helper = join(root, 'helper.ps1');
    const runner = join(root, 'fixture.ps1');
    await writeFile(helper, WSL_SPACE_HELPER);
    await writeFile(
      runner,
      `. ${quote(helper)} -LibraryOnly\n$fixtureRoot = ${quote(root)}\n` + setup + body,
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
    await rm(root, { recursive: true, force: true });
  }
}
const setup = String.raw`
$OperationId = '1234567890abcdef1234567890abcdef'
$ReceiptKeyBase64 = [Convert]::ToBase64String([byte[]](1..32))
$maintenance = Join-Path $fixtureRoot 'maintenance'
$MaintenanceRootBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($maintenance))
$memory = [IO.MemoryStream]::new()
$gzip = [IO.Compression.GZipStream]::new($memory, [IO.Compression.CompressionMode]::Compress, $true)
$sourceBytes = [Text.Encoding]::UTF8.GetBytes((Get-Content -LiteralPath (Join-Path $fixtureRoot 'helper.ps1') -Raw))
$gzip.Write($sourceBytes, 0, $sourceBytes.Length); $gzip.Dispose()
$TrustedPayload = [Convert]::ToBase64String($memory.ToArray()); $memory.Dispose()
$disk = Join-Path $fixtureRoot 'ext4.vhdx'
[IO.File]::WriteAllText($disk, 'not a virtual disk')
$script:osCalls = [Collections.Generic.List[string]]::new()
function Get-SentryDiskStats { param($Disk) return @{ bytes = 10; free = 100 } }
function Invoke-SentryWsl { param([string[]]$Arguments) $script:osCalls.Add(($Arguments -join '|')); return '' }
function Start-Process {
  param($FilePath, $Verb, $WindowStyle, [switch]$PassThru, [switch]$Wait, $ArgumentList)
  $script:launchArgs = $ArgumentList
  $index = [Array]::IndexOf($ArgumentList, '-ResultFile')
  if ($index -ge 0) {
    [IO.File]::WriteAllText($ArgumentList[$index + 1].Trim('"'), '{"ok":true,"operationId":"wrong"}')
  } else {
    Write-SentryReceipt -Directory (Join-Path $maintenance ('reclaim-' + $OperationId)) -Distro 'Ubuntu' -Disk $disk -Outcome 'completed' -Message ''
  }
  return [pscustomobject]@{ ExitCode = 0 }
}
`;
describe.skipIf(process.platform !== 'win32')(
  'WSL elevation integrity (disposable, never elevated)',
  () => {
    it('confines native interop compiler temporary files to the private operation', async () => {
      expect(
        await run(String.raw`
$script:compilerDirectory = ''
function Add-Type { param($TypeDefinition, $CompilerParameters)
  if ($null -ne $CompilerParameters) { $script:compilerDirectory = $CompilerParameters.TempFiles.TempDir }
}
Initialize-SentryVirtualDiskApi
$expected = Join-Path $maintenance ('reclaim-' + $OperationId)
if ($script:compilerDirectory -cne $expected) { throw 'Native compiler used an unvalidated temporary directory' }
'compiler-private'
`),
      ).toBe('compiler-private');
    });
    it('creates a private operation DACL and a signed atomically published receipt accepted by Node', async () => {
      const output = await run(String.raw`
$directory = New-SentryOperation
$acl = [IO.Directory]::GetAccessControl($directory)
if (-not $acl.AreAccessRulesProtected) { throw 'Inherited operation DACL' }
$trusted = @((Get-SentrySid), 'S-1-5-18', 'S-1-5-32-544')
foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if ($rule.IdentityReference.Value -notin $trusted -or $rule.AccessControlType -ne 'Allow') { throw 'Unexpected operation principal' }
}
Write-SentryReceipt -Directory $directory -Distro 'Ubuntu' -Disk $disk -Outcome 'completed' -Message ''
if (Test-Path -LiteralPath (Join-Path $directory 'result.tmp')) { throw 'Temporary receipt not moved' }
$receipt = Read-SentryReceipt -Directory $directory -Distro 'Ubuntu' -Disk $disk -Sid (Get-SentrySid)
$receipt | ConvertTo-Json -Compress
`);
      expect(() =>
        verifyWslSpaceReceipt(
          JSON.parse(output),
          '1234567890abcdef1234567890abcdef',
          'Ubuntu',
          Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)),
        ),
      ).not.toThrow();
    });
    it.each(['result.json', 'result.tmp'])(
      'refuses a pre-existing %s when publishing a receipt',
      async (name) => {
        expect(
          await run(
            String.raw`
$directory = New-SentryOperation
$existing = Join-Path $directory '__NAME__'
[IO.File]::WriteAllText($existing, 'preserve-me')
$refused = $false
try { Write-SentryReceipt -Directory $directory -Distro 'Ubuntu' -Disk $disk -Outcome 'completed' -Message '' } catch { $refused = $true }
if (-not $refused -or [IO.File]::ReadAllText($existing) -cne 'preserve-me') { throw 'Receipt overwrote an existing file' }
'preserved'
`.replace('__NAME__', name),
          ),
        ).toBe('preserved');
      },
    );
    it('rejects operation-root junctions before reaching any OS mutation', async () => {
      expect(
        await run(String.raw`
$target = Join-Path $fixtureRoot 'junction-target'; $null = [IO.Directory]::CreateDirectory($target)
$null = New-Item -ItemType Junction -Path $maintenance -Target $target
$refused = $false
try { $null = Invoke-SentryReclaim 'Ubuntu' $disk } catch { $refused = $true }
if (-not $refused -or $script:osCalls.Count -ne 0) { throw 'Reparse path reached maintenance' }
'junction-refused'
`),
      ).toBe('junction-refused');
    });
    it.each(['sid', 'disk'])(
      'refuses changed elevated %s identity before mutations',
      async (changed) => {
        const dispatcher = WSL_SPACE_HELPER.slice(
          WSL_SPACE_HELPER.indexOf('if ($LibraryOnly) { return }') +
            'if ($LibraryOnly) { return }'.length,
        ).replaceAll('exit 1', 'return');
        expect(
          await run(
            String.raw`
$Action = 'Elevated'; $DistroBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('Ubuntu'))
$ExpectedSid = __SID__; $ExpectedDiskBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($disk))
function Get-SentryDisk { param($Distro) return __DISK__ }
$script:mutated = $false
function Stop-SentryWslForCompaction { $script:mutated = $true; throw 'Unexpected shutdown' }
function Invoke-SentryNativeCompact { $script:mutated = $true; throw 'Unexpected compaction' }
$errors = [IO.StringWriter]::new(); $previous = [Console]::Error; [Console]::SetError($errors)
try { & { __DISPATCH__ } } finally { [Console]::SetError($previous) }
if ($script:mutated -or $errors.ToString() -notmatch 'user or registered WSL disk changed') { throw 'Identity refusal failed' }
'identity-refused'
`
              .replace('__SID__', changed === 'sid' ? "'S-1-5-21-wrong'" : '(Get-SentrySid)')
              .replace(
                '__DISK__',
                changed === 'disk' ? "(Join-Path $fixtureRoot 'different.vhdx')" : '$disk',
              )
              .replace('__DISPATCH__', dispatcher),
          ),
        ).toBe('identity-refused');
      },
    );
    it.each(['Modify', '268435456'])(
      'refuses broadly writable custom-profile ancestry before OS maintenance (%s)',
      async (rights) => {
        expect(
          await run(
            String.raw`
$acl = [IO.Directory]::GetAccessControl($fixtureRoot)
__ACL_RULE__
[IO.Directory]::SetAccessControl($fixtureRoot, $acl)
$refused = $false
try { $null = Invoke-SentryReclaim 'Ubuntu' $disk } catch { $refused = $true }
if (-not $refused -or $script:osCalls.Count -ne 0) { throw 'Broad ancestry reached maintenance' }
'refused'
`.replace(
              '__ACL_RULE__',
              rights === 'Modify'
                ? String.raw`$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))`
                : String.raw`
$raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
$raw.DiscretionaryAcl.InsertAce($raw.DiscretionaryAcl.Count, [Security.AccessControl.CommonAce]::new([Security.AccessControl.AceFlags]::None, [Security.AccessControl.AceQualifier]::AccessAllowed, 268435456, [Security.Principal.SecurityIdentifier]::new('S-1-1-0'), $false, $null))
$binary = [byte[]]::new($raw.BinaryLength); $raw.GetBinaryForm($binary, 0); $acl.SetSecurityDescriptorBinaryForm($binary, [Security.AccessControl.AccessControlSections]::Access)
`,
            ),
          ),
        ).toBe('refused');
      },
    );
    it('does not reload a substituted helper file at the elevation boundary', async () => {
      expect(
        await run(String.raw`
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'helper.ps1'), '# substituted; must never execute')
$null = Invoke-SentryReclaim 'Ubuntu' $disk
if ($script:launchArgs -contains '-File' -or $script:launchArgs -notcontains '-EncodedCommand') { throw 'Writable script selected for UAC' }
$index = [Array]::IndexOf($script:launchArgs, '-EncodedCommand')
$code = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($script:launchArgs[$index + 1]))
if ($code -notmatch [Regex]::Escape($TrustedPayload)) { throw 'Trusted in-memory payload not used' }
'inline-trusted-code'
`),
      ).toBe('inline-trusted-code');
    });
    it('does not overwrite an external caller-supplied result destination on refusal', async () => {
      const dispatcher = WSL_SPACE_HELPER.slice(
        WSL_SPACE_HELPER.indexOf('if ($LibraryOnly) { return }') +
          'if ($LibraryOnly) { return }'.length,
      );
      // Invoke unchanged dispatch in a child runspace so its exit does not stop the assertion.
      expect(
        await run(
          String.raw`
$external = Join-Path $fixtureRoot 'unrelated.txt'
[IO.File]::WriteAllText($external, 'preserve-me')
$Action = 'Elevated'; $DistroBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('Ubuntu'))
$ExpectedSid = 'S-1-5-21-wrong'; $ExpectedDiskBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($disk)); $ResultFile = $external
function Get-SentryDisk { param($Distro) return $disk }
function Stop-SentryWslForCompaction { throw 'OS mutation forbidden' }
function Invoke-SentryNativeCompact { throw 'OS mutation forbidden' }
` +
            `& { ${dispatcher.replaceAll('exit 1', 'return')} } 2>$null
if ([IO.File]::ReadAllText($external) -cne 'preserve-me') { throw 'External result overwritten' }
'external-preserved'
`,
        ),
      ).toBe('external-preserved');
    });
    it('refuses a pre-existing operation/result without overwriting or mutating WSL', async () => {
      expect(
        await run(String.raw`
$operation = Join-Path $maintenance ('reclaim-' + $OperationId)
$null = [IO.Directory]::CreateDirectory($operation)
$result = Join-Path $operation 'result.json'
[IO.File]::WriteAllText($result, 'preserve-me')
$refused = $false
try { $null = Invoke-SentryReclaim 'Ubuntu' $disk } catch { $refused = $true }
if (-not $refused -or $script:osCalls.Count -ne 0 -or [IO.File]::ReadAllText($result) -cne 'preserve-me') { throw 'Existing operation/result accepted' }
'existing-preserved'
`),
      ).toBe('existing-preserved');
    });
    it('rejects a tampered operation receipt even when the child reports success', async () => {
      expect(
        await run(String.raw`
function Start-Process {
  param($FilePath, $Verb, $WindowStyle, [switch]$PassThru, [switch]$Wait, $ArgumentList)
  $index = [Array]::IndexOf($ArgumentList, '-ResultFile')
  if ($index -ge 0) { $receipt = $ArgumentList[$index + 1].Trim('"') } else { $receipt = Join-Path (Join-Path $maintenance ('reclaim-' + $OperationId)) 'result.json' }
  [IO.File]::WriteAllText($receipt, '{"ok":true,"version":1,"operationId":"wrong","outcome":"completed","mac":"0000000000000000000000000000000000000000000000000000000000000000"}')
  return [pscustomobject]@{ ExitCode = 0 }
}
$refused = $false
try { $null = Invoke-SentryReclaim 'Ubuntu' $disk } catch { $refused = $true }
if (-not $refused) { throw 'Tampered success receipt accepted' }
'tampered-refused'
`),
      ).toBe('tampered-refused');
    });
  },
);
