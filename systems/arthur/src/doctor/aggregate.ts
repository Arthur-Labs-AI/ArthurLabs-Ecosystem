/**
 * FRS-05: aggregate health semantics.
 *
 * READY:      all REQUIRED checks pass (warn allowed only on optional).
 * DEGRADED:   all required checks pass, but optional warnings exist.
 * NOT_READY:  one or more REQUIRED checks fail.
 * UNCONFIGURED: no meaningful ARTHUR configuration exists.
 *
 * "not tested live" (skipped) is never a failure: in static mode provider
 * credential presence PASSES configuration while network readiness is
 * SKIPPED explicitly.
 */

import { CliExit, type CliExitCode } from '../cli_exit';
import type { DoctorOverallStatus, DoctorReport } from './types';

export function aggregateDoctorStatus(checks: DoctorReport['checks']): DoctorOverallStatus {
  if (checks.length === 0) return 'UNCONFIGURED';
  const meaningful = checks.some((c) => c.id !== 'config.present' || c.status === 'pass');
  const configPresent = checks.find((c) => c.id === 'config.present');
  if (configPresent && configPresent.status === 'fail' && configPresent.details?.['config_present'] === false) {
    return 'UNCONFIGURED';
  }
  if (!meaningful) return 'UNCONFIGURED';
  const requiredFailed = checks.some((c) => c.required && c.status === 'fail');
  if (requiredFailed) return 'NOT_READY';
  const optionalWarn = checks.some((c) => !c.required && (c.status === 'warn' || c.status === 'fail'));
  if (optionalWarn) return 'DEGRADED';
  return 'READY';
}

export function finalizeDoctorReport(report: DoctorReport): DoctorReport {
  const status = aggregateDoctorStatus(report.checks);
  report.status = status;
  report.ok = status === 'READY' || status === 'DEGRADED';
  return report;
}

/**
 * Deterministic exit-code mapping (no second exit-code universe):
 * READY/DEGRADED => SUCCESS(0); UNCONFIGURED / required failure =>
 * VALIDATION_FAILED(5); unexpected implementation failure => INTERNAL(1)
 * (thrown to the CLI boundary); invalid flags => USAGE(2).
 */
export function exitCodeForDoctor(report: DoctorReport): CliExitCode {
  if (report.status === 'READY' || report.status === 'DEGRADED') return CliExit.SUCCESS;
  return CliExit.VALIDATION_FAILED;
}
