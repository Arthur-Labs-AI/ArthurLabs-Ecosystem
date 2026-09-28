# commands2.ps1 — doctor, update, version, help.

function Invoke-SentryDoctor {
  $RepoRoot = Get-SentryRepoRoot
  $results = New-Object System.Collections.ArrayList
  $add = { param([string]$Name, [string]$Level, [string]$Detail = '') [void]$results.Add([pscustomobject]@{ Check = $Name; Level = $Level; Detail = $Detail }) }
  $git = Invoke-SentryNative -FilePath 'git' -Arguments @('--version')
  if ($git.ExitCode -eq 0) { &$add 'Git' 'PASS' (([string]$git.Stdout).Trim()) } else { &$add 'Git' 'FAIL' 'not on PATH' }
  try { $t = & git -C $RepoRoot rev-parse --show-toplevel 2>$null; if ($LASTEXITCODE -eq 0) { &$add 'Repository' 'PASS' (([string]$t).Trim()) } else { &$add 'Repository' 'FAIL' 'not a git checkout' } } catch { &$add 'Repository' 'FAIL' 'git error' }
  try { $s = & git -C $RepoRoot status --porcelain 2>$null; if ($LASTEXITCODE -eq 0 -and -not $s) { &$add 'Working tree' 'PASS' 'clean' } elseif ($LASTEXITCODE -eq 0) { &$add 'Working tree' 'WARN' 'local changes present' } } catch { }
  $wn = Get-SentryWindowsNodeVersion
  if ($wn -match '^v?(\d+)\.') { if ([int]$Matches[1] -ge 22) { &$add 'Windows Node' 'PASS' $wn } else { &$add 'Windows Node' 'FAIL' ($wn + ' (< 22)') } }
  else { &$add 'Windows Node' 'FAIL' 'missing' }
  $wp = Get-SentryWindowsPnpmVersion
  $pinned = Get-SentryPinnedPnpmVersion -RepoRoot $RepoRoot
  if ($wp -eq $pinned) { &$add 'Windows pnpm' 'PASS' $wp } elseif ($wp) { &$add 'Windows pnpm' 'WARN' ($wp + ' vs pinned ' + $pinned) } else { &$add 'Windows pnpm' 'FAIL' 'missing' }
  if (Test-Path (Join-Path $RepoRoot 'apps/desktop/dist/main/index.js')) { &$add 'Desktop build' 'PASS' 'dist present' } else { &$add 'Desktop build' 'FAIL' 'run sentry setup' }
  if (Get-SentryElectronExe -RepoRoot $RepoRoot) { &$add 'Electron binary' 'PASS' 'present' } else { &$add 'Electron binary' 'FAIL' 'missing' }
  if (Test-SentryWslAvailable) { &$add 'WSL availability' 'PASS' 'wsl.exe responds' } else { &$add 'WSL availability' 'FAIL' 'wsl.exe --status failed'; Show-SentryDoctorResults $results; return 1 }
  $cfg = Get-SentryLauncherConfig
  $distro = [string]$cfg['selectedDistro']
  $distros = @(Get-SentryWslDistros)
  $usable = @(Get-SentryUsableDistros $distros)
  if (-not $distro) {
    if ($usable.Count -gt 0) { $distro = $usable[0].Name; &$add 'Selected distro' 'WARN' ('none saved; would use ' + $distro) }
    else { &$add 'Selected distro' 'FAIL' 'no usable WSL2 distro' }
  } else { &$add 'Selected distro' 'PASS' $distro }
  if ($distro) {
    $ln = Get-SentryLinuxNodeVersion -Distro $distro
    if ($ln -match '^v?(\d+)\.') { if ([int]$Matches[1] -ge 22) { &$add 'Linux Node (direct exec)' 'PASS' $ln } else { &$add 'Linux Node (direct exec)' 'FAIL' ($ln + ' (< 22)') } }
    else { &$add 'Linux Node (direct exec)' 'FAIL' 'node not directly executable' }
    $lp = Invoke-SentryWsl -Distro $distro -LinuxArgs @('pnpm', '--version') -TimeoutSec 30
    if ($lp.ExitCode -eq 0) { &$add 'Linux pnpm' 'PASS' (([string]$lp.Stdout).Trim()) } else { &$add 'Linux pnpm' 'FAIL' 'missing' }
    $lnpm = Invoke-SentryWsl -Distro $distro -LinuxArgs @('npm', '--version') -TimeoutSec 30
    if ($lnpm.ExitCode -eq 0) { &$add 'Linux npm (direct exec)' 'PASS' (([string]$lnpm.Stdout).Trim()) } else { &$add 'Linux npm (direct exec)' 'FAIL' 'npm missing or unusable (Node toolchain incomplete)' }
    $base = Get-SentryBaseToolStatus -Distro $distro
    if ($base.Missing.Count -eq 0) { &$add 'Base Linux utilities' 'PASS' 'bash, find, readlink, timeout, grep, sed' }
    else { &$add 'Base Linux utilities' 'FAIL' ('missing: ' + ($base.Missing -join ', ')) }
    $sd = Invoke-SentryWslFile -Distro $distro -ScriptName 'check-systemd.sh' -TimeoutSec 60
    $sdState = ([string]$sd.Stdout).Trim()
    if ($sdState -eq 'SYSTEMD_OK') { &$add 'systemd user services' 'PASS' 'ready' }
    elseif ($sdState -eq 'SYSTEMD_BIN_MISSING') { &$add 'systemd user services' 'FAIL' 'systemd binaries missing (distinct from disabled)' }
    elseif ($sdState -eq 'SYSTEMD_DISABLED') { &$add 'systemd user services' 'FAIL' 'installed but not enabled in /etc/wsl.conf' }
    elseif ($sdState -eq 'SYSTEMD_USER_UNAVAILABLE') { &$add 'systemd user services' 'FAIL' 'enabled but user manager not responding' }
    else { &$add 'systemd user services' 'FAIL' 'unavailable' }
    $sb = Get-SentrySandboxStatus -Distro $distro
    if ($sb.Socat) { &$add 'socat' 'PASS' $sb.SocatVersion } else { &$add 'socat' 'FAIL' 'not installed in Ubuntu (GLM sandbox requires it)' }
    if ($sb.Bwrap) { &$add 'bubblewrap' 'PASS' $sb.BwrapVersion } else { &$add 'bubblewrap' 'FAIL' 'not installed in Ubuntu (GLM sandbox requires it)' }
    if ($sb.Socat -and $sb.Bwrap) {
      if ($sb.InitOk) { &$add 'Claude sandbox init' 'PASS' 'bubblewrap smoke passed (no model contact)' }
      else { &$add 'Claude sandbox init' 'FAIL' ('bubblewrap cannot initialize: ' + $sb.InitDetail) }
    }
    $cur = Get-SentryRuntimeCurrent -Distro $distro
    if ($cur -and $cur -ne 'NONE') { &$add 'Deployed runtime' 'PASS' $cur } else { &$add 'Deployed runtime' 'FAIL' 'none deployed' }
    $hello = Invoke-SentryRuntimeHandshake -Distro $distro
    if ($hello) {
      &$add 'runtime.hello handshake' 'PASS' 'protocol 1 / linux'
      &$add 'Runtime protocol' 'PASS' ('v' + [string]$hello.protocolVersion)
      &$add 'Runtime Node/platform' 'PASS' ([string]$hello.nodeVersion + ' / ' + [string]$hello.platform)
      &$add 'Sentry data root' 'PASS' ([string]$hello.dataRoot)
    } else { &$add 'runtime.hello handshake' 'FAIL' 'handshake failed' }
    $oc = Invoke-SentryWslFile -Distro $distro -ScriptName 'check-opencode.sh' -TimeoutSec 30
    $oct = ([string]$oc.Stdout).Trim()
    if ($oct.Contains('1.18.32')) { &$add 'OpenCode executable' 'PASS' '1.18.32 preflight-probed' } elseif ($oct.Contains('ABSENT')) { &$add 'OpenCode executable' 'FAIL' 'not installed' } else { &$add 'OpenCode executable' 'WARN' 'untested version' }
    $dse = Get-SentryExpectedDeepSeekVersion -RepoRoot $RepoRoot
    $ds = Invoke-SentryWslFile -Distro $distro -ScriptName 'check-deepseek.sh' -ScriptArgs @($dse) -TimeoutSec 60
    $dst = [string]$ds.Stdout
    if ($dst.Contains('DSH_OK')) { &$add 'DeepSeek runtime' 'PASS' ($dse + ' managed, preflight-probed') }
    elseif ($dst.Contains('DSH_DRIFT')) { &$add 'DeepSeek runtime' 'FAIL' 'managed binary version drift' }
    elseif ($dst.Contains('DSH_BROKEN')) { &$add 'DeepSeek runtime' 'FAIL' 'managed binary does not execute' }
    else { &$add 'DeepSeek runtime' 'FAIL' 'managed dsh executable missing' }
    $cl = Invoke-SentryWslFile -Distro $distro -ScriptName 'check-claude.sh' -ScriptArgs @('2.1.270') -TimeoutSec 60
    $clt = [string]$cl.Stdout
    $claudeBinary = ''
    if ($clt.Contains('MANAGED_OK')) { $claudeBinary = '2.1.270 Sentry-managed native Linux' }
    elseif ($clt.Contains('PATH_OK') -and $clt.Contains('PATH_NATIVE=linux')) { $claudeBinary = '2.1.270 existing native install (global untouched)' }
    if ($claudeBinary -and (-not ($sb.Socat -and $sb.Bwrap -and $sb.InitOk))) {
      $missingSandbox = @()
      if (-not $sb.Socat) { $missingSandbox += '`socat` is not installed in Ubuntu' }
      if (-not $sb.Bwrap) { $missingSandbox += '`bubblewrap` is not installed in Ubuntu' }
      if (($sb.Socat -and $sb.Bwrap) -and (-not $sb.InitOk)) { $missingSandbox += 'bubblewrap cannot initialize (' + $sb.InitDetail + ')' }
      &$add 'Claude Code' 'FAIL' ('Sandbox unavailable: ' + ($missingSandbox -join '; ') + '. GLM runs will fail closed.')
    }
    elseif ($claudeBinary) { &$add 'Claude Code' 'PASS' ($claudeBinary + '; sandbox ready') }
    elseif ($clt.Contains('2.1.276')) { &$add 'Claude Code' 'FAIL' 'known-incompatible 2.1.276; Sentry-managed 2.1.270 required' }
    elseif ($clt.Contains('windows-mount')) { &$add 'Claude Code' 'FAIL' 'Windows mount on PATH; Sentry-managed native binary required' }
    else { &$add 'Claude Code' 'FAIL' 'no usable 2.1.270 binary' }
    Add-SentryCredentialReport -Add $add -RepoRoot $RepoRoot
  }
  Show-SentryDoctorResults $results
  $fails = @($results | Where-Object { $_.Level -eq 'FAIL' })
  if ($fails.Count -eq 0) { return 0 }
  return 1
}

