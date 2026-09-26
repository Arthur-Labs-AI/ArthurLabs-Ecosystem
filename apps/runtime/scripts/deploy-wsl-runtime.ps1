# Deterministic WSL runtime deploy (setup/bootstrap, Phase 8 + Beta).
# Copies the monorepo into the Linux filesystem and installs Linux-native
# dependencies there. NEVER executes Windows node_modules from /mnt.
# Versioned: <product-version>-<short-git-sha> (e.g. 0.1.0-beta.1-e9e0b80).
# Activation is atomic: build+validate happen before `current` moves, so a
# failed deploy leaves the previous runtime usable.
# Usage: ./scripts/deploy-wsl-runtime.ps1 [-Distro Ubuntu] [-Version 0.1.0-beta.1-abc1234]
param([string]$Distro = 'Ubuntu', [string]$Version = '')
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
if (-not $Version) {
  $product = '0.1.0-beta.1'
  try { $pkg = Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json; if ($pkg.version) { $product = [string]$pkg.version } } catch { }
  $sha = 'unknown'
  try { $s = & git -C $repoRoot rev-parse --short HEAD 2>$null; if ($LASTEXITCODE -eq 0 -and $s) { $sha = ([string]$s).Trim() } } catch { }
  $Version = $product + '-' + $sha
}
$winSrc = $repoRoot
Write-Output ("[sentry-runtime] source: " + $winSrc)
Write-Output ("[sentry-runtime] version: " + $Version)
$winSrcFwd = $winSrc -replace '\\', '/'
$linuxSrc = (wsl.exe -d $Distro -- wslpath -u "$winSrcFwd").Trim()
$deployScript = Join-Path $PSScriptRoot 'deploy-inner.sh'
$deployLinux = ((wsl.exe -d $Distro -- wslpath -u (($deployScript -replace '\\', '/'))).Trim())
wsl.exe -d $Distro -- bash $deployLinux $linuxSrc $Version
if ($LASTEXITCODE -ne 0) { throw "WSL deploy failed with exit $LASTEXITCODE (previous runtime untouched)" }
Write-Output '[sentry-runtime] deployed'
