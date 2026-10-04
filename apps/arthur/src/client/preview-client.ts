import { describeCreateCaptureInputProblem, type Capture, type CreateCaptureInput, type RuntimeInfo } from "@arthur/contracts";
import { VoiceCaptureError, type ArthurClient } from "./arthur-client";

const DEFAULT_PREVIEW_INFO: RuntimeInfo = { appVersion: "0.0.0-preview", platform: "unknown" };

export interface PreviewVoiceOptions {
  /** Transcript the fake speech service "hears". Default: a fixed sentence. */
  transcript?: () => string;
  /** Make `startVoiceCapture` fail, e.g. to simulate a denied microphone permission. */
  startError?: VoiceCaptureError;
  /** Make `finishVoiceCapture` fail, e.g. to simulate a network failure. */
  finishError?: VoiceCaptureError;
}

export interface PreviewClientOptions {
  info?: RuntimeInfo;
  voice?: PreviewVoiceOptions;
  /** Injectable for deterministic tests. */
  newId?: () => string;
  now?: () => Date;
}

/** Native-free client for `vite dev` in a plain browser and for tests. Everything lives in memory only. */
export function createPreviewClient(options: PreviewClientOptions = {}): ArthurClient {
  const info = options.info ?? DEFAULT_PREVIEW_INFO;
  const newId = options.newId ?? (() => globalThis.crypto.randomUUID());
  const now = options.now ?? (() => new Date());
  const voice = options.voice ?? {};
  const captures: Capture[] = [];
  let recording = false;

  const append = (input: CreateCaptureInput): Capture => {
    const capture: Capture = { id: newId(), source: input.source, content: input.content, createdAt: now().toISOString() };
    captures.unshift(capture);
    return capture;
  };

  return {
    kind: "preview",
    capabilities: { voiceCapture: true },
    getRuntimeInfo: () => Promise.resolve(info),
    createCapture: (input) => {
      const problem = describeCreateCaptureInputProblem(input);
      if (problem) return Promise.reject(new Error(`Invalid capture: ${problem}`));
      return Promise.resolve(append(input));
    },
    listCaptures: () => Promise.resolve([...captures]),

    startVoiceCapture: () => {
      if (recording) return Promise.reject(new VoiceCaptureError("already_recording", "A recording is already in progress."));
      if (voice.startError) return Promise.reject(voice.startError);
      recording = true;
      return Promise.resolve();
    },
    finishVoiceCapture: () => {
      if (!recording) return Promise.reject(new VoiceCaptureError("not_recording", "There is no recording in progress."));
      recording = false;
      if (voice.finishError) return Promise.reject(voice.finishError);
      const transcript = (voice.transcript?.() ?? "Preview voice capture.").trim();
      if (transcript.length === 0) {
        return Promise.reject(new VoiceCaptureError("empty_transcript", "No speech was recognised. Nothing was saved."));
      }
      return Promise.resolve(append({ source: "voice", content: transcript }));
    },
    cancelVoiceCapture: () => {
      recording = false;
      return Promise.resolve();
    },
  };
}
