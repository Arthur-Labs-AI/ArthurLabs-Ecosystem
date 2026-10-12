function Get-DistributionDesktop {
  return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -ieq 'Sentry.exe' -or ($_.Name -ieq 'electron.exe' -and ([string]$_.CommandLine -match '--sentry-app|[\\/]apps[\\/]desktop')) })
}
function Stop-DistributionDesktop {
  param([Parameter(Mandatory = $true)][string]$Executable, [int]$TimeoutSeconds = 45)
  if (@(Get-DistributionDesktop).Count -eq 0) { return }
  $result = Invoke-SentryNative -FilePath $Executable -Arguments @('--sentry-control=stop') -TimeoutSec 45
  if ($result.ExitCode -ne 0) { throw 'Graceful stop failed; cancel QA, wait, then retry. No runtime was changed.' }
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while (@(Get-DistributionDesktop).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (@(Get-DistributionDesktop).Count -gt 0) { throw 'Sentry is still running; maintenance refused. Cancel QA and retry stop.' }
}
