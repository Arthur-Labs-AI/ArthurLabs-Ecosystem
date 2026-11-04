param([string]$Serial,
    [ValidateSet('x86_64','aarch64')][string]$Target = 'x86_64',
    [switch]$BuildOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'qualification-common.ps1')
$selected = Get-QualificationTarget $Target
$tools = Get-QualificationToolchain $selected
# Run verify-identity.ps1 for the SAME target first: reuses its debug .so.
# This standalone project is absent from the default Tauri Gradle settings.
if (-not $BuildOnly) { $device = Get-QualificationDevice $tools.Adb $Serial $selected; "Device ABI $($device.Abi), API $($device.Api), emulator=$($device.Emulator)" }
$project = Join-Path $PSScriptRoot 'qualification-network'
$adb = $tools.Adb
$analyzer = $tools.Analyzer
if ((Get-Content -Raw (Join-Path $PSScriptRoot 'settings.gradle')) -match 'qualification-network') {
    throw 'Test permission project must not be included in the default build'
}
& (Join-Path $PSScriptRoot 'gradlew.bat') -p $project "-PqualificationAbi=$($selected.Abi)" assembleDebug assembleDebugAndroidTest
if ($LASTEXITCODE -ne 0) { throw 'Standalone qualification build failed' }
$tasks = @(& (Join-Path $PSScriptRoot 'gradlew.bat') -p $project "-PqualificationAbi=$($selected.Abi)" tasks --all 2>&1)
if ($LASTEXITCODE -ne 0 -or ($tasks -match '^assembleRelease\b')) { throw 'Standalone release variant must be disabled' }
foreach ($spec in @(
    @('build/outputs/apk/debug','dev.kaloyan.arthur.identitytest'),
    @('build/outputs/apk/androidTest/debug','dev.kaloyan.arthur.identitytest.test')
)) {
    $apks = @(Get-ChildItem -LiteralPath (Join-Path $project $spec[0]) -Filter '*.apk')
    if ($apks.Count -ne 1) { throw 'Expected one dedicated APK' }
    Assert-QualificationApk $apks[0].FullName $spec[1] $tools $selected -Native:($spec[1] -eq 'dev.kaloyan.arthur.identitytest')
    if ($spec[1] -eq 'dev.kaloyan.arthur.identitytest') {
        $permissions = @(& $analyzer manifest permissions $apks[0].FullName 2>&1)
        if ($LASTEXITCODE -ne 0 -or -not ($permissions -match '^android.permission.ACCESS_NETWORK_STATE$') -or -not ($permissions -match '^android.permission.ACCESS_LOCAL_NETWORK$')) {
            throw 'Dedicated qualification permissions are missing'
        }
    }
}
if ($BuildOnly) { 'PASS dedicated network APKs built and inspected; no device execution or installation'; return }
foreach ($directory in @('build/outputs/apk/debug','build/outputs/apk/androidTest/debug')) {
    $apk = @(Get-ChildItem -LiteralPath (Join-Path $project $directory) -Filter '*.apk')[0]
    & $adb -s $Serial install -r $apk.FullName
    if ($LASTEXITCODE -ne 0) { throw 'Dedicated APK install failed' }
}
$probes = @('r4_actual_owned_socket_selected_network_binding','r6_incremental_knowledge_history_bootstrap_reopen','n7c_actual_read_only_snapshot_no_source_or_lan_approval','n7c_actual_callback_registration_delivery_cleanup_and_closed_candidate') | ForEach-Object { "dev.kaloyan.arthur.security.NativeIdentityBridgeTest#$_" }
$reply = @(& $adb -s $Serial shell am instrument -w -e class ($probes -join ',') `
    dev.kaloyan.arthur.identitytest.test/androidx.test.runner.AndroidJUnitRunner 2>&1)
$result = $LASTEXITCODE
$reply | Write-Output
if ($result -ne 0 -or -not ($reply -match '^OK \(4 tests\)')) { throw 'Actual Android network qualification failed' }
'PASS standalone debug-only: 4 selected native probes; LAN runner not invoked; release variant absent'