function Add-SentryCredentialReport {
  param($Add, [string]$RepoRoot)
  $exe = Get-SentryElectronExe -RepoRoot $RepoRoot
  if (-not $exe) {
    &$Add 'Provider credentials' 'INFO' 'verify in Desktop -> Settings -> Providers / Environment'
    return
  }
  $appDir = Join-Path $RepoRoot 'apps/desktop'
  $r = Invoke-SentryNative -FilePath $exe -Arguments @('.', '--sentry-credential-status') -Workdir $appDir -TimeoutSec 120 -NoRedirect $false
  $line = @(([string]$r.Stdout -split "`n") | Where-Object { $_.Contains('SENTRY_CREDENTIAL_STATUS=') })[0]
  if ((-not $line) -or ($r.ExitCode -ne 0)) {
    &$Add 'Provider credentials' 'INFO' 'verify in Desktop -> Settings -> Providers / Environment'
    return
  }
  try { $status = ($line.Substring($line.IndexOf('=') + 1) | ConvertFrom-Json) } catch {
    &$Add 'Provider credentials' 'INFO' 'verify in Desktop -> Settings -> Providers / Environment'
    return
  }
  $missing = @()
  if ($status.opencode) { &$Add 'OpenCode credential' 'PASS' 'configured' } else { &$Add 'OpenCode credential' 'WARN' 'not configured'; $missing += 'OpenCode' }
  if ($status.deepseek) { &$Add 'DeepSeek credential' 'PASS' 'configured' } else { &$Add 'DeepSeek credential' 'WARN' 'not configured'; $missing += 'DeepSeek' }
  if ($status.glm) { &$Add 'GLM credential' 'PASS' 'configured' } else { &$Add 'GLM credential' 'WARN' 'not configured'; $missing += 'GLM' }
  if ($missing.Count -eq 0) { &$Add 'Agent configuration' 'PASS' 'all three provider credentials present' }
  else { &$Add 'Agent configuration' 'INFO' ('missing: ' + ($missing -join ', ') + ' — configure in Desktop Settings') }
}

