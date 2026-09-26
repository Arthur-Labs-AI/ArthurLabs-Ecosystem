# commands.ps1 — user-facing sentry commands. Dot-sourced by sentry.ps1 via the module.

function Invoke-SentrySetup {
  param([string]$RepoRoot, [string]$DistroFlag = '', [bool]$NonInteractive = $false)
  $version = Get-SentryProductVersion -RepoRoot $RepoRoot
  Write-Host ''
  Write-Host ('Sentry v0.1 Beta Setup (product ' + $version + ')') -ForegroundColor Cyan
  Write-SentryLog ('setup start version=' + $version + ' sha=' + (Get-SentryShortSha -RepoRoot $RepoRoot)) 'setup'
  Stop-SentryDesktopIfRunning -RepoRoot $RepoRoot
  $failed = $false
  Write-SentrySection '[1/7] Windows prerequisites'
  if (-not (Test-SentryGit)) { $failed = $true }
  if (-not (Test-SentryWindowsNode)) { $failed = $true }
  if (-not (Test-SentryWindowsPnpm -RepoRoot $RepoRoot)) { $failed = $true }
  if ($failed) { Write-SentryFail 'Windows prerequisites incomplete. Fix the items above and rerun: sentry setup'; return 1 }
  Write-SentrySection '[2/7] WSL distribution'
  $prevCfg = Get-SentryLauncherConfig
  $prevDistro = ''
  if ($prevCfg['selectedDistro']) { $prevDistro = [string]$prevCfg['selectedDistro'] }
  $wslResult = Ensure-SentryWslDistro -Explicit $DistroFlag -NonInteractive $NonInteractive -Previous $prevDistro
  if ($wslResult.RebootRequired) { return $script:SentryRebootExitCode }
  if (-not $wslResult.Distro) { Write-SentryFail 'No usable WSL2 distro.'; return 1 }
  $distro = $wslResult.Distro
  Set-SentryLauncherConfig @{ selectedDistro = $distro }
  Write-SentrySection '[3/7] Linux toolchain'
  if (-not (Ensure-SentrySystemd -Distro $distro)) { $failed = $true }
  if (-not (Ensure-SentryLinuxNode -Distro $distro)) { $failed = $true }
  if (-not (Ensure-SentryLinuxPnpm -Distro $distro -RepoRoot $RepoRoot)) { $failed = $true }
  if (-not (Ensure-SentryLinuxDeps -Distro $distro -RepoRoot $RepoRoot)) { $failed = $true }
  if ($failed) { Write-SentryFail 'Linux toolchain incomplete. See messages above.'; return 1 }
  Write-SentrySection '[4/7] Sentry dependencies'
  Write-SentryInfo 'pnpm install --frozen-lockfile ...'
  $r = Invoke-SentryNative -FilePath 'pnpm' -Arguments @('install', '--frozen-lockfile') -Workdir $RepoRoot
  Write-SentryLog ('pnpm install exit=' + $r.ExitCode) 'setup'
  if ($r.ExitCode -ne 0) { Write-SentryFail 'pnpm install failed.'; Write-Host $r.Stderr; return 1 }
  Write-SentryInfo 'pnpm build ...'
  $r = Invoke-SentryNative -FilePath 'pnpm' -Arguments @('build') -Workdir $RepoRoot
  Write-SentryLog ('pnpm build exit=' + $r.ExitCode) 'setup'
  if ($r.ExitCode -ne 0) { Write-SentryFail 'pnpm build failed.'; Write-Host $r.Stderr; return 1 }
  $main = Join-Path $RepoRoot 'apps/desktop/dist/main/index.js'
  $preload = Join-Path $RepoRoot 'apps/desktop/dist/preload/preload.js'
  $renderer = Join-Path $RepoRoot 'apps/desktop/dist/renderer/index.html'
  if (-not ((Test-Path $main) -and (Test-Path $preload) -and (Test-Path $renderer))) {
    Write-SentryFail 'Desktop build output is incomplete. Run: pnpm --filter @qa/desktop build'; return 1
  }
  Write-SentryOk 'Dependencies installed; Desktop built'
  Write-SentrySection '[5/7] WSL runtime'
  $deployed = Invoke-SentryRuntimeDeploy -Distro $distro -RepoRoot $RepoRoot
  if (-not $deployed) { return 1 }
  $hello = Invoke-SentryRuntimeHandshake -Distro $distro
  if (-not $hello) { return 1 }
  [void](Sync-SentryDistroPreference -RepoRoot $RepoRoot -Distro $distro)
  Write-SentrySection '[6/7] Agent tools'
  $oc = Ensure-SentryOpenCode -Distro $distro
  $ds = Ensure-SentryDeepSeek -Distro $distro -RepoRoot $RepoRoot
  $cc = Ensure-SentryClaudeCode -Distro $distro
  Write-SentrySection '[7/7] Launcher'
  Install-SentryShim -RepoRoot $RepoRoot
  Write-SentryOk 'sentry command installed (user PATH; restart terminal if not recognized)'
  Set-SentryLauncherConfig @{ setupVersion = $version; setupCommit = (Get-SentryShortSha -RepoRoot $RepoRoot) }
  Show-SentrySetupSummary -Distro $distro -OpenCode $oc -DeepSeek $ds -Claude $cc
  if ($oc -and $ds -and $cc) { return 0 }
  return 0
}

