/**
 * Bounds one tool output for the event stream and the evidence digest.
 *
 * The decisive part of a command output (the failing assertion, the stack
 * trace, the final summary line) is at its END, so a plain head slice
 * discards exactly what a reviewer needs. This keeps a short head and the
 * tail, strips terminal control codes and progress-bar noise, and says how
 * much was omitted. Output that already fits is returned unchanged apart
 * from the noise strip.
 */

const ANSI_ESCAPE = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[A-Za-z]', 'g');
/** pnpm/npm/pip/cargo style progress lines carry no evidence and flood the budget. */
const PROGRESS_LINE =
  /^\s*(?:Progress:\s|Downloading\s|Fetching\s|Resolving\s|\[?[#=>.\-\s]{12,}\]?\s*\d*%?\s*$|[+-]{12,}\s*$|Packages:\s+[+-])/;

export interface ToolOutputBounds {
  /** Total characters returned at most (marker included). */
  readonly limit: number;
  /** Characters kept from the start when the output is cut. */
  readonly head: number;
}

export const TOOL_OUTPUT_DEFAULT_BOUNDS: ToolOutputBounds = { limit: 1800, head: 500 };

/** Terminal noise removed; consecutive duplicate lines collapsed with a count. */
export function stripToolOutputNoise(output: string): string {
  const lines = output.replace(ANSI_ESCAPE, '').replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  let repeats = 0;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (PROGRESS_LINE.test(line)) continue;
    const previous = kept[kept.length - 1];
    if (previous !== undefined && previous === line && line.length > 0) {
      repeats += 1;
      continue;
    }
    if (repeats > 0) {
      kept.push(
        '  (previous line repeated ' + repeats + ' more time' + (repeats === 1 ? '' : 's') + ')',
      );
      repeats = 0;
    }
    kept.push(line);
  }
  if (repeats > 0)
    kept.push(
      '  (previous line repeated ' + repeats + ' more time' + (repeats === 1 ? '' : 's') + ')',
    );
  return kept.join('\n').trim();
}

export function compactToolOutput(
  output: string,
  bounds: ToolOutputBounds = TOOL_OUTPUT_DEFAULT_BOUNDS,
): string {
  const text = stripToolOutputNoise(output);
  if (text.length <= bounds.limit) return text;
  const head = Math.min(bounds.head, Math.floor(bounds.limit / 3));
  // The marker states the omitted count; reserve room for its digits so the
  // result never exceeds the limit.
  const markerFor = (omitted: number): string => '\n…[' + omitted + ' characters omitted]…\n';
  const reserve = markerFor(text.length).length;
  const tail = Math.max(0, bounds.limit - head - reserve);
  const omitted = text.length - head - tail;
  return text.slice(0, head) + markerFor(omitted) + text.slice(text.length - tail);
}
