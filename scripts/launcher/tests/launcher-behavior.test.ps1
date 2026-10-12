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
  param($FilePath, $Arguments, $Workdir, $TimeoutSec = 0, $NoRedirect = $false, $NoTruncate = $false)
  $script:LastNativeFlags = @{ NoRedirect = $NoRedirect; NoTruncate = $NoTruncate }
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
  param($Distro, $ScriptName, $ScriptArgs = @(), $TimeoutSec = 60, $AsRoot = $false)
  $argText = (($ScriptArgs | ForEach-Object { [string]$_ }) -join ',')
  $script:WslFileCalls += @($ScriptName + ' root=' + [string]$AsRoot + ' args=[' + $argText + ']')
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
# ---- 3. update channel gate (dev/main allowlist; everything else refuses) ----
Assert-Equal 'branch-dev-ok' (Test-SentryUpdateBranch -Branch 'dev') ''
Assert-Equal 'branch-main-ok' (Test-SentryUpdateBranch -Branch 'main') ''
Assert-Equal 'channel-dev-ref' (Get-SentryUpdateRemoteRef -Branch 'dev') 'origin/dev'
Assert-Equal 'channel-main-ref' (Get-SentryUpdateRemoteRef -Branch 'main') 'origin/main'
Assert-Equal 'channel-feature-empty' (Get-SentryUpdateRemoteRef -Branch 'feature/foo') ''
Assert-Equal 'channel-fix-empty' (Get-SentryUpdateRemoteRef -Branch 'fix/example') ''
Assert-Equal 'channel-release-empty' (Get-SentryUpdateRemoteRef -Branch 'release/v1.0.0-rc.1') ''
Assert-Equal 'channel-hotfix-empty' (Get-SentryUpdateRemoteRef -Branch 'hotfix/v1.0.0-x') ''
Assert-Equal 'channel-detached-empty' (Get-SentryUpdateRemoteRef -Branch 'HEAD') ''
Assert-Equal 'channel-empty-empty' (Get-SentryUpdateRemoteRef -Branch '') ''
$refused = Test-SentryUpdateBranch -Branch 'feature/foo'
Assert-True 'branch-feature-refused' ($refused -ne '')
Assert-True 'branch-message-names-origin-dev' ($refused.Contains('origin/dev'))
Assert-True 'branch-message-names-origin-main' ($refused.Contains('origin/main'))
Assert-True 'branch-message-names-switch-dev' ($refused.Contains('git switch dev'))
Assert-True 'branch-message-names-switch-main' ($refused.Contains('git switch main'))
Assert-True 'branch-message-no-auto-switch' ($refused.Contains('never switches'))
Assert-True 'branch-message-no-mutation-claim' ($refused.Contains('Zero Git mutations'))
$refusedRelease = Test-SentryUpdateBranch -Branch 'release/v1.0.0-rc.1'
Assert-True 'branch-release-refused' ($refusedRelease -ne '')
$refusedDetached = Test-SentryUpdateBranch -Branch 'HEAD'
Assert-True 'branch-detached-refused' ($refusedDetached -ne '')
Assert-True 'branch-detached-names-tag' ($refusedDetached.Contains('detached HEAD'))
# ---- 3b. update fetches/merges the actual selected channel ref (disposable git repos) ----
$script:ChannelGitAvailable = $false
try { & git --version 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { $script:ChannelGitAvailable = $true } } catch { }
if ($script:ChannelGitAvailable) {
  function Invoke-SentryNative {
    param($FilePath, $Arguments, $Workdir, $TimeoutSec = 0, $NoRedirect = $false, $NoTruncate = $false)
    $script:LastNativeFlags = @{ NoRedirect = $NoRedirect; NoTruncate = $NoTruncate }
    $script:NativeCalls += @(($FilePath + ' ' + (($Arguments | ForEach-Object { [string]$_ }) -join ' ')))
    $key = $FilePath + ' ' + (($Arguments | ForEach-Object { [string]$_ }) -join ' ')
    foreach ($pat in $script:NativeStubs.Keys) { if ($key -like $pat) { return $script:NativeStubs[$pat] } }
    if (($FilePath -eq 'git') -and $script:ChannelPassthrough) {
      $out = & git @Arguments 2>$null
      $code = $LASTEXITCODE
      return @{ ExitCode = $code; Stdout = ((@($out) | ForEach-Object { [string]$_ }) -join [Environment]::NewLine); Stderr = '' }
    }
    return @{ ExitCode = 0; Stdout = ''; Stderr = '' }
  }
  $script:ChannelPassthrough = $true
  $script:NativeStubs = @{}
  $script:NativeCalls = @()
  $chanBase = Join-Path ([System.IO.Path]::GetTempPath()) ('sentry-chan-' + [System.Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $chanBase | Out-Null
  $chanSeed = Join-Path $chanBase 'seed'
  $chanWt = Join-Path $chanBase 'wt'
  function Invoke-ChanGit { param([string[]]$GArgs) & git @GArgs 2>$null | Out-Null; if ($LASTEXITCODE -ne 0) { throw ('git failed: ' + ($GArgs -join ' ')) } }
  $script:ChanPrevErr = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  Invoke-ChanGit @('init', '--bare', (Join-Path $chanBase 'origin.git'))
  Invoke-ChanGit @('--git-dir', (Join-Path $chanBase 'origin.git'), 'symbolic-ref', 'HEAD', 'refs/heads/main')
  Invoke-ChanGit @('init', '-b', 'main', $chanSeed)
  Invoke-ChanGit @('-C', $chanSeed, 'config', 'user.email', 'test@example.invalid')
  Invoke-ChanGit @('-C', $chanSeed, 'config', 'user.name', 'sentry-test')
  Invoke-ChanGit @('-C', $chanSeed, 'remote', 'add', 'origin', (Join-Path $chanBase 'origin.git'))
  Set-Content -Path (Join-Path $chanSeed 'file.txt') -Value 'base'
  Invoke-ChanGit @('-C', $chanSeed, 'add', 'file.txt')
  Invoke-ChanGit @('-C', $chanSeed, 'commit', '-qm', 'base')
  Set-Content -Path (Join-Path $chanSeed 'sentry.ps1') -Value @('param([Parameter(ValueFromRemainingArguments = $true)]$Rest)', 'exit 0')
  Invoke-ChanGit @('-C', $chanSeed, 'add', 'sentry.ps1')
  Invoke-ChanGit @('-C', $chanSeed, 'commit', '-qm', 'stub-sentry-handoff')
  Invoke-ChanGit @('-C', $chanSeed, 'push', '-q', 'origin', 'main')
  Invoke-ChanGit @('-C', $chanSeed, 'checkout', '-qb', 'dev')
  Set-Content -Path (Join-Path $chanSeed 'dev.txt') -Value 'dev1'
  Invoke-ChanGit @('-C', $chanSeed, 'add', 'dev.txt')
  Invoke-ChanGit @('-C', $chanSeed, 'commit', '-qm', 'dev1')
  Invoke-ChanGit @('-C', $chanSeed, 'push', '-q', 'origin', 'dev')
  Invoke-ChanGit @('clone', '-q', (Join-Path $chanBase 'origin.git'), $chanWt)
  $chanDevTip = ([string](& git -C $chanWt rev-parse origin/dev 2>$null)).Trim()
  $chanMainTip = ([string](& git -C $chanWt rev-parse origin/main 2>$null)).Trim()
  Assert-True 'channel-fixture-divergent-tips' ($chanDevTip -cne $chanMainTip)
  Invoke-ChanGit @('-C', $chanWt, 'checkout', '-q', 'dev')
  $script:NativeCalls = @()
  $rcDevCurrent = Invoke-SentryUpdate -RepoRoot $chanWt
  Assert-Equal 'channel-dev-current-exit' $rcDevCurrent 0
  Assert-True 'channel-dev-fetches-origin-dev' ((@($script:NativeCalls | Where-Object { $_ -like '*fetch --prune origin dev*' })).Count -gt 0)
  Assert-Equal 'channel-dev-never-touches-main' ((@($script:NativeCalls | Where-Object { $_ -like '*origin/main*' })).Count) '0'
  Assert-Equal 'channel-dev-head-stable' (([string](& git -C $chanWt rev-parse HEAD 2>$null)).Trim()) $chanDevTip
  Invoke-ChanGit @('-C', $chanWt, 'checkout', '-q', 'main')
  $script:NativeCalls = @()
  $rcMainCurrent = Invoke-SentryUpdate -RepoRoot $chanWt
  Assert-Equal 'channel-main-current-exit' $rcMainCurrent 0
  Assert-True 'channel-main-fetches-origin-main' ((@($script:NativeCalls | Where-Object { $_ -like '*fetch --prune origin main*' })).Count -gt 0)
  Assert-Equal 'channel-main-never-touches-dev' ((@($script:NativeCalls | Where-Object { $_ -like '*origin/dev*' })).Count) '0'
  Assert-Equal 'channel-main-head-stable' (([string](& git -C $chanWt rev-parse HEAD 2>$null)).Trim()) $chanMainTip
  Add-Content -Path (Join-Path $chanSeed 'dev.txt') -Value 'dev2'
  Invoke-ChanGit @('-C', $chanSeed, 'commit', '-qam', 'dev2')
  Invoke-ChanGit @('-C', $chanSeed, 'push', '-q', 'origin', 'dev')
  $chanNewDevTip = ([string](& git -C $chanSeed rev-parse HEAD 2>$null)).Trim()
  Invoke-ChanGit @('-C', $chanWt, 'checkout', '-q', 'dev')
  $script:NativeCalls = @()
  $rcDevAdvance = Invoke-SentryUpdate -RepoRoot $chanWt
  Assert-Equal 'channel-dev-advance-exit' $rcDevAdvance 0
  Assert-True 'channel-dev-merges-origin-dev' ((@($script:NativeCalls | Where-Object { $_ -like '*merge --ff-only origin/dev*' })).Count -gt 0)
  Assert-Equal 'channel-dev-advance-head' (([string](& git -C $chanWt rev-parse HEAD 2>$null)).Trim()) $chanNewDevTip
  Invoke-ChanGit @('-C', $chanWt, 'checkout', '-qb', 'feature/example')
  $script:NativeCalls = @()
  $rcFeature = Invoke-SentryUpdate -RepoRoot $chanWt
  Assert-Equal 'channel-feature-refuses' $rcFeature 1
  Assert-Equal 'channel-feature-no-fetch' ((@($script:NativeCalls | Where-Object { $_ -like '*fetch*' })).Count) '0'
  Assert-Equal 'channel-feature-branch-kept' (([string](& git -C $chanWt rev-parse --abbrev-ref HEAD 2>$null)).Trim()) 'feature/example'
  Invoke-ChanGit @('-C', $chanWt, 'checkout', '-q', '--detach', 'HEAD')
  $script:NativeCalls = @()
  $rcDetached = Invoke-SentryUpdate -RepoRoot $chanWt
  Assert-Equal 'channel-detached-refuses' $rcDetached 1
  Assert-Equal 'channel-detached-no-fetch' ((@($script:NativeCalls | Where-Object { $_ -like '*fetch*' })).Count) '0'
  Invoke-ChanGit @('-C', $chanWt, 'checkout', '-q', 'dev')
  Add-Content -Path (Join-Path $chanWt 'file.txt') -Value 'dirty'
  $script:NativeCalls = @()
  $rcDirty = Invoke-SentryUpdate -RepoRoot $chanWt
  Assert-Equal 'channel-dirty-refuses' $rcDirty 1
  Assert-Equal 'channel-dirty-no-fetch' ((@($script:NativeCalls | Where-Object { $_ -like '*fetch*' })).Count) '0'
  Assert-Equal 'channel-dirty-head-kept' (([string](& git -C $chanWt rev-parse HEAD 2>$null)).Trim()) $chanNewDevTip
  Invoke-ChanGit @('-C', $chanWt, 'checkout', '-q', '--', 'file.txt')
  Set-Content -Path (Join-Path $chanWt 'local.txt') -Value 'local-only'
  Invoke-ChanGit @('-C', $chanWt, 'add', 'local.txt')
  Invoke-ChanGit @('-C', $chanWt, 'commit', '-qm', 'local-only')
  $chanLocalTip = ([string](& git -C $chanWt rev-parse HEAD 2>$null)).Trim()
  Add-Content -Path (Join-Path $chanSeed 'dev.txt') -Value 'dev3'
  Invoke-ChanGit @('-C', $chanSeed, 'commit', '-qam', 'dev3')
  Invoke-ChanGit @('-C', $chanSeed, 'push', '-q', 'origin', 'dev')
  $script:NativeCalls = @()
  $rcDiverged = Invoke-SentryUpdate -RepoRoot $chanWt
  Assert-Equal 'channel-diverged-refuses' $rcDiverged 1
  Assert-True 'channel-diverged-fetched-dev' ((@($script:NativeCalls | Where-Object { $_ -like '*fetch --prune origin dev*' })).Count -gt 0)
  Assert-Equal 'channel-diverged-head-kept' (([string](& git -C $chanWt rev-parse HEAD 2>$null)).Trim()) $chanLocalTip
  Invoke-ChanGit @('-C', $chanWt, 'remote', 'set-url', 'origin', (Join-Path $chanBase 'does-not-exist.git'))
  Invoke-ChanGit @('-C', $chanWt, 'reset', '-q', '--hard', $chanNewDevTip)
  $script:NativeCalls = @()
  $rcFetchFail = Invoke-SentryUpdate -RepoRoot $chanWt
  Assert-Equal 'channel-fetch-fail-safe' $rcFetchFail 1
  Assert-Equal 'channel-fetch-fail-head-kept' (([string](& git -C $chanWt rev-parse HEAD 2>$null)).Trim()) $chanNewDevTip
  Remove-Item -Recurse -Force $chanBase -ErrorAction SilentlyContinue
  $ErrorActionPreference = $script:ChanPrevErr
  $script:ChannelPassthrough = $false
  $script:NativeStubs = @{}
  $script:NativeCalls = @()
}
else { Write-Host 'SKIP channel-update-integration (git unavailable)' }
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
$script:WslFileStubs = @{ 'install-deepseek-tool.sh' = @{ ExitCode = 0; Stdout = ("0.1.5-rc.2`nMANAGED_DSH=/home/u/.local/share/sentry/tools/deepseek/bin/dsh"); Stderr = '' } }
$script:NativeStubs = @{ '*' = @{ ExitCode = 0; Stdout = ''; Stderr = '' } }
$ds = Ensure-SentryDeepSeek -Distro 'Ubuntu' -RepoRoot $repoRoot
Assert-Equal 'deepseek-managed-ok' $ds $true
Assert-True 'deepseek-installs-live-wrapper' ((@($script:WslFileCalls) | Where-Object { $_ -like 'install-deepseek-tool.sh root=*' }).Count -gt 0)
$script:WslFileStubs = @{ 'install-deepseek-tool.sh' = @{ ExitCode = 1; Stdout = 'DSH_ENTRY_MISSING'; Stderr = '' } }
$ds2 = Ensure-SentryDeepSeek -Distro 'Ubuntu' -RepoRoot $repoRoot
Assert-Equal 'deepseek-missing-fails-honest' $ds2 $false
# ---- 11. deploy log path: absolute HOME resolution, never literal $HOME ----
function Get-PrintenvMock { param($HomeOut, $Code = 0) $script:NativeStubs = @{ '*printenv HOME*' = @{ ExitCode = $Code; Stdout = $HomeOut; Stderr = '' } } }
Get-PrintenvMock "/home/test`n"
Assert-Equal 'deploy-log-absolute' (Get-SentryDeployLogPath -Distro 'Ubuntu' -Version '0.1.0-beta.1-abc1234') '/home/test/sentry-deploy-0.1.0-beta.1-abc1234.log'
$logPath = Get-SentryDeployLogPath -Distro 'Ubuntu' -Version '0.1.0-beta.1-abc1234'
Assert-True 'deploy-log-no-literal-home' (-not ([string]$logPath).Contains('$HOME'))
Get-PrintenvMock ''
Assert-Equal 'deploy-log-empty-home' (Get-SentryDeployLogPath -Distro 'Ubuntu' -Version 'x') ''
Get-PrintenvMock "relative/home`n"
Assert-Equal 'deploy-log-relative-rejected' (Get-SentryDeployLogPath -Distro 'Ubuntu' -Version 'x') ''
Get-PrintenvMock "/home/u`n" 1
Assert-Equal 'deploy-log-exit-nonzero' (Get-SentryDeployLogPath -Distro 'Ubuntu' -Version 'x') ''
Get-PrintenvMock "/home/test`n"
Assert-Equal 'deploy-log-version-sanitized' (Get-SentryDeployLogPath -Distro 'Ubuntu' -Version 'a/b..c') '/home/test/sentry-deploy-a_b..c.log'
# ---- 12. post-update re-provisions tools authoritatively (mocked) ----
function Ensure-SentryOpenCode { param($Distro) return $script:MockTools.oc }
function Ensure-SentryDeepSeek { param($Distro, $RepoRoot) return $script:MockTools.ds }
function Ensure-SentryClaudeCode { param($Distro, $RepoRoot) return $script:MockTools.cc }
function Invoke-SentryRuntimeDeploy { param($Distro, $RepoRoot, $ProductVersion, $Sha) return '9.9.9-test' }
function Invoke-SentryRuntimeHandshake { param($Distro) return @{ protocolVersion = 1 } }
function Sync-SentryDistroPreference { param($RepoRoot, $Distro) return $true }
function Invoke-SentryOpen { param($RepoRoot) $script:OpenCalled++; return 0 }
function Install-SentryShim { param($RepoRoot) return }
function Set-SentryLauncherConfig { param($Values) return }
function Get-SentryLauncherConfig { return @{ selectedDistro = 'Ubuntu' } }
function Write-SentryLog { param($Message, $Kind) return }
function Get-SentryProductVersion { param($RepoRoot) return '0.1.0-beta.1' }
$script:NativeStubs = @{ '*' = @{ ExitCode = 0; Stdout = ''; Stderr = '' } }
$script:WslFileStubs = @{ 'check-sandbox.sh' = @{ ExitCode = 0; Stdout = ("HAVE-socat`nHAVE-bubblewrap`nSANDBOX_INIT_OK"); Stderr = '' } }
$script:OpenCalled = 0
$script:MockTools = @{ oc = $true; ds = $true; cc = $true }
$updOk = Invoke-SentryPostUpdate -RepoRoot $repoRoot -OldSha 'aaa' -NewSha 'bbb' -WasRunning $true
Assert-Equal 'postupdate-all-ok' $updOk 0
Assert-Equal 'postupdate-opens-when-ran' $script:OpenCalled 1
$script:OpenCalled = 0
$script:MockTools = @{ oc = $true; ds = $false; cc = $true }
$updPartial = Invoke-SentryPostUpdate -RepoRoot $repoRoot -OldSha 'aaa' -NewSha 'bbb' -WasRunning $true
Assert-Equal 'postupdate-partial-fails' $updPartial 2
Assert-Equal 'postupdate-no-reopen-when-broken' $script:OpenCalled 0
$script:MockTools = @{ oc = $true; ds = $true; cc = $true }
$script:OpenCalled = 0
$updIdle = Invoke-SentryPostUpdate -RepoRoot $repoRoot -OldSha 'aaa' -NewSha 'aaa' -WasRunning $false
Assert-Equal 'postupdate-idle-stays-stopped' $updIdle 0
Assert-Equal 'postupdate-idle-no-open' $script:OpenCalled 0
# ---- 13. privilege boundary: root only where required ----
function Invoke-SentryWsl {
  param($Distro, $LinuxArgs, $TimeoutSec = 60)
  if ($LinuxArgs[0] -eq 'node') { return @{ ExitCode = 0; Stdout = $script:MockNodeVer; Stderr = '' } }
  if ($LinuxArgs[0] -eq 'npm') {
    if ($script:MockNpmMode -eq 'ok') { return @{ ExitCode = 0; Stdout = '10.8.2'; Stderr = '' } }
    return @{ ExitCode = 1; Stdout = ''; Stderr = '' }
  }
  if ($LinuxArgs[0] -eq 'pnpm') { return @{ ExitCode = 1; Stdout = ''; Stderr = '' } }
  if (($LinuxArgs[0] -eq 'sh') -and ($script:MockNpmMode -eq 'missing')) { return @{ ExitCode = 1; Stdout = ''; Stderr = '' } }
  return @{ ExitCode = 0; Stdout = 'init-ok'; Stderr = '' }
}
$script:MockNodeVer = 'v20.1.0'
$script:MockNpmMode = 'ok'
$script:WslFileCalls = @()
$script:WslFileStubs = @{ 'check-systemd.sh' = @{ ExitCode = 0; Stdout = 'SYSTEMD_MISSING'; Stderr = '' } }
[void](Ensure-SentrySystemd -Distro 'Ubuntu')
Assert-True 'systemd-enable-runs-as-root' ((@($script:WslFileCalls) | Where-Object { $_ -like 'enable-systemd.sh root=True*' }).Count -gt 0)
Assert-True 'systemd-check-stays-user' ((@($script:WslFileCalls) | Where-Object { $_ -like 'check-systemd.sh root=False*' }).Count -gt 0)
$script:WslFileCalls = @()
[void](Ensure-SentryLinuxNode -Distro 'Ubuntu')
Assert-True 'node-install-runs-as-root' ((@($script:WslFileCalls) | Where-Object { $_ -like 'install-node.sh root=True*' }).Count -gt 0)
$script:WslFileCalls = @()
[void](Ensure-SentryLinuxPnpm -Distro 'Ubuntu' -RepoRoot $repoRoot)
Assert-True 'pnpm-install-runs-as-root' ((@($script:WslFileCalls) | Where-Object { $_ -like 'install-pnpm.sh root=True*' }).Count -gt 0)
$nodeVer = Get-SentryLinuxNodeVersion -Distro 'Ubuntu'
Assert-Equal 'node-version-probe-stays-user' $nodeVer 'v20.1.0'
$script:WslFileCalls = @()
$r = Invoke-SentryWslFile -Distro 'Ubuntu' -ScriptName 'check-deepseek.sh' -ScriptArgs @('0.1.5-rc.2') -TimeoutSec 60
Assert-True 'tool-check-stays-user' ((@($script:WslFileCalls) | Where-Object { $_ -like 'check-deepseek.sh root=False*' }).Count -gt 0)
# ---- 20. npm readiness: toolchain states and repair ----
$script:MockNodeVer = 'v22.14.0'
$script:MockNpmMode = 'ok'
$tcOk = Test-SentryLinuxNodeToolchain -Distro 'Ubuntu'
Assert-Equal 'toolchain-node22-npm-ok' $tcOk.Ready $true
$script:MockNpmMode = 'missing'
$tcMiss = Test-SentryLinuxNodeToolchain -Distro 'Ubuntu'
Assert-Equal 'toolchain-npm-missing-not-ready' $tcMiss.Ready $false
Assert-Equal 'toolchain-npm-missing-reason' $tcMiss.Reason 'npm-missing'
$script:MockNpmMode = 'broken'
$tcBroken = Test-SentryLinuxNodeToolchain -Distro 'Ubuntu'
Assert-Equal 'toolchain-npm-broken-not-ready' $tcBroken.Ready $false
Assert-Equal 'toolchain-npm-broken-reason' $tcBroken.Reason 'npm-broken'
$script:WslFileCalls = @()
$script:WslFileStubs = @{}
$nodeRepair = Ensure-SentryLinuxNode -Distro 'Ubuntu'
Assert-Equal 'toolchain-repair-verifies-both' $nodeRepair $false
Assert-True 'toolchain-repair-reinstalls-node' ((@($script:WslFileCalls) | Where-Object { $_ -like 'install-node.sh root=True*' }).Count -gt 0)
$script:MockNpmMode = 'ok'
$script:MockNodeVer = 'v20.1.0'
# ---- 21. base utilities and systemd states ----
$script:WslFileStubs = @{ 'check-base.sh' = @{ ExitCode = 0; Stdout = ("HAVE-bash`nHAVE-find`nHAVE-readlink`nHAVE-timeout`nHAVE-grep`nHAVE-sed"); Stderr = '' } }
$baseOk = Get-SentryBaseToolStatus -Distro 'Ubuntu'
Assert-Equal 'base-all-present' $baseOk.Missing.Count 0
$script:WslFileStubs = @{ 'check-base.sh' = @{ ExitCode = 0; Stdout = ("HAVE-bash`nMISS-timeout`nMISS-systemd-run"); Stderr = '' } }
$baseMiss = Get-SentryBaseToolStatus -Distro 'Ubuntu'
Assert-Equal 'base-missing-listed' ($baseMiss.Missing -join ',') 'timeout,systemd-run'
$script:WslFileStubs = @{ 'check-systemd.sh' = @{ ExitCode = 0; Stdout = 'SYSTEMD_BIN_MISSING'; Stderr = '' }; 'install-deps.sh' = @{ ExitCode = 0; Stdout = ''; Stderr = '' } }
$sysBin = Ensure-SentrySystemd -Distro 'Ubuntu'
Assert-True 'systemd-bin-missing-tries-install' ((@($script:WslFileCalls) | Where-Object { $_ -like 'install-deps.sh root=True*' }).Count -gt 0)
# ---- 14. PATH refresh merges machine/user without losing session entries ----
$sentinelDir = 'C:\SentryTestSentinelPath'
$env:PATH = ($env:PATH + ';' + $sentinelDir)
[void](Update-SentryProcessPath)
Assert-True 'path-refresh-keeps-session-entry' (($env:PATH -split ';') -contains $sentinelDir)
Assert-True 'path-refresh-no-dupes' (((@($env:PATH -split ';' | Where-Object { $_ -ne '' }).Count) -eq (@($env:PATH -split ';' | Where-Object { $_ -ne '' } | Select-Object -Unique).Count)))
$env:PATH = ((@($env:PATH -split ';' | Where-Object { $_ -ne $sentinelDir }) -join ';'))
# ---- 15. sandbox status parsing drives honest GLM gating (mocked) ----
$script:WslFileStubs = @{ 'check-sandbox.sh' = @{ ExitCode = 0; Stdout = ("HAVE-socat`nSOCAT_VERSION=socat version 1.8.0.3`nHAVE-bubblewrap`nBWRAP_VERSION=bubblewrap 0.10.1`nSANDBOX_INIT_OK"); Stderr = '' } }
$sbOk = Get-SentrySandboxStatus -Distro 'Ubuntu'
Assert-Equal 'sandbox-all-present' (([bool]$sbOk.Socat -and [bool]$sbOk.Bwrap -and [bool]$sbOk.InitOk)) $true
$script:WslFileStubs = @{ 'check-sandbox.sh' = @{ ExitCode = 0; Stdout = ("MISS-socat`nHAVE-bubblewrap`nBWRAP_VERSION=bubblewrap 0.10.1`nSANDBOX_INIT_OK"); Stderr = '' } }
$sbNoSoc = Get-SentrySandboxStatus -Distro 'Ubuntu'
Assert-Equal 'sandbox-socat-missing-detected' $sbNoSoc.Socat $false
Assert-Equal 'sandbox-bwrap-still-present' $sbNoSoc.Bwrap $true
$script:WslFileStubs = @{ 'check-sandbox.sh' = @{ ExitCode = 0; Stdout = ("MISS-socat`nMISS-bwrap`nSANDBOX_INIT_FAIL=bwrap-missing"); Stderr = '' } }
$sbBoth = Get-SentrySandboxStatus -Distro 'Ubuntu'
Assert-Equal 'sandbox-both-missing' (([bool](-not $sbBoth.Socat) -and [bool](-not $sbBoth.Bwrap))) $true
# ---- 22. setup order: missing systemd binaries reach systemd repair ----
$script:MockNodeVer = 'v22.14.0'
$script:MockNpmMode = 'ok'
$script:WslFileCalls = @()
$script:WslFileStubs = @{
  'check-base.sh' = @{ ExitCode = 0; Stdout = ("HAVE-bash`nHAVE-find`nHAVE-readlink`nHAVE-timeout`nHAVE-grep`nHAVE-sed"); Stderr = '' };
  'check-systemd.sh' = @{ ExitCode = 0; Stdout = 'SYSTEMD_BIN_MISSING'; Stderr = '' };
  'install-deps.sh' = @{ ExitCode = 0; Stdout = ''; Stderr = '' }
}
[void](Invoke-SentryToolchainPhase -Distro 'Ubuntu' -RepoRoot $repoRoot)
Assert-True 'order-base-ran' ((@($script:WslFileCalls) | Where-Object { $_ -like 'check-base.sh*' }).Count -gt 0)
Assert-True 'order-systemd-repair-reached' ((@($script:WslFileCalls) | Where-Object { $_ -like 'install-deps.sh root=True*systemd*' }).Count -gt 0)
# ---- 16. noninteractive install failure reports the apt command (E) ----
$script:WslFileStubs = @{
  'check-deps.sh' = @{ ExitCode = 0; Stdout = ("HAVE-git`nHAVE-curl`nHAVE-ca-certificates`nHAVE-bubblewrap`nMISS-socat"); Stderr = '' };
  'install-deps.sh' = @{ ExitCode = 1; Stdout = ''; Stderr = 'apt failed' }
}
$depsFail = Ensure-SentryLinuxDeps -Distro 'Ubuntu' -RepoRoot $repoRoot
Assert-Equal 'deps-install-failure-honest' $depsFail $false
# ---- 17. idempotency: PATH dedupe, no reinstall when healthy ----
Assert-Equal 'path-dedupe-hit' (Test-SentryPathEntry -PathText 'C:\A;C:\Users\x\AppData\Local\Sentry\bin;C:\B' -Dir 'C:\Users\x\AppData\Local\Sentry\bin') $true
Assert-Equal 'path-dedupe-trailing-slash' (Test-SentryPathEntry -PathText 'C:\A' -Dir 'C:\A\') $true
Assert-Equal 'path-dedupe-miss' (Test-SentryPathEntry -PathText 'C:\A;C:\B' -Dir 'C:\C') $false
Assert-Equal 'path-dedupe-empty' (Test-SentryPathEntry -PathText '' -Dir 'C:\C') $false
$script:WslFileCalls = @()
$script:WslFileStubs = @{ 'check-opencode.sh' = @{ ExitCode = 0; Stdout = ("CANDIDATE opencode opencode version 1.18.32`n"); Stderr = '' } }
$ocSkip = Ensure-SentryOpenCode -Distro 'Ubuntu'
Assert-Equal 'opencode-healthy-no-reinstall' $ocSkip $true
Assert-True 'opencode-install-not-invoked' ((@($script:WslFileCalls) | Where-Object { $_ -like 'install-opencode.sh*' }).Count -eq 0)
$script:WslFileCalls = @()
$script:WslFileStubs = @{ 'check-claude.sh' = @{ ExitCode = 0; Stdout = ("MANAGED=/home/u/.local/share/sentry/tools/claude-code/node_modules/.bin/claude`nMANAGED_VERSION=2.1.270 (Claude Code)`nMANAGED_NATIVE=linux`nMANAGED_OK"); Stderr = '' } }
$ccSkip = Ensure-SentryClaudeCode -Distro 'Ubuntu' -RepoRoot $repoRoot
Assert-Equal 'claude-managed-no-reinstall' $ccSkip $true
Assert-True 'claude-install-not-invoked' ((@($script:WslFileCalls) | Where-Object { $_ -like 'install-claude.sh*' }).Count -eq 0)
# ---- 19. install receives Ubuntu package names, never bare executables ----
$script:WslFileCalls = @()
$script:WslFileStubs = @{
  'check-deps.sh' = @{ ExitCode = 0; Stdout = ("HAVE-git`nHAVE-curl`nHAVE-ca-certificates`nMISS-bubblewrap`nMISS-socat"); Stderr = '' };
  'install-deps.sh' = @{ ExitCode = 0; Stdout = ''; Stderr = '' }
}
[void](Ensure-SentryLinuxDeps -Distro 'Ubuntu' -RepoRoot $repoRoot)
$installCall = @($script:WslFileCalls | Where-Object { $_ -like 'install-deps.sh*' })[0]
Assert-Equal 'install-args-use-package-names' ([string]$installCall) 'install-deps.sh root=True args=[bubblewrap,socat]'
$before = [Environment]::GetEnvironmentVariable('PATH', 'User')
Assert-True 'user-path-untouched' (([Environment]::GetEnvironmentVariable('PATH', 'User')) -eq $before)
# ---- 20. sentry cli forwards argv intact to the built CLI (no string concat) ----
$script:NativeCalls = @()
$cliHelpCode = Invoke-SentryCli -RepoRoot $repoRoot -CliArgs @()
Assert-Equal 'cli-noargs-help' $cliHelpCode 0
$script:NativeCalls = @()
$script:NativeStubs = @{ 'node *' = @{ ExitCode = 0; Stdout = ''; Stderr = '' } }
$cliCode = Invoke-SentryCli -RepoRoot $repoRoot -CliArgs @('project', 'add', 'C:\Users\User Name\Projects\Test App', '--json')
Assert-Equal 'cli-passthrough-exit' $cliCode 0
$nodeCall = @($script:NativeCalls | Where-Object { $_ -like 'node *' })[0]
Assert-True 'cli-uses-node-entry' ($nodeCall -like '*apps*cli*dist*index.js*project*add*--json*')
Assert-True 'cli-keeps-spaced-path' ($nodeCall.Contains('C:\Users\User Name\Projects\Test App'))
$script:NativeCalls = @()
[void](Invoke-SentryCli -RepoRoot $repoRoot -CliArgs @('run', 'start', 'proj_01K7777777777777777777A8W1', '--instructions', 'Check authentication and API validation', '--json'))
$runCall = @($script:NativeCalls | Where-Object { $_ -like 'node *' })[0]
Assert-True 'cli-keeps-instructions' ($runCall.Contains('Check authentication and API validation'))
Assert-Equal 'cli-captures-output' $script:LastNativeFlags['NoRedirect'] $false
Assert-Equal 'cli-no-truncate' $script:LastNativeFlags['NoTruncate'] $true
$script:NativeStubs = @{ 'node *' = @{ ExitCode = 3; Stdout = '{"ok":false}'; Stderr = 'diag' } }
$swOut = New-Object System.IO.StringWriter
$swErr = New-Object System.IO.StringWriter
$oldOut = [Console]::Out
$oldErr = [Console]::Error
[Console]::SetOut($swOut)
[Console]::SetError($swErr)
try { $fwdCode = Invoke-SentryCli -RepoRoot $repoRoot -CliArgs @('run', 'status', 'run_x') }
finally { [Console]::SetOut($oldOut); [Console]::SetError($oldErr) }
Assert-Equal 'cli-forwards-exit' $fwdCode 3
Assert-Equal 'cli-forwards-stdout' ($swOut.ToString()) '{"ok":false}'
Assert-Equal 'cli-forwards-stderr' ($swErr.ToString()) 'diag'
Assert-Equal 'cli-quoting-spaces' (Get-SentryQuotedArguments @('a b', 'e')) '"a b" e'
Assert-Equal 'cli-quoting-passthrough' (Get-SentryQuotedArguments @('project', 'add', 'C:\P\Test App')) 'project add "C:\P\Test App"'
# Credential diagnostics preserve the boolean protocol and unavailable INFO fallback.
function Get-SentryElectronExe { param($RepoRoot) return 'fixture-electron' }
$captureCredentials = { param($Name, $Level, $Detail) $script:CredentialRows += @(@{ Name=$Name; Level=$Level; Detail=$Detail }) }
foreach ($case in @('present', 'mixed', 'missing', 'unavailable', 'malformed', 'failed-report')) {
  $script:CredentialRows = @()
  $report = switch ($case) {
    'present' { 'SENTRY_CREDENTIAL_STATUS={"opencode":true,"deepseek":true,"glm":true}' }
    'mixed' { 'SENTRY_CREDENTIAL_STATUS={"opencode":false,"deepseek":true,"glm":false}' }
    'missing' { 'SENTRY_CREDENTIAL_STATUS={"opencode":false,"deepseek":false,"glm":false}' }
    'malformed' { 'SENTRY_CREDENTIAL_STATUS={' }
    'failed-report' { 'SENTRY_CREDENTIAL_STATUS={"opencode":false,"deepseek":false,"glm":false}' }
    default { '' }
  }
  $statusCode = if ($case -in @('unavailable', 'failed-report')) { 1 } else { 0 }
  $script:NativeStubs = @{ 'fixture-electron *' = @{ ExitCode=$statusCode; Stdout=$report; Stderr='sanitized unavailable guidance' } }
  Add-SentryCredentialReport -Add $captureCredentials -RepoRoot $repoRoot
  if ($case -in @('unavailable', 'malformed', 'failed-report')) {
    Assert-Equal "credentials-$case-row-count" $script:CredentialRows.Count 1
    Assert-Equal "credentials-$case-info" $script:CredentialRows[0].Level 'INFO'
    Assert-True "credentials-$case-guidance" ($script:CredentialRows[0].Detail.Contains('Settings -> Providers'))
  } else {
    $warns = @($script:CredentialRows | Where-Object { $_.Level -eq 'WARN' }).Count
    $expectedWarns = if ($case -eq 'present') { 0 } elseif ($case -eq 'mixed') { 2 } else { 3 }
    Assert-Equal "credentials-$case-presence" $warns $expectedWarns
    if ($case -eq 'mixed') { Assert-Equal 'credentials-independent-deepseek' (@($script:CredentialRows | Where-Object { $_.Name -eq 'DeepSeek credential' })[0].Level) 'PASS' }
  }
}
if ($script:failures -gt 0) { Write-Host ([string]("BEHAVIOR-FAIL " + $script:failures)); exit 1 }
Write-Host 'BEHAVIOR-OK'
exit 0