function Show-SentrySetupSummary {
  param([string]$Distro, [bool]$OpenCode, [bool]$DeepSeek, [bool]$Claude)
  $wver = Get-SentryWindowsNodeVersion
  $wpnpm = Get-SentryWindowsPnpmVersion
  $lver = Get-SentryLinuxNodeVersion -Distro $Distro
  Write-Host ''
  Write-Host 'Sentry v0.1 Beta Setup' -ForegroundColor Cyan
  Write-Host '========================================'
  Write-Host 'Windows'
  Write-SentryOk 'Git'
  Write-SentryOk ('Node ' + $wver)
  Write-SentryOk ('pnpm ' + $wpnpm)
  Write-Host 'Linux Runtime'
  Write-SentryOk 'WSL2'
  Write-SentryOk $Distro
  Write-SentryOk ('Node ' + $lver)
  Write-SentryOk 'systemd'
  Write-Host 'Agent Tools'
  if ($OpenCode) { Write-SentryOk 'OpenCode 1.18.32' } else { Write-SentryFail 'OpenCode (missing)' }
  if ($DeepSeek) { Write-SentryOk 'DeepSeek harness 0.1.5-rc.2' } else { Write-SentryFail 'DeepSeek (missing)' }
  if ($Claude) { Write-SentryOk 'Claude Code 2.1.270' } else { Write-SentryFail 'Claude Code (missing)' }
  Write-Host 'Sentry'
  Write-SentryOk 'Dependencies installed'
  Write-SentryOk 'Desktop built'
  Write-SentryOk 'Runtime deployed'
  Write-SentryOk 'Runtime handshake passed'
  Write-SentryOk 'sentry command installed'
  Write-Host '========================================'
  if ($OpenCode -and $DeepSeek -and $Claude) {
    Write-Host 'Sentry is ready.' -ForegroundColor Green
    Write-Host 'Run: sentry open'
    Write-Host 'Then configure provider accounts in: Settings -> Providers'
  } else {
    Write-Host 'Sentry core setup completed, but one agent tool is missing.' -ForegroundColor Yellow
    Write-Host 'Sentry can open; affected runs stay unavailable until the tool is installed.'
    Write-Host 'Run: sentry doctor'
  }
}

function Get-SentryDesktopProcesses {
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" -ErrorAction Stop
    return @($procs | Where-Object { [string]$_.CommandLine -like '*--sentry-app*' -or [string]$_.CommandLine -like '*--sentry-control=*' })
  } catch { return @() }
}

function Get-SentryElectronExe {
  param([string]$RepoRoot)
  $exe = Join-Path $RepoRoot 'apps/desktop/node_modules/electron/dist/electron.exe'
  if (Test-Path $exe) { return $exe }
  return ''
}

function Invoke-SentryOpen {
  param([string]$RepoRoot)
  $main = Join-Path $RepoRoot 'apps/desktop/dist/main/index.js'
  $renderer = Join-Path $RepoRoot 'apps/desktop/dist/renderer/index.html'
  if (-not ((Test-Path $main) -and (Test-Path $renderer))) {
    Write-SentryFail 'Sentry is not built.'
    Write-Host 'Run: sentry setup'
    return 1
  }
  $exe = Get-SentryElectronExe -RepoRoot $RepoRoot
  if (-not $exe) { Write-SentryFail 'Electron binary not found. Run: sentry setup'; return 1 }
  $appDir = Join-Path $RepoRoot 'apps/desktop'
  $already = @(Get-SentryDesktopProcesses)
  [void](Start-Process -FilePath $exe -ArgumentList @('.', '--sentry-app') -WorkingDirectory $appDir -PassThru)
  if ($already.Count -gt 0) { Write-Host 'Sentry is already running; focusing the existing window.' }
  else { Write-Host 'Launching Sentry...' }
  return 0
}

function Invoke-SentryOpenDetached {
  param([string]$RepoRoot)
  $r = Invoke-SentryNative -FilePath 'pnpm' -Arguments @('--filter', '@qa/desktop', 'exec', 'electron', '.', '--sentry-app') -Workdir $RepoRoot
  return $r.ExitCode
}

