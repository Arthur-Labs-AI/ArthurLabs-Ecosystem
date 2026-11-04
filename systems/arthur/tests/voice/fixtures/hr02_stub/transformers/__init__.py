"""Deterministic fake of the Transformers Parakeet API for HR-02 tests.

Behavior is driven by JSON config at $PARAKEET_STUB_CONFIG:
  transcript, fail_generate, fail_processor, fail_decode, empty_result,
  reject_dtypes (substring match), print_noise, record_path, count_path.

Only json/os are imported: never torch, never the real transformers.
"""
import json
import os


def _config():
    path = os.environ.get("PARAKEET_STUB_CONFIG", "")
    if not path:
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return {}


def _count(key):
    path = _config().get("count_path", "")
    if not path:
        return
    try:
        try:
            with open(path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except Exception:
            data = {}
        data[key] = int(data.get(key, 0)) + 1
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(data, handle)
    except Exception:
        pass


def _record(event):
    path = _config().get("record_path", "")
    if not path:
        return
    try:
        try:
            with open(path, "r", encoding="utf-8") as handle:
                events = json.load(handle)
        except Exception:
            events = []
        events.append(event)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(events, handle)
    except Exception:
        pass


class _FakeTensor:
    """Duck-typed tensor: .to(device) records placement, stays itself."""
    def __init__(self, owner):
        self._owner = owner
    def to(self, device, dtype=None):
        first = str(device)
        if dtype is None and not first.startswith("torch."):
            _record({"kind": "tensor_placed", "placed_on": str(device)})
        else:
            pushed = str(dtype) if dtype is not None else first
            _record({"kind": "tensor_cast", "cast_dtype": pushed})
        return self
    def get(self, key, default=None):
        return default


class _FakeGenerateOutput:
    def __init__(self, sequences):
        self.sequences = sequences


class _FakeProcessor:
    def __call__(self, waveform, sampling_rate=None, return_tensors=None):
        has_shape = hasattr(waveform, "shape")
        samples = waveform.tolist() if hasattr(waveform, "tolist") else list(waveform)
        peak = 0.0
        for value in samples:
            magnitude = abs(float(value))
            if magnitude > peak:
                peak = magnitude
        _record({
            "kind": "processor_call",
            "frames": len(samples),
            "has_shape": has_shape,
            "sampling_rate": sampling_rate,
            "return_tensors": return_tensors,
            "peak": peak,
        })
        tensor = _FakeTensor(self)
        return {"input_features": tensor, "attention_mask": tensor}
    def batch_decode(self, sequences, skip_special_tokens=True):
        if _config().get("fail_decode"):
            raise RuntimeError("stub decode boom")
        return [_config().get("transcript", "hello world")]


class _FakeModel:
    """Duck-typed ParakeetForTDT: device/dtype pinned at load, generate recorded."""
    def __init__(self, device, dtype_name):
        self.device = device
        self.dtype_name = dtype_name
    def to(self, device):
        return _FakeModel(device, self.dtype_name)
    def eval(self):
        return self
    def generate(self, features, attention_mask=None):
        cfg = _config()
        if cfg.get("print_noise"):
            print(cfg["print_noise"])
        _record({"kind": "generate_call", "has_mask": attention_mask is not None})
        if cfg.get("fail_generate"):
            raise RuntimeError("stub generate boom")
        if cfg.get("empty_result"):
            return _FakeGenerateOutput([])
        return _FakeGenerateOutput([["stub-seq"]])


class _Logging:
    @staticmethod
    def set_verbosity_error():
        return None


logging = _Logging()


class AutoProcessor:
    @staticmethod
    def from_pretrained(model_id):
        if _config().get("fail_processor"):
            raise RuntimeError("stub processor boom")
        _count("processor_loads")
        return _FakeProcessor()


class ParakeetForTDT:
    @staticmethod
    def from_pretrained(model_id, dtype=None):
        cfg = _config()
        name = str(dtype)
        short = name.split(".")[-1]
        for rejected in cfg.get("reject_dtypes", []):
            if str(rejected) == short:
                raise RuntimeError("stub rejects dtype " + name)
        _count("model_loads")
        return _FakeModel("cpu", name)
