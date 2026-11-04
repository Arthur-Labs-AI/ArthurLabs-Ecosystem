#!/usr/bin/env python3
"""HR-02 Parakeet local STT worker (opt-in, never auto-run by tests).

Production backend: Transformers (ParakeetForTDT) reading normalized
float waveforms in memory. A legacy NeMo backend exists ONLY when
explicitly selected via PARAKEET_BACKEND=nemo; it is never a hidden
fallback. Normal runtime never imports NeMo.

Persistent stdin/stdout JSONL protocol (one JSON object per line):

  -> {"id": "<req>", "audio_b64": "<16k mono s16le base64>", "sample_rate_hz": 16000}
  <- {"id": "<req>", "ok": true, "text": "..."}
  <- {"id": "<req>", "ok": false, "error": "<bounded code>"}

Decoded audio contract: mono, signed 16-bit little-endian PCM, 16000 Hz.
Validated PCM is normalized to a float waveform in memory and handed to
the Transformers processor directly (no temp files, no ffmpeg/sox/shell).

Stdout carries ONLY protocol JSON lines. Third-party output (imports,
model/processor load, transcription) is redirected to stderr at the file
descriptor level, so even logging handlers bound to the original stdout
cannot corrupt JSONL IPC. Fatal exceptions still propagate.

Diagnostics on stderr are bounded and never contain audio, base64,
transcripts, or environment values:

  - every ordinary Python failure in load / feature preparation / generate /
    decode writes one bounded `error stage=... type=... message="..."` line
    BEFORE the worker answers with its normal bounded JSON error, so a failing
    request stays diagnosable from the caller's captured stderr tail;
  - PARAKEET_DEBUG=1 additionally emits the bounded request metadata line, a
    CUDA memory snapshot immediately before generate(), and a bounded
    traceback (never emitted in normal production mode);
  - native termination (CUDA fault, abort, segfault) cannot be caught in
    Python at all: the caller diagnoses it from the process exit code/signal.

Environment:
  PARAKEET_MODEL   model id (default nvidia/parakeet-tdt-0.6b-v3)
  PARAKEET_DEVICE  auto|cpu|cuda (default auto; auto uses CUDA when available)
  PARAKEET_BACKEND transformers|nemo (default transformers; nemo is explicit legacy)
  PARAKEET_LOG_VRAM 1 enables opt-in CUDA memory diagnostics on stderr
  PARAKEET_DEBUG   1 enables opt-in bounded diagnostics on stderr (request
                   metadata, pre-generate CUDA memory, bounded tracebacks)

Device/dtype policy: CPU -> float32. CUDA -> float16 when the backend loads
it correctly, otherwise the lowest-memory officially supported CUDA dtype,
always reported in the bounded startup diagnostic. Explicit PARAKEET_DEVICE=cuda
with no CUDA available fails closed (model_unavailable), never silently CPU.

Bounds: per-line stdin cap 32 MiB, per-utterance audio cap ~120 s.
Errors are bounded codes only (never tracebacks on stdout).
Protocol JSONL is ASCII-safe (ensure_ascii=True) so the wire survives a
legacy host console encoding; Node reconstructs the exact Unicode transcript
from JSON escapes. Python stdio is reconfigured to UTF-8 when supported, but
the protocol must never depend on it.
"""
import base64
import binascii
import contextlib
import json
import os
import sys
import traceback


# Progress bars write carriage-return fragments without newlines, which would
# merge with protocol lines on stdout. Disable tqdm process-wide (overridable).
os.environ.setdefault("TQDM_DISABLE", "1")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")


def configure_stdio():
    """Prefer UTF-8 stdio when the host supports it (defense in depth only).

    The JSONL wire is ASCII-safe regardless (ensure_ascii=True on every
    protocol write), so this must never be load-bearing: a legacy Windows code
    page keeps working without it. failures are swallowed by design.
    """
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    except Exception:
        pass
    try:
        if hasattr(sys.stderr, "reconfigure"):
            sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
    except Exception:
        pass


configure_stdio()

