/**
 * FRS-05: doctor diagnostic model.
 *
 * Read-only representation of one ARTHUR machine diagnostic run. The CLI
 * renders it (human or JSON); the domain builds it without mutation.
 * Statuses are a small deterministic set; required=false + skipped never
 * fails health. No secret values ever appear here (sources only).
 */

import type { SetupProfile } from '../setup/profile';

export const DOCTOR_CHECK_STATUSES = ['pass', 'warn', 'fail', 'skipped'] as const;

export type DoctorCheckStatus = (typeof DOCTOR_CHECK_STATUSES)[number];

export function isDoctorCheckStatus(value: unknown): value is DoctorCheckStatus {
  return typeof value === 'string' && (DOCTOR_CHECK_STATUSES as readonly string[]).includes(value);
}

export const DOCTOR_AREAS = [
  'configuration',
  'reasoning',
  'speech',
  'audio',
  'local-models',
  'policy',
] as const;

export type DoctorArea = (typeof DOCTOR_AREAS)[number];

export interface DoctorCheck {
  /** Stable machine-readable id, e.g. "provider.deepseek.credential". */
  id: string;
  area: DoctorArea;
  status: DoctorCheckStatus;
  /** True when a fail here makes the machine NOT_READY (or UNCONFIGURED). */
  required: boolean;
  /** Bounded human message (never a secret, never raw provider prose). */
  message: string;
  /** Exactly one safe repair command when known, e.g. "arthur audio setup". */
  remediation?: string;
  /** Safe structured detail (sources, ids, counts — never secrets). */
  details?: Record<string, string | number | boolean>;
  /** Credential/config source where relevant (never the value). */
  source?: string;
}

export const DOCTOR_OVERALL_STATUSES = ['READY', 'DEGRADED', 'NOT_READY', 'UNCONFIGURED'] as const;

export type DoctorOverallStatus = (typeof DOCTOR_OVERALL_STATUSES)[number];

export function isDoctorOverallStatus(value: unknown): value is DoctorOverallStatus {
  return typeof value === 'string' && (DOCTOR_OVERALL_STATUSES as readonly string[]).includes(value);
}

export type DoctorProfile = SetupProfile | 'partial' | 'unconfigured';

export interface DoctorReport {
  ok: boolean;
  status: DoctorOverallStatus;
  profile: DoctorProfile;
  live: boolean;
  interactive: boolean;
  checks: DoctorCheck[];
}

export function emptyDoctorReport(profile: DoctorProfile, live: boolean, interactive: boolean): DoctorReport {
  return { ok: false, status: 'NOT_READY', profile, live, interactive, checks: [] };
}
