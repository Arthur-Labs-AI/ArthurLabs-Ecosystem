export interface VerifyOutcomeCounts {
  readonly attempts: number;
  readonly reproduced: number;
  readonly partial: number;
  readonly notReproducible: number;
  readonly inconclusive: number;
}

export function summarizeVerificationAttempts(
  attempts: readonly { outcome?: string | undefined }[] | undefined,
): VerifyOutcomeCounts {
  const list = attempts ?? [];
  return {
    attempts: list.length,
    reproduced: list.filter((a) => a.outcome === 'reproduced').length,
    partial: list.filter((a) => a.outcome === 'partially_verified').length,
    notReproducible: list.filter((a) => a.outcome === 'not_reproducible').length,
    inconclusive: list.filter((a) => a.outcome === 'inconclusive').length,
  };
}

export function severityBreakdown(findings: readonly { severity?: string | undefined }[]): {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
} {
  const count = (severity: string): number =>
    findings.filter((f) => f.severity === severity).length;
  return {
    critical: count('critical'),
    high: count('high'),
    medium: count('medium'),
    low: count('low'),
    info: count('info'),
  };
}
