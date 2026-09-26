# agent-tools.ps1 — OpenCode / DeepSeek / Claude Code preparation + runtime deploy.
# Discovery only: never changes harness prompts, routing, or adapter behavior.
# Linux work runs via static scripts (scripts/launcher/linux/*.sh) so no
# quoting crosses the wsl.exe boundary.

function Ensure-SentryOpenCode {
  param([string]$Distro)
  $pinned = '1.18.32'
  $r = Invoke-SentryWslFile -Distro $Distro -ScriptName 'check-opencode.sh' -TimeoutSec 60
  $out = [string]$r.Stdout
  if ($out.Contains($pinned)) { Write-SentryOk ('OpenCode ' + $pinned); return $true }
  Write-SentryInfo ('Installing tested OpenCode ' + $pinned + ' into the Sentry-managed location (official npm registry)...')
  $r2 = Invoke-SentryWslFile -Distro $Distro -ScriptName 'install-opencode.sh' -ScriptArgs @($pinned) -TimeoutSec 600
  Write-SentryLog ('opencode install exit=' + $r2.ExitCode) 'setup'
  if (([string]$r2.Stdout).Contains($pinned)) { Write-SentryOk ('OpenCode ' + $pinned + ' (Sentry-managed)'); return $true }
  Write-SentryWarn 'OpenCode could not be installed automatically. OpenCode runs will be unavailable until it is installed.'
  Write-SentryInfo ('Install inside WSL: npm install opencode-ai@' + $pinned + ' (or: npm install -g opencode-ai@' + $pinned + ')')
  return $false
}

function Ensure-SentryDeepSeek {
  param([string]$Distro, [string]$RepoRoot)
  $expected = '0.1.5-rc.2'
  try {
    $pkg = Get-Content (Join-Path $RepoRoot 'packages/harness-deepseek/package.json') -Raw | ConvertFrom-Json
    $dep = [string]$pkg.dependencies.'@deepseek-ai/dsh-sdk-client'
    if ($dep) { $expected = $dep }
  } catch { }
  try {
    $sdkSrc = Get-Content (Join-Path $RepoRoot 'packages/harness-deepseek/src/sdk.ts') -Raw
    if ($sdkSrc -match "DEEPSEEK_SDK_VERSION = '([^']+)'") { $expected = $Matches[1] }
  } catch { }
  $r = Invoke-SentryWslFile -Distro $Distro -ScriptName 'check-dsh.sh' -TimeoutSec 30
  $dshOut = ([string]$r.Stdout).Trim()
  if ($dshOut.Contains($expected)) { Write-SentryOk ('DeepSeek harness ' + $expected + ' (dsh CLI)'); return $true }
  Write-SentryOk ('DeepSeek harness ' + $expected + ' (SDK client bundled in runtime; dsh CLI optional)')
  Write-SentryInfo 'Note: the DeepSeek agent runs through the runtime-bundled SDK client; no separate dsh binary is required.'
  return $true
}

function Ensure-SentryClaudeCode {
  param([string]$Distro)
  $pinned = '2.1.270'
  $r = Invoke-SentryWslFile -Distro $Distro -ScriptName 'check-claude.sh' -TimeoutSec 60
  $out = [string]$r.Stdout
  if ($out.Contains($pinned) -and $out.Contains('NATIVE=linux')) { Write-SentryOk ('Claude Code ' + $pinned); return $true }
  if ($out.Contains('2.1.276')) {
    Write-SentryWarn 'Claude Code 2.1.276 detected: a known-incompatible version for the Sentry adapter.'
  } elseif ($out.Contains('NATIVE=windows-mount')) {
    Write-SentryWarn 'The claude on PATH is a Windows mount (/mnt/c); Sentry needs a native Linux binary.'
  } else { Write-SentryInfo ('Installing adapter-tested Claude Code ' + $pinned + ' (official npm registry)...') }
  $r2 = Invoke-SentryWslFile -Distro $Distro -ScriptName 'install-claude.sh' -ScriptArgs @($pinned) -TimeoutSec 600
  Write-SentryLog ('claude install exit=' + $r2.ExitCode) 'setup'
  $out2 = [string]$r2.Stdout
  if ($out2.Contains($pinned)) { Write-SentryOk ('Claude Code ' + $pinned); return $true }
  Write-SentryWarn 'Claude Code could not be installed automatically. GLM runs are unavailable until it is installed.'
  Write-SentryInfo ('Install inside WSL: sudo npm install -g @anthropic-ai/claude-code@' + $pinned)
  return $false
}