MAX_LINE_BYTES = 32 * 1024 * 1024
MAX_AUDIO_BYTES = 120 * 16000 * 2  # ~120 s of 16 kHz mono s16le
EXPECTED_SAMPLE_RATE_HZ = 16000

# Diagnostic bounds: diagnostics are always bounded (never unbounded dumps).
MAX_DIAG_STAGE_CHARS = 32
MAX_DIAG_TYPE_CHARS = 80
MAX_DIAG_DETAIL_CHARS = 64
MAX_DIAG_MESSAGE_CHARS = 300
MAX_DIAG_TRACEBACK_CHARS = 2000
MAX_DIAG_REQUEST_ID_CHARS = 64


def _env_flag(name):
    """True when $name is set to a truthy value ("1", "true", "yes", "on")."""
    return str(os.environ.get(name, "")).strip().lower() in ("1", "true", "yes", "on")


MODEL_ID = os.environ.get("PARAKEET_MODEL", "nvidia/parakeet-tdt-0.6b-v3")
DEVICE = os.environ.get("PARAKEET_DEVICE", "auto")
BACKEND = os.environ.get("PARAKEET_BACKEND", "transformers")
LOG_VRAM = os.environ.get("PARAKEET_LOG_VRAM", "") == "1"
DEBUG = _env_flag("PARAKEET_DEBUG")


class TranscriptionError(Exception):
    """Internal: backend produced no usable transcript (bounded as transcription_failed)."""


def err_line(req_id, code):
    # ASCII-safe: a legacy host console encoding (e.g. Windows cp1252) must
    # never break the JSONL wire, even for a non-ASCII request id.
    return json.dumps({"id": req_id, "ok": False, "error": code}, ensure_ascii=True)


def diag(message):
    """Bounded diagnostic on stderr only (never stdout: stdout is JSONL IPC)."""
    sys.stderr.write("parakeet_worker: %s\n" % message)
    sys.stderr.flush()


def _bounded_text(value, limit):
    """One-line, control-free, bounded diagnostic text (never raises).

    Control characters are neutralized so a diagnostic can never split or forge
    a log line; newlines become " | " so a bounded traceback stays readable.
    """
    try:
        raw = str(value)
    except Exception:
        return ""
    out = []
    for ch in raw:
        code = ord(ch)
        if ch == "\r" or ch == "\n":
            out.append(" | ")
        elif ch == "\t":
            out.append(" ")
        elif code < 32 or code == 127 or 128 <= code <= 159 or code in (0x2028, 0x2029):
            out.append(" ")
        else:
            out.append(ch)
    return "".join(out)[:limit]


def diag_exception(stage, exc, detail=""):
    """Bounded stderr diagnostic for a caught exception (never raises).

    Written BEFORE the caller answers with its normal bounded JSON error, so a
    request that fails is diagnosable from the caller's captured stderr tail.
    Carries only the stage, the exception type, and a bounded message: never
    audio, base64, transcripts, or environment values. The full traceback is
    emitted only under PARAKEET_DEBUG=1 and is bounded. Diagnostics must never
    change worker behaviour, so any failure inside them is swallowed.
    """
    try:
        parts = [
            "parakeet_worker: error stage=" + _bounded_text(stage, MAX_DIAG_STAGE_CHARS),
            "type=" + _bounded_text(type(exc).__name__, MAX_DIAG_TYPE_CHARS),
        ]
        if detail:
            parts.append(_bounded_text(detail, MAX_DIAG_DETAIL_CHARS))
        parts.append('message="' + _bounded_text(exc, MAX_DIAG_MESSAGE_CHARS) + '"')
        sys.stderr.write(" ".join(parts) + "\n")
        if DEBUG:
            sys.stderr.write(
                "parakeet_worker: traceback stage=%s %s\n"
                % (_bounded_text(stage, MAX_DIAG_STAGE_CHARS), _bounded_text(traceback.format_exc(), MAX_DIAG_TRACEBACK_CHARS))
            )
        sys.stderr.flush()
    except Exception:
        pass


def _cuda_mb(getter):
    """CUDA memory value in MB, or None when the query is unavailable."""
    try:
        return int(getter()) // (1024 * 1024)
    except Exception:
        return None


