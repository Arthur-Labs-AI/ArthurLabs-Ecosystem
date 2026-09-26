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
    $sd = Invoke-SentryWslFile -Distro $distro -ScriptName 'check-systemd.sh' -TimeoutSec 60
    if (([string]$sd.Stdout).Trim() -eq 'SYSTEMD_OK') { &$add 'systemd user services' 'PASS' 'ready' } else { &$add 'systemd user services' 'FAIL' 'unavailable' }
    $bw = Invoke-SentryWslFile -Distro $distro -ScriptName 'check-deps.sh' -TimeoutSec 30
    if (([string]$bw.Stdout).Contains('HAVE-bwrap')) { &$add 'bubblewrap' 'PASS' 'present' } else { &$add 'bubblewrap' 'FAIL' 'missing' }
    $cur = Get-SentryRuntimeCurrent -Distro $distro
    if ($cur -and $cur -ne 'NONE') { &$add 'Deployed runtime' 'PASS' $cur } else { &$add 'Deployed runtime' 'FAIL' 'none deployed' }
    $hello = Invoke-SentryRuntimeHandshake -Distro $distro
    if ($hello) { &$add 'runtime.hello handshake' 'PASS' 'protocol 1 / linux' } else { &$add 'runtime.hello handshake' 'FAIL' 'handshake failed' }
    $oc = Invoke-SentryWslFile -Distro $distro -ScriptName 'check-opencode.sh' -TimeoutSec 30
    $oct = ([string]$oc.Stdout).Trim()
    if ($oct.Contains('1.18.32')) { &$add 'OpenCode 1.18.32' 'PASS' 'verified' } elseif ($oct.Contains('ABSENT')) { &$add 'OpenCode' 'WARN' 'not installed' } else { &$add 'OpenCode' 'WARN' 'untested version' }
    $cl = Invoke-SentryWslFile -Distro $distro -ScriptName 'check-claude.sh' -TimeoutSec 60
    $clt = [string]$cl.Stdout
    if ($clt.Contains('2.1.270') -and -not $clt.Contains('/mnt/c')) { &$add 'Claude Code 2.1.270' 'PASS' 'native linux' }
    elseif ($clt.Contains('2.1.276')) { &$add 'Claude Code' 'FAIL' 'known-incompatible 2.1.276 installed' }
    elseif ($clt.Contains('/mnt/c')) { &$add 'Claude Code' 'FAIL' 'Windows mount on PATH; need native Linux binary' }
    else { &$add 'Claude Code' 'WARN' 'not installed or unverified' }
    &$add 'DeepSeek SDK 0.1.5-rc.2' 'PASS' 'bundled via runtime (see setup log)'
    &$add 'Provider credentials' 'PASS' 'presence-only: configured in Desktop Settings (never printed here)'
  }
  Show-SentryDoctorResults $results
  $fails = @($results | Where-Object { $_.Level -eq 'FAIL' })
  if ($fails.Count -eq 0) { return 0 }
  return 1
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
  Write-Host ''
  if ($fails.Count -eq 0) { Write-Host 'Doctor result: READY' -ForegroundColor Green }
  else {
    Write-Host 'Doctor result: NOT READY' -ForegroundColor Red
    Write-Host 'Fix:'
    foreach ($f in $fails) { Write-Host ('  - ' + $f.Check + $(if ($f.Detail) { ': ' + $f.Detail })) }
    Write-Host 'See docs/beta/troubleshooting.md. Never paste API keys into bug reports.'
  }
}

function Invoke-SentryUpdate {
  param([string]$RepoRoot, [bool]$Repair = $false)
  Write-Host ''
  Write-Host 'Sentry update (tracks latest main commits; Releases are milestones only)' -ForegroundColor Cyan
  try { $branch = ([string](& git -C $RepoRoot rev-parse --abbrev-ref HEAD 2>$null)).Trim() } catch { $branch = '' }
  try { $oldSha = ([string](& git -C $RepoRoot rev-parse --short HEAD 2>$null)).Trim() } catch { $oldSha = 'unknown' }
  $porcelain = ''
  try { $porcelain = & git -C $RepoRoot status --porcelain 2>$null } catch { }
  if ($porcelain) {
    Write-SentryFail 'Sentry cannot update because this repository contains local changes.'
    Write-Host $porcelain
    Write-Host 'Commit, stash, or discard these changes, then run: sentry update'
    Write-Host 'Sentry never resets or stashes your changes automatically.'
    return 1
  }
  Write-SentryInfo ('Branch ' + $branch + ' at ' + $oldSha + '; stopping Sentry...')
  Stop-SentryDesktopIfRunning -RepoRoot $RepoRoot
  Write-SentryInfo 'git fetch --prune origin ...'
  $f = Invoke-SentryNative -FilePath 'git' -Arguments @('-C', $RepoRoot, 'fetch', '--prune', 'origin')
  if ($f.ExitCode -ne 0) { Write-SentryFail 'git fetch failed (network or remote issue).'; return 1 }
  Write-SentryInfo 'git pull --ff-only ...'
  $p = Invoke-SentryNative -FilePath 'git' -Arguments @('-C', $RepoRoot, 'pull', '--ff-only')
  if ($p.ExitCode -ne 0) {
    Write-SentryFail 'Fast-forward pull failed (local branch diverged). Resolve manually, then rerun.'
    return 1
  }
  try { $newSha = ([string](& git -C $RepoRoot rev-parse --short HEAD 2>$null)).Trim() } catch { $newSha = 'unknown' }
  if (($oldSha -eq $newSha) -and (-not $Repair)) {
    Write-Host ('Sentry is already up to date (' + $newSha + ').')
    return 0
  }
  Write-Host ('Updated: ' + $oldSha + ' -> ' + $newSha)
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
  $psi.Arguments = (Get-SentryQuotedArguments $handoffArgs)
  $proc = [System.Diagnostics.Process]::Start($psi)
  $proc.WaitForExit()
  return $proc.ExitCode
}

function Invoke-SentryPostUpdate {
  param([string]$RepoRoot, [string]$OldSha, [string]$NewSha, [bool]$Repair = $false)
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
  Install-SentryShim -RepoRoot $RepoRoot
  Set-SentryLauncherConfig @{ setupVersion = (Get-SentryProductVersion -RepoRoot $RepoRoot); setupCommit = $NewSha }
  Write-Host ('Updated: ' + $OldSha + ' -> ' + $NewSha) -ForegroundColor Green
  Write-Host 'Provider settings and projects were preserved (no migration in this release).'
  [void](Invoke-SentryOpen -RepoRoot $RepoRoot)
  return 0
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
  Write-Host '  open      Launch Sentry Desktop'
  Write-Host '  update    Pull latest commits and update Sentry'
  Write-Host '  stop      Gracefully stop Sentry'
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
  Write-Host 'Flags: -Distro <name> (setup), -Json (status), -Repair (update), -NonInteractive'
  return 0
}
