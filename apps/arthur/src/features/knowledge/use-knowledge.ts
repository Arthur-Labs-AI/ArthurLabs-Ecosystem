import { useCallback, useEffect, useRef, useState } from "react";
import type { KnowledgeObject } from "@arthur/contracts";
import { useArthurClient } from "../../hooks/use-arthur-client";

/**
 * Where one capture is in being organized into knowledge objects.
 * A capture with no job is either already organized (it has objects) or has not been asked to organize yet.
 */
export type OrganizeStatus = "queued" | "organizing" | "failed" | "empty";

export interface OrganizeJob {
  status: OrganizeStatus;
  /** Safe to show to the user. Only set when `status` is "failed". */
  message?: string;
}

export interface KnowledgeState {
  status: "loading" | "ready" | "error";
  /** Newest distillation first, in reading order within one (as the client returns them). */
  objects: KnowledgeObject[];
  /** The capture currently being distilled, if any. Only one at a time. */
  distilling: string | null;
  /** Per capture: queued, organizing, failed (retry with `distill`) or empty (nothing to structure). */
  jobs: ReadonlyMap<string, OrganizeJob>;
  /** Failure to LOAD or re-read knowledge. Distillation failures are per capture, in `jobs`. */
  error: string | null;
  /**
   * Organizes one persisted capture. Requests are served strictly one at a time, in order. It is also the retry:
   * asking again for a failed capture runs it again. A capture that is already queued or running is not queued twice.
   * Never throws: a failure becomes that capture's job. The capture itself is never touched.
   */
  distill: (captureId: string) => Promise<void>;
  /** Re-reads the objects, e.g. after an edit changed their current text. */
  refresh: () => Promise<void>;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function useKnowledgeState(): KnowledgeState {
  const client = useArthurClient();
  const [status, setStatus] = useState<KnowledgeState["status"]>("loading");
  const [objects, setObjects] = useState<KnowledgeObject[]>([]);
  const [distilling, setDistilling] = useState<string | null>(null);
  const [jobs, setJobs] = useState<ReadonlyMap<string, OrganizeJob>>(new Map());
  const [error, setError] = useState<string | null>(null);

  // Mirrors for the serial queue, which must see the current values between awaits.
  const jobsRef = useRef<ReadonlyMap<string, OrganizeJob>>(new Map());
  const queue = useRef<string[]>([]);
  /** True from the moment a drain starts until its loop has ended, synchronously, so no request can slip into the gap. */
  const draining = useRef(false);
  const current = useRef<Promise<void>>(Promise.resolve());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    client.listKnowledgeObjects().then(
      (loaded) => {
        if (cancelled) return;
        setObjects(loaded);
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

  const setJob = useCallback((captureId: string, job: OrganizeJob | null) => {
    const next = new Map(jobsRef.current);
    if (job === null) next.delete(captureId);
    else next.set(captureId, job);
    jobsRef.current = next;
    if (alive.current) setJobs(next);
  }, []);

  const drain = useCallback(async () => {
    // The loop test and the flag reset below are one synchronous step: a request arriving at any other moment either
    // finds the queue still being served (and is picked up by the loop) or finds `draining` false (and starts a drain).
    try {
      while (queue.current.length > 0 && alive.current) {
        const captureId = queue.current.shift() as string;
        setDistilling(captureId);
        setJob(captureId, { status: "organizing" });
        try {
          const produced = await client.distillCapture(captureId);
          setJob(captureId, produced.length === 0 ? { status: "empty" } : null);
        } catch (failure) {
          setJob(captureId, { status: "failed", message: messageOf(failure) });
        }
        // Either way, show exactly what is stored. A failed run stores nothing, and the UI never builds objects itself.
        try {
          const stored = await client.listKnowledgeObjects();
          if (alive.current) {
            setObjects(stored);
            setStatus("ready");
          }
        } catch (failure) {
          if (alive.current) setError(messageOf(failure));
        }
      }
    } finally {
      draining.current = false;
      if (alive.current) setDistilling(null);
    }
  }, [client, setJob]);

  const distill = useCallback(
    (captureId: string): Promise<void> => {
      const existing = jobsRef.current.get(captureId);
      if (existing && (existing.status === "queued" || existing.status === "organizing")) return current.current;
      queue.current.push(captureId);
      setJob(captureId, { status: "queued" });
      if (!draining.current) {
        draining.current = true;
        current.current = drain();
      }
      return current.current;
    },
    [drain, setJob],
  );

  const refresh = useCallback(async () => {
    try {
      setObjects(await client.listKnowledgeObjects());
      setStatus("ready");
    } catch (failure) {
      setError(messageOf(failure));
    }
  }, [client]);

  return { status, objects, distilling, jobs, error, distill, refresh };
}