function Show-SentryDoctorResults {
  param($Results)
  Write-Host ''
  Write-Host 'Sentry doctor' -ForegroundColor Cyan
  foreach ($r in $Results) {
    $color = 'Green'; if ($r.Level -eq 'WARN') { $color = 'Yellow' }; if ($r.Level -eq 'FAIL') { $color = 'Red' }
    Write-Host ('  [' + $r.Level + '] ' + $r.Check + $(if ($r.Detail) { ' — ' + $r.Detail })) -ForegroundColor $color
  }
  $fails = @($Results | Where-Object { $_.Level -eq 'FAIL' })
  $warns = @($Results | Where-Object { $_.Level -eq 'WARN' })
  Write-Host ''
  if ($fails.Count -eq 0) {
    Write-Host 'Doctor result: READY (core infrastructure)' -ForegroundColor Green
    if ($warns.Count -gt 0) { Write-Host 'Configuration: some provider credentials are missing — configure them in Desktop Settings -> Providers.' -ForegroundColor Yellow }
  }
  else {
    Write-Host 'Doctor result: NOT READY' -ForegroundColor Red
    Write-Host 'Fix:'
    foreach ($f in $fails) { Write-Host ('  - ' + $f.Check + $(if ($f.Detail) { ': ' + $f.Detail })) }
    Write-Host 'See docs/beta/troubleshooting.md. Never paste API keys into bug reports.'
  }
}

