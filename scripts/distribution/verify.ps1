# Dependency-free Windows validation; runs before any WSL/setup operation.
function Get-SentryDistribution {
  param([Parameter(Mandatory = $true)][string]$Root)
  $ErrorActionPreference = 'Stop'
  $manifest = Get-Content -LiteralPath (Join-Path $Root 'distribution.json') -Raw | ConvertFrom-Json
  if ($manifest.schemaVersion -ne 1 -or $manifest.product -cne 'Sentry' -or
      $manifest.version -cnotmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$' -or
      $manifest.sourceCommit -cnotmatch '^[a-f0-9]{40}$' -or
      $manifest.runtimeProtocol -ne 1 -or $manifest.targetPlatform -cne 'windows-x64' -or
      $manifest.artifactType -cne 'versioned-archive' -or $manifest.checksumAlgorithm -cne 'SHA256' -or
      -not $manifest.buildPlatform -or -not $manifest.toolchain -or -not $manifest.components -or -not $manifest.prerequisites -or -not $manifest.files) {
    throw 'Invalid Windows Sentry distribution manifest'
  }
  $expected = @{}
  foreach ($entry in $manifest.files.PSObject.Properties) {
    $name = [string]$entry.Name
    if ($name -cnotmatch '^[A-Za-z0-9@_.+/-]+$' -or $name -match '(^/|(^|/)\.{1,2}(/|$)|//)' -or
        $name -match '(^|/)(\.git|\.env[^/]*|\.npmrc|credentials|secrets|workspaces|\.sentry-data|sentry-data|\.sentry-live)(/|$)|\.(sqlite[^/]*|db|log|pem|key|p12|pfx)$' -or
        [string]$entry.Value -cnotmatch '^[a-f0-9]{64}$' -or $expected.ContainsKey($name)) { throw 'Invalid checksum entry' }
    $expected[$name] = [string]$entry.Value
  }
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue(@{ Directory = (Get-Item -LiteralPath $Root); Prefix = '' })
  $count = 0
  while ($queue.Count -gt 0) {
    $entry = $queue.Dequeue()
    foreach ($item in Get-ChildItem -LiteralPath $entry.Directory.FullName -Force) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Artifact reparse point rejected' }
      $name = [string]$entry.Prefix + $item.Name
      if ($item.PSIsContainer) { $queue.Enqueue(@{ Directory = $item; Prefix = $name + '/' }); continue }
      if ($name -ceq 'distribution.json') { continue }
      if (-not $expected.ContainsKey($name)) { throw ('Unexpected artifact file: ' + $name) }
      $stream = [IO.File]::OpenRead($item.FullName)
      $algorithm = [Security.Cryptography.SHA256]::Create()
      try { $hash = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
      finally { $stream.Dispose(); $algorithm.Dispose() }
      if ($hash -cne $expected[$name]) { throw ('Checksum mismatch: ' + $name) }
      $count++
    }
  }
  if ($count -ne $expected.Count) { throw 'Artifact file inventory mismatch' }
  $required = @('build-identity.json', 'runtime-source/build-identity.json', 'runtime-source/apps/runtime/src/host.ts', 'runtime-source/pnpm-lock.yaml',
    'scripts/distribution/bootstrap-runtime.sh', 'scripts/distribution/verify.mjs', 'desktop/resources/app/build-identity.json', 'desktop/resources/app/package.json',
    'desktop/resources/app/dist/main/index.js', 'desktop/resources/app/dist/preload/preload.js', 'desktop/resources/app/dist/renderer/index.html',
    'desktop/resources/app/assets/sentry-icon.png', 'desktop/Sentry.exe', 'sentry.ps1')
  foreach ($path in $required) { if (-not $expected.ContainsKey($path)) { throw ('Required component missing: ' + $path) } }
  foreach ($path in @('build-identity.json', 'runtime-source/build-identity.json', 'desktop/resources/app/build-identity.json')) {
    $identity = Get-Content -LiteralPath (Join-Path $Root $path) -Raw | ConvertFrom-Json
    if ($identity.schemaVersion -ne 1 -or $identity.product -cne 'Sentry' -or $identity.version -cne $manifest.version -or $identity.sourceCommit -cne $manifest.sourceCommit -or $identity.runtimeProtocol -ne $manifest.runtimeProtocol) { throw 'Component identity mismatch' }
  }
  foreach ($path in @('runtime-source/package.json', 'desktop/resources/app/package.json')) {
    $pkg = Get-Content -LiteralPath (Join-Path $Root $path) -Raw | ConvertFrom-Json
    if ($pkg.version -cne $manifest.version) { throw 'Package version mismatch' }
  }
  return $manifest
}
