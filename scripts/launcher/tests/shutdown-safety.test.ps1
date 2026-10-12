# Production setup/update must stop before mutation if graceful shutdown fails.
$ErrorActionPreference = 'Stop'
$launcherDir = Split-Path (Split-Path $PSCommandPath -Parent) -Parent
Import-Module (Join-Path $launcherDir 'SentryLauncher.psm1') -Force -DisableNameChecking
. (Join-Path $launcherDir 'commands.ps1')
. (Join-Path $launcherDir 'commands2.ps1')
$script:mutations = 0
$script:running = $true
$script:stopCode = 1
function Get-SentryDesktopProcesses { if ($script:running) { [pscustomobject]@{ Id = 123 } } }
function Invoke-SentryStop { param($RepoRoot) return $script:stopCode }
function Get-SentryProductVersion { param($RepoRoot) return '0.1.0-beta.1' }
function Get-SentryShortSha { param($RepoRoot) return 'old' }
function Write-SentryLog { param($Message, $Command) }
function Write-SentrySection { param($Message) $script:mutations++ }
function Invoke-SentryNative {
  param($FilePath, $Arguments)
  if (($Arguments -join ' ') -notlike '*fetch --prune origin main') { $script:mutations++ }
  return @{ ExitCode = 0 }
}
function git {
  $global:LASTEXITCODE = 0
  switch -Wildcard ($args -join ' ') {
    '*rev-parse --abbrev-ref HEAD' { 'main' }
    '*rev-parse HEAD' { 'old' }
    '*status --porcelain' { }
    '*rev-parse origin/main' { 'new' }
    '*merge-base --is-ancestor*' { $global:LASTEXITCODE = 0 }
    default { throw 'Unexpected Git call' }
  }
}
if ((Stop-SentryDesktopIfRunning -RepoRoot 'fixture') -ne 1) { throw 'Failed shutdown reported success' }
if ((Invoke-SentrySetup -RepoRoot 'fixture') -ne 1) { throw 'Setup accepted failed shutdown' }
if ((Invoke-SentryUpdate -RepoRoot 'fixture') -ne 1) { throw 'Update accepted failed shutdown' }
if ($script:mutations -ne 0) { throw 'Setup/update mutated after failed shutdown' }
$script:stopCode = 0
if ((Stop-SentryDesktopIfRunning -RepoRoot 'fixture') -ne 0) { throw 'Successful stop refused' }
$script:running = $false
if ((Stop-SentryDesktopIfRunning -RepoRoot 'fixture') -ne 0) { throw 'Idle stop refused' }
Write-Host 'SHUTDOWN-SAFETY-OK'
