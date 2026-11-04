#!/usr/bin/env python3
"""HR-02.5E1 OmniVoice-BG smoke harness (installer-owned, versioned).

Real synthesis path: loads preslaff/omnivoice-bg via the omnivoice
package, conditions on a caller-provided reference wav + fixture phrase,
writes a temp wav, prints SMOKE_BYTES=<pcm bytes>. Any failure exits
non-zero with a bounded stderr line (never audio, never tokens).
"""
import os
import sys
import wave


def fail(code):
    sys.stderr.write("omnivoice_smoke: %s\n" % code)
    sys.exit(1)


def main():
    if len(sys.argv) != 4:
        fail("usage: omnivoice_smoke.py <reference-wav> <text> <out-wav>")
    ref_wav, text, out_wav = sys.argv[1], sys.argv[2], sys.argv[3]
    try:
        import torch
    except Exception:
        fail("torch-unavailable")
    if not torch.cuda.is_available():
        fail("cuda-unavailable")
    try:
        from omnivoice import OmniVoice  # type: ignore
    except Exception:
        fail("omnivoice-import-failed")
    try:
        import torch as _torch  # type: ignore
        model = OmniVoice.from_pretrained(os.environ.get("OMNIVOICE_REPO", "preslaff/omnivoice-bg"))
        if hasattr(model, "cuda"):
            model.cuda()
        if hasattr(model, "eval"):
            model.eval()
        # Real conditioning path: reference wav + transcript -> reusable
        # voice-clone prompt, then generate() the fixture phrase.
        # ref_text None: pipeline auto-conditioning path.
        prompt = model.create_voice_clone_prompt(ref_wav, None)
        out = model.generate(text, voice_clone_prompt=prompt)
        import numpy as _np  # type: ignore
        arr = out[0] if isinstance(out, list) else out
        if isinstance(arr, _torch.Tensor):
            arr = arr.detach().to("cpu").numpy()
        arr = _np.asarray(arr, dtype=_np.float32).reshape(-1)
        peak = float(_np.max(_np.abs(arr))) if arr.size else 0.0
        scale = (32767.0 / peak) if peak > 1.0 else 32767.0
        data = (arr * scale).astype(_np.int16).tobytes()
    except Exception as exc:
        sys.stderr.write("omnivoice_smoke: synth-failed %s\n" % type(exc).__name__)
        sys.exit(2)
    try:
        w = wave.open(out_wav, "wb")
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(data)
        w.close()
    except Exception:
        fail("wav-write-failed")
    if len(data) <= 0:
        fail("empty-audio")
    print("SMOKE_BYTES=" + str(len(data)))


if __name__ == "__main__":
    main()