param(
    [string]$ManifestPath = (Join-Path $PSScriptRoot '../../../../Cargo.toml'),
    [string]$OutputDirectory = (Join-Path ([IO.Path]::GetTempPath()) 'arthur-e3a3-isolation')
)
$ErrorActionPreference = 'Stop'
# Check actual resolved target graphs, including a positive control for each lab.
# This proves dependency isolation, not binary reachability or advisory remediation.
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
foreach ($target in @('x86_64-pc-windows-msvc','x86_64-linux-android')) {
    foreach ($lab in @($false,$true)) {
        $edges = 'normal,build'
        $extra = @()
        if ($lab) {
            if ($target -eq 'x86_64-linux-android') { $extra = @('--features','android-identity-tests') }
            else { $edges = 'normal,build,dev' }
        }
        $graph = @(& cargo tree --manifest-path $ManifestPath --locked --offline --target $target `
            --edges $edges --prefix none --format '{p}' @extra)
        if ($LASTEXITCODE -ne 0) { throw "Cargo graph failed: $target lab=$lab" }
        $graph | Set-Content -Encoding utf8 (Join-Path $OutputDirectory "$target-lab-$lab.txt")
        foreach ($package in @('opaque-ke','argon2','crypto-bigint')) {
            $present = [bool]($graph -match "^$package v")
            if ($present -ne $lab) { throw "Unexpected $package exposure: $target lab=$lab" }
        }
        "PASS $target lab=$lab ($edges)"
    }
}