def cuda_memory_diag(req_id=""):
    """Opt-in (PARAKEET_DEBUG=1) CUDA memory snapshot immediately before
    generate(). Values only: never audio, transcripts, or environment values.
    Unavailable values are omitted rather than fabricated.
    """
    if not DEBUG:
        return
    try:
        import torch  # type: ignore

        if not torch.cuda.is_available():
            return
        fields = []
        allocated = _cuda_mb(torch.cuda.memory_allocated)
        reserved = _cuda_mb(torch.cuda.memory_reserved)
        if allocated is not None:
            fields.append("cuda_allocated_mb=%d" % allocated)
        if reserved is not None:
            fields.append("cuda_reserved_mb=%d" % reserved)
        try:
            info = torch.cuda.mem_get_info()
            fields.append("cuda_free_mb=%d" % (int(info[0]) // (1024 * 1024)))
            fields.append("cuda_total_mb=%d" % (int(info[1]) // (1024 * 1024)))
        except Exception:
            pass
        if not fields:
            return
        diag("vram request=%s %s" % (_bounded_text(req_id, MAX_DIAG_REQUEST_ID_CHARS), " ".join(fields)))
    except Exception:
        pass


def pcm_duration_ms(pcm_bytes):
    """Derived utterance duration for diagnostics (integer, deterministic)."""
    return (len(pcm_bytes) // 2) * 1000 // EXPECTED_SAMPLE_RATE_HZ


@contextlib.contextmanager
def third_party_output_to_stderr():
    """Route third-party output to stderr at the fd level."""
    """Python-level redirect_stdout misses logging handlers already bound to the
    original stdout object, and misses C-level writes. dup2 covers both.
    Fatal exceptions still propagate; the fds are restored in finally.
    """
    stdout_fd = sys.stdout.fileno()
    stderr_fd = sys.stderr.fileno()
    sys.stdout.flush()
    saved = os.dup(stdout_fd)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            os.dup2(stderr_fd, stdout_fd)
            try:
                yield
            finally:
                sys.stdout.flush()
                os.dup2(saved, stdout_fd)
    finally:
        os.close(saved)
    sys.stdout.flush()


def select_device():
    """Resolve PARAKEET_DEVICE to "cuda" or "cpu".
    Explicit "cuda" with no CUDA available FAILS CLOSED
    (raises TranscriptionError at load -> model_unavailable), never
    silently runs on CPU. Returns (use_cuda, error_code)."""
    want = str(DEVICE or "auto").strip().lower()
    if want == "cpu":
        return False, ""
    cuda_available = False
    try:
        import torch  # type: ignore

        cuda_available = bool(torch.cuda.is_available())
    except Exception:
        cuda_available = False
    if want == "cuda":
        if cuda_available:
            return True, ""
        return False, "cuda_unavailable"
    return cuda_available, ""


def vram_diag(tag):
    """Opt-in CUDA memory diagnostic on stderr (PARAKEET_LOG_VRAM=1)."""
    if not LOG_VRAM:
        return
    try:
        import torch  # type: ignore

        if not torch.cuda.is_available():
            return
        alloc = torch.cuda.memory_allocated() // (1024 * 1024)
        reserved = torch.cuda.memory_reserved() // (1024 * 1024)
        peak = torch.cuda.max_memory_allocated() // (1024 * 1024)
        diag("vram " + tag + " alloc=%dMB reserved=%dMB peak=%dMB" % (alloc, reserved, peak))
    except Exception:
        pass


def load_transformers_runtime(use_cuda):
    """Load ParakeetForTDT + processor directly (no pipeline)."""
    """Returns (runtime_dict, dtype_name, error_code). CPU -> float32.
    CUDA tries float16 first; on failure uses the lowest-memory
    officially supported CUDA dtype and reports it honestly.
    """
    try:
        import torch  # type: ignore
        from transformers import AutoProcessor, ParakeetForTDT  # type: ignore
    except Exception as exc:
        diag_exception("import", exc)
        return None, "", "dependency_missing"
    try:
        with third_party_output_to_stderr():
            try:
                import transformers as _tf  # type: ignore
                _tf.logging.set_verbosity_error()
            except Exception:
                pass
            processor = AutoProcessor.from_pretrained(MODEL_ID)
    except Exception as exc:
        diag_exception("processor_load", exc)
        return None, "", "model_unavailable"
    dtype_name = "float32"
    torch_dtype = torch.float32
    model = None
    if use_cuda:
        for candidate in (torch.float16, torch.bfloat16):
            candidate_name = "float16" if candidate == torch.float16 else "bfloat16"
            try:
                with third_party_output_to_stderr():
                    model = ParakeetForTDT.from_pretrained(MODEL_ID, dtype=candidate)
                dtype_name = candidate_name
                torch_dtype = candidate
                break
            except Exception as exc:
                diag_exception("model_load", exc, detail="dtype=" + candidate_name)
                model = None
        if model is None:
            try:
                with third_party_output_to_stderr():
                    model = ParakeetForTDT.from_pretrained(MODEL_ID, dtype=torch.float32)
                dtype_name = "float32"
            except Exception as exc:
                diag_exception("model_load", exc, detail="dtype=float32")
                return None, "", "model_unavailable"
    else:
        try:
            with third_party_output_to_stderr():
                model = ParakeetForTDT.from_pretrained(MODEL_ID, dtype=torch.float32)
        except Exception as exc:
            diag_exception("model_load", exc, detail="dtype=float32")
            return None, "", "model_unavailable"
    try:
        with third_party_output_to_stderr():
            if use_cuda:
                model = model.to("cuda")
            else:
                model = model.to("cpu")
            model.eval()
    except Exception as exc:
        diag_exception("model_move", exc, detail="device=" + ("cuda" if use_cuda else "cpu"))
        return None, "", "model_unavailable"
    return {"model": model, "processor": processor, "torch_dtype": torch_dtype}, dtype_name, ""


def load_nemo_runtime(use_cuda):
    """Explicit legacy backend (PARAKEET_BACKEND=nemo only). Kept for
    operator fallback; never selected implicitly. Returns the same
    (runtime_dict, dtype_name, error_code) shape with dtype float32.
    """
    try:
        import nemo.collections.asr as nemo_asr  # type: ignore
    except Exception as exc:
        diag_exception("import", exc)
        return None, "", "dependency_missing"
    try:
        with third_party_output_to_stderr():
            model = nemo_asr.models.EncDecRNNTBPEModel.from_pretrained(model_name=MODEL_ID)
            model.eval()
            if use_cuda:
                try:
                    model = model.cuda()
                except Exception as exc:
                    diag_exception("model_move", exc, detail="device=cuda")
                    return None, "", "model_unavailable"
            else:
                try:
                    model = model.to("cpu")
                except Exception:
                    pass
    except Exception as exc:
        diag_exception("model_load", exc)
        return None, "", "model_unavailable"
    return {"model": model, "legacy": "nemo"}, "float32", ""


def load_runtime():
    """Select backend + device, load once. Returns
    (runtime_dict, backend, device_name, dtype_name, error_code).
    Transformers is the production default; NeMo requires explicit opt-in.
    No hidden fallback between backends.
    """
    backend = str(BACKEND or "transformers").strip().lower()
    if backend not in ("transformers", "nemo"):
        return None, backend, "", "", "bad_configuration"
    use_cuda, err = select_device()
    if err != "":
        diag("device requested=%s unavailable reason=%s" % (_bounded_text(DEVICE, MAX_DIAG_DETAIL_CHARS), err))
        return None, backend, "", "", "model_unavailable"
    if backend == "nemo":
        runtime, dtype_name, err = load_nemo_runtime(use_cuda)
    else:
        runtime, dtype_name, err = load_transformers_runtime(use_cuda)
    if err != "":
        return None, backend, "", "", err
    device_name = "cuda" if use_cuda else "cpu"
    return runtime, backend, device_name, dtype_name, ""


def pcm_to_waveform(pcm_bytes):
    """Validated s16le mono 16 kHz PCM -> normalized float32 numpy waveform.
    The Transformers feature extractor requires an object with .shape, so a
    numpy float32 array is the contract (numpy is a backend dependency).
    Pure in-memory; no temp files, no shell.
    """
    import numpy as np  # type: ignore
    samples = np.frombuffer(bytearray(pcm_bytes), dtype=np.int16)
    return (samples.astype(np.float32) / 32768.0)


def extract_pcm(req):
    """Strictly validate one decoded request. Returns (pcm_bytes, error_code)."""
    sample_rate = req.get("sample_rate_hz", 16000)
    if isinstance(sample_rate, bool) or not isinstance(sample_rate, int):
        return None, "bad_audio_format"
    if sample_rate != EXPECTED_SAMPLE_RATE_HZ:
        return None, "bad_audio_format"
    audio_b64 = req.get("audio_b64")
    if not isinstance(audio_b64, str) or audio_b64 == "":
        return None, "bad_audio_format"
    try:
        pcm = base64.b64decode(audio_b64, validate=True)
    except (binascii.Error, ValueError):
        return None, "bad_audio_format"
    if len(pcm) == 0 or len(pcm) % 2 != 0:
        return None, "bad_audio_format"
    if len(pcm) > MAX_AUDIO_BYTES:
        return None, "audio_too_large"
    return pcm, ""


def transcribe_transformers(runtime, pcm_bytes, req_id=""):
    """PCM -> float waveform -> processor/model.generate -> text.
    No temp files. Raises TranscriptionError when no transcript results.
    Each stage (feature preparation, generate, decode) reports an ordinary
    Python failure to stderr as a bounded diagnostic before the caller answers
    with its normal bounded JSON error code (unchanged on the wire).
    """
    if not pcm_bytes or len(pcm_bytes) % 2 != 0:
        raise TranscriptionError("bad_audio")
    import torch  # type: ignore
    waveform = pcm_to_waveform(pcm_bytes)
    processor = runtime["processor"]
    model = runtime["model"]
    try:
        with third_party_output_to_stderr():
            inputs = processor(waveform, sampling_rate=EXPECTED_SAMPLE_RATE_HZ, return_tensors="pt")
            target_dtype = runtime.get("torch_dtype", None)
            features = inputs["input_features"].to(model.device)
            if target_dtype is not None:
                try:
                    features = features.to(target_dtype)
                except Exception:
                    pass
            mask = inputs.get("attention_mask")
            if mask is not None:
                mask = mask.to(model.device)
            else:
                mask = None
    except Exception as exc:
        diag_exception("feature_prepare", exc)
        raise TranscriptionError("generate_failed")
    try:
        with third_party_output_to_stderr():
            try:
                torch.cuda.reset_peak_memory_stats()
            except Exception:
                pass
            # Immediately before generate(): opt-in bounded CUDA memory values.
            cuda_memory_diag(req_id)
            with torch.inference_mode():
                if mask is None:
                    out = model.generate(features)
                else:
                    out = model.generate(features, attention_mask=mask)
    except TranscriptionError:
        raise
    except Exception as exc:
        diag_exception("generate", exc)
        raise TranscriptionError("generate_failed")
    try:
        with third_party_output_to_stderr():
            sequences = out.sequences if hasattr(out, "sequences") else out
            texts = processor.batch_decode(sequences, skip_special_tokens=True)
    except TranscriptionError:
        raise
    except Exception as exc:
        diag_exception("decode", exc)
        raise TranscriptionError("generate_failed")
    if not texts:
        raise TranscriptionError("empty_result")
    text = texts[0]
    if not isinstance(text, str):
        text = str(text)
    return text.strip()


def transcribe_nemo_legacy(runtime, pcm_bytes):
    """Legacy explicit-nemo path: PCM -> private temp WAV -> transcribe.
    Temp file is unlinked in finally on every path.
    """
    import tempfile
    import wave
    if not pcm_bytes or len(pcm_bytes) % 2 != 0:
        raise TranscriptionError("bad_audio")
    fd, path = tempfile.mkstemp(suffix=".wav", prefix="parakeet-")
    os.close(fd)
    try:
        with wave.open(path, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(EXPECTED_SAMPLE_RATE_HZ)
            wav.writeframes(pcm_bytes)
    except Exception:
        with contextlib.suppress(Exception):
            os.unlink(path)
        raise TranscriptionError("wav_failed")
    try:
        with third_party_output_to_stderr():
            out = runtime["model"].transcribe([path])
    finally:
        with contextlib.suppress(Exception):
            os.unlink(path)
    if not out:
        raise TranscriptionError("empty_result")
    first = out[0]
    raw_text = getattr(first, "text", None)
    text = raw_text if isinstance(raw_text, str) else str(first)
    language = getattr(first, "language", None)
    return (text or "").strip(), str(language) if language else None


def transcribe_request(runtime, backend, pcm_bytes, req_id=""):
    """Dispatch one validated utterance. Returns (text, language|None)."""
    if backend == "nemo":
        return transcribe_nemo_legacy(runtime, pcm_bytes)
    text = transcribe_transformers(runtime, pcm_bytes, req_id)
    return text, None


def main():
    with third_party_output_to_stderr():
        runtime, backend, device, dtype_name, err = load_runtime()
    if runtime is None:
        sys.stderr.write("parakeet_worker: unavailable (%s)\n" % err)
        sys.stderr.flush()
        for raw in sys.stdin.buffer:
            try:
                req = json.loads(raw.decode("utf-8"))
                rid = req.get("id", "") if isinstance(req, dict) else ""
            except Exception:
                continue
            sys.stdout.write(err_line(str(rid), "model_unavailable") + "\n")
            sys.stdout.flush()
        return 2
    diag("backend=" + backend + " device=" + device + " dtype=" + dtype_name)
    vram_diag("after-load")
    stdin = sys.stdin.buffer
    write = sys.stdout.write
    while True:
        raw = stdin.readline(MAX_LINE_BYTES + 2)
        if not raw:
            break
        if len(raw) > MAX_LINE_BYTES + 1:
            write(json.dumps({"id": "", "ok": False, "error": "audio_too_large"}) + "\n")
            sys.stdout.flush()
            continue
        try:
            req = json.loads(raw.decode("utf-8"))
        except Exception:
            write(json.dumps({"id": "", "ok": False, "error": "bad_request"}) + "\n")
            sys.stdout.flush()
            continue
        if not isinstance(req, dict):
            write(json.dumps({"id": "", "ok": False, "error": "bad_request"}) + "\n")
            sys.stdout.flush()
            continue
        rid = req.get("id", "")
        if not isinstance(rid, str) or rid == "":
            write(err_line("", "bad_request") + "\n")
            sys.stdout.flush()
            continue
        pcm, code = extract_pcm(req)
        if code != "":
            write(err_line(rid, code) + "\n")
            sys.stdout.flush()
            continue
        if DEBUG:
            # Opt-in bounded request metadata (safe values only: no PCM bytes,
            # no transcript, no environment dump).
            diag(
                "request=%s pcm_bytes=%d duration_ms=%d sample_rate=%d backend=%s device=%s dtype=%s"
                % (
                    _bounded_text(rid, MAX_DIAG_REQUEST_ID_CHARS),
                    len(pcm),
                    pcm_duration_ms(pcm),
                    EXPECTED_SAMPLE_RATE_HZ,
                    backend,
                    device,
                    dtype_name,
                )
            )
        try:
            text, lang = transcribe_request(runtime, backend, pcm, rid)
        except Exception:
            write(err_line(rid, "transcription_failed") + "\n")
            sys.stdout.flush()
            continue
        vram_diag("after-utterance")
        out = {"id": rid, "ok": True, "text": text}
        if lang:
            out["language"] = str(lang)
        # ASCII-safe: Unicode transcripts (e.g. Cyrillic) travel as JSON
        # \uXXXX escapes, which Node's JSON.parse reconstructs exactly. A
        # legacy Windows console encoding must never crash the worker after a
        # successful inference. No transliteration: text is preserved verbatim.
        write(json.dumps(out, ensure_ascii=True) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
