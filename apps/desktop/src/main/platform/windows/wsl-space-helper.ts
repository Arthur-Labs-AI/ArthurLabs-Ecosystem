/** Fixed host helper; no renderer-supplied paths or PowerShell source. */
export const WSL_SPACE_HELPER = String.raw`
param(
  [ValidateSet('Inspect', 'Reclaim', 'Elevated')][string]$Action = 'Inspect',
  [string]$DistroBase64,
  [string]$ExpectedDiskBase64,
  [string]$ExpectedSid,
  [string]$MaintenanceRootBase64,
  [string]$OperationId,
  [string]$ReceiptKeyBase64,
  [string]$TrustedPayload,
  [switch]$LibraryOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$script:operationDirectory = $null

function Decode-SentryValue([string]$Value) {
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}


function Get-SentrySid { return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }

function Assert-SentryPath([string]$Path, [switch]$Private) {
  $full = [IO.Path]::GetFullPath($Path)
  if ($full -notmatch '^[A-Za-z]:\\' -or $full -match '[\x00-\x1f"]') { throw 'Unsupported maintenance path.' }
  $sid = Get-SentrySid
  $trusted = @($sid, 'S-1-5-18', 'S-1-5-32-544')
  $owners = $trusted + @(([Security.Principal.NTAccount]::new('NT SERVICE', 'TrustedInstaller')).Translate([Security.Principal.SecurityIdentifier]).Value)
  $item = Get-Item -LiteralPath $full -Force
  if (-not $item.PSIsContainer) { throw 'Maintenance path is not a directory.' }
  $first = $true
  while ($null -ne $item) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Maintenance reparse paths are not supported.' }
    $acl = [IO.Directory]::GetAccessControl($item.FullName)
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -notin $owners -or ($Private -and $first -and $owner -cne $sid)) { throw 'Unsafe maintenance directory ownership.' }
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    if ($null -eq $raw.DiscretionaryAcl) { throw 'Maintenance directory has no restrictive DACL.' }
    if ($Private -and $first -and -not $acl.AreAccessRulesProtected) { throw 'Operation directory must not inherit permissions.' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -ne 'Allow' -or (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0)) { continue }
      if ($rule.IdentityReference.Value -in $trusted) { continue }
      $unsafe = 0x10000000 -bor 0x40000000 -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
      if (($Private -and $first) -or (($rule.FileSystemRights -band $unsafe) -ne 0)) { throw 'Maintenance path is writable or replaceable by another account.' }
    }
    $first = $false
    $item = $item.Parent
  }
  return $full
}

function New-SentryPrivateDirectory([string]$Path) {
  $security = [Security.AccessControl.DirectorySecurity]::new()
  $security.SetAccessRuleProtection($true, $false)
  $sid = [Security.Principal.SecurityIdentifier]::new((Get-SentrySid))
  $security.SetOwner($sid)
  foreach ($identity in @($sid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
    $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  }
  $null = [IO.Directory]::CreateDirectory($Path, $security)
  $null = Assert-SentryPath -Path $Path -Private
}

function Get-SentryOperationPath {
  if ($OperationId -cnotmatch '^[a-f0-9]{32}$' -or ([Convert]::FromBase64String($ReceiptKeyBase64)).Length -ne 32) { throw 'Invalid maintenance operation identity.' }
  $root = [IO.Path]::GetFullPath((Decode-SentryValue $MaintenanceRootBase64))
  if ($root -notmatch '^[A-Za-z]:\\' -or $root -match '[\x00-\x1f"]') { throw 'Unsupported maintenance root.' }
  return (Join-Path $root ('reclaim-' + $OperationId))
}

function New-SentryOperation {
  $operation = Get-SentryOperationPath
  $root = Split-Path -Parent $operation
  $missing = [Collections.Generic.List[string]]::new()
  $ancestor = $root
  while (-not (Test-Path -LiteralPath $ancestor)) {
    $missing.Add($ancestor)
    $ancestor = Split-Path -Parent $ancestor
    if ([string]::IsNullOrWhiteSpace($ancestor)) { throw 'Maintenance parent not found.' }
  }
  $null = Assert-SentryPath $ancestor
  for ($i = $missing.Count - 1; $i -ge 0; $i--) { New-SentryPrivateDirectory $missing[$i] }
  $null = Assert-SentryPath $root
  if (Test-Path -LiteralPath $operation) { throw 'Maintenance operation already exists; refusing reuse.' }
  New-SentryPrivateDirectory $operation
  $script:operationDirectory = $operation
  return $operation
}

function Assert-SentryOperation([string]$Directory) {
  if ($Directory -cne (Get-SentryOperationPath)) { throw 'Maintenance operation path mismatch.' }
  $null = Assert-SentryPath -Path $Directory -Private
}

function Assert-SentryReceiptAbsent([string]$Directory) {
  Assert-SentryOperation $Directory
  foreach ($name in @('result.json', 'result.tmp')) {
    if (Test-Path -LiteralPath (Join-Path $Directory $name)) { throw 'Maintenance result already exists; refusing overwrite.' }
  }
}

function Get-SentryReceiptMac($Receipt) {
  $fields = @('1', $Receipt.operationId, $Receipt.sid, $Receipt.distro, $Receipt.disk, $Receipt.outcome, [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Receipt.message)))
  $hmac = [Security.Cryptography.HMACSHA256]::new([Convert]::FromBase64String($ReceiptKeyBase64))
  try { return ([BitConverter]::ToString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes(($fields -join [char]10))))).Replace('-', '').ToLowerInvariant() }
  finally { $hmac.Dispose() }
}

function Write-SentryReceipt([string]$Directory, [string]$Distro, [string]$Disk, [ValidateSet('completed','failed')][string]$Outcome, [string]$Message) {
  Assert-SentryReceiptAbsent $Directory
  if ($Message.Length -gt 1000) { $Message = $Message.Substring(0, 1000) }
  $receipt = [ordered]@{ version = 1; operationId = $OperationId; sid = (Get-SentrySid); distro = $Distro; disk = $Disk; outcome = $Outcome; message = $Message }
  $receipt.mac = Get-SentryReceiptMac $receipt
  $temporary = Join-Path $Directory 'result.tmp'
  $destination = Join-Path $Directory 'result.json'
  $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($receipt | ConvertTo-Json -Compress))
    $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true)
  } finally { $stream.Dispose() }
  # Same-directory atomic rename, never replace an existing destination.
  [IO.File]::Move($temporary, $destination)
}

function Read-SentryReceipt([string]$Directory, [string]$Distro, [string]$Disk, [string]$Sid) {
  Assert-SentryOperation $Directory
  $file = Get-Item -LiteralPath (Join-Path $Directory 'result.json') -Force
  if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $file.Length -gt 16000) { throw 'Invalid maintenance receipt file.' }
  $receipt = [IO.File]::ReadAllText($file.FullName) | ConvertFrom-Json
  $names = @($receipt.PSObject.Properties.Name | Sort-Object) -join ','
  if ($names -cne 'disk,distro,mac,message,operationId,outcome,sid,version' -or ($receipt.version -isnot [int] -and $receipt.version -isnot [long]) -or $receipt.version -ne 1) { throw 'Invalid maintenance receipt schema.' }
  foreach ($name in @('operationId','sid','distro','disk','outcome','message','mac')) { if ($receipt.$name -isnot [string]) { throw 'Invalid maintenance receipt type.' } }
  if ($receipt.operationId -cne $OperationId -or $receipt.sid -cne $Sid -or $receipt.distro -cne $Distro -or $receipt.disk -cne $Disk -or $receipt.outcome -cnotin @('completed','failed') -or $receipt.message.Length -gt 1000 -or $receipt.mac -cnotmatch '^[a-f0-9]{64}$') { throw 'Maintenance receipt identity mismatch.' }
  $expected = Get-SentryReceiptMac $receipt
  $difference = 0
  for ($i = 0; $i -lt 64; $i++) { $difference = $difference -bor ([int][char]$receipt.mac[$i] -bxor [int][char]$expected[$i]) }
  if ($difference -ne 0) { throw 'Maintenance receipt authentication failed.' }
  return $receipt
}

function New-SentryElevatedCommand([string]$Distro, [string]$Disk, [string]$Sid) {
  if ($TrustedPayload -cnotmatch '^[A-Za-z0-9+/=]+$') { throw 'Trusted helper payload unavailable.' }
  $bootstrap = @'
$PSModuleAutoLoadingPreference='None'
foreach ($module in @('Microsoft.PowerShell.Management','Microsoft.PowerShell.Utility')) {
  Import-Module ([IO.Path]::Combine($PSHOME,'Modules',$module,($module+'.psd1'))) -ErrorAction Stop
}
$p='__PAYLOAD__'
$m=[IO.MemoryStream]::new([Convert]::FromBase64String($p))
$g=[IO.Compression.GZipStream]::new($m,[IO.Compression.CompressionMode]::Decompress)
$r=[IO.StreamReader]::new($g,[Text.Encoding]::UTF8)
try { $s=$r.ReadToEnd() } finally { $r.Dispose(); $g.Dispose(); $m.Dispose() }
& ([ScriptBlock]::Create($s)) -Action Elevated -TrustedPayload $p -DistroBase64 '__DISTRO__' -ExpectedDiskBase64 '__DISK__' -ExpectedSid '__SID__' -MaintenanceRootBase64 '__ROOT__' -OperationId '__ID__' -ReceiptKeyBase64 '__KEY__'
'@
  $bootstrap = $bootstrap.Replace('__PAYLOAD__', $TrustedPayload).Replace('__DISTRO__', [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Distro))).Replace('__DISK__', [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Disk))).Replace('__SID__', $Sid).Replace('__ROOT__', $MaintenanceRootBase64).Replace('__ID__', $OperationId).Replace('__KEY__', $ReceiptKeyBase64)
  $command = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($bootstrap))
  if ($command.Length -gt 29000) { throw 'Maintenance command exceeds the Windows argument limit.' }
  return $command
}

function Get-SentryDisk([string]$Distro) {
  if ([string]::IsNullOrWhiteSpace($Distro) -or $Distro.Length -gt 200 -or $Distro -match '[\x00-\x1f]') {
    throw 'Invalid WSL distribution.'
  }
  $matches = @(Get-ChildItem -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' |
    ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } |
    Where-Object { $_.DistributionName -ceq $Distro })
  if ($matches.Count -ne 1 -or $matches[0].Version -ne 2) {
    throw 'The selected distribution must have exactly one WSL2 registration.'
  }
  $registration = $matches[0]
  $basePath = [IO.Path]::GetFullPath($registration.BasePath)
  $fileName = 'ext4.vhdx'
  if ($registration.PSObject.Properties['VhdFileName']) { $fileName = $registration.VhdFileName }
  if ($fileName -cne 'ext4.vhdx' -or $basePath -notmatch '^[A-Za-z]:\\' -or $basePath -match '["\r\n]') {
    throw 'Unsupported WSL disk location. Only a local registered ext4.vhdx is supported.'
  }
  $disk = Get-Item -LiteralPath (Join-Path $basePath $fileName)
  if ($disk.PSIsContainer) { throw 'The registered disk is not a file.' }
  $ancestor = $disk
  while ($null -ne $ancestor) {
    if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'WSL disk paths through reparse points are not supported.'
    }
    if ($ancestor -is [IO.FileInfo]) { $ancestor = $ancestor.Directory } else { $ancestor = $ancestor.Parent }
  }
  return $disk.FullName
}

function Get-SentryDiskStats([string]$Disk) {
  Initialize-SentryVirtualDiskApi
  return @{
    bytes = [long][SentryVirtualDisk]::AllocatedBytes($Disk)
    free = [long]([IO.DriveInfo]::new([IO.Path]::GetPathRoot($Disk))).AvailableFreeSpace
  }
}

function Invoke-SentryWsl([string[]]$Arguments) {
  $wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
  $output = & $wsl @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw 'WSL maintenance command failed; no disk compaction was attempted.' }
  return ($output -join [Environment]::NewLine).Replace([string][char]0, '')
}

function Initialize-SentryVirtualDiskApi {
  if ('SentryVirtualDisk' -as [type]) { return }
  if ($null -eq $script:operationDirectory) { $null = New-SentryOperation }
  Assert-SentryOperation $script:operationDirectory
  $compiler = [CodeDom.Compiler.CompilerParameters]::new()
  $compiler.GenerateInMemory = $true
  $compiler.TempFiles = [CodeDom.Compiler.TempFileCollection]::new($script:operationDirectory, $false)
  $null = $compiler.ReferencedAssemblies.Add([ComponentModel.Win32Exception].Assembly.Location)
  Add-Type -CompilerParameters $compiler -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
public static class SentryVirtualDisk {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern uint GetCompressedFileSizeW(string path, out uint high);
  public static ulong AllocatedBytes(string path) {
    uint high;
    uint low = GetCompressedFileSizeW(path, out high);
    if (low == 0xffffffff) {
      int status = Marshal.GetLastWin32Error();
      if (status != 0) throw new System.ComponentModel.Win32Exception(status);
    }
    return ((ulong)high << 32) | low;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct StorageType { public uint DeviceId; public Guid VendorId; }
  [StructLayout(LayoutKind.Sequential)]
  public struct OpenParameters { public uint Version; public uint RWDepth; }
  [DllImport("virtdisk.dll", CharSet = CharSet.Unicode)]
  public static extern uint OpenVirtualDisk(ref StorageType type, string path,
    uint access, uint flags, ref OpenParameters parameters, out SafeFileHandle handle);
  [DllImport("virtdisk.dll")]
  public static extern uint CompactVirtualDisk(SafeFileHandle handle, uint flags,
    IntPtr parameters, IntPtr overlapped);
  public static uint Compact(string path) {
    var type = new StorageType { DeviceId = 3,
      VendorId = new Guid("EC984AEC-A0F9-47E9-901F-71415A66345B") };
    var parameters = new OpenParameters { Version = 1, RWDepth = 1 };
    SafeFileHandle handle;
    uint status = OpenVirtualDisk(ref type, path, 0x00200000, 0, ref parameters, out handle);
    if (status != 0) return status;
    using (handle) { return CompactVirtualDisk(handle, 0, IntPtr.Zero, IntPtr.Zero); }
  }
}
'@
}

function Test-SentryDiskAvailable([string]$Disk) {
  try {
    $exclusive = [IO.File]::Open($Disk, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $exclusive.Dispose()
    return $true
  } catch {
    $cause = $_.Exception.GetBaseException()
    if ($cause -is [IO.IOException] -and (($cause.HResult -band 0xffff) -in @(32, 33))) { return $false }
    throw
  }
}

function Get-SentryTime { return [DateTime]::UtcNow }

function Wait-SentryDiskAvailable([string]$Disk, [int]$TimeoutMilliseconds = 30000) {
  $deadline = (Get-SentryTime).AddMilliseconds($TimeoutMilliseconds)
  while (-not (Test-SentryDiskAvailable $Disk)) {
    if ((Get-SentryTime) -ge $deadline) {
      throw 'WSL disk is still in use after shutdown. Close Docker, WSL terminals, and applications that automatically restart WSL, then retry. No disk compaction was performed.'
    }
    Start-Sleep -Milliseconds 200
  }
}

function Invoke-SentryNativeCompact([string]$Disk, [int]$WaitTimeoutMilliseconds = 30000) {
  # A stopped distro does not prove the VM released its VHD. Never force-detach it.
  Wait-SentryDiskAvailable -Disk $Disk -TimeoutMilliseconds $WaitTimeoutMilliseconds
  Initialize-SentryVirtualDiskApi
  $status = [SentryVirtualDisk]::Compact($Disk)
  if ($status -ne 0) {
    throw ('Windows disk compaction failed (error ' + $status + '). Close applications using this distribution and retry.')
  }
}

function Assert-SentryOtherDistrosStopped([string]$Distro) {
  $running = @((Invoke-SentryWsl -Arguments @('--list', '--running', '--quiet')) -split '\r?\n' |
    ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })
  $others = @($running | Where-Object { $_ -cne $Distro })
  if ($others.Count -gt 0) {
    throw ('Another WSL distribution is running: ' + ($others -join ', ') + '. Stop it and close Docker or other WSL applications before reclaiming disk space.')
  }
}

function Stop-SentryWslForCompaction([string]$Distro) {
  # Recheck after UAC: another distribution may have started while awaiting consent.
  Assert-SentryOtherDistrosStopped $Distro
  $null = Invoke-SentryWsl -Arguments @('--shutdown')
  # Do not invoke WSL again before compaction. Only native file availability is polled.
}

function Invoke-SentryReclaim([string]$Distro, [string]$Disk) {
  $directory = New-SentryOperation
  Assert-SentryReceiptAbsent $directory
  Assert-SentryOtherDistrosStopped $Distro
  $before = Get-SentryDiskStats $Disk
  $null = Invoke-SentryWsl -Arguments @('-d', $Distro, '-u', 'root', '--', 'sync')
  $null = Invoke-SentryWsl -Arguments @('-d', $Distro, '-u', 'root', '--', 'fstrim', '-v', '/')
  $sid = Get-SentrySid
  $command = New-SentryElevatedCommand $Distro $Disk $sid
  Assert-SentryReceiptAbsent $directory
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  try {
    $child = Start-Process -FilePath $powershell -Verb RunAs -WindowStyle Hidden -PassThru -Wait -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $command)
  } catch {
    if ($_.Exception -is [ComponentModel.Win32Exception] -and $_.Exception.NativeErrorCode -eq 1223) { throw 'Administrator approval was cancelled. No disk compaction was performed.' }
    throw 'Could not start the Windows administrator helper. No disk compaction was performed.'
  }
  $receipt = Read-SentryReceipt -Directory $directory -Distro $Distro -Disk $Disk -Sid $sid
  if ($child.ExitCode -ne 0 -or $receipt.outcome -cne 'completed') { throw $receipt.message }
  $after = Get-SentryDiskStats $Disk
  return @{ distro = $Distro; diskBytesBefore = $before.bytes; diskBytesAfter = $after.bytes; windowsFreeBytesBefore = $before.free; windowsFreeBytesAfter = $after.free; receipt = $receipt }
}

if ($LibraryOnly) { return }
$script:receiptDirectory = $null
try {
  $distro = Decode-SentryValue $DistroBase64
  if ($Action -eq 'Elevated' -and (Get-SentrySid) -cne $ExpectedSid) { throw 'Windows user or registered WSL disk changed. Compaction refused.' }
  $disk = Get-SentryDisk $distro
  if ($Action -eq 'Inspect') {
    $null = New-SentryOperation
    Assert-SentryOtherDistrosStopped $distro
    $stats = Get-SentryDiskStats $disk
    @{ distro = $distro; diskBytes = $stats.bytes; windowsFreeBytes = $stats.free } | ConvertTo-Json -Compress
  } elseif ($Action -eq 'Reclaim') {
    Invoke-SentryReclaim $distro $disk | ConvertTo-Json -Compress -Depth 4
  } else {
    if ($disk -cne (Decode-SentryValue $ExpectedDiskBase64)) { throw 'Windows user or registered WSL disk changed. Compaction refused.' }
    $directory = Get-SentryOperationPath
    Assert-SentryReceiptAbsent $directory
    $script:receiptDirectory = $directory
    $script:operationDirectory = $directory
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Windows administrator approval is required.' }
    Stop-SentryWslForCompaction $distro
    Invoke-SentryNativeCompact $disk
    Write-SentryReceipt -Directory $directory -Distro $distro -Disk $disk -Outcome 'completed' -Message ''
  }
} catch {
  $message = $_.Exception.Message
  if ($Action -eq 'Elevated' -and $null -ne $script:receiptDirectory) {
    try { Write-SentryReceipt -Directory $script:receiptDirectory -Distro $distro -Disk $disk -Outcome 'failed' -Message $message }
    catch { [Console]::Error.WriteLine('Could not create a fresh authenticated maintenance receipt.') }
  } else { [Console]::Error.WriteLine($message) }
  exit 1
}
`;
