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

function Get-SentryDeployLogPath {
  param([string]$Distro, [string]$Version)
  try {
    $r = Invoke-SentryNative -FilePath 'wsl.exe' -Arguments @('-d', $Distro, '--', 'printenv', 'HOME') -TimeoutSec 30
    if ($r.ExitCode -ne 0) { return '' }
    $home_ = ([string]$r.Stdout).Trim()
    if ([string]::IsNullOrEmpty($home_)) { return '' }
    if (-not $home_.StartsWith('/')) { return '' }
    if ($home_.Contains('$')) { return '' }
    $safeVersion = ([string]$Version) -replace '[^A-Za-z0-9._-]', '_'
    if ([string]::IsNullOrEmpty($safeVersion)) { return '' }
    return ($home_.TrimEnd('/') + '/sentry-deploy-' + $safeVersion + '.log')
  } catch { return '' }
}

function Get-SentryDistroClass {
  param($Distros)
  $usable = @()
  $wsl1 = @()
  $utility = @()
  foreach ($d in @($Distros)) {
    if ($d.Name -match '^docker-desktop') { $utility += $d }
    elseif ($d.Version -eq 2) { $usable += $d }
    else { $wsl1 += $d }
  }
  return @{ Usable = $usable; Wsl1 = $wsl1; Utility = $utility }
}

function Request-SentryWsl1Conversion {
  param($Convertible, [string]$Explicit = '', [bool]$NonInteractive = $false)
  $names = (($Convertible | ForEach-Object { $_.Name }) -join ', ')
  if ($Explicit) {
    $match = @($Convertible | Where-Object { $_.Name -ieq $Explicit })
    if ($match.Count -eq 0) {
      Write-SentryFail ('Requested distro is not available for conversion: ' + $Explicit)
      return ''
    }
  } elseif ($NonInteractive) {
    Write-SentryFail ('Only WSL1 distro(s) found (' + $names + '). Rerun with -Distro <name> to convert, or convert manually: wsl --set-version <distro> 2')
    return ''
  } else {
    $first = $Convertible[0].Name
    Write-Host ''
    Write-Host ('Found ' + $first + ' using WSL1.') -ForegroundColor Yellow
    Write-Host 'Sentry requires WSL2.'
    $answer = Read-Host ('Convert ' + $first + ' to WSL2? [Y/n]')
    if ($answer.Trim() -eq '') { $answer = 'Y' }
    if ($answer.Trim().ToLowerInvariant() -notin @('y', 'yes')) {
      Write-SentryInfo 'Conversion declined. Convert manually (wsl --set-version <distro> 2) and rerun setup.'
      return ''
    }
    $match = @($Convertible | Where-Object { $_.Name -ceq $first })
  }
  $target = $match[0].Name
  Write-SentryInfo ('Converting ' + $target + ' to WSL2 (this may take a while)...')
  $r = Invoke-SentryNative -FilePath 'wsl.exe' -Arguments @('--set-version', $target, '2') -TimeoutSec 900
  Write-SentryLog ('wsl --set-version exit=' + $r.ExitCode) 'setup'
  if ($r.ExitCode -ne 0) { Write-SentryFail ('Could not convert ' + $target + ' to WSL2.'); return '' }
  $recheck = @(Get-SentryWslDistros | Where-Object { ($_.Name -ceq $target) -and ($_.Version -eq 2) })
  if ($recheck.Count -eq 0) { Write-SentryFail ('Conversion reported success but ' + $target + ' is still not WSL2.'); return '' }
  Write-SentryOk ($target + ' converted to WSL2.')
  return $target
}

