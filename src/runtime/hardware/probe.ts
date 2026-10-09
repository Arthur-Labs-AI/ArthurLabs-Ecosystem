/**
 * HR-02.5A: production hardware probe.
 *
 * Flow: OS facts (node:os) + CPU/RAM facts + per-platform GPU collectors +
 * independent accelerator detectors, merged field-by-field into one
 * normalized immutable HardwareProfile. Every optional step is defensive:
 * a failure narrows one field to unknown instead of throwing.
 *
 * The probe takes all platform dependencies as injected seams (osFacts,
 * exec, fs) so tests substitute deterministic fakes and production never
 * embeds raw discovery inside application composition.
 */

import * as os from 'node:os';

import type { CapabilityState, HardwareArch, HardwareGpu, HardwareOs, HardwareProfile } from './contracts';
import { unknownAccelerators } from './contracts';
import type { ExecFn } from './exec';
import { nodeExecFn, runBounded } from './exec';
import type { FsReader } from './fs';
import { nodeFsReader } from './fs';
import {
  collectNvidiaGpus,
  collectWindowsGpus,
  detectCuda,
  detectDirectMl,
  detectNpu,
  detectRocm,
  detectVulkan,
  parseCpuModel,
  parseLspciMm,
  parseMemTotalKb,
} from './collectors';
import { normalizeArch, normalizeBytesToMb, normalizeLogicalCores, normalizeModelName, normalizeOs } from './normalization';

export interface OsFacts {
  platform: string;
  arch: string;
  totalmemBytes: number | null;
  cpuCount: number | null;
  cpuModel: string | null;
}

export interface HardwareProbe {
  detect(): Promise<HardwareProfile>;
}

export interface ProbeDeps {
  osFacts?: () => OsFacts;
  exec?: ExecFn;
  fs?: FsReader;
  platformOverride?: string;
}

export function nodeOsFacts(): OsFacts {
  let totalmemBytes: number | null = null;
  try {
    const bytes = os.totalmem();
    totalmemBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : null;
  } catch {
    totalmemBytes = null;
  }
  let cpuCount: number | null = null;
  let cpuModel: string | null = null;
  try {
    const cpus = os.cpus();
    if (Array.isArray(cpus) && cpus.length > 0) {
      cpuCount = cpus.length;
      cpuModel = normalizeModelName(cpus[0] ? cpus[0].model : null);
    }
  } catch {
    cpuCount = null;
    cpuModel = null;
  }
  let platform = 'unknown';
  try {
    platform = os.platform();
  } catch {
    platform = 'unknown';
  }
  let arch = 'unknown';
  try {
    arch = os.arch();
  } catch {
    arch = 'unknown';
  }
  return { platform, arch, totalmemBytes, cpuCount, cpuModel };
}

// Merge GPU lists, de-duplicating by normalized name (case-insensitive).
// nvidia-smi entries win over lspci entries for the same device because
// they carry VRAM facts lspci cannot provide.
export function mergeGpus(primary: HardwareGpu[], secondary: HardwareGpu[]): HardwareGpu[] {
  const seen = new Set<string>();
  const merged: HardwareGpu[] = [];
  for (const gpu of [...primary, ...secondary]) {
    const key = gpu.name.trim().toLowerCase();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    merged.push({ vendor: gpu.vendor, name: gpu.name, vram_mb: gpu.vram_mb });
  }
  return merged;
}

function safeDetect<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
  return fn().catch(() => fallback);
}

export class SystemHardwareProbe implements HardwareProbe {
  private readonly osFacts: () => OsFacts;
  private readonly exec: ExecFn;
  private readonly fs: FsReader;
  private readonly platformOverride: string | null;
  private cached: HardwareProfile | null = null;

  constructor(deps: ProbeDeps = {}) {
    this.osFacts = deps.osFacts ?? nodeOsFacts;
    this.exec = deps.exec ?? nodeExecFn();
    this.fs = deps.fs ?? nodeFsReader();
    this.platformOverride = deps.platformOverride ?? null;
  }

  async detect(): Promise<HardwareProfile> {
    if (this.cached) return this.cached;
    const profile = await this.collect();
    this.cached = profile;
    return profile;
  }

