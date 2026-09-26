# SentryLauncher.psm1 — core: identity, logging, state, shim/PATH, native exec.
# No secrets are ever requested or stored here. Provider credentials live in
# Desktop Settings (Electron safeStorage / DPAPI) only.
$ErrorActionPreference = 'Stop'

$script:SentryProductVersion = '0.1.0-beta.1'
$script:SentryReleaseTitle = 'Sentry v0.1 Beta'
$script:SentryRequiredNodeMajor = 22
$script:SentryRebootExitCode = 75

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

function Invoke-SentryNative {
  param([string]$FilePath, [string[]]$Arguments = @(), [string]$Workdir = '', [int]$TimeoutSec = 0)
  $resolved = $FilePath
  if ($FilePath -notmatch '[\\/:]') { $resolved = Resolve-SentryExecutable $FilePath }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $resolved
  $psi.Arguments = (Get-SentryQuotedArguments $Arguments)
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  if ($Workdir) { $psi.WorkingDirectory = $Workdir }
  $p = [System.Diagnostics.Process]::Start($psi)
  if ($TimeoutSec -gt 0) {
    if (-not $p.WaitForExit($TimeoutSec * 1000)) {
      try { $p.Kill() } catch { }
      return @{ ExitCode = -1; Stdout = ''; Stderr = 'timed out' }
    }
  }
  $stdout = $p.StandardOutput.ReadToEnd()
  $stderr = $p.StandardError.ReadToEnd()
  if ($TimeoutSec -le 0) { $p.WaitForExit() }
  return @{ ExitCode = $p.ExitCode; Stdout = $stdout; Stderr = $stderr }
}

function Invoke-SentryWslFile {
  param([string]$Distro, [string]$ScriptName, [string[]]$ScriptArgs = @(), [int]$TimeoutSec = 300)
  $scriptPath = Join-Path $PSScriptRoot ('linux/' + $ScriptName)
  if (-not (Test-Path $scriptPath)) { return @{ ExitCode = -1; Stdout = ''; Stderr = ('missing launcher script: ' + $ScriptName) } }
  $fwd = ((Resolve-Path $scriptPath).Path -replace '\\', '/')
  $lp = Invoke-SentryNative -FilePath 'wsl.exe' -Arguments @('-d', $Distro, '--', 'wslpath', '-u', $fwd) -TimeoutSec 30
  $linuxPath = ([string]$lp.Stdout).Trim()
  if (-not $linuxPath) { return @{ ExitCode = -1; Stdout = ''; Stderr = 'wslpath failed' } }
  $bashArgs = @()
  $bashArgs += '-d'; $bashArgs += $Distro; $bashArgs += '--'; $bashArgs += 'bash'; $bashArgs += $linuxPath
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

function Add-SentryUserPath {
  param([string]$Dir)
  $regPath = 'HKCU:\Environment'
  $current = ''
  try { $current = (Get-ItemProperty -Path $regPath -Name Path -ErrorAction Stop).Path } catch { }
  if ([string]::IsNullOrEmpty($current)) { $current = $env:PATH }
  $parts = $current -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
  $already = $false
  foreach ($p in $parts) { if ($p.TrimEnd('\') -ieq $Dir.TrimEnd('\')) { $already = $true } }
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
