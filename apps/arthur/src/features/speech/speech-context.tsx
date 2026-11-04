import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SpeechStatus } from "@arthur/contracts";
import { useArthurClient } from "../../hooks/use-arthur-client";
import { SPEECH_FAILURE_MESSAGE } from "./speech-copy";

/** How often the status of a playing session is read. Only runs while something is being spoken. */
const POLL_MS = 350;

export interface SourceSpeech {
  /** This source's session is being prepared or played. */
  active: boolean;
  preparing: boolean;
  /** Text was left out of a long answer. */
  truncated: boolean;
  /** A bounded, fixed message for the last failure of THIS source, or null. */
  error: string | null;
  speak: (text: string) => Promise<void>;
  /** Speaks the short fixed test sentence (Settings only). */
  test: () => Promise<void>;
  stop: () => Promise<void>;
  /** The latest session's first-chunk timings, once audible. */
  status: SpeechStatus | null;
}

interface Session {
  source: string;
  sessionId: number | null;
}

interface SpeechContextValue {
  session: Session | null;
  status: SpeechStatus | null;
  errors: Record<string, string | null>;
  start: (source: string, begin: () => Promise<{ sessionId: number }>) => Promise<void>;
  stop: (source: string) => Promise<void>;
}

const SpeechContext = createContext<SpeechContextValue | null>(null);

const messageOf = (failure: unknown): string => (failure instanceof Error ? failure.message : "Couldn’t start speaking.");

/**
 * One speaker for the whole app. The native layer plays one session at a time and replaces the previous one; this keeps track of
 * WHICH button started it so each shows its own state. Nothing spoken is stored here: only a session number and a status.
 */
export function SpeechProvider({ children }: { children: ReactNode }) {
  const client = useArthurClient();
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<SpeechStatus | null>(null);
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

  const setError = useCallback((source: string, message: string | null) => setErrors((current) => ({ ...current, [source]: message })), []);

  const start = useCallback<SpeechContextValue["start"]>(
    async (source, begin) => {
      setError(source, null);
      setSession({ source, sessionId: null });
      try {
        const started = await begin();
        setSession({ source, sessionId: started.sessionId });
      } catch (failure) {
        setSession(null);
        setError(source, messageOf(failure));
      }
    },
    [setError],
  );

  const stop = useCallback(
    async (source: string) => {
      if (sessionRef.current?.source === source) setSession(null);
      try {
        await client.stopSpeech();
      } catch {
        /* stopping is best effort; the native session also ends on its own */
      }
    },
    [client],
  );

  // While a session is active, read its status until it is over. Nothing polls when nothing is being spoken.
  const sessionId = session?.sessionId ?? null;
  const source = session?.source ?? null;
  useEffect(() => {
    if (source === null || sessionId === null) return;
    let cancelled = false;
    const tick = () => {
      client.getSpeechStatus().then(
        (next) => {
          if (cancelled) return;
          setStatus(next);
          // A newer session (started elsewhere) or the end of this one releases the button.
          if (next.sessionId !== sessionId) {
            setSession(null);
          } else if (next.state === "idle") {
            if (next.outcome === "failed" && next.failure) setError(source, SPEECH_FAILURE_MESSAGE[next.failure]);
            setSession(null);
          }
        },
        () => {
          if (!cancelled) setSession(null);
        },
      );
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [client, sessionId, source, setError]);

  // Closing the app's UI never leaves audio playing.
  useEffect(
    () => () => {
      if (sessionRef.current) void client.stopSpeech().catch(() => undefined);
    },
    [client],
  );

  const value = useMemo(() => ({ session, status, errors, start, stop }), [session, status, errors, start, stop]);
  return <SpeechContext.Provider value={value}>{children}</SpeechContext.Provider>;
}

/** Speech for one named source (a button). Leaving the screen that owns the source stops its audio. */
export function useSpeechSource(source: string): SourceSpeech {
  const context = useContext(SpeechContext);
  if (!context) throw new Error("useSpeechSource must be used inside <SpeechProvider>");
  const client = useArthurClient();
  const { session, status, errors, start, stop } = context;
  const mine = session?.source === source;

  const speak = useCallback((text: string) => start(source, () => client.speakText({ text })), [client, source, start]);
  const test = useCallback(() => start(source, () => client.testVoice()), [client, source, start]);
  const stopMine = useCallback(() => stop(source), [source, stop]);

  const stopRef = useRef(stopMine);
  stopRef.current = stopMine;
  const mineRef = useRef(mine);
  mineRef.current = mine;
  useEffect(
    () => () => {
      if (mineRef.current) void stopRef.current();
    },
    [],
  );

  return {
    active: mine,
    preparing: mine && (session?.sessionId === null || status?.state !== "playing" || status.sessionId !== session?.sessionId),
    truncated: mine && status?.truncated === true && status.sessionId === session?.sessionId,
    error: errors[source] ?? null,
    speak,
    test,
    stop: stopMine,
    status: status,
  };
}
