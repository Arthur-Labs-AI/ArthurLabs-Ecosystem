# launcher-smoke.ps1 — dependency-free launcher self-test (no WSL, no mutations).
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/launcher/tests/launcher-smoke.ps1
# Exit 0 = pass, 1 = failure. Developer gate only (normal users never need this).
$ErrorActionPreference = 'Stop'
$here = Split-Path $PSCommandPath -Parent
$launcherDir = Split-Path $here -Parent
Import-Module (Join-Path $launcherDir 'SentryLauncher.psm1') -Force -DisableNameChecking
. (Join-Path $launcherDir 'wsl-setup.ps1')
$failures = 0
function Assert-Equal { param($Name, $Actual, $Expected) if ([string]$Actual -ne [string]$Expected) { Write-Host ([string]("FAIL " + $Name + " expected=[" + $Expected + "] actual=[" + $Actual + "]")); $script:failures++ } else { Write-Host ([string]("PASS " + $Name)) } }
$repoRoot = (Resolve-Path (Join-Path $launcherDir '..\..')).Path
Assert-Equal 'product-version' (Get-SentryProductVersion -RepoRoot $repoRoot) '1.0.0'
Assert-Equal 'pinned-pnpm' (Get-SentryPinnedPnpmVersion -RepoRoot $repoRoot) '9.12.3'
$redacted = Redact-SentrySecrets 'key OPENROUTER_API_KEY=sk-secret-123 and token: abc'
if ($redacted.Contains('sk-secret-123') -or $redacted.Contains('abc')) { Write-Host 'FAIL redact-secrets'; $failures++ } else { Write-Host 'PASS redact-secrets' }
$mockDistros = @(
  [pscustomobject]@{ Name = 'docker-desktop'; State = 'Stopped'; Version = 2 },
  [pscustomobject]@{ Name = 'Debian'; State = 'Running'; Version = 2 },
  [pscustomobject]@{ Name = 'Ubuntu'; State = 'Stopped'; Version = 2 }
)
Assert-Equal 'select-default-ubuntu' (Select-SentryDistro -Distros $mockDistros -NonInteractive $true) 'Ubuntu'
Assert-Equal 'select-previous' (Select-SentryDistro -Distros $mockDistros -Previous 'Debian' -NonInteractive $true) 'Debian'
Assert-Equal 'select-explicit' (Select-SentryDistro -Distros $mockDistros -Explicit 'debian' -NonInteractive $true) 'Debian'
$usable = @(Get-SentryUsableDistros $mockDistros)
Assert-Equal 'usable-skips-docker' $usable.Count '2'
$dockerOnly = @([pscustomobject]@{ Name = 'docker-desktop'; State = 'Stopped'; Version = 2 })
$usableNone = @(Get-SentryUsableDistros $dockerOnly)
Assert-Equal 'docker-only-empty' $usableNone.Count '0'
$quoted = Get-SentryQuotedArguments @('--filter', '@qa/desktop', 'C:\ path with spaces\x')
if (-not $quoted.Contains('"C:\ path with spaces\x"')) { Write-Host ([string]("FAIL quote-spaces: " + $quoted)); $failures++ } else { Write-Host 'PASS quote-spaces' }
if ($failures -gt 0) { Write-Host ([string]("SMOKE-FAIL " + $failures)); exit 1 }
Write-Host 'SMOKE-OK'
exit 0
