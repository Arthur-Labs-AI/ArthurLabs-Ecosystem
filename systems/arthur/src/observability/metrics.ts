/**
 * Metrics interface + in-memory implementation (spec section 17).
 *
 * Counters/timers sit behind `Metrics` so they can later be exported to an
 * observability system without changing call sites.
 */

export interface Metrics {
  counter(name: string, value?: number, tags?: Record<string, string>): void;
  timer(name: string, ms: number, tags?: Record<string, string>): void;
  snapshot(): MetricsSnapshot;
}

export interface MetricsSnapshot {
  counters: Record<string, { count: number; value: number }>;
  timers: Record<string, { count: number; total_ms: number; last_ms: number }>;
}

function metricKey(name: string, tags?: Record<string, string>): string {
  if (!tags || Object.keys(tags).length === 0) return name;
  const suffix = Object.entries(tags)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  return `${name}{${suffix}}`;
}

export class InMemoryMetrics implements Metrics {
  private counters = new Map<string, { count: number; value: number }>();
  private timers = new Map<string, { count: number; total_ms: number; last_ms: number }>();

  counter(name: string, value = 1, tags?: Record<string, string>): void {
    const key = metricKey(name, tags);
    const cur = this.counters.get(key) ?? { count: 0, value: 0 };
    cur.count += 1;
    cur.value += value;
    this.counters.set(key, cur);
  }

  timer(name: string, ms: number, tags?: Record<string, string>): void {
    const key = metricKey(name, tags);
    const cur = this.timers.get(key) ?? { count: 0, total_ms: 0, last_ms: 0 };
    cur.count += 1;
    cur.total_ms += ms;
    cur.last_ms = ms;
    this.timers.set(key, cur);
  }

  snapshot(): MetricsSnapshot {
    const counters: Record<string, { count: number; value: number }> = {};
    for (const [k, v] of this.counters) counters[k] = { ...v };
    const timers: Record<string, { count: number; total_ms: number; last_ms: number }> = {};
    for (const [k, v] of this.timers) timers[k] = { ...v };
    return { counters, timers };
  }
}