function Install-SentryWslUbuntu {
  param([bool]$Elevate = $true)
  $tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), ('sentry-wsl-install-' + [System.Guid]::NewGuid().ToString('N') + '.ps1'))
  [System.IO.File]::WriteAllText($tmp, 'wsl.exe --install -d Ubuntu' + [Environment]::NewLine + 'exit $LASTEXITCODE', (New-Object System.Text.UTF8Encoding $false))
  try {
    if ($Elevate) {
      Write-SentryInfo 'Requesting Administrator approval to install WSL2 + Ubuntu (only this step elevates)...'
      try {
        $argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $tmp + '"'
        $proc = Start-Process 'powershell.exe' -ArgumentList $argLine -Verb RunAs -Wait -PassThru -ErrorAction Stop
      } catch {
        Write-SentryLog 'elevated WSL install cancelled or failed to start' 'setup'
        return 'cancelled'
      }
      $code = $proc.ExitCode
    } else {
      $r = Invoke-SentryNative -FilePath 'wsl.exe' -Arguments @('--install', '-d', 'Ubuntu') -TimeoutSec 600
      $code = $r.ExitCode
    }
    Write-SentryLog ('wsl --install exit=' + $code) 'setup'
    if (($code -ne 0) -and ($code -ne 3010)) {
      Write-SentryFail ('WSL installation failed with exit code ' + $code + '.')
      return 'failed'
    }
    Start-Sleep -Seconds 5
    if (Test-SentryWslAvailable) {
      $after = @(Get-SentryWslDistros)
      $ready = @($after | Where-Object { ($_.Name -ieq 'Ubuntu') -and ($_.Version -eq 2) })
      if ($ready.Count -gt 0) {
        $probe = Invoke-SentryWsl -Distro 'Ubuntu' -LinuxArgs @('printf', 'init-ok') -TimeoutSec 60
        if ($probe.ExitCode -eq 0) { return 'ready' }
      }
    }
    return 'reboot'
  } finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
}

