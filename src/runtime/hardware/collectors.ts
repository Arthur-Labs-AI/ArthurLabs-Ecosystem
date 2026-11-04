/**
 * HR-02.5A: platform-specific hardware collectors.
 *
 * Each collector gathers one bounded fact family and degrades
 * field-by-field: a missing command or unreadable file yields unknown for
 * that field only, never an exception. GPU vendor presence and
 * accelerator/runtime availability are always detected independently
 * (an NVIDIA GPU does not imply CUDA; an AMD GPU does not imply ROCm).
 */

import type { CapabilityState, HardwareGpu } from './contracts';
import type { ExecFn } from './exec';
import { outputLines, runBounded } from './exec';
import type { FsReader } from './fs';
import { normalizeBytesToMb, normalizeGpuVendor, normalizeModelName, normalizeVramMb } from './normalization';

export interface CollectorEnv {
  exec: ExecFn;
  fs: FsReader;
  platform: string;
}

// Parse nvidia-smi CSV rows: '<name>, <total MiB> MiB'. The name may itself
// contain commas, so the VRAM field is anchored at the end of the line.
export function parseNvidiaSmiCsv(output: string): HardwareGpu[] {
  const gpus: HardwareGpu[] = [];
  for (const line of outputLines(output, 64)) {
    const match = /^(.*?),\s*([0-9]+(?:\.[0-9]+)?)\s*mi?b\s*$/i.exec(line);
    if (!match) continue;
    const name = normalizeModelName(match[1]);
    if (name === null) continue;
    const vram = normalizeVramMb(Number(match[2]));
    gpus.push({ vendor: 'nvidia', name, vram_mb: vram });
  }
  return gpus;
}

// Query NVIDIA GPUs via nvidia-smi (trusted argv, no shell).
export async function collectNvidiaGpus(exec: ExecFn): Promise<HardwareGpu[] | null> {
  const result = await runBounded(exec, 'nvidia-smi', [
    '--query-gpu=name,memory.total',
    '--format=csv,noheader',
  ]);
  if (!result.ok) return null;
  return parseNvidiaSmiCsv(result.stdout);
}

// CUDA runtime usable: nvidia-smi must run AND report at least one GPU.
export async function detectCuda(exec: ExecFn, nvidiaGpus: HardwareGpu[] | null): Promise<CapabilityState> {
  if (nvidiaGpus === null) return 'unknown';
  if (nvidiaGpus.length === 0) return 'unavailable';
  const result = await runBounded(exec, 'nvidia-smi', ['-L']);
  if (!result.ok) return 'unknown';
  return outputLines(result.stdout, 64).length > 0 ? 'available' : 'unavailable';
}

// Parse rocminfo agent lines and rocm-smi product-name output.
export function parseRocmAgents(output: string): boolean {
  return outputLines(output, 512).some((line) => /^(name|marketing name)\s*:/i.test(line));
}

// ROCm runtime usable: rocminfo/rocm-smi must positively report agents.
export async function detectRocm(exec: ExecFn): Promise<CapabilityState> {
  const info = await runBounded(exec, 'rocminfo', []);
  if (info.ok && parseRocmAgents(info.stdout)) return 'available';
  const smi = await runBounded(exec, 'rocm-smi', ['--showproductname']);
  if (smi.ok && outputLines(smi.stdout, 128).some((line) => /card|series|gpu/i.test(line))) return 'available';
  // A failing probe proves nothing: the tools may simply not be installed.
  if (!info.ok && !smi.ok) return 'unknown';
  return 'unavailable';
}

// Vulkan usable: a vulkaninfo deviceType line must be present.
export async function detectVulkan(exec: ExecFn): Promise<CapabilityState> {
  const result = await runBounded(exec, 'vulkaninfo', ['--summary']);
  if (!result.ok) return 'unknown';
  return outputLines(result.stdout, 512).some((line) => /devicetype\s*=/i.test(line)) ? 'available' : 'unavailable';
}

export interface WindowsGpuFacts {
  gpus: HardwareGpu[] | null;
  directml: CapabilityState;
}

// Windows GPU discovery via wmic win32_VideoController.
// AdapterRAM (bytes) becomes VRAM; names classify vendors centrally.
export function parseWmicVideoControllers(output: string): HardwareGpu[] {
  const gpus: HardwareGpu[] = [];
  const lines = outputLines(output, 128).filter((line) => !/^name\s+adapterram$/i.test(line));
  for (const line of lines) {
    const match = /^(.*?)\s{2,}([0-9]+)\s*$/.exec(line);
    const nameRaw = match ? match[1] : line;
    const ramRaw = match ? Number(match[2]) : NaN;
    const name = normalizeModelName(nameRaw);
    if (name === null) continue;
    gpus.push({
      vendor: normalizeGpuVendor(name),
      name,
      vram_mb: Number.isFinite(ramRaw) && ramRaw > 0 ? normalizeBytesToMb(ramRaw) : null,
    });
  }
  return gpus;
}

