# wsl-setup.ps1 — WSL detection, distro selection, systemd, Linux toolchain.
# Dot-sourced by the launcher module. Mutations are minimal and explained.
# Never wipes a distro, never changes the default, never removes packages.
# Multi-word Linux scripts run via Invoke-SentryWslScript (temp file + bash)
# so no nested quoting crosses the wsl.exe boundary. Direct single-command
# probes (node --version) use Invoke-SentryWsl argv execution (no shell).

function Invoke-SentryWslScript {
  param([string]$Distro, [string]$Script, [int]$TimeoutSec = 300)
  $tmp = ''
  try {
    $tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), ('sentry-' + [System.Guid]::NewGuid().ToString('N') + '.sh'))
    [System.IO.File]::WriteAllText($tmp, $Script, (New-Object System.Text.UTF8Encoding $false))
    $fwd = ($tmp -replace '\\\\', '/')
    $lp = Invoke-SentryNative -FilePath 'wsl.exe' -Arguments @('-d', $Distro, '--', 'wslpath', '-u', $fwd) -TimeoutSec 30
    $linuxPath = ([string]$lp.Stdout).Trim()
    if (-not $linuxPath) { return @{ ExitCode = -1; Stdout = ''; Stderr = 'wslpath failed' } }
    $bashArgs = @()
    $bashArgs += '-d'; $bashArgs += $Distro; $bashArgs += '--'; $bashArgs += 'bash'; $bashArgs += $linuxPath
    return Invoke-SentryNative -FilePath 'wsl.exe' -Arguments $bashArgs -TimeoutSec $TimeoutSec
  } finally {
    if ($tmp -and (Test-Path $tmp)) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  }
}

function Test-SentryWslAvailable {
  try {
    $r = Invoke-SentryNative -FilePath 'wsl.exe' -Arguments @('--status')
    return ($r.ExitCode -eq 0)
  } catch { return $false }
}

function Get-SentryWslDistros {
  $r = Invoke-SentryNative -FilePath 'wsl.exe' -Arguments @('--list', '--verbose')
  if ($r.ExitCode -ne 0) { return @() }
  $text = ([string]$r.Stdout).Replace([string][char]0, '')
  $out = @()
  foreach ($raw in ($text -split "`n")) {
    $line = $raw.Trim() -replace '^\*\s*', ''
    if ($line -match '^NAME\s+STATE') { continue }
    if ($line -match '^(\S(?:.*?\S)?)\s+(Running|Stopped|Installing|Uninstalling|Converting)\s+(\d+)\s*$') {
      $entry = [pscustomobject]@{ Name = $Matches[1].Trim(); State = $Matches[2]; Version = [int]$Matches[3] }
      $out += $entry
    }
  }
  return $out
}

function Get-SentryUsableDistros {
  param($Distros)
  return @($Distros | Where-Object { $_.Version -eq 2 -and $_.Name -notmatch '^docker-desktop' })
}

