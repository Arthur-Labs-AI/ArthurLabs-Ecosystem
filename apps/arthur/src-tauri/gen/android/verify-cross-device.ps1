param([Parameter(Mandatory=$true)][string]$Serial,
    [string]$LanAddress,[string]$AndroidAddress,[ValidateRange(1024,65535)][int]$AndroidSourcePort=37432)
# Supplying both addresses explicitly authorizes the narrow disposable LAN test.
# ADB is control/public-results only in this mode: no reverse data connection.
$lanMode= -not [string]::IsNullOrEmpty($LanAddress)
if ($lanMode -ne (-not [string]::IsNullOrEmpty($AndroidAddress))) {throw 'Both LAN addresses are required'}
if ($lanMode) {
    foreach ($address in @($LanAddress,$AndroidAddress)) {
        $ip=[Net.IPAddress]::Parse($address)
        if ($ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $ip.ToString() -ne $address) {throw 'Explicit numeric IPv4 addresses required'}
    }
    if ($LanAddress -eq $AndroidAddress) {throw 'Two distinct interfaces/devices required'}
}
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../../..'))
$adb=Join-Path $env:ANDROID_HOME 'platform-tools/adb.exe'
$base=Join-Path ([IO.Path]::GetTempPath()) ('arthur-r3-'+[Guid]::NewGuid())
New-Item -ItemType Directory -Path $base | Out-Null
$oldDir=$env:ARTHUR_R3_DIR; $oldCase=$env:ARTHUR_R3_CASE
$env:ARTHUR_R3_DIR=$base
$testName='storage::journal::cross_device_qualification::r3_windows_external_endpoint'
$runner='dev.kaloyan.arthur.identitytest.test/androidx.test.runner.AndroidJUnitRunner'
$app='dev.kaloyan.arthur.identitytest'
$deviceRoot='cache/r3-cross-device'
$endpointClass=if($lanMode){'dev.kaloyan.arthur.security.NativeIdentityBridgeTest'}else{'dev.kaloyan.arthur.security.CrossDeviceSyncTest'}
$runnerFlag=if($lanMode){'arthurR4Lan'}else{'arthurR3'}
function Android([string]$Method) {
    $reply=@(& $adb -s $Serial shell am instrument -w -e $runnerFlag true -e class "$endpointClass#$Method" $runner 2>&1)
    $reply | Write-Output
    if ($LASTEXITCODE -ne 0 -or -not ($reply -match '^OK \(1 test\)')) { throw "Android $Method failed" }
}
function Windows([int]$Case,[string]$Name) {
    $env:ARTHUR_R3_CASE="$Case"
    Start-Process -FilePath $script:exe -ArgumentList @('--ignored','--exact',$testName,'--nocapture','--test-threads=1') -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $base "$Name.log") -RedirectStandardError (Join-Path $base "$Name.err.log")
}
function Finished($Process) {
    if (-not $Process.WaitForExit(30000)) { throw 'Windows endpoint did not exit' }
    if ($Process.ExitCode -ne 0) { throw 'Windows endpoint failed; inspect disposable runner log' }
}
function Pull([string]$Name,[string]$Destination) {
    $text=@(& $adb -s $Serial exec-out run-as $app cat "$deviceRoot/$Name" 2>$null)
    if ($LASTEXITCODE -ne 0) { return $false }
    # adb exec-out can report exit 0 for a remote cat failure. Accept only a
    # complete JSON publication, not shell diagnostics or a partial read.
    $json=$text -join "`n"
    try { $value=$json | ConvertFrom-Json; if (-not $value.pid) {return $false} } catch {return $false}
    [IO.File]::WriteAllText($Destination,$json,[Text.UTF8Encoding]::new($false))
    return $true
}
$bridge=$false; $process=$null; $androidProcess=$null
try {
    if ((@(& $adb -s $Serial reverse --list) -join "`n") -match 'tcp:37431') { throw 'Qualification ADB port is already in use' }
    Push-Location -LiteralPath $repo
    try {
        $build=@(& cargo test --locked --offline --manifest-path apps/arthur/src-tauri/Cargo.toml --lib --no-run --message-format=json 2> (Join-Path $base 'build.log'))
        if ($LASTEXITCODE -ne 0) { throw 'Windows qualification build failed' }
        $artifacts=@($build | ForEach-Object {try {$_ | ConvertFrom-Json} catch {}} | Where-Object {$_.reason -eq 'compiler-artifact' -and $_.profile.test -and $_.executable})
        if ($artifacts.Count -ne 1) { throw 'Expected one Windows test executable' }
        $script:exe=$artifacts[0].executable
    } finally {Pop-Location}
    $process=Windows 43 'prepare'; Finished $process
    Android prepare
    $androidPublic=Join-Path $base 'android-public.json'
    if (-not (Pull 'public.json' $androidPublic)) { throw 'Missing Android public fixture' }
    if ($lanMode) {
        $lan=@{windows=$LanAddress;android=$AndroidAddress;source_port=$AndroidSourcePort;server_port=0}
        [IO.File]::WriteAllText((Join-Path $base 'lan.json'),($lan | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
    }
    Copy-Item -LiteralPath $androidPublic -Destination (Join-Path $base 'peer.json')
    & $adb -s $Serial push (Join-Path $base 'public.json') '/data/local/tmp/arthur-r3-public.json' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Public manifest push failed' }
    & $adb -s $Serial shell run-as $app cp '/data/local/tmp/arthur-r3-public.json' "$deviceRoot/peer.json"
    if ($LASTEXITCODE -ne 0) { throw 'Public manifest install failed' }
    $pids=@()
    foreach ($phase in @(1,2)) {
        & $adb -s $Serial shell am force-stop $app
        if ($LASTEXITCODE -ne 0) { throw 'Dedicated process stop failed' }
        $process=Windows (43+$phase) "windows-$phase"
        $ready=Join-Path $base 'listen.json'; $deadline=[DateTime]::UtcNow.AddSeconds(15); $listen=$null
        while ([DateTime]::UtcNow -lt $deadline) {
            if (Test-Path -LiteralPath $ready) {
                try { $candidate=Get-Content -LiteralPath $ready -Raw | ConvertFrom-Json; if ($candidate.phase -eq $phase) {$listen=$candidate;break} } catch {}
            }
            if ($process.HasExited) { throw 'Windows endpoint exited before listening' }
            Start-Sleep -Milliseconds 50
        }
        if (-not $listen) { throw 'Missing bounded qualification listener' }
        if ($lanMode) {
            $lan.server_port=[int]$listen.port
            $config=Join-Path $base 'android-lan.json'
            [IO.File]::WriteAllText($config,($lan | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
            & $adb -s $Serial push $config '/data/local/tmp/arthur-r4-lan.json' | Out-Null
            if ($LASTEXITCODE -ne 0) {throw 'Public LAN config push failed'}
            & $adb -s $Serial shell run-as $app cp '/data/local/tmp/arthur-r4-lan.json' "$deviceRoot/lan.json"
            if ($LASTEXITCODE -ne 0) {throw 'Public LAN config install failed'}
        } else {
            & $adb -s $Serial reverse tcp:37431 "tcp:$($listen.port)"
            if ($LASTEXITCODE -ne 0) { throw 'ADB reverse failed' };$bridge=$true
        }
        $method=if ($phase -eq 1) {'exchange'}else{'resume'}
        $androidLog=Join-Path $base "android-$phase.log"; $androidError=Join-Path $base "android-$phase.err.log"
        $androidProcess=Start-Process -FilePath $adb -ArgumentList @('-s',$Serial,'shell','am','instrument','-w','-e',$runnerFlag,'true','-e','class',"$endpointClass#$method",$runner) `
            -WindowStyle Hidden -PassThru -RedirectStandardOutput $androidLog -RedirectStandardError $androidError
        $windowsResult=Join-Path $base "result-$phase.json"; $androidResult=Join-Path $base "android-result-$phase.json"
        $deadline=[DateTime]::UtcNow.AddSeconds(65);$pulled=$false
        while ([DateTime]::UtcNow -lt $deadline) {
            if (Test-Path -LiteralPath $windowsResult) { $pulled=Pull "result-$phase.json" $androidResult; if ($pulled) {break} }
            if ($process.HasExited -or $androidProcess.HasExited) { throw 'Endpoint exited before durable result publication' }
            Start-Sleep -Milliseconds 100
        }
        if (-not $pulled) { throw 'Cross-platform transfer timed out' }
        [IO.File]::WriteAllText((Join-Path $base "finish-$phase"),'done')
        & $adb -s $Serial shell run-as $app touch "$deviceRoot/finish-$phase"
        if ($LASTEXITCODE -ne 0) { throw 'Finish barrier failed' }
        Finished $process
        if (-not $androidProcess.WaitForExit(30000) -or -not ((Get-Content -LiteralPath $androidLog) -match '^OK \(1 test\)')) {throw 'Android exchange failed'}
        $w=Get-Content -LiteralPath $windowsResult -Raw | ConvertFrom-Json
        $a=Get-Content -LiteralPath $androidResult -Raw | ConvertFrom-Json
        if ($w.pid -ne $process.Id -or $w.events.Count -ne 3 -or $a.events.Count -ne 3) {throw 'Endpoint/evidence count mismatch'}
        if (($w.events | ConvertTo-Json -Depth 100 -Compress) -cne ($a.events | ConvertTo-Json -Depth 100 -Compress)) {throw 'Canonical event/row evidence differs'}
        $expectedPending=if($phase -eq 1){2}else{0}
        if ($w.outstanding.Count -ne $expectedPending -or $a.outstanding.Count -ne 0) {throw 'Incorrect durable receipt/retry state'}
        $pids+=@{windows=$w.pid;android=$a.pid}
        "PASS phase $phase CNG/Keystore TLS13 exact bidirectional originals/rows; pending lost receipts $expectedPending; Windows PID $($w.pid), Android PID $($a.pid)"
        "Endpoints Windows $($w.endpoints -join ' -> '); Android $($a.endpoints -join ' -> ')"
    }
    if ($pids[0].windows -eq $pids[1].windows -or $pids[0].android -eq $pids[1].android) {throw 'Both endpoint processes must restart'}
    $before=Get-Content (Join-Path $base 'result-1.json') -Raw | ConvertFrom-Json
    $after=Get-Content (Join-Path $base 'result-2.json') -Raw | ConvertFrom-Json
    if (($before.events | ConvertTo-Json -Depth 100 -Compress) -cne ($after.events | ConvertTo-Json -Depth 100 -Compress)) {throw 'Restart altered original evidence'}
    foreach ($endpoint in @('result','android-result')) {
        $first=Get-Content (Join-Path $base "$endpoint-1.json") -Raw | ConvertFrom-Json
        $second=Get-Content (Join-Path $base "$endpoint-2.json") -Raw | ConvertFrom-Json
        foreach ($field in @('proofs','cursors')) {
            if (($first.$field | ConvertTo-Json -Depth 100 -Compress) -cne ($second.$field | ConvertTo-Json -Depth 100 -Compress)) {throw "Restart altered $endpoint $field"}
        }
    }
    if ($lanMode) {'PASS direct native TCP, both process restarts, exact persisted OS public keys, no duplicate application; no ADB reverse data path'}
    else {'PASS both process restarts, exact persisted OS public keys, no duplicate application; ADB-mediated loopback only'}
    "Evidence: $base"
} finally {
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id }
    if ($androidProcess -and -not $androidProcess.HasExited) { Stop-Process -Id $androidProcess.Id }
    if ($bridge) { & $adb -s $Serial reverse --remove tcp:37431 | Out-Null }
    # Only this explicitly-created fixture is eligible for cleanup.
    if (Test-Path -LiteralPath (Join-Path $base 'db')) { try { $p=Windows 46 'cleanup'; Finished $p } catch { Write-Warning 'Windows fixture cleanup needs inspection' } }
    try { Android cleanup } catch { Write-Warning 'Android fixture cleanup needs inspection' }
    $env:ARTHUR_R3_DIR=$oldDir;$env:ARTHUR_R3_CASE=$oldCase
}
