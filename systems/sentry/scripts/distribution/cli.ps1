# The included Electron executable provides Node for the production-only CLI.
# ProcessStartInfo keeps streams capturable by both shells and automation clients.
function ConvertTo-DistributionArgument {
  param([AllowEmptyString()][string]$Value)
  # Windows CommandLineToArgvW/CRT quoting: double slash runs before embedded
  # quotes and before the closing quote; preserve empty arguments as well.
  $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}

function Invoke-DistributionCli {
  param([string]$Root, [string[]]$CliArguments = @())
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $executable = Join-Path $Root 'desktop/Sentry.exe'
  $entry = Join-Path $Root 'cli/sentry-cli.cjs'
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf) -or -not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    throw 'Packaged CLI is missing. Verify and extract the complete archive again.'
  }
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $executable
  $start.Arguments = (@(@($entry) + $CliArguments | ForEach-Object { ConvertTo-DistributionArgument $_ }) -join ' ')
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $start.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
  $start.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
  $start.EnvironmentVariables.Remove('NODE_OPTIONS')
  $child = [System.Diagnostics.Process]::Start($start)
  try {
    $stdout = $child.StandardOutput.ReadToEndAsync()
    $stderr = $child.StandardError.ReadToEndAsync()
    $child.WaitForExit()
    [Console]::Out.Write($stdout.GetAwaiter().GetResult())
    [Console]::Error.Write($stderr.GetAwaiter().GetResult())
    return $child.ExitCode
  } finally { $child.Dispose() }
}