function Test-SentryUpdateBranch {
  param([string]$Branch)
  if ($Branch -ceq 'main') { return '' }
  return ('Sentry Beta updates track origin/main.' + "`n`n" + 'Current branch:' + "`n" + '    ' + $Branch + "`n`n" + 'Switch to main and rerun:' + "`n" + '    git switch main' + "`n" + '    sentry update')
}

function Test-SentryUpdateNeeded {
  param([string]$HeadSha, [string]$RemoteSha)
  if (-not $HeadSha -or -not $RemoteSha) { return $true }
  return ($HeadSha -cne $RemoteSha)
}

function Invoke-SentryUpdate {
  param([string]$RepoRoot, [bool]$Repair = $false)
  Write-Host ''
  Write-Host 'Sentry update (tracks latest origin/main commits; Releases are milestones only)' -ForegroundColor Cyan
  try { $branch = ([string](& git -C $RepoRoot rev-parse --abbrev-ref HEAD 2>$null)).Trim() } catch { $branch = '' }
  $branchRefusal = Test-SentryUpdateBranch -Branch $branch
  if ($branchRefusal) {
    Write-SentryFail $branchRefusal
    Write-SentryInfo 'Zero Git mutations were made.'
    return 1
  }
  try { $oldSha = ([string](& git -C $RepoRoot rev-parse HEAD 2>$null)).Trim() } catch { $oldSha = '' }
  $porcelain = ''
  try { $porcelain = & git -C $RepoRoot status --porcelain 2>$null } catch { }
  if ($porcelain) {
    Write-SentryFail 'Sentry cannot update because this repository contains local changes.'
    Write-Host $porcelain
    Write-Host 'Commit, stash, or discard these changes, then run: sentry update'
    Write-Host 'Sentry never resets or stashes your changes automatically.'
    return 1
  }
  Write-SentryInfo 'git fetch --prune origin main ...'
  $f = Invoke-SentryNative -FilePath 'git' -Arguments @('-C', $RepoRoot, 'fetch', '--prune', 'origin', 'main')
  if ($f.ExitCode -ne 0) { Write-SentryFail 'git fetch failed (network or remote issue).'; return 1 }
  try { $remoteSha = ([string](& git -C $RepoRoot rev-parse origin/main 2>$null)).Trim() } catch { $remoteSha = '' }
  if (-not $remoteSha) { Write-SentryFail 'origin/main is unavailable after fetch.'; return 1 }
  $wasRunning = (@(Get-SentryDesktopProcesses).Count -gt 0)
  if ((-not (Test-SentryUpdateNeeded -HeadSha $oldSha -RemoteSha $remoteSha)) -and (-not $Repair)) {
    if ($wasRunning) { Write-Host ('Sentry is already up to date (' + $oldSha.Substring(0, [Math]::Min(9, $oldSha.Length)) + '). Sentry left running.') }
    else { Write-Host ('Sentry is already up to date (' + $oldSha.Substring(0, [Math]::Min(9, $oldSha.Length)) + ').') }
    return 0
  }
  if ($wasRunning) {
    Write-SentryInfo 'An update is available; stopping Sentry...'
    Stop-SentryDesktopIfRunning -RepoRoot $RepoRoot
  }
  Write-SentryInfo 'git merge --ff-only origin/main ...'
  $p = Invoke-SentryNative -FilePath 'git' -Arguments @('-C', $RepoRoot, 'merge', '--ff-only', 'origin/main')
  if ($p.ExitCode -ne 0) {
    Write-SentryFail 'Fast-forward to origin/main failed (local main diverged). Resolve manually, then rerun.'
    Write-SentryInfo 'Sentry was stopped; reopen it with: sentry open'
    return 1
  }
  try { $newSha = ([string](& git -C $RepoRoot rev-parse HEAD 2>$null)).Trim() } catch { $newSha = $remoteSha }
  Write-Host ('Updated: ' + $oldSha.Substring(0, [Math]::Min(9, $oldSha.Length)) + ' -> ' + $newSha.Substring(0, [Math]::Min(9, $newSha.Length)))
  Write-SentryInfo 'Re-executing the updated launcher for install/build/deploy...'
  $newLauncher = Join-Path $RepoRoot 'sentry.ps1'
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'powershell.exe'
  $psi.UseShellExecute = $false
  $handoffArgs = @()
  $handoffArgs += '-NoProfile'; $handoffArgs += '-ExecutionPolicy'; $handoffArgs += 'Bypass'
  $handoffArgs += '-File'; $handoffArgs += $newLauncher; $handoffArgs += '__post-update'
  $handoffArgs += $oldSha; $handoffArgs += $newSha
  if ($Repair) { $handoffArgs += '-Repair' }
  if ($wasRunning) { $handoffArgs += '-WasRunning' }
  $psi.Arguments = (Get-SentryQuotedArguments $handoffArgs)
  $proc = [System.Diagnostics.Process]::Start($psi)
  $proc.WaitForExit()
  return $proc.ExitCode
}