function Stop-SentryDesktopIfRunning {
  param([string]$RepoRoot)
  $running = @(Get-SentryDesktopProcesses)
  if ($running.Count -eq 0) { return }
  Write-SentryInfo 'Stopping the running Sentry instance...'
  [void](Invoke-SentryStop -RepoRoot $RepoRoot)
}

function Invoke-SentryStop {
  param([string]$RepoRoot)
  $running = @(Get-SentryDesktopProcesses)
  $hasMarker = $running.Count -gt 0
  if (-not $hasMarker) {
    $anyElectron = @(Get-Process -Name 'electron' -ErrorAction SilentlyContinue)
    if ($anyElectron.Count -eq 0) { Write-Host 'Sentry is not currently running.'; return 0 }
  }
  $exe = Get-SentryElectronExe -RepoRoot $RepoRoot
  if (-not $exe) { Write-SentryFail 'Electron binary not found; cannot send a graceful stop.'; return 1 }
  $appDir = Join-Path $RepoRoot 'apps/desktop'
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.WorkingDirectory = $appDir
  $psi.UseShellExecute = $false
  $psi.Arguments = (Get-SentryQuotedArguments @('.', '--sentry-control=stop'))
  $p = [System.Diagnostics.Process]::Start($psi)
  [void]$p.WaitForExit(45000)
  Start-Sleep -Seconds 2
  $left = @(Get-SentryDesktopProcesses)
  if ($left.Count -eq 0) { Write-Host 'Sentry stopped.'; return 0 }
  Write-SentryWarn 'Sentry did not exit promptly; its window may need closing manually. No other Electron apps were touched.'
  return 1
}

function Invoke-SentryStatus {
  param([string]$RepoRoot, [bool]$AsJson = $false)
  $version = Get-SentryProductVersion -RepoRoot $RepoRoot
  $sha = Get-SentryShortSha -RepoRoot $RepoRoot
  $branch = ''
  try { $b = & git -C $RepoRoot rev-parse --abbrev-ref HEAD 2>$null; if ($LASTEXITCODE -eq 0) { $branch = ([string]$b).Trim() } } catch { }
  $clean = $true
  try { $s = & git -C $RepoRoot status --porcelain 2>$null; if ($LASTEXITCODE -eq 0 -and $s) { $clean = $false } } catch { }
  $wNode = Get-SentryWindowsNodeVersion
  $wPnpm = Get-SentryWindowsPnpmVersion
  $cfg = Get-SentryLauncherConfig
  $distro = [string]$cfg['selectedDistro']
  $lNode = ''
  $rtSha = ''
  if ($distro) {
    $lNode = Get-SentryLinuxNodeVersion -Distro $distro
    $rtSha = Get-SentryRuntimeCurrent -Distro $distro
  }
  $desktopBuilt = (Test-Path (Join-Path $RepoRoot 'apps/desktop/dist/main/index.js')) -and (Test-Path (Join-Path $RepoRoot 'apps/desktop/dist/renderer/index.html'))
  $running = @(Get-SentryDesktopProcesses).Count -gt 0
  if ($AsJson) {
    $obj = @{
      product = 'Sentry'; release = 'v0.1 Beta'; version = $version; commit = $sha; branch = $branch; clean = $clean;
      windows = @{ node = $wNode; pnpm = $wPnpm };
      wsl = @{ distro = $distro; node = $lNode };
      sentry = @{ desktopBuilt = $desktopBuilt; runtime = $rtSha; running = $running }
    }
    Write-Host ($obj | ConvertTo-Json -Depth 5)
    return 0
  }
  Write-Host ''
  Write-Host 'Sentry v0.1 Beta' -ForegroundColor Cyan
  Write-Host 'Repository'
  Write-Host ('  Path        ' + $RepoRoot)
  Write-Host ('  Branch      ' + $branch)
  Write-Host ('  Commit      ' + $sha)
  $cleanText = 'no'; if ($clean) { $cleanText = 'yes' }
  Write-Host ('  Clean       ' + $cleanText)
  Write-Host 'Windows'
  Write-Host ('  Node        ' + $wNode)
  Write-Host ('  pnpm        ' + $wPnpm)
  Write-Host 'WSL'
  Write-Host ('  Distro      ' + $distro)
  Write-Host ('  Node        ' + $lNode)
  Write-Host 'Sentry'
  $builtText = 'not built'; if ($desktopBuilt) { $builtText = 'built' }
  Write-Host ('  Desktop     ' + $builtText)
  Write-Host ('  Runtime     ' + $rtSha)
  $runningText = 'no'; if ($running) { $runningText = 'yes' }
  Write-Host ('  Running     ' + $runningText)
  return 0
}
