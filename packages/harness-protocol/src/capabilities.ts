export { HarnessCapabilitiesSchema, type HarnessCapabilities } from './metadata.js';

/** Minimal capability set for a fake/test adapter. */
export const FAKE_ADAPTER_CAPABILITIES = {
  streaming: true,
  cancellation: true,
  filesystemRead: true,
  filesystemWrite: false,
  shell: false,
  browser: false,
  sessionResume: false,
  structuredOutput: true,
  usageReporting: true,
} as const;
