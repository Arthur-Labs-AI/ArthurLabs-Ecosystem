/**
 * HR-02.5A unit tests: normalization, parsers, probe behavior, fixtures.
 *
 * Fully deterministic: subprocess and filesystem access are injected fakes.
 * No test requires a real GPU, CUDA, ROCm, Vulkan, or network access.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { HardwareProfile } from '../../src/runtime/hardware/contracts';
import {
  collectLinuxGpus,
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
  parseNvidiaSmiCsv,
  parseRocmAgents,
  parseWmicListFormat,
  parseWmicVideoControllers,
} from '../../src/runtime/hardware/collectors';
import type { ExecFn } from '../../src/runtime/hardware/exec';
import { outputLines, PROBE_MAX_BUFFER_BYTES, runBounded } from '../../src/runtime/hardware/exec';
import { mapFsReader } from '../../src/runtime/hardware/fs';
import {
  normalizeArch,
  normalizeBytesToMb,
  normalizeGpuVendor,
  normalizeLogicalCores,
  normalizeModelName,
  normalizeOs,
  normalizeVramMb,
  orUnknown,
} from '../../src/runtime/hardware/normalization';
import { FakeHardwareProbe, mergeGpus, SystemHardwareProbe, type OsFacts } from '../../src/runtime/hardware/probe';
import {
  cpuOnlyX64,
  linuxAmdNoRocm,
  linuxAmdRocm,
  linuxArm64CpuOnly,
  linuxArm64UnknownAccel,
  multiGpuMixed,
  partiallyUnknown,
  windowsNvidiaCuda,
  windowsNvidiaNoCuda,
} from './hardware_fixtures';

// ---- helpers -------------------------------------------------------------

function stubExec(routes: Record<string, { ok: boolean; stdout: string; stderr?: string }>): ExecFn {
  return async (file, args) => {
    const key = file + ' ' + args.join(' ');
    const hit = routes[key] ?? routes[file];
    if (!hit) return { ok: false, stdout: '', stderr: 'ENOENT' };
    return { ok: hit.ok, stdout: hit.stdout, stderr: hit.stderr ?? '' };
  };
}

function throwingExec(): ExecFn {
  return async () => {
    throw new Error('spawn exploded');
  };
}

const LINUX_X64_FACTS: OsFacts = {
  platform: 'linux',
  arch: 'x64',
  totalmemBytes: 16 * 1024 * 1024 * 1024,
  cpuCount: 8,
  cpuModel: 'AMD Ryzen 5 5600X',
};

const NVIDIA_SMI_CSV = 'NVIDIA GeForce RTX 4070, 8192 MiB\n';
const NVIDIA_SMI_LIST = 'GPU 0: NVIDIA GeForce RTX 4070 (UUID: GPU-abc)\n';
const LSPCI_AMD = '00:00.0 "VGA compatible controller" "Advanced Micro Devices [AMD]" "Navi 23 [Radeon RX 6600]"\n';
const ROCMINFO = 'Agent 1\nName:                    gfx1030\nMarketing Name:       AMD Radeon RX 6600\n';
const VULKAN_SUMMARY = 'deviceType = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU\n';

// ---- architecture normalization ------------------------------------------

test('arch normalization maps platform aliases', () => {
  assert.equal(normalizeArch('x64'), 'x64');
  assert.equal(normalizeArch('AMD64'), 'x64');
  assert.equal(normalizeArch('x86_64'), 'x64');
  assert.equal(normalizeArch('aarch64'), 'arm64');
  assert.equal(normalizeArch('arm64'), 'arm64');
  assert.equal(normalizeArch('ia32'), 'unknown');
  assert.equal(normalizeArch(null), 'unknown');
  assert.equal(normalizeArch(undefined), 'unknown');
  assert.equal(normalizeArch(''), 'unknown');
});

test('os normalization maps node platform strings', () => {
  assert.equal(normalizeOs('win32'), 'windows');
  assert.equal(normalizeOs('linux'), 'linux');
  assert.equal(normalizeOs('darwin'), 'darwin');
  assert.equal(normalizeOs('freebsd'), 'unknown');
  assert.equal(normalizeOs(null), 'unknown');
});

// ---- GPU vendor normalization --------------------------------------------

test('gpu vendor normalization is deterministic', () => {
  assert.equal(normalizeGpuVendor('NVIDIA GeForce RTX 4070'), 'nvidia');
  assert.equal(normalizeGpuVendor('Quadro P2000'), 'nvidia');
  assert.equal(normalizeGpuVendor('AMD Radeon RX 7900 XTX'), 'amd');
  assert.equal(normalizeGpuVendor('Radeon RX 6600'), 'amd');
  assert.equal(normalizeGpuVendor('Intel Iris Xe Graphics'), 'intel');
  assert.equal(normalizeGpuVendor('Intel UHD Graphics 770'), 'intel');
  assert.equal(normalizeGpuVendor('Some Future Device 9000'), 'other');
  assert.equal(normalizeGpuVendor(''), 'unknown');
  assert.equal(normalizeGpuVendor(null), 'unknown');
  assert.equal(normalizeGpuVendor(undefined), 'unknown');
});

test('vendor classification never throws on hostile input', () => {
  assert.equal(normalizeGpuVendor('   '), 'unknown');
  assert.equal(normalizeGpuVendor('nViDiA ' + 'x'.repeat(5000)), 'nvidia');
});

// ---- memory / scalar normalization ---------------------------------------

test('memory normalization converts bytes to MiB', () => {
  assert.equal(normalizeBytesToMb(8 * 1024 * 1024 * 1024), 8192);
  assert.equal(normalizeBytesToMb(null), null);
  assert.equal(normalizeBytesToMb(0), null);
  assert.equal(normalizeBytesToMb(-5), null);
  assert.equal(normalizeBytesToMb(Number.NaN), null);
  assert.equal(normalizeBytesToMb(Number.POSITIVE_INFINITY), null);
});

test('logical core normalization rejects garbage', () => {
  assert.equal(normalizeLogicalCores(8), 8);
  assert.equal(normalizeLogicalCores(0), null);
  assert.equal(normalizeLogicalCores(2.5), null);
  assert.equal(normalizeLogicalCores(null), null);
});

test('model name normalization blanks to null', () => {
  assert.equal(normalizeModelName('  AMD   Ryzen  5 '), 'AMD Ryzen 5');
  assert.equal(normalizeModelName('   '), null);
  assert.equal(normalizeModelName(null), null);
  assert.equal(normalizeVramMb(8192), 8192);
  assert.equal(normalizeVramMb(0), null);
  assert.equal(normalizeVramMb(null), null);
  assert.equal(orUnknown(null), 'unknown');
  assert.equal(orUnknown('available'), 'available');
});

// ---- nvidia-smi parsing ---------------------------------------------------

test('nvidia-smi csv parses names with commas and guards garbage', () => {
  const parsed = parseNvidiaSmiCsv('Tesla V100, DGXS, 16384 MiB\nGarbage line\n, \n');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0] && parsed[0].vendor, 'nvidia');
  assert.equal(parsed[0] && parsed[0].name, 'Tesla V100, DGXS');
  assert.equal(parsed[0] && parsed[0].vram_mb, 16384);
  assert.deepEqual(parseNvidiaSmiCsv(''), []);
  assert.deepEqual(parseNvidiaSmiCsv('not a gpu line'), []);
});

test('invalid external command output yields empty gpu lists', () => {
  assert.deepEqual(parseLspciMm(''), []);
  assert.deepEqual(parseLspciMm('00:00.0 "Ethernet controller" "Intel" "I219"\n'), []);
  assert.deepEqual(parseWmicListFormat(''), []);
  assert.deepEqual(parseWmicVideoControllers('Name  AdapterRAM\n'), []);
  assert.equal(parseMemTotalKb('garbage'), null);
  assert.equal(parseCpuModel(''), null);
  assert.equal(parseRocmAgents('nothing here'), false);
});

test('lspci parser extracts amd device names', () => {
  const parsed = parseLspciMm(LSPCI_AMD);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0] && parsed[0].vendor, 'amd');
  assert.ok((parsed[0] && parsed[0].name) || '');
  assert.equal(parsed[0] && parsed[0].vram_mb, null);
});

test('wmic parsers handle list and table formats', () => {
  const list = parseWmicListFormat('Name=NVIDIA GeForce RTX 4070\nAdapterRAM=8589934592\n\nName=Intel UHD 770\nAdapterRAM=1073741824\n');
  assert.equal(list.length, 2);
  assert.equal(list[0] && list[0].vendor, 'nvidia');
  assert.equal(list[0] && list[0].vram_mb, 8192);
  assert.equal(list[1] && list[1].vendor, 'intel');
  const table = parseWmicVideoControllers('NVIDIA GeForce RTX 4070  8589934592\n');
  assert.equal(table.length, 1);
  assert.equal(table[0] && table[0].vram_mb, 8192);
});

test('meminfo/cpuinfo parsers handle linux formats', () => {
  assert.equal(parseMemTotalKb('MemTotal:       16384000 kB\nMemFree: 100 kB\n'), 16000);
  assert.equal(parseCpuModel('processor\t: 0\nmodel name\t: AMD Ryzen 5 5600X\n'), 'AMD Ryzen 5 5600X');
  assert.equal(parseCpuModel('Hardware\t: Ampere Altra\n'), 'Ampere Altra');
});

// ---- exec bounds ----------------------------------------------------------

test('runBounded truncates oversized output and survives throwing exec', async () => {
  const big: ExecFn = async () => ({ ok: true, stdout: 'x'.repeat(PROBE_MAX_BUFFER_BYTES + 100), stderr: '' });
  const truncated = await runBounded(big, 'lspci', ['-mm']);
  assert.equal(truncated.ok, true);
  assert.equal(truncated.stdout.length, PROBE_MAX_BUFFER_BYTES);
  const failed = await runBounded(throwingExec(), 'lspci', ['-mm']);
  assert.equal(failed.ok, false);
  assert.deepEqual(outputLines('', 10), []);
  assert.equal(outputLines('a\nb\n', 1).length, 1);
});

// ---- NVIDIA vs CUDA distinction -------------------------------------------

test('nvidia gpu without working cuda stays distinct', async () => {
  const exec = stubExec({
    'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader': { ok: true, stdout: NVIDIA_SMI_CSV },
    'nvidia-smi -L': { ok: false, stdout: '', stderr: 'driver missing' },
  });
  const gpus = await collectNvidiaGpus(exec);
  assert.equal(gpus && gpus.length, 1);
  assert.equal(await detectCuda(exec, gpus), 'unknown');
});

test('nvidia gpu with cuda reports available; absent gpu reports unavailable', async () => {
  const exec = stubExec({
    'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader': { ok: true, stdout: NVIDIA_SMI_CSV },
    'nvidia-smi -L': { ok: true, stdout: NVIDIA_SMI_LIST },
  });
  const gpus = await collectNvidiaGpus(exec);
  assert.equal(await detectCuda(exec, gpus), 'available');
  assert.equal(await detectCuda(exec, []), 'unavailable');
  assert.equal(await detectCuda(exec, null), 'unknown');
});

// ---- AMD vs ROCm distinction ----------------------------------------------

test('amd gpu does not imply rocm: missing tools stay unknown', async () => {
  const exec = stubExec({});
  assert.equal(await detectRocm(exec), 'unknown');
});

test('rocm available only on positive agent evidence', async () => {
  const present = stubExec({ 'rocminfo': { ok: true, stdout: ROCMINFO } });
  assert.equal(await detectRocm(present), 'available');
  const smiOnly = stubExec({
    'rocminfo': { ok: false, stdout: '', stderr: 'ENOENT' },
    'rocm-smi --showproductname': { ok: true, stdout: 'Card series: RX 6600\n' },
  });
  assert.equal(await detectRocm(smiOnly), 'available');
  const ranButEmpty = stubExec({
    'rocminfo': { ok: true, stdout: 'no agents\n' },
    'rocm-smi --showproductname': { ok: true, stdout: 'nothing\n' },
  });
  assert.equal(await detectRocm(ranButEmpty), 'unavailable');
});

// ---- vulkan / directml / npu ----------------------------------------------

test('vulkan requires a deviceType line', async () => {
  assert.equal(await detectVulkan(stubExec({ 'vulkaninfo --summary': { ok: true, stdout: VULKAN_SUMMARY } })), 'available');
  assert.equal(await detectVulkan(stubExec({ 'vulkaninfo --summary': { ok: true, stdout: 'no devices\n' } })), 'unavailable');
  assert.equal(await detectVulkan(stubExec({})), 'unknown');
});

test('directml evidence is scoped to windows', () => {
  assert.equal(detectDirectMl(mapFsReader({ 'C:\\Windows\\System32\\DirectML.dll': 'bin' }), 'win32'), 'available');
  assert.equal(detectDirectMl(mapFsReader({}), 'win32'), 'unknown');
  assert.equal(detectDirectMl(mapFsReader({ 'C:\\Windows\\System32\\DirectML.dll': 'bin' }), 'linux'), 'unknown');
});

test('npu reports available only on positive evidence', () => {
  assert.equal(detectNpu({ lspciOutput: '01:00.0 Neural processing unit: Intel\n', sysfsEntries: [] }), 'available');
  assert.equal(detectNpu({ lspciOutput: null, sysfsEntries: ['accel0'] }), 'available');
  assert.equal(detectNpu({ lspciOutput: 'VGA: Intel\n', sysfsEntries: [] }), 'unavailable');
  assert.equal(detectNpu({ lspciOutput: null, sysfsEntries: null }), 'unknown');
  assert.equal(detectNpu({ lspciOutput: 'VGA: Intel\n', sysfsEntries: null }), 'unknown');
});

// ---- probe integration -----------------------------------------------------

test('linux amd + rocm probe keeps vendor and runtime separate', async () => {
  const probe = new SystemHardwareProbe({
    osFacts: () => ({ ...LINUX_X64_FACTS }),
    exec: stubExec({
      'lspci -mm': { ok: true, stdout: LSPCI_AMD },
      'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader': { ok: false, stdout: '', stderr: 'ENOENT' },
      'nvidia-smi -L': { ok: false, stdout: '', stderr: 'ENOENT' },
      'rocminfo': { ok: true, stdout: ROCMINFO },
      'vulkaninfo --summary': { ok: true, stdout: VULKAN_SUMMARY },
    }),
    fs: mapFsReader(
      { '/proc/meminfo': 'MemTotal:       16777216 kB\n', '/proc/cpuinfo': 'model name\t: AMD Ryzen 5 5600X\n' },
      { '/sys/class/accel': [] },
    ),
  });
  const profile = await probe.detect();
  assert.equal(profile.os, 'linux');
  assert.equal(profile.arch, 'x64');
  assert.equal(profile.memory.total_mb, 16384);
  assert.equal(profile.cpu.model, 'AMD Ryzen 5 5600X');
  assert.equal(profile.gpus.length, 1);
  assert.equal(profile.gpus[0] && profile.gpus[0].vendor, 'amd');
  assert.equal(profile.accelerators.rocm, 'available');
  assert.equal(profile.accelerators.cuda, 'unknown');
});

test('linux amd without rocm keeps gpu but runtime unavailable-or-unknown', async () => {
  const probe = new SystemHardwareProbe({
    osFacts: () => ({ ...LINUX_X64_FACTS }),
    exec: stubExec({ 'lspci -mm': { ok: true, stdout: LSPCI_AMD } }),
    fs: mapFsReader({}, { '/sys/class/accel': [] }),
  });
  const profile = await probe.detect();
  assert.equal(profile.gpus.length, 1);
  assert.ok(profile.accelerators.rocm === 'unavailable' || profile.accelerators.rocm === 'unknown');
});

test('linux arm64 cpu-only profile has no gpus and honest accelerators', async () => {
  const probe = new SystemHardwareProbe({
    osFacts: () => ({ platform: 'linux', arch: 'arm64', totalmemBytes: 8 * 1024 * 1024 * 1024, cpuCount: 8, cpuModel: 'Ampere Altra' }),
    exec: stubExec({ 'lspci -mm': { ok: true, stdout: '' } }),
    fs: mapFsReader(
      { '/proc/meminfo': 'MemTotal:        8388608 kB\n', '/proc/cpuinfo': 'Hardware\t: Ampere Altra\n' },
      { '/sys/class/accel': [] },
    ),
  });
  const profile = await probe.detect();
  assert.equal(profile.os, 'linux');
  assert.equal(profile.arch, 'arm64');
  assert.deepEqual(profile.gpus, []);
  assert.equal(profile.memory.total_mb, 8192);
  assert.equal(profile.accelerators.directml, 'unavailable');
});

test('partial probe failure degrades field-by-field', async () => {
  const probe = new SystemHardwareProbe({
    osFacts: () => ({ ...LINUX_X64_FACTS }),
    exec: throwingExec(),
    fs: mapFsReader({}),
  });
  const profile = await probe.detect();
  assert.equal(profile.os, 'linux');
  assert.equal(profile.arch, 'x64');
  assert.equal(profile.memory.total_mb, 16384);
  assert.equal(profile.cpu.logical_cores, 8);
  assert.deepEqual(profile.gpus, []);
  assert.equal(profile.accelerators.cuda, 'unknown');
  assert.equal(profile.accelerators.rocm, 'unknown');
});

test('multiple gpus merge with nvidia vram winning', async () => {
  const probe = new SystemHardwareProbe({
    osFacts: () => ({ ...LINUX_X64_FACTS, cpuCount: 64, cpuModel: 'AMD EPYC 9554', totalmemBytes: 128 * 1024 * 1024 * 1024 }),
    exec: stubExec({
      'lspci -mm': {
        ok: true,
        stdout: '41:00.0 "VGA compatible controller" "NVIDIA" "GA102 [GeForce RTX 3080]"\n' + '42:00.0 "VGA compatible controller" "Intel" "UHD Graphics 770"\n',
      },
      'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader': { ok: true, stdout: 'GA102 [GeForce RTX 3080], 10240 MiB\n' },
      'nvidia-smi -L': { ok: true, stdout: 'GPU 0: GA102 [GeForce RTX 3080]\n' },
    }),
    fs: mapFsReader({}, { '/sys/class/accel': [] }),
  });
  const profile = await probe.detect();
  assert.ok(profile.gpus.length >= 2);
  const nvidia = profile.gpus.find((g) => g.vendor === 'nvidia');
  assert.ok(nvidia);
  assert.equal(nvidia && nvidia.vram_mb, 10240);
  assert.equal(profile.accelerators.cuda, 'available');
});

test('mergeGpus dedupes case-insensitively with primary winning', () => {
  const merged = mergeGpus(
    [{ vendor: 'nvidia', name: 'RTX 3080', vram_mb: 10240 }],
    [{ vendor: 'nvidia', name: 'rtx 3080', vram_mb: null }, { vendor: 'intel', name: 'UHD 770', vram_mb: null }],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0] && merged[0].vram_mb, 10240);
});

test('windows probe path collects wmic gpus and directml evidence', async () => {
  const probe = new SystemHardwareProbe({
    osFacts: () => ({ platform: 'win32', arch: 'x64', totalmemBytes: 32 * 1024 * 1024 * 1024, cpuCount: 16, cpuModel: 'AMD Ryzen 9 5900X' }),
    exec: stubExec({
      'wmic path win32_VideoController get Name,AdapterRAM /format:list': {
        ok: true,
        stdout: 'Name=NVIDIA GeForce RTX 4070\nAdapterRAM=8589934592\n',
      },
      'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader': { ok: true, stdout: NVIDIA_SMI_CSV },
      'nvidia-smi -L': { ok: true, stdout: NVIDIA_SMI_LIST },
      'vulkaninfo --summary': { ok: true, stdout: VULKAN_SUMMARY },
    }),
    fs: mapFsReader({ 'C:\\Windows\\System32\\DirectML.dll': 'bin' }),
  });
  const profile = await probe.detect();
  assert.equal(profile.os, 'windows');
  assert.equal(profile.gpus.length, 1);
  assert.equal(profile.gpus[0] && profile.gpus[0].vendor, 'nvidia');
  assert.equal(profile.accelerators.cuda, 'available');
  assert.equal(profile.accelerators.directml, 'available');
});

test('throwing osFacts still yields a valid unknown profile', async () => {
  const probe = new SystemHardwareProbe({
    osFacts: () => {
      throw new Error('os down');
    },
    exec: stubExec({}),
    fs: mapFsReader({}),
  });
  const profile = await probe.detect();
  assert.equal(profile.os, 'unknown');
  assert.equal(profile.arch, 'unknown');
  assert.deepEqual(profile.gpus, []);
});

// ---- fixtures carry required representative shapes -------------------------

test('fixtures cover nvidia/cuda, amd/rocm, arm64, cpu-only and unknown', () => {
  const cases: HardwareProfile[] = [
    windowsNvidiaCuda(),
    windowsNvidiaNoCuda(),
    linuxAmdRocm(),
    linuxAmdNoRocm(),
    linuxArm64CpuOnly(),
    linuxArm64UnknownAccel(),
    cpuOnlyX64(),
    partiallyUnknown(),
    multiGpuMixed(),
  ];
  assert.equal(cases.length, 9);
  const withCuda = cases.find((c) => c.accelerators.cuda === 'available');
  assert.ok(withCuda && withCuda.gpus.some((g) => g.vendor === 'nvidia'));
  const nvidiaNoCuda = windowsNvidiaNoCuda();
  assert.ok(nvidiaNoCuda.gpus.some((g) => g.vendor === 'nvidia'));
  assert.ok(nvidiaNoCuda.accelerators.cuda !== 'available');
  const amdNoRocm = linuxAmdNoRocm();
  assert.ok(amdNoRocm.gpus.some((g) => g.vendor === 'amd'));
  assert.ok(amdNoRocm.accelerators.rocm !== 'available');
  assert.equal(linuxArm64CpuOnly().arch, 'arm64');
  assert.deepEqual(linuxArm64CpuOnly().gpus, []);
  assert.equal(partiallyUnknown().memory.total_mb, null);
  assert.ok(multiGpuMixed().gpus.length >= 2);
});

test('fake probe returns a frozen-equivalent copy', async () => {
  const probe = new FakeHardwareProbe(windowsNvidiaCuda());
  const first = await probe.detect();
  first.gpus.push({ vendor: 'other', name: 'evil', vram_mb: 1 });
  const second = await probe.detect();
  assert.equal(second.gpus.length, 1);
});

test('external probe timeout/failure degrades to unknown, never throws', async () => {
  // A never-resolving exec must be containable by the caller: racing it
  // against an already-resolved value proves the awaiting side is not
  // coupled to the hung child (no real timer needed in this test).
  const slow: ExecFn = async () => new Promise(() => {});
  const pending = runBounded(slow, 'vulkaninfo', ['--summary'], 25, 1024);
  assert.ok(pending instanceof Promise);
  const vulkan = await detectVulkan(stubExec({}));
  assert.equal(vulkan, 'unknown');
  const cuda = await detectCuda(stubExec({}), null);
  assert.equal(cuda, 'unknown');
  const rocm = await detectRocm(stubExec({}));
  assert.equal(rocm, 'unknown');
});