function Select-SentryDistro {
  param($Distros, [string]$Previous = '', [string]$Explicit = '', [bool]$NonInteractive = $false)
  $usable = @(Get-SentryUsableDistros $Distros)
  if ($usable.Count -eq 0) { return '' }
  if ($Explicit) {
    $m = @($usable | Where-Object { $_.Name -ieq $Explicit })
    if ($m.Count -gt 0) { return $m[0].Name }
    Write-SentryFail ('Requested distro is not a usable WSL2 distro: ' + $Explicit)
    return ''
  }
  if ($Previous) {
    $m = @($usable | Where-Object { $_.Name -ceq $Previous })
    if ($m.Count -gt 0) { return $m[0].Name }
  }
  $ubuntu = @($usable | Where-Object { $_.Name -ieq 'Ubuntu' })
  if ($ubuntu.Count -gt 0) { return $ubuntu[0].Name }
  if ($usable.Count -eq 1) { return $usable[0].Name }
  if ($NonInteractive) {
    $running = @($usable | Where-Object { $_.State -eq 'Running' })
    if ($running.Count -gt 0) { return $running[0].Name }
    return $usable[0].Name
  }
  Write-Host ''
  Write-Host 'Available WSL2 distributions' -ForegroundColor Cyan
  for ($i = 0; $i -lt $usable.Count; $i++) { Write-Host ('  ' + ($i + 1) + '. ' + $usable[$i].Name + ' (' + $usable[$i].State + ')') }
  $def = 1
  for ($i = 0; $i -lt $usable.Count; $i++) { if ($usable[$i].Name -ieq 'Ubuntu') { $def = $i + 1 } }
  $answer = Read-Host ('Select the distribution Sentry should use [' + $def + ']')
  if ([string]::IsNullOrWhiteSpace($answer)) { $answer = [string]$def }
  $n = 0
  if ([int]::TryParse($answer.Trim(), [ref]$n) -and $n -ge 1 -and $n -le $usable.Count) { return $usable[$n - 1].Name }
  $named = @($usable | Where-Object { $_.Name -ieq $answer.Trim() })
  if ($named.Count -gt 0) { return $named[0].Name }
  Write-SentryWarn 'Unrecognized selection; using default.'
  return $usable[$def - 1].Name
}

function Invoke-SentryWsl {
  param([string]$Distro, [string[]]$LinuxArgs, [int]$TimeoutSec = 120)
  $wslArgs = @()
  $wslArgs += '-d'; $wslArgs += $Distro; $wslArgs += '--'
  foreach ($a in $LinuxArgs) { $wslArgs += $a }
  return Invoke-SentryNative -FilePath 'wsl.exe' -Arguments $wslArgs -TimeoutSec $TimeoutSec
}

function Ensure-SentryWslDistro {
  param([string]$Explicit = '', [bool]$NonInteractive = $false, [string]$Previous = '')
  if (-not (Test-SentryWslAvailable)) {
    Write-SentryWarn 'WSL is not installed.'
    Write-SentryInfo 'Requesting WSL2 + Ubuntu via: wsl --install -d Ubuntu'
    Write-SentryInfo 'This step may require Administrator approval and a Windows reboot.'
    try {
      $r = Invoke-SentryNative -FilePath 'wsl.exe' -Arguments @('--install', '-d', 'Ubuntu')
      Write-SentryLog ('wsl --install exit=' + $r.ExitCode) 'setup'
    } catch { Write-SentryLog ('wsl --install failed: ' + $_.Exception.Message) 'setup' }
    Write-Host ''
    Write-Host 'WSL2 installation has been requested.' -ForegroundColor Yellow
    Write-Host 'Windows may need to restart before Sentry setup can continue.'
    Write-Host 'After restarting, rerun from this repository:'
    Write-Host '    .\sentry.ps1 setup'
    return @{ Distro = ''; RebootRequired = $true }
  }
  $distros = @(Get-SentryWslDistros)
  $usable = @(Get-SentryUsableDistros $distros)
  if ($usable.Count -eq 0) {
    Write-SentryWarn 'WSL exists but no usable WSL2 distro was found.'
    Write-SentryInfo 'Installing Ubuntu via: wsl --install -d Ubuntu (may need reboot)...'
    try {
      $r = Invoke-SentryNative -FilePath 'wsl.exe' -Arguments @('--install', '-d', 'Ubuntu')
      Write-SentryLog ('wsl --install ubuntu exit=' + $r.ExitCode) 'setup'
    } catch { }
    Write-Host 'After Ubuntu finishes installing (and any reboot), rerun: .\sentry.ps1 setup'
    return @{ Distro = ''; RebootRequired = $true }
  }
  $choice = Select-SentryDistro -Distros $distros -Previous $Previous -Explicit $Explicit -NonInteractive $NonInteractive
  if (-not $choice) { return @{ Distro = ''; RebootRequired = $false } }
  $entry = @($distros | Where-Object { $_.Name -ceq $choice })[0]
  if ($entry -and $entry.Version -ne 2) {
    Write-SentryWarn ($choice + ' is WSL1; Sentry requires WSL2. Converting (this may take a while)...')
    $r = Invoke-SentryNative -FilePath 'wsl.exe' -Arguments @('--set-version', $choice, '2')
    if ($r.ExitCode -ne 0) { Write-SentryFail ('Could not convert ' + $choice + ' to WSL2.'); return @{ Distro = ''; RebootRequired = $false } }
    Write-SentryOk ($choice + ' converted to WSL2.')
  }
  $probe = Invoke-SentryWsl -Distro $choice -LinuxArgs @('printf', 'init-ok') -TimeoutSec 60
  if ($probe.ExitCode -ne 0) {
    Write-Host ''
    Write-Host 'Ubuntu must complete first-time initialization.' -ForegroundColor Yellow
    Write-Host 'A WSL window will open. Create your Linux username/password, then return here.'
    [void](Start-Process 'wsl.exe' -ArgumentList @('-d', $choice))
    Write-Host 'Press Enter here after finishing initialization...'
    [void](Read-Host)
    $probe2 = Invoke-SentryWsl -Distro $choice -LinuxArgs @('printf', 'init-ok') -TimeoutSec 60
    if ($probe2.ExitCode -ne 0) { Write-SentryFail ('Distro ' + $choice + ' is still not usable.'); return @{ Distro = ''; RebootRequired = $false } }
  }
  Write-SentryOk ('WSL distro: ' + $choice)
  return @{ Distro = $choice; RebootRequired = $false }
}

