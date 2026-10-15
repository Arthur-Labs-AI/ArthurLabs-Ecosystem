# Per-user command registration for immutable packaged archives. No WSL or Node required.
function Register-SentryDistributionCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [string]$BinDirectory = (Join-Path $env:LOCALAPPDATA 'Sentry\bin'),
    [scriptblock]$ReadUserPath = { [Environment]::GetEnvironmentVariable('Path', 'User') },
    [scriptblock]$WriteUserPath = { param($Value) [Environment]::SetEnvironmentVariable('Path', $Value, 'User') }
  )
  $target = Join-Path ([IO.Path]::GetFullPath($Root)) 'sentry.ps1'
  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw 'Archive launcher missing. Register an extracted, verified Sentry archive.' }
  [void](New-Item -ItemType Directory -Force -Path $BinDirectory)
  $launcher = @'
$ErrorActionPreference = 'Stop'
try {
  $configuration = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-command.json') -Raw | ConvertFrom-Json
  $target = [string]$configuration.launcherPath
  if (-not [IO.Path]::IsPathRooted($target) -or -not (Test-Path -LiteralPath $target -PathType Leaf)) {
    throw 'Registered Sentry archive is missing or moved. Run register-command from the verified archive again.'
  }
  $global:LASTEXITCODE = 0
  & $target @args
  exit $LASTEXITCODE
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
'@
  $batch = @'
@echo off
setlocal DisableDelayedExpansion
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0sentry-launch.ps1" %*
exit /b %errorlevel%
'@
  # The archive path is data in UTF-8 JSON, never interpolated into batch code.
  $launcher | Set-Content -LiteralPath (Join-Path $BinDirectory 'sentry-launch.ps1') -Encoding UTF8
  $batch | Set-Content -LiteralPath (Join-Path $BinDirectory 'sentry.cmd') -Encoding ASCII
  @{ launcherPath = $target } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $BinDirectory 'release-command.json') -Encoding UTF8
  $userPath = [string](& $ReadUserPath)
  $entries = @($userPath -split ';' | Where-Object { $_.Trim() -ne '' })
  $present = @($entries | Where-Object { $_.Trim().Trim('"').TrimEnd('\') -ieq $BinDirectory.TrimEnd('\') }).Count -gt 0
  if (-not $present) {
    $updated = if ($userPath.Trim().Length -eq 0) { $BinDirectory } else { $userPath.TrimEnd(';') + ';' + $BinDirectory }
    & $WriteUserPath $updated
  }
  if (@($env:Path -split ';' | Where-Object { $_.Trim().TrimEnd('\') -ieq $BinDirectory.TrimEnd('\') }).Count -eq 0) {
    $env:Path = $env:Path.TrimEnd(';') + ';' + $BinDirectory
  }
  Write-Host ('sentry command registered at: ' + $BinDirectory)
  Write-Host 'Open a new terminal, then run: sentry open | sentry status | sentry doctor | sentry version'
  Write-Host 'For this existing PowerShell window: $env:Path += ";$env:LOCALAPPDATA\Sentry\bin"'
}