// Parse wmic /format:list output (Name= / AdapterRAM= pairs).
export function parseWmicListFormat(output: string): HardwareGpu[] {
  const gpus: HardwareGpu[] = [];
  let name: string | null = null;
  let ram: number | null = null;
  const flush = (): void => {
    if (name !== null) {
      gpus.push({ vendor: normalizeGpuVendor(name), name, vram_mb: ram });
    }
    name = null;
    ram = null;
  };
  for (const line of outputLines(output, 256)) {
    const nameMatch = /^name\s*=\s*(.+?)\s*$/i.exec(line);
    if (nameMatch) {
      if (name !== null) flush();
      name = normalizeModelName(nameMatch[1]);
      continue;
    }
    const ramMatch = /^adapterram\s*=\s*([0-9]+)\s*$/i.exec(line);
    if (ramMatch) {
      ram = normalizeBytesToMb(Number(ramMatch[1]));
      continue;
    }
  }
  if (name !== null) flush();
  return gpus;
}

export async function collectWindowsGpus(exec: ExecFn): Promise<WindowsGpuFacts> {
  const result = await runBounded(exec, 'wmic', ['path', 'win32_VideoController', 'get', 'Name,AdapterRAM', '/format:list']);
  if (result.ok) {
    const gpus = parseWmicListFormat(result.stdout);
    if (gpus.length > 0) return { gpus, directml: 'unknown' };
  }
  const table = await runBounded(exec, 'wmic', ['path', 'win32_VideoController', 'get', 'Name,AdapterRAM']);
  if (!table.ok) return { gpus: null, directml: 'unknown' };
  const parsed = parseWmicVideoControllers(table.stdout);
  const listed = parseWmicListFormat(table.stdout);
  const gpus = parsed.length > 0 ? parsed : listed;
  return { gpus: gpus.length > 0 ? gpus : null, directml: 'unknown' };
}

// DirectML ships with Windows 10+ (build 19041+); presence of the system DLL is evidence.
export function detectDirectMl(fs: FsReader, platform: string): CapabilityState {
  if (platform !== 'win32' && platform !== 'windows') return 'unknown';
  try {
    if (fs.exists('C:\\Windows\\System32\\DirectML.dll')) return 'available';
  } catch {
    return 'unknown';
  }
  return 'unknown';
}

export interface LinuxGpuFacts {
  gpus: HardwareGpu[];
  // False when PCI enumeration was impossible (lspci missing).
  enumerated: boolean;
}

// Parse lspci -mm VGA/3D/display controller records into GPU entries.
export function parseLspciMm(output: string): HardwareGpu[] {
  const gpus: HardwareGpu[] = [];
  for (const line of outputLines(output, 256)) {
    if (!/vga|3d controller|display controller/i.test(line)) continue;
    const quoted = Array.from(line.matchAll(/"([^"]*)"/g), (m) => m[1] ?? '');
    const device = normalizeModelName(quoted[2] ?? quoted[1] ?? quoted[0] ?? null);
    if (device === null) continue;
    const vendorRaw = ((quoted[0] ?? '') + ' ' + device);
    gpus.push({ vendor: normalizeGpuVendor(vendorRaw), name: device, vram_mb: null });
  }
  return gpus;
}

// Linux GPU enumeration via lspci; VRAM stays null (no safe generic source).
export async function collectLinuxGpus(exec: ExecFn): Promise<LinuxGpuFacts> {
  const result = await runBounded(exec, 'lspci', ['-mm']);
  if (!result.ok) return { gpus: [], enumerated: false };
  return { gpus: parseLspciMm(result.stdout), enumerated: true };
}

// Parse /proc/meminfo MemTotal (kB) into MiB.
export function parseMemTotalKb(meminfo: string): number | null {
  const match = /^memtotal:\s*([0-9]+)\s*kb\s*$/im.exec(meminfo);
  if (!match) return null;
  const kb = Number(match[1]);
  if (!Number.isFinite(kb) || kb <= 0) return null;
  return Math.max(1, Math.floor(kb / 1024));
}

// Parse /proc/cpuinfo model name (first occurrence wins).
export function parseCpuModel(cpuinfo: string): string | null {
  const match = /^model name\s*:\s*(.+?)\s*$/im.exec(cpuinfo);
  if (match) return normalizeModelName(match[1]);
  const hw = /^hardware\s*:\s*(.+?)\s*$/im.exec(cpuinfo);
  if (hw) return normalizeModelName(hw[1]);
  return null;
}

// NPU detection. Only reports available on positive evidence (PCI class
// keyword or accelerator sysfs node); unavailable when the platform
// enumerated devices and found none; unknown otherwise.
export function detectNpu(args: { lspciOutput: string | null; sysfsEntries: string[] | null }): CapabilityState {
  if (args.sysfsEntries !== null) {
    if (args.sysfsEntries.some((entry) => /accel|npu|vpu|ap1302/i.test(entry))) return 'available';
  }
  if (args.lspciOutput !== null) {
    const hit = outputLines(args.lspciOutput, 512).some((line) =>
      /neural|npu|vpu|vision processing|ai (accelerator|engine)/i.test(line),
    );
    if (hit) return 'available';
    if (args.sysfsEntries !== null) return 'unavailable';
    return 'unknown';
  }
  return 'unknown';
}
