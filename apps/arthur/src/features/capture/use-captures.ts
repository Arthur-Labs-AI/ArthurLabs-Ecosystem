import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Capture, MicrophonePermissionState, VoiceCaptureErrorCode } from "@arthur/contracts";
import { VoiceCaptureError } from "../../client/arthur-client";
import { useArthurClient } from "../../hooks/use-arthur-client";
import { useProjects } from "../projects/projects-context";

export type VoiceState = "idle" | "starting" | "recording" | "transcribing";

/** Why the last voice attempt failed. `message` is safe to show; `code` lets a screen explain what happens next. */
export interface VoiceFailure {
  code: VoiceCaptureErrorCode;
  message: string;
}

export interface CapturesState {
  status: "loading" | "ready" | "error";
  captures: Capture[];
  saving: boolean;
  /** Last load, save or voice failure. Cleared by the next successful operation. */
  error: string | null;
  /** The last voice failure, until the next voice attempt, save or `dismissVoiceFailure`. Mirrors `error` for voice only. */
  voiceFailure: VoiceFailure | null;
  dismissVoiceFailure: () => void;
  /**
   * The microphone permission as the platform reports it, read without asking (see `ArthurClient.getMicrophonePermission`).
   * Refreshed on launch, when the app comes back to the foreground (for example from the system settings), and after
   * every start attempt. `unknown` until the first answer, and on platforms without voice.
   */
  micPermission: MicrophonePermissionState;
  /** True when recording can start immediately, with no dialog. */
  micKnownGranted: boolean;
  /** Opens this app's page in the system settings, where a permanently refused microphone can be allowed. */
  openAppSettings: () => Promise<void>;
  /**
   * Transcribes again the recording that was kept after a retryable failure (`voiceFailure.code === "stt_retryable"`),
   * without recording again.
   */
  retryVoice: () => Promise<void>;
  /** Deletes the recording kept for a retry, and clears the failure that offered it. */
  discardVoice: () => Promise<void>;
  /** Discards an in-progress recording without transcribing it. */
  cancelVoice: () => Promise<void>;
  /**
   * A capture by id: from the active project's list, or from the ones fetched by `ensure`. Provenance needs this because
   * an idea can live in a different project than the Capture it came from.
   */
  captureOf: (captureId: string) => Capture | undefined;
  /** Fetches (in ONE request) the captures among `captureIds` that are not in the active project's list, once each. */
  ensure: (captureIds: readonly string[]) => void;
  /** Resolves true when the capture was durably saved. */
  save: (content: string) => Promise<boolean>;
  voiceState: VoiceState;
  startVoice: () => Promise<void>;
  /** Stops recording and waits for the transcript to be saved as a capture. */
  stopVoice: () => Promise<void>;
  /**
   * Runs `listener` once for every capture that was durably saved (typed or voice), AFTER it is persisted and shown.
   * A listener can never fail or delay a capture: its errors are swallowed here. Returns the unsubscribe function.
   */
  subscribe: (listener: (capture: Capture) => void) => () => void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const failureOf = (error: unknown): VoiceFailure => ({ code: error instanceof VoiceCaptureError ? error.code : "capture_failed", message: messageOf(error) });

export function useCapturesState(): CapturesState {
  const client = useArthurClient();
  const { activeProjectId, dataVersion } = useProjects();
  // The project a capture is made in is the one active when it is made, read at that moment (not at render time).
  const activeRef = useRef<string | null>(activeProjectId);
  activeRef.current = activeProjectId;
  const shownScope = useRef<string | null>(null);
  /** The active project now. Normally already known; a capture made before the first read finishes asks the store itself. */
  const currentProjectId = useCallback(async (): Promise<string> => activeRef.current ?? (await client.getActiveProject()).id, [client]);
  const [status, setStatus] = useState<CapturesState["status"]>("loading");
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceFailure, setVoiceFailure] = useState<VoiceFailure | null>(null);
  // Mirrors "a recording is kept for a retry", so leaving the retry flow by any route can delete it.
  const keptRef = useRef(false);
  const [micPermission, setMicPermission] = useState<MicrophonePermissionState>("unknown");
  // Mirrors `voiceState` so event handlers and cleanup see the current value.
  const voiceRef = useRef<VoiceState>("idle");
  const changeVoiceState = useCallback((next: VoiceState) => {
    voiceRef.current = next;
    setVoiceState(next);
  }, []);

