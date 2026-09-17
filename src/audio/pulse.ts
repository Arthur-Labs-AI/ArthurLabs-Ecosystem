/**
 * FRS-03.1: Pulse/PipeWire source-list parser (pure, deterministic).
 *
 * Preferred discovery is the structured JSON of:
 *
 *   pactl -f json list sources
 *
 * because it avoids parsing human-formatted text. Each entry contributes
 * a stable Pulse/PipeWire source NAME (never the transient numeric
 * index); the human DESCRIPTION becomes the label. Monitor sources
 * ("*.monitor" or device.class === "monitor") are output-monitor
 * loopbacks, not physical microphones, and are excluded by default.
 *
 * Bounded: input size, entry count, and name length are capped;
 * malformed entries are skipped, never fatal. Device names are
 * untrusted local strings — validation of command safety happens in
 * commands.ts, not here.
 */

import type { AudioDevice } from './backend';

/** Hard bounds for discovery parsing (never unbounded). */
export const PULSE_MAX_INPUT_CHARS = 1024 * 1024;
export const PULSE_MAX_DEVICES = 64;
export const PULSE_MAX_NAME_CHARS = 256;

interface PulseSourceEntry {
  name?: unknown;
  description?: unknown;
  properties?: unknown;
}

function propertiesOf(entry: PulseSourceEntry): Record<string, unknown> {
  if (entry.properties !== null && typeof entry.properties === 'object' && !Array.isArray(entry.properties)) {
    return entry.properties as Record<string, unknown>;
  }
  return {};
}

function isMonitorSource(name: string, properties: Record<string, unknown>): boolean {
  if (name.endsWith('.monitor')) return true;
  const deviceClass = properties['device.class'];
  if (typeof deviceClass === 'string' && deviceClass.toLowerCase() === 'monitor') return true;
  const mediaClass = properties['media.class'];
  if (typeof mediaClass === 'string' && mediaClass.toLowerCase().indexOf('monitor') !== -1) return true;
  return false;
}

/**
 * Parse `pactl -f json list sources` output into microphone devices.
 * `backend` tags every returned device. Monitor loopbacks are excluded.
 * Duplicates (same stable name) are preserved in discovery order so the
 * operator can distinguish repeated hardware; over-limit entries dropped.
 * Malformed JSON or non-array shapes yield [] (never throw).
 */
export function parsePulseAudioSources(output: string, backend: string): AudioDevice[] {
  const text = output.length > PULSE_MAX_INPUT_CHARS ? output.slice(0, PULSE_MAX_INPUT_CHARS) : output;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed) ? parsed : [];
  const devices: AudioDevice[] = [];
  for (const raw of entries) {
    if (devices.length >= PULSE_MAX_DEVICES) break;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as PulseSourceEntry;
    const name = entry.name;
    if (typeof name !== 'string' || name.length === 0 || name.length > PULSE_MAX_NAME_CHARS) continue;
    if (name.indexOf(String.fromCharCode(0)) !== -1) continue;
    const properties = propertiesOf(entry);
    if (isMonitorSource(name, properties)) continue;
    const description = entry.description;
    const label = typeof description === 'string' && description.trim() !== '' ? description.slice(0, PULSE_MAX_NAME_CHARS) : name;
    devices.push({ id: name, label, backend });
  }
  return devices;
}

/**
 * Parse `pactl list short sources` fallback text (tab-separated
 * "index <name> <driver> ..."). Monitor sources excluded by the same
 * rule; numeric indices never persisted. Returns [] on any malformed
 * input rather than throwing.
 */
export function parsePulseShortSources(output: string, backend: string): AudioDevice[] {
  const text = output.length > PULSE_MAX_INPUT_CHARS ? output.slice(0, PULSE_MAX_INPUT_CHARS) : output;
  const devices: AudioDevice[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (devices.length >= PULSE_MAX_DEVICES) break;
    const line = rawLine.trim();
    if (line === '') continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const name = parts[1] as string;
    if (name.length === 0 || name.length > PULSE_MAX_NAME_CHARS) continue;
    if (name.indexOf(String.fromCharCode(0)) !== -1) continue;
    if (isMonitorSource(name, {})) continue;
    devices.push({ id: name, label: name, backend });
  }
  return devices;
}
