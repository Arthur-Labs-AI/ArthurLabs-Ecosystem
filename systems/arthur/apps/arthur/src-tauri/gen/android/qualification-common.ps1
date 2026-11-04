# Shared checks for the explicitly invoked, disposable qualification scripts.
# Dot-sourcing this file never builds, installs, opens a database or starts IO.
function Get-QualificationTarget {
    param([ValidateSet('x86_64','aarch64')][string]$Target = 'x86_64')
    if ($Target -eq 'aarch64') {
        return @{ Tauri='aarch64'; Rust='aarch64-linux-android'; Abi='arm64-v8a'; Flavor='arm64'; Task='Arm64'; Machine=183 }
    }
    return @{ Tauri='x86_64'; Rust='x86_64-linux-android'; Abi='x86_64'; Flavor='x86_64'; Task='X86_64'; Machine=62 }
}

function Get-QualificationToolchain {
    param($Target)
    foreach ($name in @('JAVA_HOME','ANDROID_HOME','NDK_HOME')) {
        if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Missing $name" }
    }
    $bin = Join-Path $env:NDK_HOME 'toolchains/llvm/prebuilt/windows-x86_64/bin'
    $tools = @{
        Adb = Join-Path $env:ANDROID_HOME 'platform-tools/adb.exe'
        Analyzer = Join-Path $env:ANDROID_HOME 'cmdline-tools/latest/bin/apkanalyzer.bat'
        Linker = Join-Path $bin "$($Target.Rust)24-clang.cmd"
        Ar = Join-Path $bin 'llvm-ar.exe'
        Nm = Join-Path $bin 'llvm-nm.exe'
    }
    foreach ($file in $tools.Values) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required qualification tool is unavailable: $file" }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin/javac.exe'))) { throw 'JAVA_HOME must name a JDK' }
    $installed = @(& rustup target list --installed)
    if ($LASTEXITCODE -ne 0 -or $Target.Rust -notin $installed) { throw "Install the Rust target: rustup target add $($Target.Rust)" }
    return $tools
}

function Get-QualificationDevice {
    param([string]$Adb, [string]$Serial, $Target, [switch]$Physical)
    if ([string]::IsNullOrWhiteSpace($Serial) -or $Serial -notmatch '^[A-Za-z0-9_.:-]+$') { throw 'An explicit authorized ADB serial is required (without whitespace or shell syntax)' }
    $state = @(& $Adb -s $Serial get-state 2>&1)
    if ($LASTEXITCODE -ne 0 -or ($state -join '').Trim() -ne 'device') { throw 'Selected device is missing, offline or unauthorized' }
    $abis = (@(& $Adb -s $Serial shell getprop ro.product.cpu.abilist) -join '').Trim().Split(',')
    if ($LASTEXITCODE -ne 0 -or $Target.Abi -notin $abis) { throw "Selected device does not support $($Target.Abi)" }
    $apiText = (@(& $Adb -s $Serial shell getprop ro.build.version.sdk) -join '').Trim()
    $api = 0
    if ($LASTEXITCODE -ne 0 -or -not [int]::TryParse($apiText, [ref]$api) -or $api -lt 24) { throw 'Unsupported or unknown Android API' }
    $qemu = (@(& $Adb -s $Serial shell getprop ro.kernel.qemu) -join '').Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Unable to read device provenance' }
    $emulator = $Serial.StartsWith('emulator-') -or $qemu -eq '1'
    if ($Physical -and ($emulator -or $Target.Abi -ne 'arm64-v8a')) { throw 'Physical qualification requires an ARM64 phone, not an emulator' }
    if ($Physical -and $api -lt 29) { throw 'The native LAN route verifier requires Android API 29 or newer' }
    return @{ Abi=$Target.Abi; Api=$api; Emulator=$emulator }
}

