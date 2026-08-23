/**
 * Safe audio device enumeration (Phase 3 spec sections 24, 41).
 *
 * Only minimal, safe metadata is exposed: kind + id + a generic label.
 * No OS internals, hardware identifiers, or private details.
 */

import { VoiceSettings } from "../config";

export type AudioDeviceKind = "input" | "output";

export interface AudioDeviceInfo {
  id: string;
  kind: AudioDeviceKind;
  label: string;
}

export interface AudioDeviceRegistry {
  listInputs(): AudioDeviceInfo[];
  listOutputs(): AudioDeviceInfo[];
  /** Resolve a configured id to safe metadata (default = first match). */
  resolve(kind: AudioDeviceKind, deviceId: string): AudioDeviceInfo | undefined;
}

export class ConfigDeviceRegistry implements AudioDeviceRegistry {
  constructor(private readonly settings: VoiceSettings) {}

  listInputs(): AudioDeviceInfo[] {
    const items: AudioDeviceInfo[] = [{ id: "default", kind: "input", label: "default input" }];
    if (this.settings.audioInputDevice !== "default") {
      items.push({ id: this.settings.audioInputDevice, kind: "input", label: "configured input" });
    }
    return items;
  }

  listOutputs(): AudioDeviceInfo[] {
    const items: AudioDeviceInfo[] = [{ id: "default", kind: "output", label: "default output" }];
    if (this.settings.audioOutputDevice !== "default") {
      items.push({ id: this.settings.audioOutputDevice, kind: "output", label: "configured output" });
    }
    return items;
  }

  resolve(kind: AudioDeviceKind, deviceId: string): AudioDeviceInfo | undefined {
    if (deviceId === "default") {
      return { id: "default", kind, label: kind === "input" ? "default input" : "default output" };
    }
    const list = kind === "input" ? this.listInputs() : this.listOutputs();
    return list.find((d) => d.id === deviceId);
  }
}
