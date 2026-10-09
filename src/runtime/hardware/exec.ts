/**
 * HR-02.5A: bounded trusted-command runner for hardware probing.
 *
 * Safety properties:
 * - Only hardcoded trusted argv arrays from the platform collectors below
 *   are ever executed. There is no configuration input, no model input, and
 *   no string interpolation anywhere in this path.
 * - No shell is used (`shell: false`, argv arrays via execFile).
 * - Every invocation is bounded by a timeout and a max output buffer; slow
 *   or chatty commands degrade to `{ ok: false }` instead of hanging or
 *   exhausting memory.
 * - Failures (missing binary, timeout, non-zero exit, oversized/garbled
 *   output) are non-fatal by design: collectors map them to unknown or
 *   unavailable field-by-field.
 */

import { execFile } from "node:child_process";

export const PROBE_TIMEOUT_MS = 5000;
export const PROBE_MAX_BUFFER_BYTES = 256 * 1024;

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Injectable exec seam: production uses execFile; tests inject fakes. */
export type ExecFn = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number; maxBufferBytes: number },
) => Promise<ExecResult>;

export function nodeExecFn(): ExecFn {
  return (file, args, options) =>
    new Promise<ExecResult>((resolve) => {
      execFile(
        file,
        [...args],
        {
          timeout: options.timeoutMs,
          maxBuffer: options.maxBufferBytes,
          windowsHide: true,
          shell: false,
        },
        (error, stdout, stderr) => {
          if (error) {
            resolve({ ok: false, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
            return;
          }
          resolve({ ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        },
      );
    });
}

/**
 * Run one trusted command and truncate its captured output to a defensive
 * bound. Output is truncated rather than rejected so collectors can still
 * parse the leading (most significant) section.
 */
export async function runBounded(
  exec: ExecFn,
  file: string,
  args: readonly string[],
  timeoutMs: number = PROBE_TIMEOUT_MS,
  maxBufferBytes: number = PROBE_MAX_BUFFER_BYTES,
): Promise<ExecResult> {
  let result: ExecResult;
  try {
    result = await exec(file, args, { timeoutMs, maxBufferBytes });
  } catch {
    return { ok: false, stdout: "", stderr: "" };
  }
  if (typeof result.stdout !== "string") result = { ...result, ok: false, stdout: "" };
  if (typeof result.stderr !== "string") result = { ...result, ok: false, stderr: "" };
  if (result.stdout.length > maxBufferBytes) {
    result = { ...result, stdout: result.stdout.slice(0, maxBufferBytes) };
  }
  if (result.stderr.length > maxBufferBytes) {
    result = { ...result, stderr: result.stderr.slice(0, maxBufferBytes) };
  }
  return result;
}

/** Split command output into trimmed, non-empty lines (defensively capped). */
export function outputLines(output: string, maxLines = 256): string[] {
  if (typeof output !== "string" || output.length === 0) return [];
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, maxLines);
}
