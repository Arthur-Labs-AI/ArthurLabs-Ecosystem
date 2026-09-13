/**
 * HR-02.5A: deterministic hardware fixtures for tests.
 *
 * Every profile below is a plain HardwareProfile object: no I/O, no GPU,
 * no subprocess, no network. Tests that need probe behavior inject a
 * FakeHardwareProbe or a stub ExecFn/FsReader instead.
 */

import type { HardwareProfile } from '../../src/runtime/hardware/contracts';
import { unknownAccelerators } from '../../src/runtime/hardware/contracts';

function base(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    os: 'unknown',
    arch: 'unknown',
    memory: { total_mb: null },
    cpu: { logical_cores: null, model: null },
    gpus: [],
    accelerators: unknownAccelerators(),
    ...overrides,
  };
}

export function windowsNvidiaCuda(): HardwareProfile {
  return base({
    os: 'windows',
    arch: 'x64',
    memory: { total_mb: 32768 },
    cpu: { logical_cores: 16, model: 'AMD Ryzen 9 5900X' },
    gpus: [{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4070', vram_mb: 8192 }],
    accelerators: { cuda: 'available', rocm: 'unavailable', vulkan: 'available', directml: 'available', npu: 'unknown' },
  });
}

export function windowsNvidiaNoCuda(): HardwareProfile {
  return base({
    os: 'windows',
    arch: 'x64',
    memory: { total_mb: 16384 },
    cpu: { logical_cores: 8, model: 'Intel Core i7-12700' },
    gpus: [{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3060', vram_mb: 8192 }],
    accelerators: { cuda: 'unavailable', rocm: 'unavailable', vulkan: 'available', directml: 'available', npu: 'unknown' },
  });
}

export function linuxAmdRocm(): HardwareProfile {
  return base({
    os: 'linux',
    arch: 'x64',
    memory: { total_mb: 65536 },
    cpu: { logical_cores: 32, model: 'AMD Ryzen Threadripper 5975WX' },
    gpus: [{ vendor: 'amd', name: 'AMD Radeon RX 7900 XTX', vram_mb: null }],
    accelerators: { cuda: 'unavailable', rocm: 'available', vulkan: 'available', directml: 'unavailable', npu: 'unavailable' },
  });
}

export function linuxAmdNoRocm(): HardwareProfile {
  return base({
    os: 'linux',
    arch: 'x64',
    memory: { total_mb: 16384 },
    cpu: { logical_cores: 8, model: 'AMD Ryzen 5 5600X' },
    gpus: [{ vendor: 'amd', name: 'AMD Radeon RX 6600', vram_mb: null }],
    accelerators: { cuda: 'unavailable', rocm: 'unavailable', vulkan: 'available', directml: 'unavailable', npu: 'unavailable' },
  });
}

export function linuxArm64CpuOnly(): HardwareProfile {
  return base({
    os: 'linux',
    arch: 'arm64',
    memory: { total_mb: 8192 },
    cpu: { logical_cores: 8, model: 'Ampere Altra' },
    gpus: [],
    accelerators: { cuda: 'unavailable', rocm: 'unavailable', vulkan: 'unknown', directml: 'unavailable', npu: 'unavailable' },
  });
}

export function linuxArm64UnknownAccel(): HardwareProfile {
  return base({
    os: 'linux',
    arch: 'arm64',
    memory: { total_mb: 8192 },
    cpu: { logical_cores: 8, model: null },
    gpus: [],
    accelerators: unknownAccelerators(),
  });
}

export function cpuOnlyX64(): HardwareProfile {
  return base({
    os: 'linux',
    arch: 'x64',
    memory: { total_mb: 16384 },
    cpu: { logical_cores: 4, model: 'Intel Xeon E5-2673' },
    gpus: [],
    accelerators: { cuda: 'unavailable', rocm: 'unavailable', vulkan: 'unavailable', directml: 'unavailable', npu: 'unavailable' },
  });
}

export function partiallyUnknown(): HardwareProfile {
  return base({
    os: 'linux',
    arch: 'x64',
    memory: { total_mb: null },
    cpu: { logical_cores: 4, model: null },
    gpus: [],
    accelerators: unknownAccelerators(),
  });
}

export function multiGpuMixed(): HardwareProfile {
  return base({
    os: 'linux',
    arch: 'x64',
    memory: { total_mb: 131072 },
    cpu: { logical_cores: 64, model: 'AMD EPYC 9554' },
    gpus: [
      { vendor: 'nvidia', name: 'NVIDIA A100 80GB', vram_mb: 81920 },
      { vendor: 'nvidia', name: 'NVIDIA A100 80GB (2)', vram_mb: 81920 },
      { vendor: 'intel', name: 'Intel UHD Graphics 770', vram_mb: null },
    ],
    accelerators: { cuda: 'available', rocm: 'unavailable', vulkan: 'available', directml: 'unavailable', npu: 'unavailable' },
  });
}
