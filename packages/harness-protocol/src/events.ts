/**
 * Event-stream helpers: validated NDJSON encode/decode for golden
 * fixtures today and the future NDJSON worker transport.
 */
import { HarnessEventSchema, type HarnessEvent } from '@qa/schemas';

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
      throw new Error('Invalid NDJSON on line ' + (i + 1) + ': not JSON');
    }
    const parsed = HarnessEventSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        'Invalid HarnessEvent on line ' +
          (i + 1) +
          ': ' +
          parsed.error.issues.map((x) => x.path.join('.') + ' ' + x.message).join('; '),
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
