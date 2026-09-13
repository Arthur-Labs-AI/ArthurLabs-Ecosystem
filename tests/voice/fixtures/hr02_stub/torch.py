"""Deterministic fake torch for HR-02 worker tests (never the real torch).

Driven by $PARAKEET_STUB_CONFIG: cuda_available (bool), vram_mb (int).
Provides only what parakeet_worker.py touches: dtype sentinels, cuda
queries, and a no-op inference_mode context manager.
"""
import os


class _DType:
    def __init__(self, name):
        self._name = name
    def __repr__(self):
        return self._name
    def __str__(self):
        return self._name
    def __eq__(self, other):
        return isinstance(other, _DType) and other._name == self._name
    def __hash__(self):
        return hash(self._name)


float16 = _DType("torch.float16")
bfloat16 = _DType("torch.bfloat16")
float32 = _DType("torch.float32")


def _config_value(name, default):
    import json
    path = os.environ.get("PARAKEET_STUB_CONFIG", "")
    if not path:
        return default
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle).get(name, default)
    except Exception:
        return default


def _config_flag(name, default=False):
    return bool(_config_value(name, default))


def _config_mb(name):
    """Configured MB value as bytes (0 when unset)."""
    try:
        return int(_config_value(name, 0)) * 1024 * 1024
    except Exception:
        return 0


class _Cuda:
    @staticmethod
    def is_available():
        return _config_flag("cuda_available", False)
    @staticmethod
    def reset_peak_memory_stats():
        return None
    @staticmethod
    def memory_allocated():
        return _config_mb("vram_allocated_mb")
    @staticmethod
    def memory_reserved():
        return _config_mb("vram_reserved_mb")
    @staticmethod
    def max_memory_allocated():
        return _config_mb("vram_allocated_mb")
    @staticmethod
    def mem_get_info():
        return (_config_mb("vram_free_mb"), _config_mb("vram_total_mb"))


cuda = _Cuda()


class _InferenceMode:
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False


def inference_mode():
    return _InferenceMode()
