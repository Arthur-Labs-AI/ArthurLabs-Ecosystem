# SentryLauncher.psm1 — core: identity, logging, state, shim/PATH, native exec.
# No secrets are ever requested or stored here. Provider credentials live in
# Desktop Settings (Electron safeStorage / DPAPI) only.
$ErrorActionPreference = 'Stop'

$script:SentryProductVersion = '0.1.0-beta.1'
$script:SentryReleaseTitle = 'Sentry v0.1 Beta'
$script:SentryRequiredNodeMajor = 22
$script:SentryRebootExitCode = 75

# Cross-boundary constants MUST be exposed as functions: dot-sourced scripts
# (prerequisites/wsl-setup/commands) run in the CALLER's scope, where the
# module's $script: variables are invisible (they silently read as $null).
function Get-SentryRequiredNodeMajor { return $script:SentryRequiredNodeMajor }
function Get-SentryRebootExitCode { return $script:SentryRebootExitCode }
function Get-SentryReleaseTitle { return $script:SentryReleaseTitle }

function Get-SentryRepoRoot {
  $here = $PSScriptRoot
  if ([string]::IsNullOrEmpty($here)) { $here = (Get-Location).Path }
  # This module lives at <repo>/scripts/launcher/SentryLauncher.psm1.
  if ((Split-Path $here -Leaf) -eq 'launcher') { return (Resolve-Path (Join-Path $here '..\..')).Path }
  return (Resolve-Path $here).Path
}

function Get-SentryProductVersion {
  param([string]$RepoRoot)
  try {
    $pkg = Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json
    if ($pkg.version) { return [string]$pkg.version }
  } catch { }
  return $script:SentryProductVersion
}

function Get-SentryShortSha {
  param([string]$RepoRoot)
  try {
    $out = & git -C $RepoRoot rev-parse --short HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and $out) { return ([string]$out).Trim() }
  } catch { }
  return 'unknown'
}

function Get-SentryPinnedPnpmVersion {
  param([string]$RepoRoot)
  try {
    $pkg = Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json
    $pm = [string]$pkg.packageManager
    if ($pm -match 'pnpm@(\d+\.\d+\.\d+)') { return $Matches[1] }
  } catch { }
  return '9.12.3'
}

function Write-SentryLine { param([string]$Text, [string]$Color = '') if ($Color) { Write-Host $Text -ForegroundColor $Color } else { Write-Host $Text } }
function Write-SentryOk { param([string]$Text) Write-Host ('  [OK] ' + $Text) -ForegroundColor Green }
function Write-SentryWarn { param([string]$Text) Write-Host ('  [!] ' + $Text) -ForegroundColor Yellow }
function Write-SentryFail { param([string]$Text) Write-Host ('  [X] ' + $Text) -ForegroundColor Red }
function Write-SentryInfo { param([string]$Text) Write-Host ('  ' + $Text) -ForegroundColor Gray }
function Write-SentrySection { param([string]$Text) Write-Host ''; Write-Host $Text -ForegroundColor Cyan }

function Get-SentryQuotedArguments {
  param([string[]]$Arguments)
  $parts = @()
  foreach ($a in $Arguments) {
    if ($a -match '[\s\"]') { $parts += ('"' + ($a -replace '"', '\\"') + '"') }
    else { $parts += $a }
  }
  return ($parts -join ' ')
}

function Resolve-SentryExecutable {
  param([string]$Name)
  $candidates = @()
  $candidates += ($Name + '.cmd')
  $candidates += ($Name + '.exe')
  $candidates += $Name
  foreach ($candidate in $candidates) {
    try { $cmd = Get-Command $candidate -ErrorAction Stop } catch { continue }
    if ($cmd.Source) { return $cmd.Source }
  }
  return $Name
}

function Get-SentryTail {
  param([string]$Text, [int]$MaxChars = 1048576)
  if ([string]::IsNullOrEmpty($Text)) { return '' }
  if ($Text.Length -le $MaxChars) { return $Text }
  return ('[...truncated to last ' + $MaxChars + ' chars...]' + "`n" + $Text.Substring($Text.Length - $MaxChars))
}

