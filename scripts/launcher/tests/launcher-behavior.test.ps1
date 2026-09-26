# launcher-behavior.test.ps1 — direct tests of PRODUCTION launcher functions
# with mocked process boundaries (no WSL, no installs, no mutations).
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/launcher/tests/launcher-behavior.test.ps1
# No Pester required (works on PS5/PS7 and CI): plain assertions, exit 1 on failure.
$ErrorActionPreference = 'Stop'
$here = Split-Path $PSCommandPath -Parent
$launcherDir = Split-Path $here -Parent
Import-Module (Join-Path $launcherDir 'SentryLauncher.psm1') -Force -DisableNameChecking
. (Join-Path $launcherDir 'prerequisites.ps1')
. (Join-Path $launcherDir 'wsl-setup.ps1')
. (Join-Path $launcherDir 'agent-tools.ps1')
. (Join-Path $launcherDir 'commands.ps1')
. (Join-Path $launcherDir 'commands2.ps1')
$script:failures = 0
$script:NativeStubs = @{}
$script:NativeCalls = @()
$script:WslFileStubs = @{}
$script:WslFileCalls = @()
$script:StartCalls = @()
$script:StartThrows = $false
$script:StartExit = 0
function Assert-Equal { param($Name, $Actual, $Expected) if ([string]$Actual -ne [string]$Expected) { Write-Host ([string]("FAIL " + $Name + " expected=[" + $Expected + "] actual=[" + $Actual + "]")); $script:failures++ } else { Write-Host ([string]("PASS " + $Name)) } }
function Assert-True { param($Name, $Actual) if (-not $Actual) { Write-Host ([string]("FAIL " + $Name + " expected true")); $script:failures++ } else { Write-Host ([string]("PASS " + $Name)) } }
# ---- mocked process boundaries (production code calls THESE names) ----
function Invoke-SentryNative {
  param($FilePath, $Arguments, $Workdir, $TimeoutSec = 0, $NoRedirect = $false)
  $script:NativeCalls += @(($FilePath + ' ' + (($Arguments | ForEach-Object { [string]$_ }) -join ' ')))
  $key = $FilePath + ' ' + (($Arguments | ForEach-Object { [string]$_ }) -join ' ')
  foreach ($pat in $script:NativeStubs.Keys) { if ($key -like $pat) { return $script:NativeStubs[$pat] } }
  return @{ ExitCode = 0; Stdout = ''; Stderr = '' }
}
function Invoke-SentryWsl {
  param($Distro, $LinuxArgs, $TimeoutSec = 60)
  if ($script:WslInitOk -eq $false) { return @{ ExitCode = 1; Stdout = ''; Stderr = '' } }
  return @{ ExitCode = 0; Stdout = 'init-ok'; Stderr = '' }
}
function Invoke-SentryWslFile {
  param($Distro, $ScriptName, $ScriptArgs = @(), $TimeoutSec = 60)
  $script:WslFileCalls += @($ScriptName)
  foreach ($pat in $script:WslFileStubs.Keys) { if ($ScriptName -like $pat) { return $script:WslFileStubs[$pat] } }
  return @{ ExitCode = 0; Stdout = ''; Stderr = '' }
}
function Start-Process {
  param($FilePath, $ArgumentList, $Verb, [switch]$Wait, [switch]$PassThru, $ErrorAction)
  $script:StartCalls += @(($FilePath + ' verb=' + $Verb))
  if ($script:StartThrows) { throw 'The operation was canceled by the user' }
  return [pscustomobject]@{ ExitCode = $script:StartExit }
}
# ---- 1. distro classification: docker ignored, WSL1 separated ----
$mock = @(
  [pscustomobject]@{ Name = 'docker-desktop'; State = 'Stopped'; Version = 2 },
  [pscustomobject]@{ Name = 'docker-desktop-data'; State = 'Stopped'; Version = 2 },
  [pscustomobject]@{ Name = 'Ubuntu'; State = 'Stopped'; Version = 1 },
  [pscustomobject]@{ Name = 'Debian'; State = 'Running'; Version = 2 }
)
$class = Get-SentryDistroClass $mock
Assert-Equal 'class-usable' (@($class.Usable).Count) '1'
Assert-Equal 'class-usable-name' (@($class.Usable))[0].Name 'Debian'
Assert-Equal 'class-wsl1' (@($class.Wsl1).Count) '1'
Assert-Equal 'class-wsl1-name' (@($class.Wsl1))[0].Name 'Ubuntu'
Assert-Equal 'class-utility' (@($class.Utility).Count) '2'
# ---- 2. selection never picks WSL1 or docker ----
$sel = Select-SentryDistro -Distros $mock -NonInteractive $true
Assert-Equal 'select-skips-wsl1-docker' $sel 'Debian'
$onlyWsl1 = @([pscustomobject]@{ Name = 'Ubuntu'; State = 'Stopped'; Version = 1 })
Assert-Equal 'select-no-wsl2-empty' (Select-SentryDistro -Distros $onlyWsl1 -NonInteractive $true) ''
# ---- 3. update branch gate ----
Assert-Equal 'branch-main-ok' (Test-SentryUpdateBranch -Branch 'main') ''
$refused = Test-SentryUpdateBranch -Branch 'feature/foo'
Assert-True 'branch-feature-refused' ($refused -ne '')
Assert-True 'branch-message-names-origin-main' ($refused.Contains('origin/main'))
Assert-True 'branch-message-no-mutation-claim' ($refused.Contains('git switch main'))
# ---- 4. no-update decision ----
Assert-Equal 'update-needed-different' (Test-SentryUpdateNeeded -HeadSha 'aaa' -RemoteSha 'bbb') $true
Assert-Equal 'update-not-needed-equal' (Test-SentryUpdateNeeded -HeadSha 'aaa' -RemoteSha 'aaa') $false
Assert-Equal 'update-needed-unknown' (Test-SentryUpdateNeeded -HeadSha '' -RemoteSha 'bbb') $true
# ---- 5. expected DeepSeek version comes from the harness SDK source ----
$repoRoot = (Resolve-Path (Join-Path $launcherDir '..\..')).Path
Assert-Equal 'deepseek-pinned-version' (Get-SentryExpectedDeepSeekVersion -RepoRoot $repoRoot) '0.1.5-rc.2'
# ---- 6. managed claude path parsing ----
$sample = "MANAGED=missing`nPATH_CLAUDE=/usr/bin/claude`nPATH_NATIVE=linux`nPATH_VERSION=2.1.270`nPATH_OK"
Assert-Equal 'claude-managed-missing' (Get-SentryManagedClaudePath $sample) 'missing'
$sample2 = "MANAGED=/home/u/.local/share/sentry/tools/claude-code/node_modules/.bin/claude`nMANAGED_OK"
Assert-Equal 'claude-managed-path' (Get-SentryManagedClaudePath $sample2) '/home/u/.local/share/sentry/tools/claude-code/node_modules/.bin/claude'
# ---- 7. WSL install elevation: UAC cancel / failure / reboot / ready ----
$script:NativeStubs = @{}
$script:StartThrows = $true
Assert-Equal 'install-uac-cancel' (Install-SentryWslUbuntu -Elevate $true) 'cancelled'
$script:StartThrows = $false
$script:StartExit = 1
Assert-Equal 'install-failed' (Install-SentryWslUbuntu -Elevate $true) 'failed'
Assert-True 'install-elevates-only-install' ((@($script:StartCalls) | Where-Object { $_ -like '*verb=RunAs*' }).Count -gt 0)
$script:StartExit = 0
$script:NativeStubs = @{ '*--status*' = @{ ExitCode = 1; Stdout = ''; Stderr = '' } }
Assert-Equal 'install-accepted-needs-reboot' (Install-SentryWslUbuntu -Elevate $true) 'reboot'
# ---- 8. WSL1 conversion: explicit converts, silent noninteractive refuses ----
$script:NativeStubs = @{
  '*--set-version*' = @{ ExitCode = 0; Stdout = ''; Stderr = '' };
  '*--list --verbose*' = @{ ExitCode = 0; Stdout = ("  NAME      STATE    VERSION`n* Ubuntu    Stopped         2`n"); Stderr = '' }
}
$conv = Request-SentryWsl1Conversion -Convertible @($onlyWsl1) -Explicit 'Ubuntu' -NonInteractive $true
Assert-Equal 'wsl1-explicit-converts' $conv 'Ubuntu'
Assert-True 'wsl1-used-set-version' ((@($script:NativeCalls) | Where-Object { $_ -like '*--set-version Ubuntu 2*' }).Count -gt 0)
$conv2 = Request-SentryWsl1Conversion -Convertible @($onlyWsl1) -NonInteractive $true
Assert-Equal 'wsl1-silent-refuses' $conv2 ''
# ---- 9. DeepSeek ensure uses the managed check (mocked boundary) ----
$script:WslFileStubs = @{ 'check-deepseek.sh' = @{ ExitCode = 0; Stdout = ("DSH_MANAGED=/home/u/.local/share/sentry/tools/deepseek/bin/dsh`nDSH_VERSION=0.1.5-rc.2`nDSH_OK"); Stderr = '' } }
$script:NativeStubs = @{ '*' = @{ ExitCode = 0; Stdout = ''; Stderr = '' } }
$ds = Ensure-SentryDeepSeek -Distro 'Ubuntu' -RepoRoot $repoRoot
Assert-Equal 'deepseek-managed-ok' $ds $true
Assert-True 'deepseek-ran-managed-check' ((@($script:WslFileCalls) | Where-Object { $_ -eq 'check-deepseek.sh' }).Count -gt 0)
$script:WslFileStubs = @{ 'check-deepseek.sh' = @{ ExitCode = 0; Stdout = 'DSH_MANAGED=missing'; Stderr = '' }; 'install-deepseek-tool.sh' = @{ ExitCode = 1; Stdout = 'DSH_ENTRY_MISSING'; Stderr = '' } }
$ds2 = Ensure-SentryDeepSeek -Distro 'Ubuntu' -RepoRoot $repoRoot
Assert-Equal 'deepseek-missing-fails-honest' $ds2 $false
# ---- 10. no host mutations: user PATH untouched by tests ----
$before = [Environment]::GetEnvironmentVariable('PATH', 'User')
Assert-True 'user-path-untouched' (([Environment]::GetEnvironmentVariable('PATH', 'User')) -eq $before)
if ($script:failures -gt 0) { Write-Host ([string]("BEHAVIOR-FAIL " + $script:failures)); exit 1 }
Write-Host 'BEHAVIOR-OK'
exit 0