function Assert-QualificationApk {
    param([string]$Path, [string]$ExpectedPackage, $Tools, $Target, [switch]$Native)
    if ($ExpectedPackage -notin @('dev.kaloyan.arthur.identitytest','dev.kaloyan.arthur.identitytest.test')) { throw 'Only dedicated qualification packages are allowed' }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Missing APK: $Path" }
    $actual = @(& $Tools.Analyzer manifest application-id $Path 2>&1)
    if ($LASTEXITCODE -ne 0 -or ($actual -join '').Trim() -ne $ExpectedPackage) { throw 'Refusing APK with unexpected application id' }
    $debug = @(& $Tools.Analyzer manifest debuggable $Path 2>&1)
    if ($LASTEXITCODE -ne 0 -or ($debug -join '').Trim() -ne 'true') { throw 'Qualification APK must be debuggable' }
    if ($ExpectedPackage -eq 'dev.kaloyan.arthur.identitytest.test') {
        $text = @(& $Tools.Analyzer manifest print $Path 2>&1)
        if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect instrumentation manifest' }
        $manifest = [xml]($text -join "`n")
        $instrumentation = $manifest.SelectSingleNode('/manifest/instrumentation')
        $namespace = 'http://schemas.android.com/apk/res/android'
        if ($null -eq $instrumentation -or $instrumentation.GetAttribute('targetPackage',$namespace) -ne 'dev.kaloyan.arthur.identitytest' -or $instrumentation.GetAttribute('name',$namespace) -ne 'androidx.test.runner.AndroidJUnitRunner') { throw 'Instrumentation must target the dedicated qualification app with the expected runner' }
    }
    if ($Native) {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [IO.Compression.ZipFile]::OpenRead($Path)
        $temporary = Join-Path ([IO.Path]::GetTempPath()) ('arthur-r7-inspect-' + [Guid]::NewGuid() + '.so')
        try {
            $libraries = @($zip.Entries | Where-Object { $_.FullName -match '^lib/[^/]+/libarthur_lib\.so$' })
            if ($libraries.Count -ne 1 -or $libraries[0].FullName -ne "lib/$($Target.Abi)/libarthur_lib.so") { throw 'APK must contain exactly the selected Arthur native ABI' }
            $libraryStream = $libraries[0].Open()
            $libraryFile = [IO.File]::Create($temporary)
            try { $libraryStream.CopyTo($libraryFile) } finally { $libraryFile.Dispose(); $libraryStream.Dispose() }
            $reader = [IO.BinaryReader]::new([IO.File]::OpenRead($temporary))
            try { $header = $reader.ReadBytes(20) } finally { $reader.Dispose() }
            if ($header.Length -lt 20 -or [BitConverter]::ToString($header[0..3]) -ne '7F-45-4C-46' -or $header[4] -ne 2 -or $header[5] -ne 1 -or [BitConverter]::ToUInt16($header,18) -ne $Target.Machine) { throw 'APK native library has an unexpected ELF architecture' }
            $exports = @(& $Tools.Nm --dynamic --defined-only $temporary 2>&1)
            if ($LASTEXITCODE -ne 0 -or -not ($exports -match '\bJava_dev_kaloyan_arthur_security_NativeIdentityBridgeTest_runScenario$')) { throw 'APK lacks the explicit debug qualification JNI entrypoint' }
            "PASS inspected $ExpectedPackage $($Target.Abi); native SHA256 $((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash)"
        } finally {
            $zip.Dispose()
            if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
        }
    } else { "PASS inspected $ExpectedPackage" }
}

function Assert-QualificationLanPair {
    param([string]$Windows, [string]$Android)
    foreach ($address in @($Windows,$Android)) {
        $ip = $null
        if (-not [Net.IPAddress]::TryParse($address,[ref]$ip) -or $ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $ip.ToString() -cne $address) { throw 'Explicit canonical numeric IPv4 addresses are required' }
        $bytes = $ip.GetAddressBytes()
        if (-not ($bytes[0] -eq 10 -or ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or ($bytes[0] -eq 192 -and $bytes[1] -eq 168))) { throw 'Qualification permits only explicit private LAN IPv4 addresses' }
    }
    if ($Windows -eq $Android) { throw 'Two distinct LAN devices are required' }
}

function Restore-QualificationGradle {
    param([string]$Path, [byte[]]$Before)
    $current = [IO.File]::ReadAllText($Path).Replace("`r`n","`n")
    $original = [Text.Encoding]::UTF8.GetString($Before).Replace("`r`n","`n")
    # Restore only the CLI's known generated suffix change. Concurrent/unrelated
    # edits must be inspected, never overwritten by a blanket file restoration.
    $withoutSuffix = $current.Replace('            applicationIdSuffix = ".identitytest"' + "`n",'')
    if ($current -ne $original -and $withoutSuffix -ne $original) { throw 'Unexpected generated Gradle changes; refusing to overwrite them' }
    [IO.File]::WriteAllBytes($Path,$Before)
}

function Get-QualificationFailureSummary {
    param($Failure, [int]$Phase)
    try { $reportedPhase=[int]$Failure.phase; $reportedPid=[int]$Failure.pid } catch { return }
    if ($reportedPhase -ne $Phase -or $reportedPid -le 0) { return }
    if ($Failure.stage -notin @('listen','accept','connect','authenticate','engine','flush','transfer')) { return }
    if ($Failure.fault -cnotmatch '^[A-Za-z]{1,40}(\([A-Za-z]{1,40}\))?$') { return }
    "Native phase $Phase at $($Failure.stage): $($Failure.fault)"
}