function Invoke-SentryPostUpdate {
  param([string]$RepoRoot, [string]$OldSha, [string]$NewSha, [bool]$Repair = $false, [bool]$WasRunning = $false)
  Write-SentryLog ('post-update ' + $OldSha + ' -> ' + $NewSha) 'update'
  $cfg = Get-SentryLauncherConfig
  $distro = [string]$cfg['selectedDistro']
  if (-not $distro) {
    $distros = @(Get-SentryWslDistros)
    $distro = Select-SentryDistro -Distros $distros -NonInteractive $true
  }
  if (-not $distro) { Write-SentryFail 'No usable WSL2 distro after update.'; return 1 }
  Write-SentryInfo 'pnpm install --frozen-lockfile ...'
  $r = Invoke-SentryNative -FilePath 'pnpm' -Arguments @('install', '--frozen-lockfile') -Workdir $RepoRoot
  if ($r.ExitCode -ne 0) { Write-SentryFail 'pnpm install failed after update.'; return 1 }
  Write-SentryInfo 'pnpm build ...'
  $r = Invoke-SentryNative -FilePath 'pnpm' -Arguments @('build') -Workdir $RepoRoot
  if ($r.ExitCode -ne 0) { Write-SentryFail 'pnpm build failed after update.'; return 1 }
  $deployed = Invoke-SentryRuntimeDeploy -Distro $distro -RepoRoot $RepoRoot
  if (-not $deployed) { return 1 }
  $hello = Invoke-SentryRuntimeHandshake -Distro $distro
  if (-not $hello) { return 1 }
  [void](Sync-SentryDistroPreference -RepoRoot $RepoRoot -Distro $distro)
  Write-SentrySection 'Agent tools (re-provision after update)'
  $oc = Ensure-SentryOpenCode -Distro $distro
  $ds = Ensure-SentryDeepSeek -Distro $distro -RepoRoot $RepoRoot
  $cc = Ensure-SentryClaudeCode -Distro $distro -RepoRoot $RepoRoot
  $updSandbox = Get-SentrySandboxStatus -Distro $distro
  $cc = ([bool]$cc) -and $updSandbox.Socat -and $updSandbox.Bwrap -and $updSandbox.InitOk
  if (-not $cc) { Write-SentryWarn 'GLM sandbox not fully ready (see sentry doctor).' }
  Install-SentryShim -RepoRoot $RepoRoot
  Set-SentryLauncherConfig @{ setupVersion = (Get-SentryProductVersion -RepoRoot $RepoRoot); setupCommit = $NewSha }
  if (-not ($oc -and $ds -and $cc)) {
    Write-SentryFail 'Sentry source was updated, but agent tooling is not fully ready.'
    Write-Host 'Agent readiness:'
    if ($oc) { Write-Host '  OpenCode PASS' } else { Write-Host '  OpenCode FAIL' }
    if ($ds) { Write-Host '  DeepSeek PASS' } else { Write-Host '  DeepSeek FAIL' }
    if ($cc) { Write-Host '  GLM PASS' } else { Write-Host '  GLM FAIL' }
    Write-Host 'Git was advanced and the previous runtime was preserved; nothing was reset.'
    Write-Host 'Provider settings and projects were preserved.'
    Write-Host 'Run:'
    Write-Host '    sentry doctor'
    Write-Host 'Sentry stays stopped until tooling is ready.'
    return 2
  }
  Write-Host ('Updated: ' + $OldSha + ' -> ' + $NewSha) -ForegroundColor Green
  Write-Host 'Provider settings and projects were preserved (no migration in this release).'
  $shaChanged = ($OldSha -cne $NewSha)
  if ($WasRunning -or $shaChanged) { [void](Invoke-SentryOpen -RepoRoot $RepoRoot) }
  else { Write-Host 'Sentry was not running before; leaving it stopped.' }
  return 0
}

