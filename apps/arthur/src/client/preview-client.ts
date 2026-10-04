import {
  describeCreateCaptureInputProblem,
  describeSpanProblem,
  sliceCodePoints,
  type Capture,
  type CreateCaptureInput,
  type KnowledgeObject,
  type KnowledgeObjectKind,
  type RuntimeInfo,
} from "@arthur/contracts";
import { DistillationError, VoiceCaptureError, type ArthurClient } from "./arthur-client";

const DEFAULT_PREVIEW_INFO: RuntimeInfo = { appVersion: "0.0.0-preview", platform: "unknown" };

export interface PreviewVoiceOptions {
  /** Transcript the fake speech service "hears". Default: a fixed sentence. */
  transcript?: () => string;
  /** Make `startVoiceCapture` fail, e.g. to simulate a denied microphone permission. */
  startError?: VoiceCaptureError;
  /** Make `finishVoiceCapture` fail, e.g. to simulate a network failure. */
  finishError?: VoiceCaptureError;
}

/** What the fake language model proposes. `evidence` must be a verbatim quote of the capture. */
export interface PreviewCandidate {
  kind: KnowledgeObjectKind;
  title: string;
  body: string;
  evidence: string;
}

export interface PreviewDistillationOptions {
  /** Default: one `note` covering the whole capture. */
  candidates?: (capture: Capture) => PreviewCandidate[];
  /** Make `distillCapture` fail, e.g. to simulate a provider error. Cleared after one use when `once` is true. */
  error?: DistillationError;
  once?: boolean;
}

export interface PreviewClientOptions {
  info?: RuntimeInfo;
  voice?: PreviewVoiceOptions;
  distillation?: PreviewDistillationOptions;
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
  const distillation = { ...options.distillation };
  const captures: Capture[] = [];
  /** Newest distillation first, like the native store. Zero-object runs are remembered too. */
  const runs: { captureId: string; objects: KnowledgeObject[] }[] = [];
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

    distillCapture: (captureId) => {
      const capture = captures.find((candidate) => candidate.id === captureId);
      if (!capture) return Promise.reject(new DistillationError("capture_not_found", "That capture no longer exists."));
      const existing = runs.find((run) => run.captureId === captureId);
      if (existing) return Promise.resolve([...existing.objects]);

      if (distillation.error) {
        const failure = distillation.error;
        if (distillation.once) delete distillation.error;
        return Promise.reject(failure);
      }

      const proposed = distillation.candidates?.(capture) ?? [
        { kind: "note" as const, title: sliceCodePoints(capture.content.trim(), 0, 60), body: capture.content.trim(), evidence: capture.content.trim() },
      ];
      const objects: KnowledgeObject[] = [];
      const characters = [...capture.content];
      for (const candidate of proposed) {
        // Same rule as the native resolver: the evidence must be found verbatim in the raw text.
        const needle = [...candidate.evidence.trim()];
        let start = -1;
        for (let from = 0; from + needle.length <= characters.length; from += 1) {
          if (needle.every((character, offset) => characters[from + offset] === character)) {
            start = from;
            break;
          }
        }
        const end = start + needle.length;
        if (needle.length === 0 || start < 0 || describeSpanProblem(capture.content, start, end) !== null) {
          return Promise.reject(new DistillationError("llm_invalid_output", "The language model returned something that could not be trusted. Nothing was saved."));
        }
        objects.push({
          id: newId(),
          kind: candidate.kind,
          title: candidate.title.trim(),
          body: candidate.body.trim(),
          createdAt: now().toISOString(),
          provenance: { captureId, sourceStart: start, sourceEnd: end },
        });
      }
      objects.sort((a, b) => a.provenance.sourceStart - b.provenance.sourceStart);
      runs.unshift({ captureId, objects });
      return Promise.resolve([...objects]);
    },
    listKnowledgeObjects: () => Promise.resolve(runs.flatMap((run) => run.objects)),
  };
}