function Invoke-SentryNative {
  param([string]$FilePath, [string[]]$Arguments = @(), [string]$Workdir = '', [int]$TimeoutSec = 0, [bool]$NoRedirect = $false, [bool]$NoTruncate = $false)
  $resolved = $FilePath
  if ($FilePath -notmatch '[\\/:]') { $resolved = Resolve-SentryExecutable $FilePath }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $resolved
  $psi.Arguments = (Get-SentryQuotedArguments $Arguments)
  # NoRedirect: child inherits the console (no pipes). Use for spawns whose
  # grandchildren may linger (Electron helpers): inherited pipes would keep
  # our own output stream open and block setup completion.
  $psi.RedirectStandardOutput = (-not $NoRedirect)
  $psi.RedirectStandardError = (-not $NoRedirect)
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  if ($Workdir) { $psi.WorkingDirectory = $Workdir }
  $p = [System.Diagnostics.Process]::Start($psi)
  # Drain BOTH redirected streams concurrently from process start: a child
  # that fills an OS pipe would otherwise deadlock against WaitForExit.
  # ReadToEndAsync + GetResult are available on .NET Framework 4.5+,
  # i.e. Windows PowerShell 5.1 (Kill() is the Framework-compatible
  # parameterless overload; Kill($true) needs .NET Core and is avoided).
  $stdoutTask = $null
  $stderrTask = $null
  if (-not $NoRedirect) {
    $stdoutTask = $p.StandardOutput.ReadToEndAsync()
    $stderrTask = $p.StandardError.ReadToEndAsync()
  }
  $timedOut = $false
  if ($TimeoutSec -gt 0) {
    if (-not $p.WaitForExit($TimeoutSec * 1000)) {
      $timedOut = $true
      try { $p.Kill() } catch { }
      try { [void]$p.WaitForExit(10000) } catch { }
    }
  } else {
    $p.WaitForExit()
  }
  $stdout = ''
  $stderr = ''
  if (-not $NoRedirect) {
    # After exit (or kill + bounded wait) the streams normally close and the
    # pending reads complete within milliseconds. A foreign lingering
    # grandchild can hold a pipe open; bound that wait, then abandon the
    # reads rather than blocking forever.
    $drainDeadline = [DateTime]::UtcNow.AddSeconds(30)
    while (((-not $stdoutTask.IsCompleted) -or (-not $stderrTask.IsCompleted)) -and ([DateTime]::UtcNow -lt $drainDeadline)) {
      Start-Sleep -Milliseconds 50
    }
    if ($stdoutTask.IsCompleted) {
      try { $stdout = [string]$stdoutTask.GetAwaiter().GetResult() } catch { $stdout = '' }
    }
    if ($stderrTask.IsCompleted) {
      try { $stderr = [string]$stderrTask.GetAwaiter().GetResult() } catch { $stderr = '' }
    }
    # NoTruncate: machine-output passthrough (sentry cli --json) must forward
    # every byte; the tail cap would corrupt JSON documents.
    if (-not $NoTruncate) {
      $stdout = Get-SentryTail $stdout
      $stderr = Get-SentryTail $stderr
    }
  }
  if ($timedOut) {
    $note = "`n[sentry] process timed out after " + $TimeoutSec + 's (output above is what was captured before termination)'
    return @{ ExitCode = -1; Stdout = $stdout; Stderr = ($stderr + $note) }
  }
  return @{ ExitCode = $p.ExitCode; Stdout = $stdout; Stderr = $stderr }
}

function Invoke-SentryWslFile {
  param([string]$Distro, [string]$ScriptName, [string[]]$ScriptArgs = @(), [int]$TimeoutSec = 300, [bool]$AsRoot = $false)
  $scriptPath = Join-Path $PSScriptRoot ('linux/' + $ScriptName)
  if (-not (Test-Path $scriptPath)) { return @{ ExitCode = -1; Stdout = ''; Stderr = ('missing launcher script: ' + $ScriptName) } }
  $fwd = ((Resolve-Path $scriptPath).Path -replace '\\', '/')
  $lp = Invoke-SentryNative -FilePath 'wsl.exe' -Arguments @('-d', $Distro, '--', 'wslpath', '-u', $fwd) -TimeoutSec 30
  $linuxPath = ([string]$lp.Stdout).Trim()
  if (-not $linuxPath) { return @{ ExitCode = -1; Stdout = ''; Stderr = 'wslpath failed' } }
  $bashArgs = @()
  $bashArgs += '-d'; $bashArgs += $Distro
  if ($AsRoot) { $bashArgs += '-u'; $bashArgs += 'root' }
  $bashArgs += '--'; $bashArgs += 'bash'; $bashArgs += $linuxPath
  foreach ($a in $ScriptArgs) { $bashArgs += $a }
  return Invoke-SentryNative -FilePath 'wsl.exe' -Arguments $bashArgs -TimeoutSec $TimeoutSec
}

function Get-SentryLauncherHome {
  $base = $env:LOCALAPPDATA
  if ([string]::IsNullOrEmpty($base)) { $base = (Join-Path $env:USERPROFILE 'AppData/Local') }
  return (Join-Path $base 'Sentry/launcher')
}