  private async collect(): Promise<HardwareProfile> {
    let facts: OsFacts;
    try {
      facts = this.osFacts();
    } catch {
      facts = { platform: 'unknown', arch: 'unknown', totalmemBytes: null, cpuCount: null, cpuModel: null };
    }
    const platform = this.platformOverride ?? facts.platform;
    const osName: HardwareOs = normalizeOs(platform);
    const arch: HardwareArch = normalizeArch(facts.arch);

    let totalMb: number | null = null;
    let cpuModel: string | null = null;
    try {
      totalMb = normalizeBytesToMb(facts.totalmemBytes);
      cpuModel = normalizeModelName(facts.cpuModel);
    } catch {
      totalMb = null;
      cpuModel = null;
    }
    let logicalCores: number | null = null;
    try {
      logicalCores = normalizeLogicalCores(facts.cpuCount);
    } catch {
      logicalCores = null;
    }

    if (osName === 'linux') {
      try {
        const meminfo = this.fs.readTextFile('/proc/meminfo');
        if (meminfo !== null) {
          const parsed = parseMemTotalKb(meminfo);
          if (parsed !== null) totalMb = parsed;
        }
      } catch {
        // Keep node:os value.
      }
      try {
        const cpuinfo = this.fs.readTextFile('/proc/cpuinfo');
        if (cpuinfo !== null) {
          const parsed = parseCpuModel(cpuinfo);
          if (parsed !== null) cpuModel = parsed;
        }
      } catch {
        // Keep node:os value.
      }
    }

    let gpus: HardwareGpu[] = [];
    let cuda: CapabilityState = 'unknown';
    let rocm: CapabilityState = 'unknown';
    let vulkan: CapabilityState = 'unknown';
    let directml: CapabilityState = 'unknown';
    let npu: CapabilityState = 'unknown';

    if (osName === 'windows') {
      const win = await safeDetect({ gpus: null as HardwareGpu[] | null, directml: 'unknown' as CapabilityState }, () =>
        collectWindowsGpus(this.exec),
      );
      const nvidia = await safeDetect(null as HardwareGpu[] | null, () => collectNvidiaGpus(this.exec));
      if (win.gpus !== null) gpus = mergeGpus(win.gpus, nvidia ?? []);
      else if (nvidia !== null) gpus = [...nvidia];
      cuda = await safeDetect('unknown' as CapabilityState, () => detectCuda(this.exec, nvidia));
      rocm = await safeDetect('unknown' as CapabilityState, () => detectRocm(this.exec));
      vulkan = await safeDetect('unknown' as CapabilityState, () => detectVulkan(this.exec));
      try {
        directml = detectDirectMl(this.fs, platform);
      } catch {
        directml = 'unknown';
      }
      npu = 'unknown';
    } else if (osName === 'linux') {
      const lspci = await safeDetect({ ok: false, stdout: '', stderr: '' }, () =>
        runBounded(this.exec, 'lspci', ['-mm']),
      );
      const enumerated = lspci.ok;
      const pciGpus = lspci.ok ? parseLspciMm(lspci.stdout) : [];
      const nvidia = await safeDetect(null as HardwareGpu[] | null, () => collectNvidiaGpus(this.exec));
      if (nvidia !== null && nvidia.length > 0) gpus = mergeGpus(nvidia, pciGpus);
      else gpus = [...pciGpus];
      cuda = await safeDetect('unknown' as CapabilityState, () => detectCuda(this.exec, nvidia));
      rocm = await safeDetect('unknown' as CapabilityState, () => detectRocm(this.exec));
      vulkan = await safeDetect('unknown' as CapabilityState, () => detectVulkan(this.exec));
      directml = 'unavailable';
      let sysfs: string[] | null = null;
      try {
        sysfs = this.fs.listDir('/sys/class/accel');
      } catch {
        sysfs = null;
      }
      try {
        npu = detectNpu({ lspciOutput: enumerated ? lspci.stdout : null, sysfsEntries: sysfs });
      } catch {
        npu = 'unknown';
      }
    } else {
      const nvidia = await safeDetect(null as HardwareGpu[] | null, () => collectNvidiaGpus(this.exec));
      if (nvidia !== null) gpus = [...nvidia];
      cuda = await safeDetect('unknown' as CapabilityState, () => detectCuda(this.exec, nvidia));
      // ROCm/Vulkan/DirectML/NPU have no reliable generic probe here.
    }

    const accelerators = unknownAccelerators();
    accelerators.cuda = cuda;
    accelerators.rocm = rocm;
    accelerators.vulkan = vulkan;
    accelerators.directml = directml;
    accelerators.npu = npu;

    return {
      os: osName,
      arch,
      memory: { total_mb: totalMb },
      cpu: { logical_cores: logicalCores, model: cpuModel },
      gpus,
      accelerators,
    };
  }
}

// Fake probe for tests and future composition roots: returns a deep copy
// so callers can never mutate the fixture through the returned profile.
export class FakeHardwareProbe implements HardwareProbe {
  constructor(private readonly profile: HardwareProfile) {}

  async detect(): Promise<HardwareProfile> {
    return JSON.parse(JSON.stringify(this.profile)) as HardwareProfile;
  }
}
