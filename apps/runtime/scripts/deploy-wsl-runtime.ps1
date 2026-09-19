# Deterministic WSL runtime deploy (development/bootstrap, Phase 8).
# Copies the monorepo into the Linux filesystem and installs Linux-native
# dependencies there. NEVER executes Windows node_modules from /mnt.
# Usage: ./scripts/deploy-wsl-runtime.ps1 [-Distro Ubuntu] [-Version 0.1.0]
param([string]$Distro = 'Ubuntu', [string]$Version = '0.1.0')
$ErrorActionPreference = 'Stop'
$winSrc = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
Write-Output "[sentry-runtime] source: $winSrc"
$winSrcFwd = $winSrc -replace '\\', '/'
$linuxSrc = (wsl.exe -d $Distro -- wslpath -u "$winSrcFwd").Trim()
$deployScript = Join-Path $PSScriptRoot 'deploy-inner.sh'
$deployLinux = ((wsl.exe -d $Distro -- wslpath -u (($deployScript -replace '\\', '/'))).Trim())
wsl.exe -d $Distro -- bash $deployLinux $linuxSrc $Version
if ($LASTEXITCODE -ne 0) { throw "WSL deploy failed with exit $LASTEXITCODE" }
Write-Output '[sentry-runtime] deployed'
