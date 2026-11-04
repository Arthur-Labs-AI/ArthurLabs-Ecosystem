#!/usr/bin/env python3
"""HR-02.5E1 BgTTS-38M-V2 smoke harness (installer-owned, versioned).

Real synthesis path (mirrors inference.py of the proven standalone recipe,
standalone recipe): load_for_inference(checkpoint) + TTSTokenizer +
CodecV6, encode the caller-provided reference wav to a speaker
embedding, generate() the fixture phrase with a small token bound,
decode with codec.tokens_to_wav to the output wav.
Prints SMOKE_BYTES=<pcm bytes>. Failures exit non-zero with a bounded
stderr line (never audio, never tokens).
"""
import os
import sys
import wave

SMOKE_MAX_TOKENS = 128


def fail(code):
    sys.stderr.write("bgtts_smoke: %s\n" % code)
    sys.exit(1)


def pick_device():
    # HR-02.5 Linux enablement: cuda when the torch build exposes it,
    # otherwise cpu. The upstream generate()/CodecV6/load_for_inference
    # all accept a device string (generate documents "cuda/cpu").
    try:
        import torch  # noqa: F401
    except Exception:
        return None
    import torch
    return "cuda" if torch.cuda.is_available() else "cpu"


def main():
    if len(sys.argv) != 5:
        fail("usage: bgtts_smoke.py <snapshot-dir> <reference-wav> <text> <out-wav>")
    ckpt_dir, ref_wav, text, out_wav = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    device = pick_device()
    if device is None:
        fail("torch-unavailable")
    if not os.path.isdir(ckpt_dir):
        fail("no-checkpoint-dir")
    sys.path.insert(0, ckpt_dir)
    try:
        from huggingface_hub import snapshot_download  # type: ignore
    except Exception:
        fail("hub-unavailable")
    try:
        from miocodec import MioCodec  # type: ignore
        assert MioCodec
        from model import load_for_inference  # type: ignore
        from tokenizer import TTSTokenizer  # type: ignore
        from codec import CodecV6  # type: ignore
        from inference import generate  # type: ignore
    except Exception as exc:
        sys.stderr.write("bgtts_smoke: load-failed %s\n" % type(exc).__name__)
        sys.exit(2)
    try:
        ckpt_file = os.path.join(ckpt_dir, "checkpoint_inference.pt")
        model = load_for_inference(ckpt_file, device=device)
        tokenizer = TTSTokenizer()
        codec = CodecV6(device=device)
        spk = codec.encode(ref_wav)["global_embedding"].to(device)
        codes = generate(model, tokenizer, text, spk, max_new_tokens=SMOKE_MAX_TOKENS, device=device)
        if codes is None or len(codes) == 0:
            fail("empty-codes")
        wav = codec.tokens_to_wav(codes, spk, out_wav)
    except Exception as exc:
        sys.stderr.write("bgtts_smoke: synth-failed %s\n" % type(exc).__name__)
        sys.exit(3)
    try:
        info = os.path.getsize(out_wav)
    except Exception:
        fail("wav-missing")
    if info <= 44:
        fail("empty-audio")
    print("SMOKE_BYTES=" + str(info))


if __name__ == "__main__":
    main()