function Ensure-SentrySystemd {
  param([string]$Distro)
  $probe = Invoke-SentryWslFile -Distro $Distro -ScriptName 'check-systemd.sh' -TimeoutSec 60
  if (([string]$probe.Stdout).Trim() -eq 'SYSTEMD_OK') { Write-SentryOk 'systemd user services'; return $true }
  Write-SentryWarn 'systemd user services are not enabled in this distro.'
  Write-SentryInfo 'Sentry will enable systemd in /etc/wsl.conf (backup first, other settings preserved).'
  $r = Invoke-SentryWslFile -Distro $Distro -ScriptName 'enable-systemd.sh' -TimeoutSec 60
  Write-SentryLog ('wsl.conf update exit=' + $r.ExitCode) 'setup'
  Write-SentryInfo ('Restarting distro ' + $Distro + ' (terminate only this distro)...')
  [void](Invoke-SentryNative -FilePath 'wsl.exe' -Arguments @('--terminate', $Distro))
  Start-Sleep -Seconds 5
  $probe2 = Invoke-SentryWslFile -Distro $Distro -ScriptName 'check-systemd.sh' -TimeoutSec 90
  if (([string]$probe2.Stdout).Trim() -eq 'SYSTEMD_OK') { Write-SentryOk 'systemd enabled'; return $true }
  Write-SentryFail 'systemd could not be enabled. See docs/beta/troubleshooting.md (systemd section).'
  return $false
}

function Get-SentryLinuxNodeVersion {
  param([string]$Distro)
  $r = Invoke-SentryWsl -Distro $Distro -LinuxArgs @('node', '--version') -TimeoutSec 30
  if ($r.ExitCode -ne 0) { return '' }
  return ([string]$r.Stdout).Trim()
}

