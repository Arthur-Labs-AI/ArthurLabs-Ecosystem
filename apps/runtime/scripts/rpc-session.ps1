$ErrorActionPreference = 'Stop'
param([string]$DataRoot = '/tmp/sentry-wsl-accept', [string]$RequestsFile = '', [int]$TimeoutSec = 300)
# Sends NDJSON requests one at a time, waiting for each response id.
$lines = Get-Content $RequestsFile
$proc = Start-Process -FilePath 'wsl.exe' -ArgumentList @('-d','Ubuntu','--','bash','-c',"timeout $TimeoutSec node `$HOME/.local/share/sentry/runtime/current/apps/runtime/dist/host.js --stdio --data-root $DataRoot") -PassThru -NoNewWindow -RedirectStandardOutput "$env:TEMP/sentry-rpc-out.txt" -RedirectStandardError "$env:TEMP/sentry-rpc-err.txt" -RedirectStandardInput "$env:TEMP/sentry-rpc-in.txt"
Set-Content -Path "$env:TEMP/sentry-rpc-in.txt" -Value '' -NoNewline
$stdin = [System.IO.File]::OpenWrite("$env:TEMP/sentry-rpc-in.txt")
$writer = New-Object System.IO.StreamWriter($stdin)
foreach ($line in $lines) {
  if ($line.Trim().Length -eq 0) { continue }
  $writer.WriteLine($line); $writer.Flush()
  $id = ($line | ConvertFrom-Json).id
  $deadline = (Get-Date).AddSeconds(120)
  $found = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 200
    $text = Get-Content "$env:TEMP/sentry-rpc-out.txt" -Raw -ErrorAction SilentlyContinue
    if ($text -match "`"$id`"") { $found = $true; break }
  }
  if (-not $found) { Write-Output ("TIMEOUT waiting for " + $id); break }
}
$writer.Close(); $stdin.Close()
$proc.WaitForExit(15000) | Out-Null
Get-Content "$env:TEMP/sentry-rpc-out.txt" -Raw
