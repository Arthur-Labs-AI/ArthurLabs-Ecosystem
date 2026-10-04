import { useCallback, useEffect, useRef, useState } from "react";
import type { Capture } from "@arthur/contracts";
import { useArthurClient } from "../../hooks/use-arthur-client";

export type VoiceState = "idle" | "starting" | "recording" | "transcribing";

export interface CapturesState {
  status: "loading" | "ready" | "error";
  captures: Capture[];
  saving: boolean;
  /** Last load, save or voice failure. Cleared by the next successful operation. */
  error: string | null;
  /** Resolves true when the capture was durably saved. */
  save: (content: string) => Promise<boolean>;
  voiceState: VoiceState;
  startVoice: () => Promise<void>;
  /** Stops recording and waits for the transcript to be saved as a capture. */
  stopVoice: () => Promise<void>;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function useCaptures(): CapturesState {
  const client = useArthurClient();
  const [status, setStatus] = useState<CapturesState["status"]>("loading");
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  // Mirrors `voiceState` so event handlers and cleanup see the current value.
  const voiceRef = useRef<VoiceState>("idle");
  const changeVoiceState = useCallback((next: VoiceState) => {
    voiceRef.current = next;
    setVoiceState(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    client.listCaptures().then(
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
  }, [client]);

  const addCapture = useCallback((created: Capture) => {
    setCaptures((current) => [created, ...current]);
    setError(null);
    setStatus("ready");
  }, []);

  const save = useCallback(
    async (content: string): Promise<boolean> => {
      setSaving(true);
      try {
        addCapture(await client.createCapture({ source: "text", content }));
        return true;
      } catch (failure) {
        setError(messageOf(failure));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [client, addCapture],
  );

  const startVoice = useCallback(async () => {
    if (voiceRef.current !== "idle") return;
    changeVoiceState("starting");
    setError(null);
    try {
      await client.startVoiceCapture();
      changeVoiceState("recording");
    } catch (failure) {
      setError(messageOf(failure));
      changeVoiceState("idle");
    }
  }, [client, changeVoiceState]);

  const stopVoice = useCallback(async () => {
    if (voiceRef.current !== "recording") return;
    changeVoiceState("transcribing");
    try {
      addCapture(await client.finishVoiceCapture());
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      changeVoiceState("idle");
    }
  }, [client, addCapture, changeVoiceState]);

  // Recording never continues in the background: if the screen is left or hidden, discard it.
  useEffect(() => {
    const discard = () => {
      if (voiceRef.current !== "recording") return;
      changeVoiceState("idle");
      setError("Recording stopped because Arthur left the foreground. Nothing was saved.");
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

  return { status, captures, saving, error, save, voiceState, startVoice, stopVoice };
}