  useEffect(() => {
    // Captures are scoped to the active project; wait until it is known.
    if (activeProjectId === null) return;
    let cancelled = false;
    if (shownScope.current !== activeProjectId) {
      shownScope.current = activeProjectId;
      setCaptures([]); // never show the previous project's captures while this one loads
    }
    setStatus("loading");
    client.listCaptures({ projectId: activeProjectId }).then(
      (loaded) => {
        if (cancelled) return;
        setCaptures(loaded);
        setError(null);
        setStatus("ready");
      },
      (failure: unknown) => {
        if (cancelled) return;
        setError(messageOf(failure));
        setStatus("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, activeProjectId, dataVersion]);

  // The permission is only ever READ here: reading must never prompt. It is re-read when the app returns to the
  // foreground, which is how a user who just allowed the microphone in the system settings is noticed.
  const refreshMicPermission = useCallback(async () => {
    if (!client.capabilities.voiceCapture) return;
    try {
      setMicPermission(await client.getMicrophonePermission());
    } catch {
      /* an unreadable permission is the same as an unknown one */
    }
  }, [client]);
  useEffect(() => {
    void refreshMicPermission();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshMicPermission();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refreshMicPermission]);

  useEffect(() => {
    keptRef.current = voiceFailure?.code === "stt_retryable";
  }, [voiceFailure]);

  // A refusal that has since been undone (the user allowed the microphone in the system settings) is no longer true.
  useEffect(() => {
    if (micPermission === "granted") setVoiceFailure((current) => (current?.code === "microphone_permission_denied" ? null : current));
  }, [micPermission]);

  const [others, setOthers] = useState<ReadonlyMap<string, Capture>>(new Map());
  const asked = useRef(new Set<string>());
  const byId = useMemo(() => new Map(captures.map((capture) => [capture.id, capture])), [captures]);
  const captureOf = useCallback((captureId: string) => byId.get(captureId) ?? others.get(captureId), [byId, others]);
  const ensure = useCallback(
    (captureIds: readonly string[]) => {
      // Until the active project's own list has loaded, "missing" would just mean "not loaded yet".
      if (status !== "ready") return;
      const missing = [...new Set(captureIds)].filter((id) => !byId.has(id) && !asked.current.has(id));
      if (missing.length === 0) return;
      for (const id of missing) asked.current.add(id);
      client.getCaptures(missing).then(
        (found) => setOthers((current) => new Map([...current, ...found.map((capture): [string, Capture] => [capture.id, capture])])),
        () => missing.forEach((id) => asked.current.delete(id)),
      );
    },
    [client, byId, status],
  );

  const listeners = useRef(new Set<(capture: Capture) => void>());
  const subscribe = useCallback((listener: (capture: Capture) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const addCapture = useCallback((created: Capture) => {
    // A capture finished after the user switched project belongs to the project it was made in: it is not shown in this one.
    if (created.projectId === activeRef.current) setCaptures((current) => [created, ...current]);
    setError(null);
    setVoiceFailure(null);
    setStatus("ready");
    // The capture is persisted and visible. Whatever follows (auto-organizing) must never be able to undo or fail it.
    for (const listener of [...listeners.current]) {
      try {
        listener(created);
      } catch {
        /* a subscriber's problem is not the capture's */
      }
    }
  }, []);

  const save = useCallback(
    async (content: string): Promise<boolean> => {
      setSaving(true);
      try {
        const wasKept = keptRef.current;
        addCapture(await client.createCapture({ source: "text", content, projectId: await currentProjectId() }));
        if (wasKept) void client.discardVoiceRecording().catch(() => undefined); // typing it instead leaves the retry flow
        return true;
      } catch (failure) {
        setError(messageOf(failure));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [client, addCapture, currentProjectId],
  );

  const startVoice = useCallback(async () => {
    if (voiceRef.current !== "idle") return;
    changeVoiceState("starting");
    setError(null);
    setVoiceFailure(null);
    try {
      await client.startVoiceCapture();
      setMicPermission("granted");
      changeVoiceState("recording");
    } catch (failure) {
      setError(messageOf(failure));
      const reason = failureOf(failure);
      setVoiceFailure(reason);
      changeVoiceState("idle");
      if (reason.code === "microphone_permission_denied") void refreshMicPermission();
    }
  }, [client, changeVoiceState, refreshMicPermission]);

  const stopVoice = useCallback(async () => {
    if (voiceRef.current !== "recording") return;
    changeVoiceState("transcribing");
    try {
      addCapture(await client.finishVoiceCapture(await currentProjectId()));
    } catch (failure) {
      setError(messageOf(failure));
      setVoiceFailure(failureOf(failure));
    } finally {
      changeVoiceState("idle");
    }
  }, [client, addCapture, changeVoiceState, currentProjectId]);

  const retryVoice = useCallback(async () => {
    if (voiceRef.current !== "idle") return;
    changeVoiceState("transcribing");
    setError(null);
    setVoiceFailure(null);
    try {
      addCapture(await client.retryVoiceTranscription(await currentProjectId()));
    } catch (failure) {
      setError(messageOf(failure));
      setVoiceFailure(failureOf(failure));
    } finally {
      changeVoiceState("idle");
    }
  }, [client, addCapture, changeVoiceState, currentProjectId]);

  const discardVoice = useCallback(async () => {
    setVoiceFailure((current) => (current?.code === "stt_retryable" ? null : current));
    setError(null);
    await client.discardVoiceRecording().catch(() => undefined);
  }, [client]);

  const openAppSettings = useCallback(async () => {
    try {
      await client.openAppSettings();
    } catch (failure) {
      setError(messageOf(failure));
    }
  }, [client]);

  const cancelVoice = useCallback(async () => {
    if (voiceRef.current !== "recording") return;
    changeVoiceState("idle");
    await client.cancelVoiceCapture().catch(() => undefined);
  }, [client, changeVoiceState]);

  const dismissVoiceFailure = useCallback(() => {
    // Dismissing the retry card is leaving the retry flow: the kept recording goes with it.
    if (keptRef.current) void client.discardVoiceRecording().catch(() => undefined);
    setVoiceFailure(null);
  }, [client]);

  // Recording never continues in the background: if the screen is left or hidden, discard it.
  useEffect(() => {
    const discard = () => {
      if (voiceRef.current !== "recording") return;
      changeVoiceState("idle");
      setError("Recording stopped because Arthur left the foreground. Nothing was saved.");
      setVoiceFailure({ code: "recording_interrupted", message: "Recording stopped because Arthur left the foreground. Nothing was saved." });
      void client.cancelVoiceCapture().catch(() => undefined);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") discard();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (voiceRef.current === "recording") void client.cancelVoiceCapture().catch(() => undefined);
    };
  }, [client, changeVoiceState]);

  return { status, captures, captureOf, ensure, saving, error, save, voiceState, startVoice, stopVoice, voiceFailure, dismissVoiceFailure, micPermission, micKnownGranted: micPermission === "granted", openAppSettings, retryVoice, discardVoice, cancelVoice, subscribe };
}