function Invoke-SentryRuntimeDeploy {
  param([string]$Distro, [string]$RepoRoot, [string]$ProductVersion = '', [string]$Sha = '')
  if (-not $ProductVersion) { $ProductVersion = Get-SentryProductVersion -RepoRoot $RepoRoot }
  if (-not $Sha) { $Sha = Get-SentryShortSha -RepoRoot $RepoRoot }
  $version = $ProductVersion + '-' + $Sha
  Write-SentryInfo ('Deploying WSL runtime ' + $version + ' ...')
  $script_ = Join-Path $RepoRoot 'apps/runtime/scripts/deploy-wsl-runtime.ps1'
  $deployArgs = @()
  $deployArgs += '-NoProfile'; $deployArgs += '-ExecutionPolicy'; $deployArgs += 'Bypass'; $deployArgs += '-File'
  $deployArgs += $script_; $deployArgs += '-Distro'; $deployArgs += $Distro; $deployArgs += '-Version'; $deployArgs += $version
  $r = Invoke-SentryNative -FilePath 'powershell.exe' -Arguments $deployArgs -Workdir $RepoRoot -TimeoutSec 1200
  Write-SentryLog ('runtime deploy exit=' + $r.ExitCode) 'setup'
  if ($r.ExitCode -ne 0) {
    Write-SentryFail 'Runtime deployment failed (previous runtime left untouched).'
    Write-Host $r.Stdout
    Write-Host $r.Stderr -ForegroundColor Red
    return ''
  }
  Write-SentryOk ('Runtime deployed: ' + $version)
  return $version
}

function Get-SentryRuntimeEntry {
  param([string]$Distro)
  $homeR = Invoke-SentryWsl -Distro $Distro -LinuxArgs @('printenv', 'HOME') -TimeoutSec 30
  $home_ = ([string]$homeR.Stdout).Trim()
  if (-not $home_) { return '' }
  return ($home_ + '/.local/share/sentry/runtime/current/apps/runtime/dist/host.js')
}

function Invoke-SentryRuntimeHandshake {
  param([string]$Distro)
  $entry = Get-SentryRuntimeEntry -Distro $Distro
  if (-not $entry) { Write-SentryFail 'Could not resolve WSL home for handshake.'; return $null }
  $r = Invoke-SentryWslFile -Distro $Distro -ScriptName 'runtime-hello.sh' -ScriptArgs @($entry) -TimeoutSec 90
  $out = [string]$r.Stdout
  if ($out.Contains('ENTRY_MISSING')) { Write-SentryFail ('Runtime entry missing: ' + $entry); return $null }
  try {
    $line = @($out -split "`n" | Where-Object { $_ -match '^\s*\{' })[0]
    if (-not $line) { throw 'no JSON line' }
    $hello = $line | ConvertFrom-Json
    $result = $hello.result
    if (-not $result) { $result = $hello }
    if ([int]$result.protocolVersion -ne 1) { Write-SentryFail 'Runtime protocol mismatch.'; return $null }
    if ([string]$result.platform -ne 'linux') { Write-SentryFail 'Runtime platform is not linux.'; return $null }
    if ([string]$result.processExecPath -ilike '*electron.exe') { Write-SentryFail 'Runtime runs under Electron.'; return $null }
    Write-SentryOk ('Runtime handshake passed (protocol 1, node ' + [string]$result.nodeVersion + ')')
    return $result
  } catch {
    Write-SentryFail 'Runtime handshake failed: no valid runtime.hello response.'
    Write-SentryLog ('handshake output: ' + $out) 'setup'
    return $null
  }
}

function Get-SentryRuntimeCurrent {
  param([string]$Distro)
  $r = Invoke-SentryWslFile -Distro $Distro -ScriptName 'readlink-current.sh' -TimeoutSec 30
  return ([string]$r.Stdout).Trim()
}

function Sync-SentryDistroPreference {
  param([string]$RepoRoot, [string]$Distro)
  Write-SentryInfo ('Saving distro preference via Desktop mechanism: ' + $Distro)
  # Invoke electron.exe directly (not via pnpm/cmd shims): the shim chain can
  # stall under hidden-window launches, while direct spawn exits promptly.
  $exe = Get-SentryElectronExe -RepoRoot $RepoRoot
  if (-not $exe) {
    Write-SentryWarn 'Electron binary not found; skipping distro-preference sync.'
    return $false
  }
  $appDir = Join-Path $RepoRoot 'apps/desktop'
  $syncArgs = @('.', '--sentry-setup-distro', $Distro)
  $r = Invoke-SentryNative -FilePath $exe -Arguments $syncArgs -Workdir $appDir -TimeoutSec 120 -NoRedirect $true
  if ($r.ExitCode -ne 0) {
    Write-SentryWarn 'Distro sync was slow; retrying once...'
    $r = Invoke-SentryNative -FilePath $exe -Arguments $syncArgs -Workdir $appDir -TimeoutSec 120 -NoRedirect $true
  }
  Write-SentryLog ('configure:distro exit=' + $r.ExitCode) 'setup'
  if ($r.ExitCode -eq 0) { Write-SentryOk 'Distro preference saved'; return $true }
  Write-SentryWarn 'Could not save the distro preference through Desktop; setup selection still applies to the deployed runtime.'
  return $false
}
