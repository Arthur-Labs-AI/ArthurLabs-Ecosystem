/**
 * Structured JSON logger (spec section 17).
 *
 * Emits one JSON object per line with timestamp, level, component, and optional
 * correlation fields. Known secrets are redacted defensively at the boundary.
 */

import { redactDeep, redactText } from "../security/redaction";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  trace_id?: string;
  session_id?: string;
  turn_id?: string;
  [key: string]: unknown;
}

export class Logger {
  private readonly threshold: number;
  private readonly secrets: readonly string[];

  constructor(level: string, secrets: readonly string[] = [], private readonly component = "arthur") {
    const normalized = level.toLowerCase() as LogLevel;
    this.threshold = LEVEL_ORDER[normalized] ?? LEVEL_ORDER.info;
    this.secrets = secrets;
  }

  child(component: string): Logger {
    return new Logger(this.levelName(), this.secrets, component);
  }

  private levelName(): string {
    for (const [name, order] of Object.entries(LEVEL_ORDER)) {
      if (order === this.threshold) return name;
    }
    return "info";
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < this.threshold) return;
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      component: this.component,
      msg: redactText(message, this.secrets),
    };
    if (fields) {
      const redacted = redactDeep(fields, this.secrets) as Record<string, unknown>;
      Object.assign(entry, redacted);
    }
    // Structured logs go to stderr so primary output (CLI text, API bodies) is
    // never polluted. Fall back gracefully if stderr is unavailable.
    try {
      process.stderr.write(`${JSON.stringify(entry)}\n`);
    } catch {
      // no-op: never let logging break the request path.
    }
  }

  debug(message: string, fields?: LogFields): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write("error", message, fields);
  }
}
