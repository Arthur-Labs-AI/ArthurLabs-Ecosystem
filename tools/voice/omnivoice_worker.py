#!/usr/bin/env python3
"""HR-02.5E2 OmniVoice-BG runtime worker (persistent, installer-owned, versioned).

Production provider worker (NOT the E1 smoke script): loads
preslaff/omnivoice-bg ONCE, then serves bounded synthesis requests over
a persistent stdin/stdout JSONL protocol (one object per line):

  -> {"id": "<req>", "op": "synthesize", "text": "...", "output_path": "<managed wav path>"}
  <- {"id": "<req>", "ok": true, "audio_path": "<wav path>", "sample_rate_hz": 24000, "bytes": <pcm bytes>}
  <- {"id": "<req>", "ok": false, "error": "<bounded code>"}

Reference conditioning: the caller passes a managed reference wav via
OMNIVOICE_REF_WAV (installer-owned default) or per-request `ref_path`.
Paths are used as given (the Node side containment-checks them); the
worker never lists directories or follows caller-controlled roots.

Stdout carries ONLY protocol JSON lines (ASCII-safe). Diagnostics go
to stderr (bounded, never audio/transcripts/tokens). No microphone,
no quality judgment — operational synthesis only.
"""
import json
import os
import sys
import wave

MAX_LINE_BYTES = 4 * 1024 * 1024
MAX_TEXT_CHARS = 2000
ERROR_CODES = {"bad_request", "torch-unavailable", "cuda-unavailable", "model-load-failed", "condition-failed", "synth-failed", "wav-write-failed", "empty-audio"}


def err_line(req_id, code):
    if code not in ERROR_CODES:
        code = "synth-failed"
    return json.dumps({"id": req_id, "ok": False, "error": code}, ensure_ascii=True)


def load_model():
    import torch
    if not torch.cuda.is_available():
        return None, "cuda-unavailable"
    try:
        from omnivoice import OmniVoice  # type: ignore
    except Exception:
        return None, "omnivoice-import-failed"
    try:
        model = OmniVoice.from_pretrained(os.environ.get("OMNIVOICE_REPO", "preslaff/omnivoice-bg"))
        if hasattr(model, "cuda"):
            model.cuda()
        if hasattr(model, "eval"):
            model.eval()
        return model, ""
    except Exception:
        return None, "model-load-failed"


def synthesize(model, text, ref_wav, out_wav):
    import torch
    import numpy as _np
    prompt = model.create_voice_clone_prompt(ref_wav, None)
    out = model.generate(text, voice_clone_prompt=prompt)
    arr = out[0] if isinstance(out, list) else out
    if isinstance(arr, torch.Tensor):
        arr = arr.detach().to("cpu").numpy()
    arr = _np.asarray(arr, dtype=_np.float32).reshape(-1)
    peak = float(_np.max(_np.abs(arr))) if arr.size else 0.0
    scale = (32767.0 / peak) if peak > 1.0 else 32767.0
    data = (arr * scale).astype(_np.int16).tobytes()
    if len(data) <= 0:
        return None, "empty-audio"
    try:
        w = wave.open(out_wav, "wb")
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(data)
        w.close()
    except Exception:
        return None, "wav-write-failed"
    return {"audio_path": out_wav, "sample_rate_hz": 24000, "bytes": len(data)}, ""


def serve(model, default_ref):
    # Raw byte stdin (parakeet pattern): the host console encoding is
    # irrelevant (managed venvs default to cp1252); UTF-8 is decoded
    # per line, undecodable lines are skipped, never fatal.
    stdin = sys.stdin.buffer
    while True:
        raw = stdin.readline(MAX_LINE_BYTES + 2)
        if not raw:
            break
        if len(raw) > MAX_LINE_BYTES + 1:
            continue
        try:
            req = json.loads(raw.decode("utf-8"))
        except Exception:
            continue
        if not isinstance(req, dict):
            continue
        rid = req.get("id")
        if not isinstance(rid, str) or rid == "":
            continue
        if req.get("op") != "synthesize":
            sys.stdout.write(err_line(rid, "bad_request") + "\n")
            sys.stdout.flush()
            continue
        text = req.get("text")
        out_path = req.get("output_path")
        if not isinstance(text, str) or text == "" or len(text) > MAX_TEXT_CHARS:
            sys.stdout.write(err_line(rid, "bad_request") + "\n")
            sys.stdout.flush()
            continue
        if not isinstance(out_path, str) or out_path == "":
            sys.stdout.write(err_line(rid, "bad_request") + "\n")
            sys.stdout.flush()
            continue
        ref_wav = req.get("ref_path") if isinstance(req.get("ref_path"), str) and req.get("ref_path") != "" else default_ref
        if not ref_wav:
            sys.stdout.write(err_line(rid, "condition-failed") + "\n")
            sys.stdout.flush()
            continue
        try:
            result, err = synthesize(model, text, ref_wav, out_path)
        except Exception as exc:
            sys.stderr.write("omnivoice_worker: synth-failed %s\n" % type(exc).__name__)
            sys.stderr.flush()
            result, err = None, "synth-failed"
        if err:
            sys.stdout.write(err_line(rid, err) + "\n")
        else:
            sys.stdout.write(json.dumps({"id": rid, "ok": True, **result}, ensure_ascii=True) + "\n")
        sys.stdout.flush()


def main():
    default_ref = os.environ.get("OMNIVOICE_REF_WAV", "")
    try:
        import torch  # noqa: F401
    except Exception:
        sys.stderr.write("omnivoice_worker: torch-unavailable\n")
        sys.exit(3)
    model, err = load_model()
    if err:
        sys.stderr.write("omnivoice_worker: %s\n" % err)
        sys.exit(2)
    serve(model, default_ref)


if __name__ == "__main__":
    main()