param(
    [string]$Serial,
    [ValidateSet('x86_64','aarch64')][string]$Target = 'x86_64',
    [switch]$BuildOnly
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'qualification-common.ps1')
# Use the supported Tauri generator/build, never hand-written generated Gradle files.
$selected = Get-QualificationTarget $Target
$tools = Get-QualificationToolchain $selected
$adb = $tools.Adb
$analyzer = $tools.Analyzer
if (-not $BuildOnly) { $device = Get-QualificationDevice $adb $Serial $selected; "Device ABI $($device.Abi), API $($device.Api), emulator=$($device.Emulator)" }
$appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$generatedGradle = Join-Path $PSScriptRoot 'app/build.gradle.kts'
$gradleBefore = [IO.File]::ReadAllBytes($generatedGradle)
if ([Text.Encoding]::UTF8.GetString($gradleBefore).Contains('applicationIdSuffix')) { throw 'Start with the ordinary generated application configuration (no debug package suffix)' }
$environment = @{
    ANDROID_SERIAL = $Serial
    CARGO_NET_OFFLINE = 'true'
}
$environment['CARGO_TARGET_' + $selected.Rust.Replace('-','_').ToUpperInvariant() + '_LINKER'] = $tools.Linker
$environment['CC_' + $selected.Rust.Replace('-','_')] = $tools.Linker
$environment['AR_' + $selected.Rust.Replace('-','_')] = $tools.Ar
$previous = @{}
$identityConfig = Join-Path $PSScriptRoot 'identity-tests.tauri.json'
function Install-TestApk([string]$RelativePath, [string]$ExpectedPackage) {
    $path = Join-Path $PSScriptRoot $RelativePath
    Assert-QualificationApk $path $ExpectedPackage $tools $selected -Native:($ExpectedPackage -eq 'dev.kaloyan.arthur.identitytest')
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
    foreach ($name in $environment.Keys) {
        $previous[$name] = [Environment]::GetEnvironmentVariable($name)
        [Environment]::SetEnvironmentVariable($name,$environment[$name])
    }
    "NDK linker: $($tools.Linker); Rust target: $($selected.Rust)"
    Push-Location -LiteralPath $appRoot
    try {
        & npm run tauri -- android init --ci --skip-targets-install
        if ($LASTEXITCODE -ne 0) { throw 'Tauri Android generation failed' }
        & npm run tauri -- android build --debug --target $selected.Tauri --apk --ci --features android-identity-tests --config $identityConfig
        if ($LASTEXITCODE -ne 0) { throw 'Tauri Android instrumentation build failed' }
    } finally { Pop-Location }
    $apk = Join-Path $PSScriptRoot 'app/build/outputs/apk/universal/debug/app-universal-debug.apk'
    Assert-QualificationApk $apk 'dev.kaloyan.arthur.identitytest' $tools $selected -Native
    Push-Location -LiteralPath $PSScriptRoot
    try {
        & ./gradlew.bat tasks --all
        if ($LASTEXITCODE -ne 0) { throw 'Gradle task discovery failed' }
        # Build both checked artifacts without requiring a connected device.
        # Reuse the feature-enabled .so just built successfully by Tauri above.
        # Its generated Android Studio callback requires the now-finished CLI server.
        & ./gradlew.bat "assemble$($selected.Task)Debug" "assemble$($selected.Task)DebugAndroidTest" -x "rustBuild$($selected.Task)Debug"
        if ($LASTEXITCODE -ne 0) { throw 'Instrumentation APK build failed' }
        $appApk = "app/build/outputs/apk/$($selected.Flavor)/debug/app-$($selected.Flavor)-debug.apk"
        $testApk = "app/build/outputs/apk/androidTest/$($selected.Flavor)/debug/app-$($selected.Flavor)-debug-androidTest.apk"
        Assert-QualificationApk (Join-Path $PSScriptRoot $appApk) 'dev.kaloyan.arthur.identitytest' $tools $selected -Native
        Assert-QualificationApk (Join-Path $PSScriptRoot $testApk) 'dev.kaloyan.arthur.identitytest.test' $tools $selected
        if ($BuildOnly) { 'PASS dedicated qualification APKs built and inspected; no device execution or installation'; return }
        & ./gradlew.bat "connected$($selected.Task)DebugAndroidTest" -x "rustBuild$($selected.Task)Debug" `
            '-Pandroid.testInstrumentationRunnerArguments.class=dev.kaloyan.arthur.security.NativeIdentityBridgeTest,dev.kaloyan.arthur.security.DeviceSigningIdentityTest,dev.kaloyan.arthur.security.TlsIdentityTest'
        if ($LASTEXITCODE -ne 0) { throw 'Native identity instrumentation failed' }
        # Connected-test cleanup removes these APKs. Install only the checked,
        # dedicated packages for two separate process-restart invocations.
        Install-TestApk $appApk 'dev.kaloyan.arthur.identitytest'
        Install-TestApk $testApk 'dev.kaloyan.arthur.identitytest.test'
        Invoke-RestartPhase 'prepare'
        & $adb -s $Serial shell am force-stop dev.kaloyan.arthur.identitytest
        if ($LASTEXITCODE -ne 0) { throw 'Test process stop failed' }
        Invoke-RestartPhase 'reopen'
    } finally { Pop-Location }
} finally {
    try {
        # The supported CLI materializes its suffix in the generated file.
        # android init leaves an existing Gradle file alone, so undo only that
        # known temporary change and preserve the exact original file bytes.
        Restore-QualificationGradle $generatedGradle $gradleBefore
    } finally {
        foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name,$previous[$name]) }
    }
}
