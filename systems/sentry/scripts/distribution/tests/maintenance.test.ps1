$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../maintenance.ps1')
$script:code = 0
$script:running = $false
$script:sent = 0
function Get-DistributionDesktop { if ($script:running) { [pscustomobject]@{ Id = 123 } } }
function Invoke-SentryNative { param($FilePath, $Arguments, $TimeoutSec) $script:sent++; return @{ ExitCode = $script:code } }
Stop-DistributionDesktop -Executable 'fixture'
if ($script:sent -ne 0) { throw 'Idle stop should not launch anything' }
$script:running = $true
$script:code = 1
$refused = $false
try { Stop-DistributionDesktop -Executable 'fixture' -TimeoutSeconds 0 } catch { $refused = $true }
if (-not $refused) { throw 'Failed shutdown accepted' }
$script:code = 0
$refused = $false
try { Stop-DistributionDesktop -Executable 'fixture' -TimeoutSeconds 0 } catch { $refused = $true }
if (-not $refused) { throw 'Still-running Desktop accepted' }
function Invoke-SentryNative { param($FilePath, $Arguments, $TimeoutSec) $script:running = $false; return @{ ExitCode = 0 } }
$script:running = $true
Stop-DistributionDesktop -Executable 'fixture'
Write-Host 'RELEASE-MAINTENANCE-OK (idle, failed stop, busy, successful stop)'
