/** Static secret-pattern redaction for verification output (§102).
 *  No secret VALUES are handled here: patterns only (Bearer tokens,
 *  key/token assignments, authorization headers). Persisted source
 *  records were already redacted at capture; this is defense-in-depth
 *  for fresh verifier output before persistence. */
export function redactSecrets(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/=-]{8,}/gi, '$1[REDACTED]')
    .replace(
      /\b([A-Za-z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION))\s*[:=]\s*([^\s,}]+)/gi,
      '$1=[REDACTED]',
    )
    .slice(0, 20000);
}
