/**
 * Names the fields a schema validation rejected, never their values: a raw
 * ZodError message is JSON that can contain agent output and must not be
 * persisted verbatim. Returns '' when the failure carries no issues.
 */
export function describeSchemaIssues(cause: unknown, limit = 3): string {
  const issues = (cause as { issues?: unknown } | null | undefined)?.issues;
  if (!Array.isArray(issues)) return '';
  return issues
    .slice(0, limit)
    .map((issue: { path?: unknown; code?: unknown }) => {
      const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
      return (path.length === 0 ? '(root)' : path) + ' [' + String(issue.code ?? 'invalid') + ']';
    })
    .join('; ');
}

/**
 * Bounded reason a planning attempt was rejected: the rejected fields for a
 * schema failure, otherwise the (already redacted) failure message, whitespace
 * collapsed and cut. Returns 'empty response' for a blank answer.
 */
export function describePlanRejection(cause: unknown, empty = false): string {
  if (empty) return 'empty response';
  const fields = describeSchemaIssues(cause);
  if (fields.length > 0) return fields;
  const message = (cause as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' ? message.replace(/\s+/g, ' ').trim().slice(0, 160) : 'unknown';
}
