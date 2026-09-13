# HR-02 Parakeet local STT setup (opt-in, development machine only).
# Installs the Transformers Parakeet worker dependencies and pre-downloads
# nvidia/parakeet-tdt-0.6b-v3 so first use never blocks on download.
# The deterministic test suite NEVER runs this and NEVER downloads weights.
#
# Production backend is Transformers (ParakeetForTDT). NeMo is NOT required
# and is NOT installed by this script; an existing NeMo install is left alone.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\voice\setup_parakeet.ps1
#
# Enable Parakeet in ARTHUR (.env):
#   ARTHUR_LOCAL_STT_PROVIDER=parakeet
#   ARTHUR_LOCAL_STT_MODEL=nvidia/parakeet-tdt-0.6b-v3
#   ARTHUR_STT_POLICY=local_only   # force local path for acceptance
#   ARTHUR_TTS_POLICY=local_only

$ErrorActionPreference = "Stop"

Write-Host "[parakeet] checking python..."
python --version

# Do not reinstall/replace an already-working CUDA PyTorch build: if torch is
# importable at all, keep it; install only what is missing.
$torchOk = $false
try {
  $cudaCheck = python -c "import torch; print("cuda" if torch.cuda.is_available() else "cpu")" 2>$null
  if ($cudaCheck -eq "cuda") {
    Write-Host "[parakeet] existing CUDA PyTorch build detected; keeping it."
    $torchOk = $true
  } elseif ($cudaCheck -eq "cpu") {
    Write-Host "[parakeet] torch present (CPU-only); keeping it."
    $torchOk = $true
  }
} catch {
  Write-Host "[parakeet] torch not detected; installing worker dependencies..."
}
if (-not $torchOk) {
  Write-Host "[parakeet] installing worker dependencies (torch, transformers, safetensors, numpy)..."
  python -m pip install --upgrade pip
  python -m pip install torch transformers safetensors numpy
} else {
  Write-Host "[parakeet] ensuring transformers/safetensors/numpy are installed (without touching torch)..."
  python -m pip install transformers safetensors numpy
}

$model = if ($env:PARAKEET_MODEL) { $env:PARAKEET_MODEL } else { "nvidia/parakeet-tdt-0.6b-v3" }
Write-Host "[parakeet] pre-downloading model (transformers format): $model"
$env:PARAKEET_MODEL = $model
$env:PARAKEET_BACKEND = "transformers"
python -c "from transformers import AutoProcessor, ParakeetForTDT; AutoProcessor.from_pretrained('$model'); ParakeetForTDT.from_pretrained('$model'); print('[parakeet] model cached')"

Write-Host "[parakeet] smoke-testing the worker protocol (valid 16 kHz mono s16le silence)..."
# Valid probe: 1 s of 16 kHz mono s16le silence (32000 zero bytes) as base64.
# Empty transcript is acceptable for silence; only "ok": true counts as success.
$probeResult = python -c @"
import base64, json, subprocess, sys, os
silence_b64 = base64.b64encode(bytes(32000)).decode('ascii')
req = json.dumps({'id': 'setup-probe', 'audio_b64': silence_b64, 'sample_rate_hz': 16000}) + chr(10)
env = dict(os.environ)
env['PARAKEET_BACKEND'] = 'transformers'
try:
    proc = subprocess.run(
        [sys.executable, 'tools/voice/parakeet_worker.py'],
        input=req, capture_output=True, text=True, timeout=300, env=env)
except subprocess.TimeoutExpired:
    print('[parakeet] smoke probe FAILED: worker timed out', file=sys.stderr)
    sys.exit(1)
line = ''
for candidate in (proc.stdout or '').splitlines():
    candidate = candidate.strip()
    if not candidate:
        continue
    try:
        obj = json.loads(candidate)
    except Exception:
        continue
    if isinstance(obj, dict) and obj.get('id') == 'setup-probe':
        line = candidate
        break
if not line:
    print('[parakeet] smoke probe FAILED: no matching worker response', file=sys.stderr)
    print('--- stdout ---', file=sys.stderr)
    print((proc.stdout or '')[-2000:], file=sys.stderr)
    print('--- stderr ---', file=sys.stderr)
    print((proc.stderr or '')[-2000:], file=sys.stderr)
    sys.exit(1)
obj = json.loads(line)
print(line)
if obj.get('ok') is True:
    sys.exit(0)
print('[parakeet] smoke probe FAILED: worker returned ok:false', file=sys.stderr)
sys.exit(1)
"@
if ($LASTEXITCODE -ne 0) {
  Write-Error "[parakeet] smoke probe FAILED (see output above). Not marking setup complete."
  exit 1
}
Write-Host $probeResult

Write-Host "[parakeet] done. Set ARTHUR_LOCAL_STT_PROVIDER=parakeet to enable."
