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

function Get-SentryExpectedDeepSeekVersion {
  param([string]$RepoRoot)
  $expected = '0.1.5-rc.2'
  try {
    $sdkSrc = Get-Content (Join-Path $RepoRoot 'packages/harness-deepseek/src/sdk.ts') -Raw
    if ($sdkSrc -match "DEEPSEEK_SDK_VERSION = '([^']+)'") { $expected = $Matches[1] }
  } catch { }
  return $expected
}

function Save-SentryProviderBinary {
  param([string]$RepoRoot, [string]$Key, [string]$LinuxPath)
  $exe = Get-SentryElectronExe -RepoRoot $RepoRoot
  if (-not $exe) {
    Write-SentryWarn ('Electron binary not found; cannot persist ' + $Key + '.')
    return $false
  }
  $appDir = Join-Path $RepoRoot 'apps/desktop'
  $saveArgs = @('.', '--sentry-setup-provider-binary', $Key, $LinuxPath)
  $r = Invoke-SentryNative -FilePath $exe -Arguments $saveArgs -Workdir $appDir -TimeoutSec 120 -NoRedirect $true
  Write-SentryLog ($Key + ' persist exit=' + $r.ExitCode) 'setup'
  if ($r.ExitCode -eq 0) { Write-SentryOk ('Persisted ' + $Key); return $true }
  Write-SentryWarn ('Could not persist ' + $Key + ' through Desktop.')
  return $false
}

function Ensure-SentryDeepSeek {
  param([string]$Distro, [string]$RepoRoot)
  $expected = Get-SentryExpectedDeepSeekVersion -RepoRoot $RepoRoot
  $r = Invoke-SentryWslFile -Distro $Distro -ScriptName 'check-deepseek.sh' -ScriptArgs @($expected) -TimeoutSec 60
  $out = [string]$r.Stdout
  if ($out.Contains('DSH_OK')) {
    $managed = ''
    foreach ($line in ($out -split "`n")) { if ($line.Trim().StartsWith('DSH_MANAGED=')) { $managed = $line.Trim().Substring(12) } }
    Write-SentryOk ('DeepSeek runtime ' + $expected + ' (managed, preflight-probed)')
    if ($managed) { [void](Save-SentryProviderBinary -RepoRoot $RepoRoot -Key 'SENTRY_DEEPSEEK_BINARY' -LinuxPath $managed) }
    return $true
  }
  Write-SentryInfo ('Preparing Sentry-managed DeepSeek runtime ' + $expected + ' (from the deployed runtime; no sudo, no network)...')
  $r2 = Invoke-SentryWslFile -Distro $Distro -ScriptName 'install-deepseek-tool.sh' -ScriptArgs @($expected) -TimeoutSec 300
  Write-SentryLog ('deepseek tool install exit=' + $r2.ExitCode) 'setup'
  $out2 = [string]$r2.Stdout
  $managed2 = ''
  foreach ($line in ($out2 -split "`n")) { if ($line.Trim().StartsWith('MANAGED_DSH=')) { $managed2 = $line.Trim().Substring(12) } }
  if (($r2.ExitCode -eq 0) -and $managed2 -and ($out2.Contains($expected))) {
    Write-SentryOk ('DeepSeek runtime ' + $expected + ' (managed, preflight-probed)')
    [void](Save-SentryProviderBinary -RepoRoot $RepoRoot -Key 'SENTRY_DEEPSEEK_BINARY' -LinuxPath $managed2)
    return $true
  }
  Write-SentryFail 'DeepSeek managed runtime could not be prepared. DeepSeek runs are unavailable.'
  Write-SentryInfo 'Rerun sentry setup after redeploying the runtime (sentry doctor shows details).'
  return $false
}

function Get-SentryManagedClaudePath {
  param([string]$CheckOutput)
  foreach ($line in (([string]$CheckOutput) -split "`n")) {
    $t = $line.Trim()
    if ($t.StartsWith('MANAGED=')) { return $t.Substring(8) }
  }
  return ''
}

function Ensure-SentryClaudeCode {
  param([string]$Distro, [string]$RepoRoot)
  $pinned = '2.1.270'
  $r = Invoke-SentryWslFile -Distro $Distro -ScriptName 'check-claude.sh' -ScriptArgs @($pinned) -TimeoutSec 60
  $out = [string]$r.Stdout
  if ($out.Contains('MANAGED_OK')) {
    $managed = Get-SentryManagedClaudePath $out
    Write-SentryOk ('Claude Code ' + $pinned + ' (Sentry-managed native Linux)')
    if ($managed -and ($managed -ne 'missing')) { [void](Save-SentryProviderBinary -RepoRoot $RepoRoot -Key 'SENTRY_GLM_BINARY' -LinuxPath $managed) }
    return $true
  }
  if ($out.Contains('PATH_OK') -and $out.Contains('PATH_NATIVE=linux')) {
    $reuse = ''
    foreach ($line in ($out -split "`n")) { if ($line.Trim().StartsWith('PATH_CLAUDE=')) { $reuse = $line.Trim().Substring(12) } }
    Write-SentryOk ('Claude Code ' + $pinned + ' (reusing existing native install; global untouched)')
    if ($reuse -and ($reuse -ne 'MISSING')) { [void](Save-SentryProviderBinary -RepoRoot $RepoRoot -Key 'SENTRY_GLM_BINARY' -LinuxPath $reuse) }
    return $true
  }
  if ($out.Contains('2.1.276')) {
    Write-SentryWarn 'A known-incompatible Claude Code 2.1.276 was seen; Sentry will use its own managed 2.1.270.'
  } elseif ($out.Contains('PATH_NATIVE=windows-mount')) {
    Write-SentryWarn 'The claude on PATH is a Windows mount (/mnt/c); Sentry will use its own managed native binary.'
  } else { Write-SentryInfo ('Installing adapter-tested Claude Code ' + $pinned + ' (Sentry-managed, no sudo, global untouched)...') }
  $r2 = Invoke-SentryWslFile -Distro $Distro -ScriptName 'install-claude.sh' -ScriptArgs @($pinned) -TimeoutSec 600
  Write-SentryLog ('claude managed install exit=' + $r2.ExitCode) 'setup'
  $out2 = [string]$r2.Stdout
  $managed2 = ''
  foreach ($line in ($out2 -split "`n")) { if ($line.Trim().StartsWith('MANAGED_CLAUDE=')) { $managed2 = $line.Trim().Substring(15) } }
  if (($r2.ExitCode -eq 0) -and $managed2 -and ($out2.Contains($pinned))) {
    Write-SentryOk ('Claude Code ' + $pinned + ' (Sentry-managed native Linux)')
    [void](Save-SentryProviderBinary -RepoRoot $RepoRoot -Key 'SENTRY_GLM_BINARY' -LinuxPath $managed2)
    return $true
  }
  Write-SentryFail 'Claude Code could not be prepared. GLM runs are unavailable.'
  return $false
}

# NOTE: post-update re-provisions tools via Ensure-SentryOpenCode,
# Ensure-SentryDeepSeek, and Ensure-SentryClaudeCode (authoritative).
# The old check-only Invoke-SentryToolRevalidation was removed.

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
  $r = Invoke-SentryNative -FilePath 'powershell.exe' -Arguments $deployArgs -Workdir $RepoRoot -TimeoutSec 5400
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