function Ensure-SentryWslDistro {
  param([string]$Explicit = '', [bool]$NonInteractive = $false, [string]$Previous = '')
  if (-not (Test-SentryWslAvailable)) {
    Write-SentryWarn 'WSL is not installed.'
    $installResult = Install-SentryWslUbuntu -Elevate $true
    if ($installResult -eq 'cancelled') {
      Write-SentryFail 'WSL installation was cancelled.'
      Write-Host 'Sentry setup cannot continue until WSL2 is installed.'
      Write-Host 'Run:'
      Write-Host '    sentry setup'
      Write-Host 'again when ready.'
      return @{ Distro = ''; RebootRequired = $false }
    }
    if ($installResult -eq 'failed') {
      Write-SentryFail 'WSL installation failed (see messages above). Fix WSL manually, then rerun sentry setup.'
      return @{ Distro = ''; RebootRequired = $false }
    }
    if ($installResult -eq 'ready') {
      Write-SentryOk 'WSL2 + Ubuntu installed and ready; continuing setup immediately.'
      return @{ Distro = 'Ubuntu'; RebootRequired = $false }
    }
    Write-Host ''
    Write-Host 'WSL2 installation was accepted.' -ForegroundColor Yellow
    Write-Host 'Windows must restart before Sentry setup can continue.'
    Write-Host 'After restarting, rerun from this repository:'
    Write-Host '    .\sentry.ps1 setup'
    return @{ Distro = ''; RebootRequired = $true }
  }
  $distros = @(Get-SentryWslDistros)
  $class = Get-SentryDistroClass $distros
  $usable = @($class.Usable)
  $convertible = @($class.Wsl1)
  if (($usable.Count -eq 0) -and ($convertible.Count -gt 0)) {
    $choice = Request-SentryWsl1Conversion -Convertible $convertible -Explicit $Explicit -NonInteractive $NonInteractive
    if (-not $choice) { return @{ Distro = ''; RebootRequired = $false } }
    $distros = @(Get-SentryWslDistros)
    $class = Get-SentryDistroClass $distros
    $usable = @($class.Usable)
  }
  if ($usable.Count -eq 0) {
    Write-SentryWarn 'WSL exists but no usable WSL2 distro was found.'
    $installResult = Install-SentryWslUbuntu -Elevate $false
    if ($installResult -eq 'ready') {
      Write-SentryOk 'Ubuntu installed and ready; continuing setup immediately.'
      return @{ Distro = 'Ubuntu'; RebootRequired = $false }
    }
    if ($installResult -eq 'failed') {
      Write-SentryFail 'Ubuntu installation failed. Install a WSL2 distro manually, then rerun sentry setup.'
      return @{ Distro = ''; RebootRequired = $false }
    }
    Write-Host 'After Ubuntu finishes installing (and any reboot), rerun: .\sentry.ps1 setup'
    return @{ Distro = ''; RebootRequired = $true }
  }
  $choice = Select-SentryDistro -Distros $distros -Previous $Previous -Explicit $Explicit -NonInteractive $NonInteractive
  if (-not $choice) { return @{ Distro = ''; RebootRequired = $false } }
  $entry = @($distros | Where-Object { $_.Name -ceq $choice })[0]
  if ($entry -and ($entry.Version -ne 2)) {
    Write-SentryFail ('Selected distro ' + $choice + ' is not WSL2 (selection bug). Aborting safely.')
    return @{ Distro = ''; RebootRequired = $false }
  }
  $probe = Invoke-SentryWsl -Distro $choice -LinuxArgs @('printf', 'init-ok') -TimeoutSec 60
  if ($probe.ExitCode -ne 0) {
    Write-Host ''
    Write-Host ($choice + ' must complete first-time initialization.') -ForegroundColor Yellow
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
  $state = ([string]$probe.Stdout).Trim()
  if ($state -eq 'SYSTEMD_OK') { Write-SentryOk 'systemd user services'; return $true }
  if ($state -eq 'SYSTEMD_BIN_MISSING') {
    Write-SentryWarn 'systemd executables are absent from this distro; attempting system install...'
    $r = Invoke-SentryWslFile -Distro $Distro -ScriptName 'install-deps.sh' -ScriptArgs @('systemd') -TimeoutSec 600 -AsRoot $true
    $recheck = Invoke-SentryWslFile -Distro $Distro -ScriptName 'check-systemd.sh' -TimeoutSec 60
    $state2 = ([string]$recheck.Stdout).Trim()
    if (($r.ExitCode -eq 0) -and (($state2 -eq 'SYSTEMD_OK') -or ($state2 -eq 'SYSTEMD_DISABLED') -or ($state2 -eq 'SYSTEMD_USER_UNAVAILABLE'))) {
      Write-SentryInfo 'systemd binaries installed; continuing with enablement check...'
    } else {
      Write-SentryFail 'systemd is not installed in this distro and could not be installed automatically.'
      Write-SentryInfo 'Install systemd inside the distro (Ubuntu/WSL: sudo apt install -y systemd), then rerun setup.'
      return $false
    }
    $state = $state2
  }
  if ($state -eq 'SYSTEMD_USER_UNAVAILABLE') {
    Write-SentryWarn 'systemd is enabled but the user manager is not responding; restarting only this distro...'
    [void](Invoke-SentryNative -FilePath 'wsl.exe' -Arguments @('--terminate', $Distro))
    Start-Sleep -Seconds 5
    $probeU = Invoke-SentryWslFile -Distro $Distro -ScriptName 'check-systemd.sh' -TimeoutSec 90
    if (([string]$probeU.Stdout).Trim() -eq 'SYSTEMD_OK') { Write-SentryOk 'systemd user services recovered'; return $true }
    Write-SentryFail 'systemd user manager is unavailable even after restarting the distro. See docs/beta/troubleshooting.md (systemd section).'
    return $false
  }
  Write-SentryWarn 'systemd user services are not enabled in this distro.'
  Write-SentryInfo 'Sentry will enable systemd in /etc/wsl.conf (backup first, other settings preserved).'
  $r = Invoke-SentryWslFile -Distro $Distro -ScriptName 'enable-systemd.sh' -TimeoutSec 60 -AsRoot $true
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

function Get-SentryLinuxNpmVersion {
  param([string]$Distro)
  $r = Invoke-SentryWsl -Distro $Distro -LinuxArgs @('npm', '--version') -TimeoutSec 30
  if ($r.ExitCode -ne 0) { return '' }
  return ([string]$r.Stdout).Trim()
}

function Test-SentryLinuxNodeToolchain {
  param([string]$Distro)
  $ver = Get-SentryLinuxNodeVersion -Distro $Distro
  $major = -1
  if ($ver -match '^v?(\d+)\.') { $major = [int]$Matches[1] }
  if ($major -lt (Get-SentryRequiredNodeMajor)) { return @{ Ready = $false; Reason = 'node'; Node = $ver; Npm = '' } }
  $npm = Get-SentryLinuxNpmVersion -Distro $Distro
  if ($npm -eq '') {
    $presence = Invoke-SentryWsl -Distro $Distro -LinuxArgs @('sh', '-c', 'command -v npm') -TimeoutSec 30
    if ($presence.ExitCode -ne 0) { return @{ Ready = $false; Reason = 'npm-missing'; Node = $ver; Npm = '' } }
    return @{ Ready = $false; Reason = 'npm-broken'; Node = $ver; Npm = '' }
  }
  return @{ Ready = $true; Reason = ''; Node = $ver; Npm = $npm }
}

function Ensure-SentryLinuxNode {
  param([string]$Distro)
  $check = Test-SentryLinuxNodeToolchain -Distro $Distro
  if ($check.Ready) { Write-SentryOk ('Linux Node ' + $check.Node + ' + npm ' + $check.Npm); return $true }
  if ($check.Reason -eq 'node') {
    if ($check.Node) { Write-SentryWarn ('Linux Node ' + $check.Node + ' is too old; installing Node 22...') }
    else { Write-SentryInfo 'Installing Linux Node 22 (NodeSource, official builds)...' }
  } elseif ($check.Reason -eq 'npm-missing') {
    Write-SentryWarn ('Linux Node ' + $check.Node + ' is present but npm is missing; repairing the tested NodeSource Node 22 toolchain (never a mismatched standalone npm)...')
  } else {
    Write-SentryWarn ('Linux Node ' + $check.Node + ' is present but npm is unusable; repairing the tested NodeSource Node 22 toolchain...')
  }
  $r = Invoke-SentryWslFile -Distro $Distro -ScriptName 'install-node.sh' -TimeoutSec 600 -AsRoot $true
  Write-SentryLog ('linux node install exit=' + $r.ExitCode) 'setup'
  $check2 = Test-SentryLinuxNodeToolchain -Distro $Distro
  if ($check2.Ready) { Write-SentryOk ('Linux Node ' + $check2.Node + ' + npm ' + $check2.Npm); return $true }
  Write-SentryFail 'Linux Node >= 22 with usable npm could not be installed automatically (non-apt distro or network issue).'
  Write-SentryInfo 'Install Node 22 manually inside the distro so that direct execution works.'
  return $false
}

function Ensure-SentryLinuxPnpm {
  param([string]$Distro, [string]$RepoRoot)
  $pinned = Get-SentryPinnedPnpmVersion -RepoRoot $RepoRoot
  $r = Invoke-SentryWsl -Distro $Distro -LinuxArgs @('pnpm', '--version') -TimeoutSec 30
  if ($r.ExitCode -eq 0 -and ([string]$r.Stdout).Trim() -eq $pinned) { Write-SentryOk ('Linux pnpm ' + $pinned); return $true }
  Write-SentryInfo ('Installing pinned Linux pnpm ' + $pinned + ' (npm -g, direct-exec visible)...')
  $r2 = Invoke-SentryWslFile -Distro $Distro -ScriptName 'install-pnpm.sh' -ScriptArgs @($pinned) -TimeoutSec 300 -AsRoot $true
  Write-SentryLog ('linux pnpm install exit=' + $r2.ExitCode) 'setup'
  $r3 = Invoke-SentryWsl -Distro $Distro -LinuxArgs @('pnpm', '--version') -TimeoutSec 30
  if ($r3.ExitCode -eq 0 -and ([string]$r3.Stdout).Trim() -eq $pinned) { Write-SentryOk ('Linux pnpm ' + $pinned); return $true }
  Write-SentryFail ('Linux pnpm ' + $pinned + ' is not directly executable.')
  return $false
}

# Explicit executable -> Ubuntu package model. The executable name is NOT
# always the package name (bwrap lives in bubblewrap); installation must
# use Package, never the bare executable token.
function Get-SentryLinuxDepModel {
  return @(
    @{ Exe = 'git'; Package = 'git'; For = 'toolchain' },
    @{ Exe = 'curl'; Package = 'curl'; For = 'toolchain' },
    @{ Exe = 'update-ca-certificates'; Package = 'ca-certificates'; For = 'tls' },
    @{ Exe = 'bwrap'; Package = 'bubblewrap'; For = 'sandbox' },
    @{ Exe = 'socat'; Package = 'socat'; For = 'sandbox' }
  )
}

function Get-SentryMissingLinuxDeps {
  param($CheckOutput)
  $missingPkgs = @()
  foreach ($line in (([string]$CheckOutput) -split "`n")) {
    $t = $line.Trim()
    if ($t.StartsWith('MISS-')) { $missingPkgs += $t.Substring(5) }
  }
  return $missingPkgs
}

function Invoke-SentryToolchainPhase {
  param([string]$Distro, [string]$RepoRoot)
  $failed = $false
  $baseTools = Get-SentryBaseToolStatus -Distro $Distro
  if ($baseTools.Missing.Count -gt 0) {
    Write-SentryFail ('Base Linux utilities missing: ' + ($baseTools.Missing -join ', ') + '.')
    Write-SentryInfo 'These come from standard Ubuntu packages (bash, coreutils, findutils, grep, sed). Repair or reinstall the distro minimal environment, then rerun setup.'
    return $false
  }
  Write-SentryOk 'Base Linux utilities (bash, find, readlink, timeout, grep, sed)'
  if (-not (Ensure-SentrySystemd -Distro $Distro)) { $failed = $true }
  if (-not (Ensure-SentryLinuxNode -Distro $Distro)) { $failed = $true }
  if (-not (Ensure-SentryLinuxPnpm -Distro $Distro -RepoRoot $RepoRoot)) { $failed = $true }
  if (-not (Ensure-SentryLinuxDeps -Distro $Distro -RepoRoot $RepoRoot)) { $failed = $true }
  if ($failed) { Write-SentryFail 'Linux toolchain incomplete. See messages above.'; return $false }
  return $true
}

function Get-SentryBaseToolStatus {
  param([string]$Distro)
  $tools = @('bash', 'find', 'readlink', 'timeout', 'grep', 'sed')
  $r = Invoke-SentryWslFile -Distro $Distro -ScriptName 'check-base.sh' -TimeoutSec 60
  $missing = @()
  foreach ($line in (([string]$r.Stdout) -split "`n")) {
    $t = $line.Trim()
    if ($t.StartsWith('MISS-')) { $missing += $t.Substring(5) }
  }
  return @{ Tools = $tools; Missing = $missing }
}

function Get-SentrySandboxStatus {
  param([string]$Distro)
  $status = @{ Socat = $false; Bwrap = $false; SocatVersion = ''; BwrapVersion = ''; InitOk = $false; InitDetail = '' }
  $r = Invoke-SentryWslFile -Distro $Distro -ScriptName 'check-sandbox.sh' -TimeoutSec 60
  foreach ($line in (([string]$r.Stdout) -split "`n")) {
    $t = $line.Trim()
    if ($t -eq 'HAVE-socat') { $status.Socat = $true }
    elseif (($t -eq 'HAVE-bwrap') -or ($t -eq 'HAVE-bubblewrap')) { $status.Bwrap = $true }
    elseif ($t.StartsWith('SOCAT_VERSION=')) { $status.SocatVersion = $t.Substring(14) }
    elseif ($t.StartsWith('BWRAP_VERSION=')) { $status.BwrapVersion = $t.Substring(14) }
    elseif ($t -eq 'SANDBOX_INIT_OK') { $status.InitOk = $true }
    elseif ($t.StartsWith('SANDBOX_INIT_FAIL')) { $status.InitDetail = $t }
  }
  return $status
}

function Show-SentryAptInstallHelp {
  param([string[]]$Packages)
  Write-Host 'Missing WSL sandbox dependencies:'
  foreach ($p in $Packages) { Write-Host ('  - ' + $p) }
  Write-Host 'Install with (inside Ubuntu/WSL, not Windows PowerShell):'
  Write-Host '  sudo apt update'
  Write-Host ('  sudo apt install -y ' + ($Packages -join ' '))
}

function Ensure-SentryLinuxDeps {
  param([string]$Distro, [string]$RepoRoot)
  # socat + bubblewrap are first-class sandbox prerequisites: the pinned
  # Claude Code sandbox runs fail-closed and its own startup requires both
  # (observed live: missing socat fails GLM runs; fixed by apt install).
  # check-deps.sh already reports Ubuntu PACKAGE names (bwrap -> bubblewrap),
  # so MISS entries install verbatim — never translate back to executables.
  $chk = Invoke-SentryWslFile -Distro $Distro -ScriptName 'check-deps.sh' -TimeoutSec 60
  $missingPkgs = @(Get-SentryMissingLinuxDeps -CheckOutput ([string]$chk.Stdout))
  if ($missingPkgs.Count -eq 0) { Write-SentryOk 'Linux dependencies (git, curl, ca-certificates, bubblewrap, socat)'; return $true }
  $missingText = ($missingPkgs -join ' ')
  Write-SentryInfo ('Installing missing Linux packages: ' + $missingText + ' (apt only, nothing removed)...')
  $instArgs = @()
  foreach ($m in $missingPkgs) { $instArgs += $m }
  $r = Invoke-SentryWslFile -Distro $Distro -ScriptName 'install-deps.sh' -ScriptArgs $instArgs -TimeoutSec 600 -AsRoot $true
  if ($r.ExitCode -ne 0) {
    Write-SentryFail 'Could not install Linux packages automatically.'
    Show-SentryAptInstallHelp $missingPkgs
    return $false
  }
  $recheck = Invoke-SentryWslFile -Distro $Distro -ScriptName 'check-deps.sh' -TimeoutSec 60
  $stillMissing = @(Get-SentryMissingLinuxDeps -CheckOutput ([string]$recheck.Stdout))
  if ($stillMissing.Count -eq 0) { Write-SentryOk 'Linux dependencies installed and verified'; return $true }
  Write-SentryFail 'Some Linux packages are still missing after installation.'
  Show-SentryAptInstallHelp $stillMissing
  return $false
}