function Ensure-SentryLinuxNode {
  param([string]$Distro)
  $ver = Get-SentryLinuxNodeVersion -Distro $Distro
  if ($ver -match '^v?(\d+)\.') {
    if ([int]$Matches[1] -ge $script:SentryRequiredNodeMajor) { Write-SentryOk ('Linux Node ' + $ver); return $true }
    Write-SentryWarn ('Linux Node ' + $ver + ' is too old; installing Node 22...')
  } else { Write-SentryInfo 'Installing Linux Node 22 (NodeSource, official builds)...' }
  $r = Invoke-SentryWslFile -Distro $Distro -ScriptName 'install-node.sh' -TimeoutSec 600
  Write-SentryLog ('linux node install exit=' + $r.ExitCode) 'setup'
  $ver2 = Get-SentryLinuxNodeVersion -Distro $Distro
  if ($ver2 -match '^v?(\d+)\.') {
    if ([int]$Matches[1] -ge $script:SentryRequiredNodeMajor) { Write-SentryOk ('Linux Node ' + $ver2); return $true }
  }
  Write-SentryFail 'Linux Node >= 22 could not be installed automatically (non-apt distro or network issue).'
  Write-SentryInfo 'Install Node 22 manually inside the distro so that direct execution works.'
  return $false
}

function Ensure-SentryLinuxPnpm {
  param([string]$Distro, [string]$RepoRoot)
  $pinned = Get-SentryPinnedPnpmVersion -RepoRoot $RepoRoot
  $r = Invoke-SentryWsl -Distro $Distro -LinuxArgs @('pnpm', '--version') -TimeoutSec 30
  if ($r.ExitCode -eq 0 -and ([string]$r.Stdout).Trim() -eq $pinned) { Write-SentryOk ('Linux pnpm ' + $pinned); return $true }
  Write-SentryInfo ('Installing pinned Linux pnpm ' + $pinned + ' (npm -g, direct-exec visible)...')
  $r2 = Invoke-SentryWslFile -Distro $Distro -ScriptName 'install-pnpm.sh' -ScriptArgs @($pinned) -TimeoutSec 300
  Write-SentryLog ('linux pnpm install exit=' + $r2.ExitCode) 'setup'
  $r3 = Invoke-SentryWsl -Distro $Distro -LinuxArgs @('pnpm', '--version') -TimeoutSec 30
  if ($r3.ExitCode -eq 0 -and ([string]$r3.Stdout).Trim() -eq $pinned) { Write-SentryOk ('Linux pnpm ' + $pinned); return $true }
  Write-SentryFail ('Linux pnpm ' + $pinned + ' is not directly executable.')
  return $false
}

function Ensure-SentryLinuxDeps {
  param([string]$Distro, [string]$RepoRoot)
  $needed = @('git', 'curl', 'ca-certificates', 'bwrap')
  try {
    $hits = Select-String -Path (Join-Path $RepoRoot 'packages/harness-claude-code/src/*.ts'), (Join-Path $RepoRoot 'apps/runtime/src/*.ts') -Pattern '\bsocat\b' -ErrorAction SilentlyContinue
    if ($hits) { $needed += 'socat' }
  } catch { }
  $socatArg = @()
  if ($needed -contains 'socat') { $socatArg += 'with-socat' }
  $chk = Invoke-SentryWslFile -Distro $Distro -ScriptName 'check-deps.sh' -ScriptArgs $socatArg -TimeoutSec 60
  $missingPkgs = @()
  foreach ($line in (([string]$chk.Stdout) -split "`n")) {
    $t = $line.Trim()
    if ($t.StartsWith('MISS-')) { $missingPkgs += $t.Substring(5) }
  }
  if ($missingPkgs.Count -eq 0) { Write-SentryOk 'Linux dependencies (git, curl, ca-certificates, bubblewrap)'; return $true }
  $missingText = ($missingPkgs -join ' ')
  Write-SentryInfo ('Installing missing Linux packages: ' + $missingText + ' (apt only, nothing removed)...')
  $instArgs = @()
  foreach ($m in $missingPkgs) { $instArgs += $m }
  $r = Invoke-SentryWslFile -Distro $Distro -ScriptName 'install-deps.sh' -ScriptArgs $instArgs -TimeoutSec 600
  if ($r.ExitCode -ne 0) { Write-SentryFail 'Could not install Linux packages (see log). Non-apt distros must be prepared manually.'; return $false }
  Write-SentryOk 'Linux dependencies installed'
  return $true
}
