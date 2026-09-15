#!/usr/bin/env python3
"""HR-02.5E2 BgTTS-38M-V2 runtime worker (persistent, installer-owned, versioned).

Production provider worker (NOT the E1 smoke script): loads
beleata74/BgTTS-38M-V2 checkpoint + MioCodec ONCE (checkpoint dir via
BGTTS_SNAPSHOT, defaulting to the managed cache), then serves bounded
synthesis requests over a persistent stdin/stdout JSONL protocol:

  -> {"id": "<req>", "op": "synthesize", "text": "...", "output_path": "<managed wav path>"}
  <- {"id": "<req>", "ok": true, "audio_path": "<wav path>", "sample_rate_hz": 24000, "bytes": <pcm bytes>}
  <- {"id": "<req>", "ok": false, "error": "<bounded code>"}

Reference conditioning: caller passes a managed reference wav via
BGTTS_REF_WAV or per-request `ref_path` (same containment rules as
the OmniVoice worker). Generation mirrors inference.py (bounded to
SMOKE-like token budgets scaled for production utterances).

Stdout carries ONLY protocol JSON lines (ASCII-safe). Diagnostics go
to stderr (bounded, never audio/transcripts/tokens).
"""
import json
import os
import sys

MAX_LINE_BYTES = 4 * 1024 * 1024
MAX_TEXT_CHARS = 2000
MAX_NEW_TOKENS = 1024
ERROR_CODES = {"bad_request", "torch-unavailable", "cuda-unavailable", "hub-unavailable", "load-failed", "condition-failed", "synth-failed", "empty-audio"}


def err_line(req_id, code):
    if code not in ERROR_CODES:
        code = "synth-failed"
    return json.dumps({"id": req_id, "ok": False, "error": code}, ensure_ascii=True)


def load_stack(snapshot_dir):
    import torch
    if not torch.cuda.is_available():
        return None, "cuda-unavailable"
    if not os.path.isdir(snapshot_dir):
        return None, "load-failed"
    sys.path.insert(0, snapshot_dir)
    try:
        from huggingface_hub import snapshot_download  # type: ignore
    except Exception:
        return None, "hub-unavailable"
    try:
        from miocodec import MioCodec  # type: ignore
        assert MioCodec
        from model import load_for_inference  # type: ignore
        from tokenizer import TTSTokenizer  # type: ignore
        from codec import CodecV6  # type: ignore
        from inference import generate  # type: ignore
    except Exception:
        return None, "load-failed"
    try:
        ckpt_file = os.path.join(snapshot_dir, "checkpoint_inference.pt")
        model = load_for_inference(ckpt_file, device="cuda")
        tokenizer = TTSTokenizer()
        codec = CodecV6(device="cuda")
        return {"model": model, "tokenizer": tokenizer, "codec": codec, "generate": generate}, ""
    except Exception:
        return None, "load-failed"


def synthesize(stack, text, ref_wav, out_wav):
    import torch
    with torch.no_grad():
        enc = stack["codec"].encode(ref_wav)
        spk = enc["global_embedding"].to("cuda")
        codes = stack["generate"](stack["model"], stack["tokenizer"], text, spk, MAX_NEW_TOKENS, 0.7, 250, 0.95, 1.1, "cuda")
        if codes is None or len(codes) == 0:
            return None, "empty-audio"
        wav = stack["codec"].tokens_to_wav(codes, spk, out_wav)
        n = len(wav) if hasattr(wav, "__len__") else 0
        if n <= 0:
            return None, "empty-audio"
        return {"audio_path": out_wav, "sample_rate_hz": 24000, "bytes": int(n)}, ""


def serve(stack, snapshot_dir, default_ref):
    del snapshot_dir
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
            result, err = synthesize(stack, text, ref_wav, out_path)
        except Exception as exc:
            sys.stderr.write("bgtts_worker: synth-failed %s\n" % type(exc).__name__)
            sys.stderr.flush()
            result, err = None, "synth-failed"
        if err:
            sys.stdout.write(err_line(rid, err) + "\n")
        else:
            sys.stdout.write(json.dumps({"id": rid, "ok": True, **result}, ensure_ascii=True) + "\n")
        sys.stdout.flush()


def resolve_snapshot():
    explicit = os.environ.get("BGTTS_SNAPSHOT", "")
    if explicit and os.path.isdir(explicit):
        return explicit, ""
    try:
        from huggingface_hub import snapshot_download  # type: ignore
        return snapshot_download(repo_id=os.environ.get("BGTTS_REPO", "beleata74/BgTTS-38M-V2")), ""
    except Exception:
        return "", "load-failed"


def main():
    default_ref = os.environ.get("BGTTS_REF_WAV", "")
    try:
        import torch  # noqa: F401
    except Exception:
        sys.stderr.write("bgtts_worker: torch-unavailable\n")
        sys.exit(3)
    snapshot_dir, err = resolve_snapshot()
    if err:
        sys.stderr.write("bgtts_worker: %s\n" % err)
        sys.exit(2)
    stack, err = load_stack(snapshot_dir)
    if err:
        sys.stderr.write("bgtts_worker: %s\n" % err)
        sys.exit(2)
    serve(stack, snapshot_dir, default_ref)


if __name__ == "__main__":
    main()