# sentry.ps1 — canonical Sentry launcher entry point.
# Usage: .\sentry.ps1 setup | open | update | stop | status | doctor | version | help
# After setup, the `sentry` shim (user PATH) allows the same from any directory.
# Provider credentials are NEVER requested here; use Desktop Settings -> Providers.
param(
  [Parameter(Position = 0)][string]$Command = 'help',
  [Parameter(Position = 1)][string]$Arg1 = '',
  [Parameter(Position = 2)][string]$Arg2 = '',
  [string]$Distro = '',
  [switch]$Json,
  [switch]$Repair,
  [switch]$NonInteractive
)
$ErrorActionPreference = 'Stop'

$launcherDir = Join-Path $PSScriptRoot 'scripts/launcher'
Import-Module (Join-Path $launcherDir 'SentryLauncher.psm1') -Force -DisableNameChecking
. (Join-Path $launcherDir 'prerequisites.ps1')
. (Join-Path $launcherDir 'wsl-setup.ps1')
. (Join-Path $launcherDir 'agent-tools.ps1')
. (Join-Path $launcherDir 'commands.ps1')
. (Join-Path $launcherDir 'commands2.ps1')

$repoRoot = Get-SentryRepoRoot
$cmd = ([string]$Command).Trim().ToLowerInvariant()
if ($cmd -eq '') { $cmd = 'help' }
# Allow `sentry -Distro X` style to still reach setup explicitly via Arg passthrough; primary UX is subcommands.
$exitCode = 0
switch ($cmd) {
  'setup' { $exitCode = Invoke-SentrySetup -RepoRoot $repoRoot -DistroFlag $Distro -NonInteractive ([bool]$NonInteractive) }
  'open' { $exitCode = Invoke-SentryOpen -RepoRoot $repoRoot }
  '__open-detached' { $exitCode = Invoke-SentryOpenDetached -RepoRoot $repoRoot }
  'update' { $exitCode = Invoke-SentryUpdate -RepoRoot $repoRoot -Repair ([bool]$Repair) }
  '__post-update' { $exitCode = Invoke-SentryPostUpdate -RepoRoot $repoRoot -OldSha $Arg1 -NewSha $Arg2 -Repair ([bool]$Repair) }
  'stop' { $exitCode = Invoke-SentryStop -RepoRoot $repoRoot }
  'status' { $exitCode = Invoke-SentryStatus -RepoRoot $repoRoot -AsJson ([bool]$Json) }
  'doctor' { $exitCode = Invoke-SentryDoctor }
  'version' { $exitCode = Invoke-SentryVersion -RepoRoot $RepoRoot }
  'help' { $exitCode = Show-SentryHelp }
  '-h' { $exitCode = Show-SentryHelp }
  '--help' { $exitCode = Show-SentryHelp }
  '-v' { $exitCode = Invoke-SentryVersion -RepoRoot $RepoRoot }
  '--version' { $exitCode = Invoke-SentryVersion -RepoRoot $RepoRoot }
  default { Write-Host ("Unknown command: " + $Command) -ForegroundColor Red; $exitCode = Show-SentryHelp; $exitCode = 1 }
}
if ($exitCode -eq 75) {
  Write-Host 'Setup paused for reboot (exit 75). Rerun sentry setup afterwards.' -ForegroundColor Yellow
}
exit $exitCode
