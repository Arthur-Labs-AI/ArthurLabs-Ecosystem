/**
 * HR-02.5B: deterministic fail-closed hardware compatibility.
 *
 * Generic over catalog definitions: no model ids, vendor names, or
 * special cases appear here. Every requirement x observed-fact pair
 * yields one structured reason; ANY failing reason makes the model
 * incompatible. Unknown required facts NEVER pass (NOT_PROVEN).
 *
 * Multi-GPU rule: at most ONE gpu must satisfy ALL gpu-scoped checks
 * (vendor-implied accelerator aside — accelerators are machine-level
 * capability states, checked separately). VRAM is never summed.
 */

import type { CapabilityState, HardwareProfile } from '../hardware/contracts';
import type { LocalModelAccelerator, LocalModelDefinition } from './contracts';

export type CompatibilityCheck = 'pass' | 'fail';

export interface CompatibilityReason {
  requirement: string;
  observed: string;
  result: CompatibilityCheck;
}

export interface CompatibilityResult {
  compatible: boolean;
  reasons: CompatibilityReason[];
}

function pass(requirement: string, observed: string): CompatibilityReason {
  return { requirement, observed, result: 'pass' };
}

function failReason(requirement: string, observed: string): CompatibilityReason {
  return { requirement, observed, result: 'fail' };
}

function acceleratorState(hardware: HardwareProfile, accel: LocalModelAccelerator): CapabilityState | 'cpu' {
  if (accel === 'cpu') return 'cpu';
  return hardware.accelerators[accel];
}

export function evaluateCompatibility(model: LocalModelDefinition, hardware: HardwareProfile): CompatibilityResult {
  const reasons: CompatibilityReason[] = [];
  const req = model.requirements;

  if (req.architectures !== undefined && req.architectures.length > 0) {
    const want = req.architectures.join('/');
    const seen = hardware.arch;
    if (req.architectures.includes(hardware.arch)) {
      reasons.push(pass('architecture: ' + want, 'architecture: ' + seen));
    } else {
      reasons.push(failReason('architecture: ' + want, 'architecture: ' + seen));
    }
  }

  if (req.operating_systems !== undefined && req.operating_systems.length > 0) {
    const want = req.operating_systems.join('/');
    const seen = hardware.os;
    if (req.operating_systems.includes(hardware.os)) {
      reasons.push(pass('os: ' + want, 'os: ' + seen));
    } else {
      reasons.push(failReason('os: ' + want, 'os: ' + seen));
    }
  }

  if (req.min_ram_mb !== undefined) {
    const want = 'minimum RAM: ' + String(req.min_ram_mb) + ' MB';
    if (hardware.memory.total_mb === null) {
      reasons.push(failReason(want, 'observed RAM: unknown (not proven)'));
    } else if (hardware.memory.total_mb >= req.min_ram_mb) {
      reasons.push(pass(want, 'observed RAM: ' + String(hardware.memory.total_mb) + ' MB'));
    } else {
      reasons.push(failReason(want, 'observed RAM: ' + String(hardware.memory.total_mb) + ' MB'));
    }
  }

  const accel = req.accelerator;
  if (accel !== undefined && accel !== 'cpu') {
    const state = acceleratorState(hardware, accel);
    const want = 'accelerator: ' + accel;
    if (state === 'available') {
      reasons.push(pass(want, accel + ': available'));
    } else if (state === 'unavailable') {
      reasons.push(failReason(want, accel + ': unavailable'));
    } else {
      reasons.push(failReason(want, accel + ': unknown (not proven)'));
    }
  }

  if (req.min_vram_mb !== undefined) {
    const minVram: number = req.min_vram_mb;
    const want = 'minimum VRAM: ' + String(minVram) + ' MB on a single GPU';
    const qualifying = hardware.gpus.filter((gpu) => gpu.vram_mb !== null && gpu.vram_mb >= minVram);
    if (hardware.gpus.length === 0) {
      reasons.push(failReason(want, 'observed GPUs: none (not proven)'));
    } else if (qualifying.length > 0) {
      const best = Math.max(...qualifying.map((gpu) => gpu.vram_mb as number));
      reasons.push(pass(want, 'observed VRAM (best single GPU): ' + String(best) + ' MB'));
    } else if (hardware.gpus.some((gpu) => gpu.vram_mb === null)) {
      reasons.push(failReason(want, 'observed VRAM: unknown on at least one GPU (not proven)'));
    } else {
      const best = Math.max(...hardware.gpus.map((gpu) => gpu.vram_mb as number));
      reasons.push(failReason(want, 'observed VRAM (best single GPU): ' + String(best) + ' MB'));
    }
  }

  const compatible = reasons.every((reason) => reason.result === 'pass');
  return { compatible, reasons };
}

export function filterCompatible(models: readonly LocalModelDefinition[], hardware: HardwareProfile): Array<{ model: LocalModelDefinition; compatibility: CompatibilityResult }> {
  return models.map((model) => ({ model, compatibility: evaluateCompatibility(model, hardware) }));
}