function Show-SentryCliHelp {
  Write-Host ''
  Write-Host 'Sentry CLI (same runtime as Desktop)' -ForegroundColor Cyan
  Write-Host ''
  Write-Host 'Usage:'
  Write-Host '  sentry cli <command>'
  Write-Host ''
  Write-Host 'Sentry Desktop must be running (sentry open). The CLI is a frontend:'
  Write-Host 'it never opens the database or starts its own runtime.'
  Write-Host ''
  Write-Host 'Commands:'
  Write-Host '  capabilities [--json]'
  Write-Host '  project list [--json]'
  Write-Host '  project add "<windows-path>" [--json]'
  Write-Host '  project show <project-id> [--json]'
  Write-Host '  project update <project-id> [path] [--json]'
  Write-Host '  project delete <project-id> --yes [--json]'
  Write-Host '  project revisions <project-id> [--json]'
  Write-Host '  project doctor <project-id> [--json]'
  Write-Host '  agent list [--json]'
  Write-Host '  agent doctor opencode|deepseek|glm [--json]'
  Write-Host '  run start <project-id> --mode full|targeted [--agents opencode,deepseek,glm] [--paths a,b] [--wait] [--json]'
  Write-Host '  run list <project-id> [--json]'
  Write-Host '  run show <run-id> [--json]'
  Write-Host '  run status <run-id> [--json]'
  Write-Host '  run cancel <run-id> [--json]'
  Write-Host '  run result <run-id> [--json]'
  Write-Host '  run export <run-id> --format log|json --out <path> [--json]'
  Write-Host '  issue list <project-id> [--json]'
  Write-Host '  issue show <issue-id> [--json]'
  Write-Host '  issue history <issue-id> [--json]'
  Write-Host '  retest start <issue-id> [--revision <id>] [--agents opencode,deepseek,glm] --wait [--json]'
  Write-Host '  retest show <retest-run-id> [--json]'
  Write-Host '  retest cancel <retest-run-id> [--json]'
  Write-Host ''
  Write-Host 'Automation (Nexus): always pass --json and parse stdout with JSON.parse.'
  Write-Host 'Start async, poll status, then fetch the result:'
  Write-Host '  sentry cli run start <project> --mode full --json'
  Write-Host '  sentry cli run status <run-id> --json'
  Write-Host '  sentry cli run result <run-id> --json'
  return 0
}

