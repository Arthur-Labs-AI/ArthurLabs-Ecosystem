/**
 * HR-02.5A: normalized hardware profile contracts.
 *
 * Machine facts only. This module (and the whole hardware subsystem) must
 * never gain model-specific content: no recommended models, quality tiers,
 * compatibility scores, provider routing, or permission/authorization
 * concepts. Those belong to later HR-02.5 stages (catalog, compatibility,
 * recommendation) and to SC-02 respectively.
 *
 * Unknown must remain unknown: every optional fact uses `null` (scalars),
 * `[]` (gpu list), or `"unknown"` (capabilities) when it cannot be
 * established. Callers rely on this for fail-closed compatibility later.
 */

export type HardwareOs = "windows" | "linux" | "android" | "darwin" | "unknown";

export type HardwareArch = "x64" | "arm64" | "unknown";

export type GpuVendor = "nvidia" | "amd" | "intel" | "other" | "unknown";

export type CapabilityState = "available" | "unavailable" | "unknown";

export interface HardwareGpu {
  vendor: GpuVendor;
  name: string;
  vram_mb: number | null;
}

export interface HardwareAccelerators {
  cuda: CapabilityState;
  rocm: CapabilityState;
  vulkan: CapabilityState;
  directml: CapabilityState;
  npu: CapabilityState;
}

export interface HardwareProfile {
  os: HardwareOs;
  arch: HardwareArch;

  memory: {
    total_mb: number | null;
  };

  cpu: {
    logical_cores: number | null;
    model: string | null;
  };

  gpus: HardwareGpu[];

  accelerators: HardwareAccelerators;
}

export const HARDWARE_OS_VALUES = ["windows", "linux", "android", "darwin", "unknown"] as const;

export const HARDWARE_ARCH_VALUES = ["x64", "arm64", "unknown"] as const;

export const GPU_VENDOR_VALUES = ["nvidia", "amd", "intel", "other", "unknown"] as const;

export const CAPABILITY_STATE_VALUES = ["available", "unavailable", "unknown"] as const;

export function isHardwareOs(value: unknown): value is HardwareOs {
  return typeof value === "string" && (HARDWARE_OS_VALUES as readonly string[]).includes(value);
}

export function isHardwareArch(value: unknown): value is HardwareArch {
  return typeof value === "string" && (HARDWARE_ARCH_VALUES as readonly string[]).includes(value);
}

export function isGpuVendor(value: unknown): value is GpuVendor {
  return typeof value === "string" && (GPU_VENDOR_VALUES as readonly string[]).includes(value);
}

export function isCapabilityState(value: unknown): value is CapabilityState {
  return typeof value === "string" && (CAPABILITY_STATE_VALUES as readonly string[]).includes(value);
}

/**
 * Totally unknown accelerator set. This is the honest default: collectors
 * upgrade individual fields to "available"/"unavailable" only on actual
 * evidence, never by assumption.
 */
export function unknownAccelerators(): HardwareAccelerators {
  return {
    cuda: "unknown",
    rocm: "unknown",
    vulkan: "unknown",
    directml: "unknown",
    npu: "unknown",
  };
}
