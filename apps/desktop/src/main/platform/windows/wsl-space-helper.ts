/** Fixed host helper; no renderer-supplied paths or PowerShell source. */
export const WSL_SPACE_HELPER = String.raw`
param(
  [ValidateSet('Inspect', 'Reclaim', 'Elevated')][string]$Action = 'Inspect',
  [string]$DistroBase64,
  [string]$ExpectedDiskBase64,
  [string]$ExpectedSid,
  [string]$ResultFile,
  [switch]$LibraryOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Decode-SentryValue([string]$Value) {
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
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
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
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
  Assert-SentryOtherDistrosStopped $Distro
  $before = Get-SentryDiskStats $Disk
  $null = Invoke-SentryWsl -Arguments @('-d', $Distro, '-u', 'root', '--', 'sync')
  $null = Invoke-SentryWsl -Arguments @('-d', $Distro, '-u', 'root', '--', 'fstrim', '-v', '/')

  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $receipt = Join-Path (Split-Path -Parent $PSCommandPath) ('result-' + [Guid]::NewGuid().ToString('N') + '.json')
  $diskEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Disk))
  $distroEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Distro))
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  try {
    $child = Start-Process -FilePath $powershell -Verb RunAs -WindowStyle Hidden -PassThru -Wait -ArgumentList @(
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'),
      '-Action', 'Elevated', '-DistroBase64', $distroEncoded, '-ExpectedDiskBase64', $diskEncoded,
      '-ExpectedSid', $sid, '-ResultFile', ('"' + $receipt + '"'))
  } catch {
    if ($_.Exception -is [ComponentModel.Win32Exception] -and $_.Exception.NativeErrorCode -eq 1223) {
      throw 'Administrator approval was cancelled. No disk compaction was performed.'
    }
    throw 'Could not start the Windows administrator helper. No disk compaction was performed.'
  }
  if (-not (Test-Path -LiteralPath $receipt -PathType Leaf)) { throw 'Administrator helper returned no result.' }
  $result = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
  if ($child.ExitCode -ne 0 -or -not $result.ok) { throw $result.message }
  $after = Get-SentryDiskStats $Disk
  return @{
    distro = $Distro; diskBytesBefore = $before.bytes; diskBytesAfter = $after.bytes
    windowsFreeBytesBefore = $before.free; windowsFreeBytesAfter = $after.free
  }
}

if ($LibraryOnly) { return }
try {
  $distro = Decode-SentryValue $DistroBase64
  $disk = Get-SentryDisk $distro
  if ($Action -eq 'Inspect') {
    Assert-SentryOtherDistrosStopped $distro
    $stats = Get-SentryDiskStats $disk
    @{ distro = $distro; diskBytes = $stats.bytes; windowsFreeBytes = $stats.free } | ConvertTo-Json -Compress
  } elseif ($Action -eq 'Reclaim') {
    Invoke-SentryReclaim $distro $disk | ConvertTo-Json -Compress
  } else {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($sid -cne $ExpectedSid -or $disk -cne (Decode-SentryValue $ExpectedDiskBase64)) {
      throw 'Windows user or registered WSL disk changed. Compaction refused.'
    }
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
      throw 'Windows administrator approval is required.'
    }
    Stop-SentryWslForCompaction $distro
    Invoke-SentryNativeCompact $disk
    [IO.File]::WriteAllText($ResultFile, '{"ok":true}', [Text.UTF8Encoding]::new($false))
  }
} catch {
  $message = $_.Exception.Message
  if ($Action -eq 'Elevated' -and -not [string]::IsNullOrWhiteSpace($ResultFile)) {
    [IO.File]::WriteAllText($ResultFile, (@{ ok = $false; message = $message } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
  } else { [Console]::Error.WriteLine($message) }
  exit 1
}
`;
