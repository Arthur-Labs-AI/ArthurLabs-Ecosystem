# Host-only safety regression tests. No SDK, device, network or database needed.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'qualification-common.ps1')
$script:checks = 0
function Check([bool]$Value, [string]$Message) {
    if (-not $Value) { throw $Message }
    $script:checks++
}
function Refuses([scriptblock]$Action, [string]$Reason) {
    $caught = $null
    try { & $Action | Out-Null } catch { $caught = $_.Exception.Message }
    Check ($null -ne $caught -and $caught.Contains($Reason)) "Expected refusal containing '$Reason', got '$caught'"
}
Check ((Get-QualificationTarget aarch64).Abi -eq 'arm64-v8a') 'ARM64 ABI mapping'
Check ((Get-QualificationTarget aarch64).Task -eq 'Arm64') 'Supported generated Gradle flavor'
Check ((Get-QualificationTarget).Abi -eq 'x86_64') 'Emulator default retained'
Assert-QualificationLanPair '192.168.1.2' '192.168.1.3'
Assert-QualificationLanPair '10.0.0.1' '10.0.0.2'
Assert-QualificationLanPair '172.31.1.1' '172.31.1.2'
foreach ($invalid in @('8.8.8.8','127.0.0.1','0.0.0.0','169.254.1.2','224.0.0.1','192.168.1.02','localhost','::1','172.32.1.1','')) {
    Refuses { Assert-QualificationLanPair '192.168.1.2' $invalid } ''
}
Refuses { Assert-QualificationLanPair '192.168.1.2' '192.168.1.2' } 'distinct'
Refuses { Assert-QualificationApk 'unused' 'dev.kaloyan.arthur' $null $null } 'Only dedicated'
Refuses { & (Join-Path $PSScriptRoot 'verify-cross-device.ps1') -Serial 'usb-phone' -Physical } 'no ADB reverse fallback'
Refuses { & (Join-Path $PSScriptRoot 'verify-cross-device.ps1') -Serial 'usb-phone' -Physical -LanAddress '8.8.8.8' -AndroidAddress '192.168.1.3' } 'private LAN'

Refuses { & (Join-Path $PSScriptRoot 'verify-cross-device.ps1') -Serial 'unused' -SignedOriginal -SignedHistory } 'Select exactly one signed profile'

function Fake-Adb {
    $global:LASTEXITCODE = 0
    switch ($args[-1]) {
        'get-state' { $script:deviceState }
        'ro.product.cpu.abilist' { $script:deviceAbis }
        'ro.build.version.sdk' { $script:deviceApi }
        'ro.kernel.qemu' { $script:deviceQemu }
        default { throw 'Unexpected ADB operation in read-only preflight' }
    }
}
$script:deviceState='device'; $script:deviceAbis='arm64-v8a,armeabi-v7a'; $script:deviceApi='37'; $script:deviceQemu='0'
$arm = Get-QualificationTarget aarch64
$device = Get-QualificationDevice Fake-Adb 'usb-phone' $arm -Physical
Check ($device.Api -eq 37 -and -not $device.Emulator) 'Physical preflight facts'
$script:deviceState='unauthorized'
Refuses { Get-QualificationDevice Fake-Adb 'usb-phone' $arm -Physical } 'unauthorized'
$script:deviceState='device'; $script:deviceAbis='x86_64'
Refuses { Get-QualificationDevice Fake-Adb 'usb-phone' $arm -Physical } 'does not support'
$script:deviceAbis='arm64-v8a'; $script:deviceQemu='1'
Refuses { Get-QualificationDevice Fake-Adb 'usb-phone' $arm -Physical } 'not an emulator'
$script:deviceQemu='0'
Refuses { Get-QualificationDevice Fake-Adb 'emulator-5554' $arm -Physical } 'not an emulator'
$script:deviceApi='28'
Refuses { Get-QualificationDevice Fake-Adb 'usb-phone' $arm -Physical } 'API 29'
$script:deviceApi='unknown'
Refuses { Get-QualificationDevice Fake-Adb 'usb-phone' $arm -Physical } 'unknown Android API'
Refuses { Get-QualificationDevice Fake-Adb '' $arm -Physical } 'serial'
Refuses { Get-QualificationDevice Fake-Adb 'usb phone;command' $arm -Physical } 'serial'
Check ((Get-QualificationFailureSummary @{pid=123;phase=1;stage='connect';fault='Io(HostUnreachable)'} 1) -eq 'Native phase 1 at connect: Io(HostUnreachable)') 'Display closed native failure code'
Check ($null -eq (Get-QualificationFailureSummary @{pid=123;phase=1;stage='connect';fault='Io(HostUnreachable)'} 2)) 'Reject stale phase diagnostic'
Check ($null -eq (Get-QualificationFailureSummary @{pid=123;phase=1;stage='connect';fault="Io`nprivate payload"} 1)) 'Reject unbounded/free-text diagnostic'

$temporary = [IO.Path]::GetTempFileName()
try {
    function Fake-Analyzer {
        $global:LASTEXITCODE=0
        switch ($args[1]) {
            'application-id' { 'dev.kaloyan.arthur.identitytest.test' }
            'debuggable' { 'true' }
            'print' { '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><instrumentation android:targetPackage="dev.kaloyan.arthur" android:name="androidx.test.runner.AndroidJUnitRunner" /></manifest>' }
            default { throw 'Unexpected APK inspection operation' }
        }
    }
    Refuses { Assert-QualificationApk $temporary 'dev.kaloyan.arthur.identitytest.test' @{Analyzer='Fake-Analyzer'} $arm } 'Instrumentation must target'
    $before = [Text.Encoding]::UTF8.GetBytes("buildTypes {`r`n        getByName(`"debug`") {`r`n        }`r`n}`r`n")
    $withSuffix = [Text.Encoding]::UTF8.GetString($before).Replace("        getByName(`"debug`") {`r`n", "        getByName(`"debug`") {`r`n" + '            applicationIdSuffix = ".identitytest"' + "`r`n")
    [IO.File]::WriteAllText($temporary,$withSuffix)
    Restore-QualificationGradle $temporary $before
    Check ([Convert]::ToBase64String([IO.File]::ReadAllBytes($temporary)) -ceq [Convert]::ToBase64String($before)) 'Exact default Gradle restoration including CRLF'
    [IO.File]::WriteAllText($temporary,$withSuffix + '// unrelated concurrent edit')
    Refuses { Restore-QualificationGradle $temporary $before } 'refusing to overwrite'
    Check ([IO.File]::ReadAllText($temporary).EndsWith('// unrelated concurrent edit')) 'Preserve unrelated generated-file edits'
} finally { Remove-Item -LiteralPath $temporary }
"PASS $script:checks host-only qualification checks (synthetic device facts; no physical evidence)"