function Invoke-SentryCli {
  param([string]$RepoRoot, [string[]]$CliArgs = @())
  if ($CliArgs.Count -eq 0 -or $CliArgs -contains '--help' -or $CliArgs -contains '-h') {
    return (Show-SentryCliHelp)
  }
  $entry = Join-Path $RepoRoot 'apps/cli/dist/index.js'
  if (-not (Test-Path $entry)) {
    Write-Host 'Sentry CLI is not built. Run: sentry setup' -ForegroundColor Red
    return 1
  }
  # Capture-and-forward (never inherit): under programmatic capture (Nexus
  # process execution, CI, this harness) an inheriting grandchild's stdout can
  # be lost entirely, and Nexus must always receive exactly one JSON document
  # on stdout for --json. NoTruncate keeps large canonical results intact.
  $nodeArgs = @($entry) + $CliArgs
  $r = Invoke-SentryNative -FilePath 'node' -Arguments $nodeArgs -NoTruncate $true
  if ($r.Stdout -ne '') { [Console]::Out.Write($r.Stdout) }
  if ($r.Stderr -ne '') { [Console]::Error.Write($r.Stderr) }
  return $r.ExitCode
}

function Invoke-SentryVersion {
  param([string]$RepoRoot)
  $version = Get-SentryProductVersion -RepoRoot $RepoRoot
  $sha = Get-SentryShortSha -RepoRoot $RepoRoot
  $branch = ''
  try { $b = & git -C $RepoRoot rev-parse --abbrev-ref HEAD 2>$null; if ($LASTEXITCODE -eq 0) { $branch = ([string]$b).Trim() } } catch { }
  Write-Host ('Sentry v' + $version)
  Write-Host ('Commit ' + $sha)
  if ($branch) { Write-Host ('Branch ' + $branch) }
  return 0
}

function Show-SentryHelp {
  Write-Host ''
  Write-Host 'Sentry v0.1 Beta' -ForegroundColor Cyan
  Write-Host ''
  Write-Host 'Usage:'
  Write-Host '  sentry <command>'
  Write-Host ''
  Write-Host 'Commands:'
  Write-Host '  setup     Prepare Windows, WSL and Sentry'
  Write-Host '  repair    Rerun full setup/validation flow (idempotent; repairs what failed)'
  Write-Host '  open      Launch Sentry Desktop'
  Write-Host '  update    Pull latest commits and update Sentry'
  Write-Host '  stop      Gracefully stop Sentry'
  Write-Host '  cli       Control the running Desktop (same runtime; automation uses --json)'
  Write-Host '  status    Show installation status'
  Write-Host '  doctor    Run detailed diagnostics'
  Write-Host '  version   Show version and commit'
  Write-Host '  help      Show this help'
  Write-Host ''
  Write-Host 'Examples:'
  Write-Host '  sentry setup'
  Write-Host '  sentry open'
  Write-Host '  sentry update'
  Write-Host ''
  Write-Host 'Flags: -Distro <name> (setup), -Json (status), -Repair (update rebuild), -NonInteractive'
  return 0
}
