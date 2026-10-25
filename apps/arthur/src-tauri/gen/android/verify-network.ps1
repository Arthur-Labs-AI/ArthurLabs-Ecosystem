param([Parameter(Mandatory=$true)][string]$Serial)
$ErrorActionPreference = 'Stop'
# Run verify-identity.ps1 first: reuses its debug-only feature-enabled x86_64 .so.
# This standalone project is absent from the default Tauri Gradle settings.
foreach ($name in @('JAVA_HOME','ANDROID_HOME')) {
    if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Missing $name" }
}
$project = Join-Path $PSScriptRoot 'qualification-network'
$adb = Join-Path $env:ANDROID_HOME 'platform-tools/adb.exe'
$analyzer = Join-Path $env:ANDROID_HOME 'cmdline-tools/latest/bin/apkanalyzer.bat'
if ((Get-Content -Raw (Join-Path $PSScriptRoot 'settings.gradle')) -match 'qualification-network') {
    throw 'Test permission project must not be included in the default build'
}
& (Join-Path $PSScriptRoot 'gradlew.bat') -p $project assembleDebug assembleDebugAndroidTest
if ($LASTEXITCODE -ne 0) { throw 'Standalone qualification build failed' }
$tasks = @(& (Join-Path $PSScriptRoot 'gradlew.bat') -p $project tasks --all 2>&1)
if ($LASTEXITCODE -ne 0 -or ($tasks -match '^assembleRelease\b')) { throw 'Standalone release variant must be disabled' }
foreach ($spec in @(
    @('build/outputs/apk/debug','dev.kaloyan.arthur.identitytest'),
    @('build/outputs/apk/androidTest/debug','dev.kaloyan.arthur.identitytest.test')
)) {
    $apks = @(Get-ChildItem -LiteralPath (Join-Path $project $spec[0]) -Filter '*.apk')
    if ($apks.Count -ne 1) { throw 'Expected one dedicated APK' }
    $id = @(& $analyzer manifest application-id $apks[0].FullName 2>&1)
    if ($LASTEXITCODE -ne 0 -or ($id -join '').Trim() -ne $spec[1]) { throw 'Refusing unexpected APK package' }
    if ($spec[1] -eq 'dev.kaloyan.arthur.identitytest') {
        $permissions = @(& $analyzer manifest permissions $apks[0].FullName 2>&1)
        if ($LASTEXITCODE -ne 0 -or -not ($permissions -match '^android.permission.ACCESS_NETWORK_STATE$')) {
            throw 'Dedicated qualification permission is missing'
        }
    }
    & $adb -s $Serial install -r $apks[0].FullName
    if ($LASTEXITCODE -ne 0) { throw 'Dedicated APK install failed' }
}
$reply = @(& $adb -s $Serial shell am instrument -w -e class dev.kaloyan.arthur.security.NativeIdentityBridgeTest `
    dev.kaloyan.arthur.identitytest.test/androidx.test.runner.AndroidJUnitRunner 2>&1)
$result = $LASTEXITCODE
$reply | Write-Output
if ($result -ne 0 -or -not ($reply -match '^OK \(7 tests\)')) { throw 'Actual Android network qualification failed' }
'PASS standalone debug-only: 3 native probes; 4 LAN runner methods assumption-skipped without explicit opt-in; release variant absent'