function Get-SentryBinDir {
  $base = $env:LOCALAPPDATA
  if ([string]::IsNullOrEmpty($base)) { $base = (Join-Path $env:USERPROFILE 'AppData/Local') }
  return (Join-Path $base 'Sentry/bin')
}

function Get-SentryLauncherConfig {
  $home_ = Get-SentryLauncherHome
  $path = Join-Path $home_ 'config.json'
  if (-not (Test-Path $path)) { return @{} }
  try { $raw = Get-Content $path -Raw | ConvertFrom-Json; $ht = @{}; foreach ($p in $raw.PSObject.Properties) { $ht[$p.Name] = $p.Value }; return $ht }
  catch { return @{} }
}

function Set-SentryLauncherConfig {
  param([hashtable]$Values)
  $home_ = Get-SentryLauncherHome
  [void](New-Item -ItemType Directory -Force -Path $home_)
  $path = Join-Path $home_ 'config.json'
  $current = Get-SentryLauncherConfig
  foreach ($k in $Values.Keys) { $current[$k] = $Values[$k] }
  $current['updatedAt'] = (Get-Date).ToUniversalTime().ToString('o')
  ($current | ConvertTo-Json -Depth 5) | Set-Content -Path $path -Encoding UTF8
}

function Write-SentryLog {
  param([string]$Message, [string]$Kind = 'setup')
  try {
    $home_ = Get-SentryLauncherHome
    $dir = Join-Path $home_ 'logs'
    [void](New-Item -ItemType Directory -Force -Path $dir)
    $file = Join-Path $dir ($Kind + '-' + (Get-Date).ToString('yyyyMMdd') + '.log')
    $redacted = Redact-SentrySecrets $Message
    Add-Content -Path $file -Value ((Get-Date).ToString('o') + ' ' + $redacted) -Encoding UTF8
  } catch { }
}

function Redact-SentrySecrets {
  param([string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return $Text }
  $out = $Text
  $patterns = @(
    '(?i)(api[_-]?key\s*[:=]\s*)([^\s''"]+)',
    '(?i)(token\s*[:=]\s*)([^\s''"]+)',
    '(?i)(authorization\s*:\s*Bearer\s+)([^\s]+)',
    '(?i)((?:OPENROUTER_API_KEY|OPENCODE_API_KEY|DEEPSEEK_API_KEY|ANTHROPIC_AUTH_TOKEN)\s*=\s*)([^\s''"]+)'
  )
  foreach ($p in $patterns) { $out = $out -replace $p, '$1***' }
  return $out
}

function Install-SentryShim {
  param([string]$RepoRoot)
  $binDir = Get-SentryBinDir
  [void](New-Item -ItemType Directory -Force -Path $binDir)
  $target = Join-Path $RepoRoot 'sentry.ps1'
  $shim = Join-Path $binDir 'sentry.cmd'
  $content = '@echo off' + [Environment]::NewLine + 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $target + '" %*'
  $existing = ''
  if (Test-Path $shim) { $existing = (Get-Content $shim -Raw) }
  if ($existing -ne $content) { $content | Set-Content -Path $shim -Encoding ASCII }
  Add-SentryUserPath $binDir
  Set-SentryLauncherConfig @{ repoPath = $RepoRoot }
  Write-SentryLog ('shim installed: ' + $shim + ' -> ' + $target) 'launcher'
}

function Test-SentryPathEntry {
  param([string]$PathText, [string]$Dir)
  $parts = ([string]$PathText) -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
  foreach ($p in $parts) { if ($p.TrimEnd('\') -ieq $Dir.TrimEnd('\')) { return $true } }
  return $false
}

function Add-SentryUserPath {
  param([string]$Dir)
  $regPath = 'HKCU:\Environment'
  $current = ''
  try { $current = (Get-ItemProperty -Path $regPath -Name Path -ErrorAction Stop).Path } catch { }
  if ([string]::IsNullOrEmpty($current)) { $current = $env:PATH }
  $already = Test-SentryPathEntry -PathText $current -Dir $Dir
  if (-not $already) {
    $newPath = ($current.TrimEnd(';') + ';' + $Dir)
    Set-ItemProperty -Path $regPath -Name Path -Value $newPath
    Write-SentryLog 'added launcher bin to USER PATH' 'launcher'
  }
  if (($env:PATH -split ';') -notcontains $Dir) { $env:PATH = ($env:PATH.TrimEnd(';') + ';' + $Dir) }
}

function Test-SentryShim {
  $shim = Join-Path (Get-SentryBinDir) 'sentry.cmd'
  return (Test-Path $shim)
}

Export-ModuleMember -Function *-Sentry*
