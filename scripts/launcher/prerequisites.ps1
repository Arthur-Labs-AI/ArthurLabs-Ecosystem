# prerequisites.ps1 — Windows Git/Node/pnpm checks. Dot-sourced by the module.
# Never changes machine execution policy; never touches secrets.

function Test-SentryGit {
  $r = Invoke-SentryNative -FilePath 'git' -Arguments @('--version')
  if ($r.ExitCode -ne 0) {
    Write-SentryFail 'Git is not installed or not on PATH.'
    Write-SentryInfo 'Install Git from https://git-scm.com/download/win, then rerun: sentry setup'
    return $false
  }
  Write-SentryOk ('Git ' + ([string]$r.Stdout).Trim())
  return $true
}

function Get-SentryWindowsNodeVersion {
  try {
    $r = Invoke-SentryNative -FilePath 'node' -Arguments @('--version')
    if ($r.ExitCode -ne 0) { return '' }
    return ([string]$r.Stdout).Trim()
  } catch { return '' }
}

function Test-SentryWindowsNode {
  param([bool]$AllowInstall = $true)
  $ver = Get-SentryWindowsNodeVersion
  if ($ver -match '^v?(\d+)\.') {
    $major = [int]$Matches[1]
    if ($major -ge $script:SentryRequiredNodeMajor) { Write-SentryOk ('Node ' + $ver); return $true }
    Write-SentryWarn ('Node ' + $ver + ' is too old; Sentry requires Node >= 22.')
  } else {
    Write-SentryWarn 'Node.js was not found on PATH.'
  }
  if (-not $AllowInstall) { return $false }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    Write-SentryInfo 'Installing Node.js 22 LTS via winget (may prompt for approval)...'
    try {
      $r = Invoke-SentryNative -FilePath 'winget' -Arguments @('install', '--silent', '-e', '--id', 'OpenJS.NodeJS.LTS', '--accept-source-agreements', '--accept-package-agreements')
      Write-SentryLog ('winget node exit=' + $r.ExitCode) 'setup'
    } catch { Write-SentryLog ('winget failed: ' + $_.Exception.Message) 'setup' }
    $ver2 = Get-SentryWindowsNodeVersion
    if ($ver2 -match '^v?(\d+)\.') {
      if ([int]$Matches[1] -ge $script:SentryRequiredNodeMajor) { Write-SentryOk ('Node ' + $ver2); return $true }
    }
  }
  Write-SentryFail 'Node >= 22 is required.'
  Write-SentryInfo 'Install Node 22 LTS from https://nodejs.org/ (or: winget install OpenJS.NodeJS.LTS), restart this terminal, then rerun: sentry setup'
  return $false
}

function Get-SentryWindowsPnpmVersion {
  try {
    $r = Invoke-SentryNative -FilePath 'pnpm' -Arguments @('--version')
    if ($r.ExitCode -ne 0) { return '' }
    return ([string]$r.Stdout).Trim()
  } catch { return '' }
}

function Test-SentryWindowsPnpm {
  param([string]$RepoRoot)
  $pinned = Get-SentryPinnedPnpmVersion -RepoRoot $RepoRoot
  $ver = Get-SentryWindowsPnpmVersion
  if ($ver -eq $pinned) { Write-SentryOk ('pnpm ' + $ver); return $true }
  if ($ver) { Write-SentryWarn ('pnpm ' + $ver + ' found; project pins pnpm ' + $pinned + '. Installing pinned version...') }
  else { Write-SentryInfo ('Installing pinned pnpm ' + $pinned + '...') }
  $npm = Get-Command npm -ErrorAction SilentlyContinue
  if (-not $npm) { Write-SentryFail 'npm is unavailable, so pnpm cannot be installed. Reinstall Node 22 LTS first.'; return $false }
  $r = Invoke-SentryNative -FilePath 'npm' -Arguments @('install', '-g', ('pnpm@' + $pinned))
  Write-SentryLog ('npm i -g pnpm exit=' + $r.ExitCode) 'setup'
  $ver2 = Get-SentryWindowsPnpmVersion
  if ($ver2 -eq $pinned) { Write-SentryOk ('pnpm ' + $ver2); return $true }
  Write-SentryFail ('pnpm ' + $pinned + ' could not be installed automatically. Run: npm install -g pnpm@' + $pinned)
  return $false
}
