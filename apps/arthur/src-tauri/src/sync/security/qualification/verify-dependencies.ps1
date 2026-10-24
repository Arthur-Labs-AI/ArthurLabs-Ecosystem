param(
    [string]$ManifestPath = (Join-Path $PSScriptRoot '../../../../Cargo.toml'),
    [string]$OutputDirectory = (Join-Path ([IO.Path]::GetTempPath()) 'arthur-e3a2-dependencies')
)
$ErrorActionPreference = 'Stop'
# Public package metadata only. This is an OSV snapshot, NOT an independent audit.
$raw = @(& cargo metadata --manifest-path $ManifestPath --format-version 1 --locked --offline)
if ($LASTEXITCODE -ne 0) { throw 'Cargo metadata failed' }
$metadata = ($raw -join "`n") | ConvertFrom-Json
$nodes = @{}
foreach ($node in $metadata.resolve.nodes) { $nodes[$node.id] = $node }
$queue = [Collections.Generic.Queue[string]]::new()
foreach ($package in $metadata.packages) {
    if ($package.name -in @('opaque-ke','argon2')) { $queue.Enqueue($package.id) }
}
if ($queue.Count -ne 2) { throw 'Expected exact OPAQUE and Argon2 qualification roots' }
$visited = [Collections.Generic.HashSet[string]]::new()
while ($queue.Count) {
    $dependencyId = $queue.Dequeue()
    if ($visited.Add($dependencyId)) {
        if (-not $nodes.ContainsKey($dependencyId)) { throw 'Incomplete Cargo dependency graph' }
        foreach ($child in $nodes[$dependencyId].dependencies) { $queue.Enqueue($child) }
    }
}
$packages = @($metadata.packages | Where-Object { $visited.Contains($_.id) } |
    Sort-Object name,version | Select-Object name,version,license)
$queries = @($packages | ForEach-Object {
    @{ package = @{ name=$_.name; ecosystem='crates.io' }; version=$_.version }
})
$response = Invoke-RestMethod -Method Post -Uri 'https://api.osv.dev/v1/querybatch' `
    -ContentType 'application/json' -Body (@{queries=$queries} | ConvertTo-Json -Depth 6)
if ($response.results.Count -ne $packages.Count) { throw 'Incomplete OSV response' }
$findings = @()
for ($index=0; $index -lt $packages.Count; $index++) {
    foreach ($entry in $response.results[$index].vulns) {
        $findings += [PSCustomObject]@{
            package=$packages[$index].name; version=$packages[$index].version; advisory=$entry.id
        }
    }
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$packages | ConvertTo-Json -Depth 3 | Set-Content -Encoding utf8 (Join-Path $OutputDirectory 'packages.json')
[PSCustomObject]@{
    checkedAt=(Get-Date -Format o); source='https://api.osv.dev/v1/querybatch'
    scope='Locked all-target transitive closure of opaque-ke and argon2; includes target/build dependencies'
    packages=$packages.Count; findings=$findings
} | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $OutputDirectory 'advisories.json')
"OSV snapshot: $($packages.Count) packages; $($findings.Count) advisory records"
$findings | Format-Table
