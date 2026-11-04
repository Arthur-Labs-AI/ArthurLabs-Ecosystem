param([Parameter(Mandatory=$true)][string]$Serial,
    [string]$LanAddress,[string]$AndroidAddress,[ValidateRange(1024,65535)][int]$AndroidSourcePort=37432,
    [switch]$Physical,[switch]$SignedOriginal,[switch]$SignedHistory)
$ErrorActionPreference='Stop'
if ($SignedOriginal -and $SignedHistory) {throw 'Select exactly one signed profile'}
$signed=$SignedOriginal -or $SignedHistory
. (Join-Path $PSScriptRoot 'qualification-common.ps1')
# Supplying both addresses explicitly authorizes the narrow disposable LAN test.
# ADB is control/public-results only in this mode: no reverse data connection.
$lanMode= -not [string]::IsNullOrEmpty($LanAddress)
if ($lanMode -ne (-not [string]::IsNullOrEmpty($AndroidAddress))) {throw 'Both LAN addresses are required'}
if ($Physical -and -not $lanMode) { throw 'Physical mode requires both explicitly permitted LAN addresses; no ADB reverse fallback' }
if ($lanMode) {
    Assert-QualificationLanPair $LanAddress $AndroidAddress
}
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../../..'))
$adb=Join-Path $env:ANDROID_HOME 'platform-tools/adb.exe'
$selected=Get-QualificationTarget $(if($Physical){'aarch64'}else{'x86_64'})
$device=Get-QualificationDevice $adb $Serial $selected -Physical:$Physical
"Selected device: ABI $($device.Abi), API $($device.Api), emulator=$($device.Emulator)"
if ($SignedHistory) { 'Scope: R9 signed historical bootstrap and reverse post-H originals, OS author signatures, pinned mutual TLS; incarnation rotation remains unsupported' }
elseif ($SignedOriginal) { 'Scope: R8 SignedOriginal candidate profile, real OS author signatures, explicit signed registry fixtures, pinned mutual TLS' }
else { 'Scope: canonical Envelope events over pinned mutual TLS; per-original SignedOriginal envelopes are not exercised by this existing lab' }
if ($lanMode) {
    $interfaces=@(Get-NetIPAddress -AddressFamily IPv4 -IPAddress $LanAddress -ErrorAction Stop)
    if ($interfaces.Count -ne 1 -or $interfaces[0].AddressState -ne 'Preferred') {throw 'Windows LAN address must belong to exactly one preferred local interface'}
    $lanProfile=Get-NetConnectionProfile -InterfaceIndex $interfaces[0].InterfaceIndex -ErrorAction Stop
    if ($lanProfile.NetworkCategory -ne 'Private') {throw 'Selected Windows interface requires an explicit Private network profile; script never changes it'}
    "Selected Windows interface index $($interfaces[0].InterfaceIndex); Private profile; native binding rechecks the route"
}
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
$routeArguments=if($lanMode){@('-e','arthurWindowsAddress',$LanAddress,'-e','arthurAndroidAddress',$AndroidAddress)}else{@()}
function Android([string]$Method) {
    $reply=@(& $adb -s $Serial shell am instrument -w -e $runnerFlag true @routeArguments -e class "$endpointClass#$Method" $runner 2>&1)
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
$bridge=$false; $process=$null; $androidProcess=$null; $androidPrepared=$false
try {
    # Fails with PermissionRequired before opening a listener or creating fixture data.
    if ($lanMode) { Android preflight }
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
    $androidPrepared=$true
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
    if ($signed) {
        $process=Windows 49 'registry'; Finished $process
        & $adb -s $Serial push (Join-Path $base 'registry.json') '/data/local/tmp/arthur-r8-registry.json' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Public signed registry push failed' }
        & $adb -s $Serial shell run-as $app cp '/data/local/tmp/arthur-r8-registry.json' "$deviceRoot/registry.json"
        if ($LASTEXITCODE -ne 0) { throw 'Public signed registry install failed' }
        Android registry
        if ($SignedHistory) {
            $process=Windows 50 'history'; Finished $process
            Android history
        }
    }
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
        $androidProcess=Start-Process -FilePath $adb -ArgumentList (@('-s',$Serial,'shell','am','instrument','-w','-e',$runnerFlag,'true') + $routeArguments + @('-e','class',"$endpointClass#$method",$runner)) `
            -WindowStyle Hidden -PassThru -RedirectStandardOutput $androidLog -RedirectStandardError $androidError
        $windowsResult=Join-Path $base "result-$phase.json"; $androidResult=Join-Path $base "android-result-$phase.json"
        $deadline=[DateTime]::UtcNow.AddSeconds(65);$pulled=$false
        while ([DateTime]::UtcNow -lt $deadline) {
            if (Test-Path -LiteralPath $windowsResult) { $pulled=Pull "result-$phase.json" $androidResult; if ($pulled) {break} }
            if ($process.HasExited -or $androidProcess.HasExited) {
                $androidFailure=Join-Path $base 'android-failure.json'
                if (Pull 'failure.json' $androidFailure) {
                    Get-QualificationFailureSummary (Get-Content -LiteralPath $androidFailure -Raw | ConvertFrom-Json) $phase
                }
                $windowsFailure=Join-Path $base 'failure.json'
                if (Test-Path -LiteralPath $windowsFailure) {
                    Get-QualificationFailureSummary (Get-Content -LiteralPath $windowsFailure -Raw | ConvertFrom-Json) $phase
                }
                throw 'Endpoint exited before durable result publication'
            }
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
        $expectedProfile=if($SignedHistory){'m05-signed-history-candidate-v1'}elseif($SignedOriginal){'m05-signed-original-candidate-v1'}else{'m05-ledger-candidate'}
        if ($w.profile -ne $expectedProfile -or $a.profile -ne $expectedProfile) {throw 'Native profile differs from explicit controller selection'}
        if ($signed) {
            foreach ($event in @($w.events)+@($a.events)) {
                if ($event.signed_original.Count -lt 1 -or $event.signed_original.Count -gt 16384 -or $event.author.Count -ne 65) {throw 'Missing native-verified original author/signature evidence'}
            }
            if ($w.original_seals.Count -ne 1 -or $a.original_seals.Count -ne 1) {throw 'Missing signed origin seal'}
        }
        if (($w.events | ConvertTo-Json -Depth 100 -Compress) -cne ($a.events | ConvertTo-Json -Depth 100 -Compress)) {throw 'Canonical event/row evidence differs'}
        $expectedPending=if($phase -eq 1 -and -not $SignedHistory){2}else{0}
        if ($w.outstanding.Count -ne $expectedPending -or $a.outstanding.Count -ne 0) {throw 'Incorrect durable receipt/retry state'}
        $expectedStatus=if($phase -eq 1){'Syncing'}else{'CleanlyApplied'}
        if ($w.status -ne $expectedStatus -or $a.status -ne 'CleanlyApplied' -or $w.needs_attention -ne $false -or $a.needs_attention -ne $false) {throw 'Incorrect native status/attention boundary'}
        if ($SignedHistory) {
            if ($w.snapshots.Count -ne 1 -or $a.snapshots.Count -ne 1) {throw 'Missing signed snapshot evidence'}
            $expectedOutcome=if($phase -eq 1){'staged'}else{'applied'}
            if ($w.snapshots[0].outcome -ne $expectedOutcome -or $a.snapshots[0].outcome -ne 'applied' -or $w.snapshots[0].direction -ne 'out' -or $a.snapshots[0].direction -ne 'in') {throw 'Incorrect durable signed snapshot receipt state'}
            foreach ($field in @('id','image_hash','image_bytes','image_chunks','evidence_hash','evidence_bytes','evidence_chunks')) {
                if ($w.snapshots[0].$field -cne $a.snapshots[0].$field) {throw "Signed snapshot descriptor mismatch: $field"}
            }
        }
        $pids+=@{windows=$w.pid;android=$a.pid}
        "PASS phase $phase CNG/Keystore TLS13 exact bidirectional originals/rows; pending original receipts $expectedPending; Windows PID $($w.pid), Android PID $($a.pid)"
        if ($SignedHistory) { "Signed snapshot source receipt state: $expectedOutcome" }
        if ($phase -eq 1) { 'Delivery pending: phase 1 is NOT up-to-date; phase 2 must obtain the missing durable receipts' }
        "Endpoints Windows $($w.endpoints -join ' -> '); Android $($a.endpoints -join ' -> ')"
    }
    if ($pids[0].windows -eq $pids[1].windows -or $pids[0].android -eq $pids[1].android) {throw 'Both endpoint processes must restart'}
    $before=Get-Content (Join-Path $base 'result-1.json') -Raw | ConvertFrom-Json
    $after=Get-Content (Join-Path $base 'result-2.json') -Raw | ConvertFrom-Json
    if (($before.events | ConvertTo-Json -Depth 100 -Compress) -cne ($after.events | ConvertTo-Json -Depth 100 -Compress)) {throw 'Restart altered original evidence'}
    foreach ($endpoint in @('result','android-result')) {
        $first=Get-Content (Join-Path $base "$endpoint-1.json") -Raw | ConvertFrom-Json
        $second=Get-Content (Join-Path $base "$endpoint-2.json") -Raw | ConvertFrom-Json
        $stableFields=@('proofs','cursors')
        if ($signed) { $stableFields+=@('original_seals') }
        if ($SignedHistory) {
            foreach ($field in @('id','image_hash','image_bytes','image_chunks','evidence_hash','evidence_bytes','evidence_chunks','direction')) {
                if ($first.snapshots[0].$field -cne $second.snapshots[0].$field) {throw "Restart altered immutable signed snapshot $field"}
            }
        }
        foreach ($field in $stableFields) {
            if (($first.$field | ConvertTo-Json -Depth 100 -Compress) -cne ($second.$field | ConvertTo-Json -Depth 100 -Compress)) {throw "Restart altered $endpoint $field"}
        }
    }
    if ($SignedHistory) { 'PASS R9 signed snapshot: exact cached image and proof, lost ACK, reverse post-H original, both process restarts; rotation was not authorized or exercised' }
    elseif ($SignedOriginal) { 'PASS R8 signed profile: exact original-author signatures and accepted seals survived both process restarts; full signature verification ran inside the native store' }
    if ($Physical) {'PASS — EXECUTED ON PHYSICAL DEVICE: direct native TCP, both process restarts, exact persisted OS public keys, no duplicates; no ADB reverse data path'}
    elseif ($lanMode) {'PASS direct native TCP; device provenance reported above; no ADB reverse data path'}
    else {'PASS both process restarts, exact persisted OS public keys, no duplicate application; ADB-mediated loopback only'}
    "Evidence: $base"
} finally {
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id }
    if ($androidProcess -and -not $androidProcess.HasExited) { Stop-Process -Id $androidProcess.Id }
    if ($androidPrepared) { & $adb -s $Serial shell am force-stop $app | Out-Null }
    if ($bridge) { & $adb -s $Serial reverse --remove tcp:37431 | Out-Null }
    # Only this explicitly-created fixture is eligible for cleanup.
    if (Test-Path -LiteralPath (Join-Path $base 'db')) { try { $p=Windows 46 'cleanup'; Finished $p } catch { Write-Warning 'Windows fixture cleanup needs inspection' } }
    if ($androidPrepared) { try { Android cleanup } catch { Write-Warning 'Android fixture cleanup needs inspection' } }
    $env:ARTHUR_R3_DIR=$oldDir;$env:ARTHUR_R3_CASE=$oldCase
}
