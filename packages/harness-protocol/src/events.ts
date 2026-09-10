/**
 * Event-stream helpers: validated NDJSON encode/decode for golden
 * fixtures today and the future NDJSON worker transport.
 */
import { HarnessEventSchema, type HarnessEvent } from '@qa/schemas';
import { HarnessProtocolError } from './errors.js';

export function encodeEventsNdjson(events: readonly HarnessEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + (events.length > 0 ? '\n' : '');
}

export function decodeEventsNdjson(ndjson: string): HarnessEvent[] {
  const lines = ndjson
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.map((line, i) => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new HarnessProtocolError('INVALID_NDJSON', 'Invalid NDJSON on line ' + (i + 1), {
        line: i + 1,
      });
    }
    const parsed = HarnessEventSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HarnessProtocolError(
        'INVALID_HARNESS_EVENT',
        'Invalid HarnessEvent on line ' +
          (i + 1) +
          ': ' +
          parsed.error.issues
            .slice(0, 5)
            .map((x) => x.path.join('.') + ' ' + x.message)
            .join('; '),
        { line: i + 1 },
      );
    }
    return parsed.data;
  });
}

export async function collectEvents(stream: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

export function eventTypes(events: readonly HarnessEvent[]): string[] {
  return events.map((e) => e.type);
}
