# ------------------------------------------------------------------
# ARTHUR True Wake Word v1 - sherpa-onnx KWS setup (TASK-0009)
#
# Idempotent Windows helper that prepares the machine-local wake model:
#   1. downloads + extracts the official English GigaSpeech zipformer KWS
#      model (3.3M params, INT8 + FP32 ONNX) into models/wake/ (git-ignored);
#   2. writes the raw keyword source file (keywords_raw.txt);
#   3. converts it into the encoded keywords_arthur.txt using the model's
#      tokens.txt + bpe.model via the official sherpa-onnx text2token
#      tooling (pip install sherpa-onnx; never part of the ARTHUR runtime).
#
# The keyword file encoding is model-specific BPE token text - the raw word
# (e.g. "Arthur") can NEVER be placed into the final keywords file directly.
#
# Usage (from the repo root):
#   powershell -ExecutionPolicy Bypass -File tools\voice\setup_sherpa_wake.ps1
#   powershell -ExecutionPolicy Bypass -File tools\voice\setup_sherpa_wake.ps1 -Keyword Arthur
# ------------------------------------------------------------------
param(
  # The literal wake word. Compared case-insensitively at runtime.
  [string]$Keyword = "Arthur",
  # Repo root (defaults to the parent of tools/voice).
  [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
  # Force a fresh keyword-file generation even if it already exists.
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$ModelName = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
$ModelUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/$ModelName.tar.bz2"
$WakeRoot = Join-Path $RepoRoot "models\wake"
$ModelDir = Join-Path $WakeRoot $ModelName
$KeywordsFile = Join-Path $ModelDir "keywords_arthur.txt"

function Write-Step($message) { Write-Host "[setup_sherpa_wake] $message" }

# ---- 1) Model -------------------------------------------------------------
$requiredOnnx = @("encoder", "decoder", "joiner") | ForEach-Object {
  Get-ChildItem -Path $ModelDir -Filter "$_*.onnx" -ErrorAction SilentlyContinue | Select-Object -First 1
}
if ($requiredOnnx -contains $null -or -not (Test-Path (Join-Path $ModelDir "tokens.txt"))) {
  Write-Step "model not found in $ModelDir - downloading (~18 MB, machine-local, git-ignored)"
  New-Item -ItemType Directory -Force -Path $WakeRoot | Out-Null
  $tarball = Join-Path $WakeRoot "$ModelName.tar.bz2"
  # Node fetch is used on purpose: no schannel/PowerShell TLS configuration
  # dependencies, same stack as the ARTHUR runtime.
  $downloadScript = @"
const fs = require('fs');
(async () => {
  const resp = await fetch(process.argv[1], { redirect: 'follow' });
  if (!resp.ok) { console.error('download failed: HTTP ' + resp.status); process.exit(1); }
  fs.writeFileSync(process.argv[2], Buffer.from(await resp.arrayBuffer()));
  console.log('downloaded bytes:', fs.statSync(process.argv[2]).size);
})().catch((e) => { console.error(e.message); process.exit(1); });
"@
  $downloadScript | Out-File -Encoding utf8 (Join-Path $env:TEMP "arthur_kws_download.cjs")
  node (Join-Path $env:TEMP "arthur_kws_download.cjs") $ModelUrl $tarball
  if ($LASTEXITCODE -ne 0) { throw "model download failed; download $ModelUrl manually and extract into $ModelDir" }
  tar -xf $tarball -C $WakeRoot
  Remove-Item $tarball -Force
  Remove-Item (Join-Path $env:TEMP "arthur_kws_download.cjs") -Force -ErrorAction SilentlyContinue
}
if (-not (Test-Path (Join-Path $ModelDir "tokens.txt"))) { throw "tokens.txt missing after extraction: $ModelDir" }
Write-Step "model OK: $ModelName"

# ---- 2) Raw keyword source (small text file, machine-local) ---------------
if ($Keyword -match "\s") { throw "the wake word must be a single word (no spaces): '$Keyword'" }
$rawPath = Join-Path $ModelDir "keywords_raw.txt"
# The @DISPLAY annotation is what sherpa returns as result.keyword on a
# detection; it must not contain spaces (single word here by construction).
# The ENCODED text must be UPPERCASE: the GigaSpeech BPE token table is
# uppercase (lowercase pieces like 'rthur' do not exist in tokens.txt).
# ascii encoding = UTF-8 without BOM on every PowerShell edition (a BOM
# prefix would corrupt the first token for text2token). The GigaSpeech model
# is English-only; non-ASCII wake words are out of scope for v1.
Set-Content -Path $rawPath -Value "$($Keyword.ToUpperInvariant()) @$($Keyword)" -Encoding ascii
Write-Step "raw keyword written: $rawPath ('$Keyword @' + '$Keyword')"

# ---- 3) text2token conversion (official sherpa-onnx tooling) --------------
if ((Test-Path $KeywordsFile) -and -not $Force) {
  Write-Step "encoded keywords already present: $KeywordsFile (use -Force to regenerate)"
} else {
  $cli = Get-Command sherpa-onnx-cli -ErrorAction SilentlyContinue
  if (-not $cli) {
    throw "sherpa-onnx-cli not found. Install the official one-shot converter tooling (runtime ARTHUR never needs Python): pip install sherpa-onnx click sentencepiece pypinyin"
  }
  # The tool prints U+2581 (sentencepiece marker); force UTF-8 so a cp1252
  # Windows console cannot crash the conversion at the print step.
  $env:PYTHONUTF8 = "1"
  $env:PYTHONIOENCODING = "utf-8"
  & $cli.Source text2token `
    --tokens (Join-Path $ModelDir "tokens.txt") `
    --tokens-type bpe `
    --bpe-model (Join-Path $ModelDir "bpe.model") `
    $rawPath $KeywordsFile
  if ($LASTEXITCODE -ne 0) { throw "text2token failed with exit code $LASTEXITCODE" }
}

$encoded = (Get-Content $KeywordsFile -TotalCount 1).Trim()
if ($encoded -eq "") { throw "generated keywords file is empty: $KeywordsFile" }
Write-Step "encoded keyword: $encoded"

# ---- 4) ARTHUR .env configuration ----------------------------------------
Write-Host ""
Write-Host "Add/confirm these lines in .env (ARTHUR_WAKE_ENABLED stays under your control):"
Write-Host "  ARTHUR_WAKE_PROVIDER=sherpa"
Write-Host "  ARTHUR_WAKE_WORD=$Keyword"
Write-Host "  ARTHUR_WAKE_MODEL_DIR=models/wake/$ModelName"
Write-Host "  ARTHUR_WAKE_KEYWORDS_FILE=            (empty = keywords_arthur.txt inside the model dir)"
Write-Host "  ARTHUR_WAKE_KEYWORDS_SCORE=1"
Write-Host "  ARTHUR_WAKE_KEYWORDS_THRESHOLD=0.25"
Write-Host "  ARTHUR_WAKE_NUM_THREADS=1"
Write-Host ""
Write-Host "Done. Start ARTHUR and run the real-device wake checks (README 'True Wake Word v1')."
