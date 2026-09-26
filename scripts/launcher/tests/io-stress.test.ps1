# io-stress.test.ps1 — Invoke-SentryNative pipe-drain regression tests.
# Exercises the REAL production helper (no mocks): a child flooding BOTH
# stdout and stderr past OS pipe capacity must complete without deadlock.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/launcher/tests/io-stress.test.ps1
# Requires node on PATH (developer/CI only). Exit 1 on failure.
$ErrorActionPreference = 'Stop'
$here = Split-Path $PSCommandPath -Parent
$launcherDir = Split-Path $here -Parent
Import-Module (Join-Path $launcherDir 'SentryLauncher.psm1') -Force -DisableNameChecking
$script:failures = 0
function Assert-True { param($Name, $Actual) if (-not $Actual) { Write-Host ([string]("FAIL " + $Name)); $script:failures++ } else { Write-Host ([string]("PASS " + $Name)) } }
$helper = Join-Path $here 'io-stress.mjs'
# 1. mixed high-output flood must finish with exit 0 and captured tails
$sw = [Diagnostics.Stopwatch]::StartNew()
$r = Invoke-SentryNative -FilePath 'node' -Arguments @($helper) -TimeoutSec 120
$sw.Stop()
Assert-True 'flood-exit-0' ($r.ExitCode -eq 0)
Assert-True 'flood-stdout-marker' (([string]$r.Stdout).Contains('FLOOD-DONE-OUT'))
Assert-True 'flood-stderr-marker' (([string]$r.Stderr).Contains('FLOOD-DONE-ERR'))
Assert-True 'flood-stdout-large' (([string]$r.Stdout).Length -ge 1000000)
Assert-True 'flood-stderr-large' (([string]$r.Stderr).Length -ge 1000000)
Assert-True 'flood-no-timeout' ($sw.Elapsed.TotalSeconds -lt 110)
# 2. hanging child: timeout enforced, pre-timeout output preserved
$sw2 = [Diagnostics.Stopwatch]::StartNew()
$h = Invoke-SentryNative -FilePath 'node' -Arguments @($helper, 'hang') -TimeoutSec 4
$sw2.Stop()
Assert-True 'hang-exit-minus1' ($h.ExitCode -eq -1)
Assert-True 'hang-fast-return' ($sw2.Elapsed.TotalSeconds -lt 30)
Assert-True 'hang-marker-preserved' (([string]$h.Stdout).Contains('HANG-MARKER-OUT'))
Assert-True 'hang-timeout-note' (([string]$h.Stderr).Contains('timed out'))
# 3. NoRedirect still launches, respects exit code, captures nothing
$n = Invoke-SentryNative -FilePath 'node' -Arguments @('--version') -TimeoutSec 30 -NoRedirect $true
Assert-True 'noredirect-exit-0' ($n.ExitCode -eq 0)
Assert-True 'noredirect-no-capture' ([string]$n.Stdout -eq '')
if ($script:failures -gt 0) { Write-Host ([string]("IO-STRESS-FAIL " + $script:failures)); exit 1 }
Write-Host 'IO-STRESS-OK'
exit 0
