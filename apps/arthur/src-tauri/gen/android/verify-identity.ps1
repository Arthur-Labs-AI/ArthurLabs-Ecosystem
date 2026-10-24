param([Parameter(Mandatory=$true)][string]$Serial)
$ErrorActionPreference = 'Stop'
# Use the supported Tauri generator/build, never hand-written generated Gradle files.
# Requires configured JAVA_HOME, ANDROID_HOME, NDK_HOME and x86_64 Rust Android target.
foreach ($name in @('JAVA_HOME','ANDROID_HOME','NDK_HOME')) {
    if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Missing $name" }
}
$adb = Join-Path $env:ANDROID_HOME 'platform-tools/adb.exe'
if (-not (Test-Path -LiteralPath $adb)) { throw 'adb is unavailable' }
$appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$oldSerial = $env:ANDROID_SERIAL
$identityConfig = Join-Path $PSScriptRoot 'identity-tests.tauri.json'
function Install-TestApk([string]$RelativePath, [string]$ExpectedPackage) {
    $path = Join-Path $PSScriptRoot $RelativePath
    $actual = @(& $analyzer manifest application-id $path 2>&1)
    if ($LASTEXITCODE -ne 0 -or ($actual -join '').Trim() -ne $ExpectedPackage) {
        throw 'Refusing to install APK with an unexpected application id'
    }
    & $adb -s $Serial install -r $path
    if ($LASTEXITCODE -ne 0) { throw 'Dedicated test APK installation failed' }
}
function Invoke-RestartPhase([string]$Phase) {
    $reply = @(& $adb -s $Serial shell am instrument -w -e class `
        "dev.kaloyan.arthur.security.NativeIdentityRestartTest#$Phase" `
        dev.kaloyan.arthur.identitytest.test/androidx.test.runner.AndroidJUnitRunner 2>&1)
    $phaseExit = $LASTEXITCODE
    $reply | Write-Output
    # am instrument may exit 0 even when a JUnit assertion fails.
    if ($phaseExit -ne 0 -or -not ($reply -match '^OK \(1 test\)')) {
        throw "Restart phase $Phase failed"
    }
}
try {
    $env:ANDROID_SERIAL = $Serial
    Push-Location -LiteralPath $appRoot
    try {
        & npm run tauri -- android init --ci --skip-targets-install
        if ($LASTEXITCODE -ne 0) { throw 'Tauri Android generation failed' }
        & npm run tauri -- android build --debug --target x86_64 --apk --ci --features android-identity-tests --config $identityConfig
        if ($LASTEXITCODE -ne 0) { throw 'Tauri Android instrumentation build failed' }
    } finally { Pop-Location }
    $analyzer = Join-Path $env:ANDROID_HOME 'cmdline-tools/latest/bin/apkanalyzer.bat'
    $apk = Join-Path $PSScriptRoot 'app/build/outputs/apk/universal/debug/app-universal-debug.apk'
    $package = @(& $analyzer manifest application-id $apk 2>&1)
    if ($LASTEXITCODE -ne 0 -or ($package -join '').Trim() -ne 'dev.kaloyan.arthur.identitytest') {
        throw 'Refusing to install an APK without the dedicated test application id'
    }
    Push-Location -LiteralPath $PSScriptRoot
    try {
        & ./gradlew.bat tasks --all
        if ($LASTEXITCODE -ne 0) { throw 'Gradle task discovery failed' }
        # Reuse the feature-enabled .so just built successfully by Tauri above.
        # Its generated Android Studio callback requires the now-finished CLI server.
        & ./gradlew.bat connectedX86_64DebugAndroidTest -x rustBuildX86_64Debug `
            '-Pandroid.testInstrumentationRunnerArguments.class=dev.kaloyan.arthur.security.NativeIdentityBridgeTest,dev.kaloyan.arthur.security.DeviceSigningIdentityTest'
        if ($LASTEXITCODE -ne 0) { throw 'Native identity instrumentation failed' }
        # Connected-test cleanup removes these APKs. Install only the checked,
        # dedicated packages for two separate process-restart invocations.
        Install-TestApk 'app/build/outputs/apk/x86_64/debug/app-x86_64-debug.apk' 'dev.kaloyan.arthur.identitytest'
        Install-TestApk 'app/build/outputs/apk/androidTest/x86_64/debug/app-x86_64-debug-androidTest.apk' 'dev.kaloyan.arthur.identitytest.test'
        Invoke-RestartPhase 'prepare'
        & $adb -s $Serial shell am force-stop dev.kaloyan.arthur.identitytest
        if ($LASTEXITCODE -ne 0) { throw 'Test process stop failed' }
        Invoke-RestartPhase 'reopen'
    } finally { Pop-Location }
} finally {
    $env:ANDROID_SERIAL = $oldSerial
}
