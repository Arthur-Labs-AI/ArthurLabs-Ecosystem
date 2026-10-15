param([Parameter(Position = 0)][string]$Command = 'help', [string]$Distro = '', [switch]$NonInteractive)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if ($Command -in @('help', '--help', '-h')) {
  Write-Host 'Sentry pinned distribution: setup | tools | open | stop | status | doctor | version | register-command | help'
  Write-Host 'Extract every approved archive into a separate version/SHA directory. See INSTALL.md. No automatic updates.'
  exit 0
}
if ($Command -eq 'update') { Write-Error 'Pinned release: verify an approved archive, stop Sentry, then run its setup. No development update.'; exit 1 }
. (Join-Path $root 'scripts/distribution/verify.ps1')
$manifest = Get-SentryDistribution -Root $root
if ($Command -eq 'version') { $manifest | Select-Object product,version,sourceCommit,targetPlatform | ConvertTo-Json; exit 0 }
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Sentry requires Windows x64' }
$os = Get-CimInstance Win32_OperatingSystem
if ([int]$os.BuildNumber -lt 22000 -or $os.ProductType -ne 1) { throw 'Sentry supports Windows 11 only' }
Import-Module (Join-Path $root 'scripts/launcher/SentryLauncher.psm1') -Force -DisableNameChecking
. (Join-Path $root 'scripts/launcher/prerequisites.ps1')
. (Join-Path $root 'scripts/launcher/wsl-setup.ps1')
$exe = Join-Path $root 'desktop/Sentry.exe'
. (Join-Path $root 'scripts/distribution/maintenance.ps1')
. (Join-Path $root 'scripts/distribution/register-command.ps1')
function Get-DistributionDistro {
  $cfg = Get-SentryLauncherConfig
  $previous = [string]$cfg['selectedDistro']
  $result = Ensure-SentryWslDistro -Explicit $Distro -NonInteractive ([bool]$NonInteractive) -Previous $previous
  if ($result.RebootRequired) { Write-Host 'Reboot, then rerun this archive setup.'; exit 75 }
  if (-not $result.Distro) { throw 'No usable WSL2 distro; see INSTALL.md' }
  return [string]$result.Distro
}
function Invoke-DistributionLinux {
  param([string]$Selected, [string]$Script, [string[]]$ScriptArguments = @())
  $converted = Invoke-SentryWsl -Distro $Selected -LinuxArgs @('wslpath', '-u', ((Join-Path $root $Script).Replace('\', '/'))) -TimeoutSec 30
  if ($converted.ExitCode -ne 0 -or -not ([string]$converted.Stdout).Trim()) { throw 'WSL path translation failed' }
  $r = Invoke-SentryWsl -Distro $Selected -LinuxArgs (@('bash', ([string]$converted.Stdout).Trim()) + $ScriptArguments) -TimeoutSec 5400
  Write-Host $r.Stdout
  if ($r.ExitCode -ne 0) { Write-Host $r.Stderr; throw 'Linux bootstrap failed. Previous state retained; see diagnostics and INSTALL.md.' }
}
switch ($Command) {
  { $_ -in @('setup', 'repair') } {
    Stop-DistributionDesktop -Executable $exe
    $selected = Get-DistributionDistro
    Invoke-DistributionLinux -Selected $selected -Script 'scripts/distribution/bootstrap-runtime.sh' -ScriptArguments @('wsl')
    $sync = Invoke-SentryNative -FilePath $exe -Arguments @('--sentry-setup-distro', $selected) -TimeoutSec 120
    if ($sync.ExitCode -ne 0) { throw 'Runtime installed, but Desktop distro preference could not be saved. Stop Desktop and rerun setup.' }
    Set-SentryLauncherConfig @{ selectedDistro = $selected }
    Register-SentryDistributionCommand -Root $root
    Write-Host 'Core installed. Next: sentry tools, then sentry open (new terminal). Configure credentials in Settings -> Providers.'
  }
  'register-command' { Register-SentryDistributionCommand -Root $root }
  'open' { [void](Start-Process -FilePath $exe -ArgumentList @('--sentry-app') -WorkingDirectory (Join-Path $root 'desktop') -WindowStyle Normal); Write-Host 'Desktop launch requested; check Environment for readiness.' }
  'stop' { Stop-DistributionDesktop -Executable $exe; Write-Host 'Sentry stopped.' }
  { $_ -in @('doctor', 'status') } {
    $manifest | Select-Object product,version,sourceCommit,targetPlatform | ConvertTo-Json
    Write-Host ('Desktop processes: ' + @(Get-DistributionDesktop).Count)
    Write-Host 'Check WSL: wsl --list --verbose; wsl -d <distro> -- node --version; wsl -d <distro> -- systemctl --user show-environment'
    Write-Host 'Open Environment for matching runtime handshake and provider readiness. No paid requests.'
  }
  'tools' {
    Stop-DistributionDesktop -Executable $exe
    $selected = Get-DistributionDistro
    Invoke-DistributionLinux -Selected $selected -Script 'scripts/distribution/check-maintenance.sh'
    foreach ($spec in @(@('install-opencode.sh', '1.18.32'), @('install-deepseek-tool.sh', '0.1.5-rc.2'), @('install-claude.sh', '2.1.270'))) {
      $r = Invoke-SentryWslFile -Distro $selected -ScriptName $spec[0] -ScriptArgs @($spec[1]) -TimeoutSec 1200
      Write-Host $r.Stdout
      if ($r.ExitCode -ne 0) { throw ('Provider tool provisioning failed: ' + $spec[0]) }
      foreach ($setting in @(@('MANAGED_DSH=', 'SENTRY_DEEPSEEK_BINARY'), @('MANAGED_CLAUDE=', 'SENTRY_GLM_BINARY'))) {
        foreach ($line in (([string]$r.Stdout) -split "`n")) {
          if ($line.StartsWith($setting[0])) {
            $path = $line.Substring($setting[0].Length).Trim()
            $save = Invoke-SentryNative -FilePath $exe -Arguments @('--sentry-setup-provider-binary', $setting[1], $path) -TimeoutSec 120
            if ($save.ExitCode -ne 0) { throw ('Could not persist ' + $setting[1]) }
          }
        }
      }
    }
    Write-Host 'Pinned tooling installed; configure credentials and verify Environment. No paid runs started.'
  }
  default { throw ('Unknown command: ' + $Command) }
}
