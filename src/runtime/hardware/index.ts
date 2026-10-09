/**
 * HR-02.5A: local hardware discovery subsystem (public entry point).
 *
 * Machine facts only: a normalized immutable HardwareProfile gathered
 * through bounded, defensive platform probes. No model knowledge, no
 * recommendations, no downloads, no routing, no permissions.
 *
 * Future HR-02.5B stages consume `HardwareProfile` via the `HardwareProbe`
 * seam (`SystemHardwareProbe` in production, `FakeHardwareProbe` in tests).
 */

export {
  CAPABILITY_STATE_VALUES,
  GPU_VENDOR_VALUES,
  HARDWARE_ARCH_VALUES,
  HARDWARE_OS_VALUES,
  isCapabilityState,
  isGpuVendor,
  isHardwareArch,
  isHardwareOs,
  unknownAccelerators,
  type CapabilityState,
  type GpuVendor,
  type HardwareAccelerators,
  type HardwareArch,
  type HardwareGpu,
  type HardwareOs,
  type HardwareProfile,
} from './contracts';
export {
  normalizeArch,
  normalizeBytesToMb,
  normalizeGpuVendor,
  normalizeLogicalCores,
  normalizeModelName,
  normalizeOs,
  normalizeVramMb,
  orUnknown,
} from './normalization';
export {
  FakeHardwareProbe,
  SystemHardwareProbe,
  mergeGpus,
  nodeOsFacts,
  type HardwareProbe,
  type OsFacts,
  type ProbeDeps,
} from './probe';
