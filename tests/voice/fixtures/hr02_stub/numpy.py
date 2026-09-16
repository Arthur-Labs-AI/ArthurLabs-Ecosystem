"""Deterministic fake numpy for HR-02 worker tests (never the real numpy).

Provides exactly the fragment parakeet_worker.pcm_to_waveform touches:

  np.int16 / np.float32 sentinels,
  np.frombuffer(bytearray(pcm), dtype=np.int16) -> 1-D int16 vector,
  vector.astype(np.float32) -> float vector,
  float_vector / 32768.0 -> normalized waveform with .shape, .tolist(),
  len() and float iteration (what the stub processor records).

Pure Python (struct-based); no third-party dependency, so the worker
contract suite runs on machines without numpy installed.
"""

import struct


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


int16 = _DType("numpy.int16")
int32 = _DType("numpy.int32")
float32 = _DType("numpy.float32")
float64 = _DType("numpy.float64")


class _Vector:
    """Minimal 1-D numeric vector: .shape/.tolist()/len()/iteration."""

    def __init__(self, values, dtype):
        self._values = list(values)
        self._dtype = dtype
        self.shape = (len(self._values),)

    def __len__(self):
        return len(self._values)

    def __iter__(self):
        return iter(self._values)

    def tolist(self):
        return list(self._values)

    def astype(self, dtype):
        if dtype == float32:
            return _Vector([float(v) for v in self._values], dtype)
        return _Vector(list(self._values), dtype)

    def __truediv__(self, scalar):
        return _Vector([v / scalar for v in self._values], self._dtype)

    def __repr__(self):
        return "array(%r, dtype=%s)" % (self._values, self._dtype)


def frombuffer(buffer, dtype=None):
    raw = bytes(buffer)
    if dtype == int16:
        count = len(raw) // 2
        values = struct.unpack("<%dh" % count, raw[: count * 2])
        return _Vector(values, dtype)
    raise TypeError("fake numpy frombuffer supports int16 only (got %r)" % (dtype,))


__all__ = ["frombuffer", "int16", "int32", "float32", "float64"]
