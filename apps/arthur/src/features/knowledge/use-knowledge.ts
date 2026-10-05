import { useCallback, useEffect, useRef, useState } from "react";
import type { KnowledgeObject } from "@arthur/contracts";
import { useArthurClient } from "../../hooks/use-arthur-client";
import { useProjects } from "../projects/projects-context";

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
  /**
   * True once the durable organization state of every capture has been read. Until then a capture without ideas must
   * not be called "not organized yet": it may have been organized into nothing, or have a failure to show.
   */
  organizationLoaded: boolean;
  /**
   * Captures that were organized into at least one idea (in ANY project). A capture can be in this project while its ideas
   * were moved elsewhere, so "no ideas here" does not mean "not organized".
   */
  organized: ReadonlySet<string>;
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
  const { activeProjectId, dataVersion } = useProjects();
  /** What is shown is always the ACTIVE project's; a re-read after an organize run must use the project active NOW. */
  const scopeRef = useRef<string | null>(activeProjectId);
  scopeRef.current = activeProjectId;
  const shownScope = useRef<string | null>(null);
  const [status, setStatus] = useState<KnowledgeState["status"]>("loading");
  const [objects, setObjects] = useState<KnowledgeObject[]>([]);
  const [distilling, setDistilling] = useState<string | null>(null);
  const [jobs, setJobs] = useState<ReadonlyMap<string, OrganizeJob>>(new Map());
  const [organizationLoaded, setOrganizationLoaded] = useState(false);
  const [organized, setOrganized] = useState<ReadonlySet<string>>(new Set());
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
    if (activeProjectId === null) return;
    let cancelled = false;
    if (shownScope.current !== activeProjectId) {
      shownScope.current = activeProjectId;
      setObjects([]); // never show the previous project's ideas while this one loads
    }
    setStatus("loading");
    client.listKnowledgeObjects({ projectId: activeProjectId }).then(
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
  }, [client, activeProjectId, dataVersion]);

  // What the previous run left behind: failures that must still offer a retry, and captures that were organized into
  // nothing. Both are durable in the native store, so this is read, not remembered. A read that fails changes nothing:
  // the screens then behave exactly as they did before this state existed.
  useEffect(() => {
    if (activeProjectId === null) return;
    let cancelled = false;
    setOrganizationLoaded(false);
    client.listOrganizationStates({ projectId: activeProjectId }).then(
      (states) => {
        if (cancelled) return;
        const next = new Map(jobsRef.current);
        setOrganized((current) => new Set([...current, ...states.filter((state) => state.status === "succeeded" && state.objectCount > 0).map((state) => state.captureId)]));
        for (const state of states) {
          if (next.has(state.captureId)) continue; // something is happening to it right now in this session
          if (state.status === "failed" && state.failure) next.set(state.captureId, { status: "failed", message: state.failure.message });
          else if (state.status === "succeeded" && state.objectCount === 0) next.set(state.captureId, { status: "empty" });
        }
        jobsRef.current = next;
        setJobs(next);
        setOrganizationLoaded(true);
      },
      () => {
        if (!cancelled) setOrganizationLoaded(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, activeProjectId, dataVersion]);

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
          if (produced.length > 0 && alive.current) setOrganized((current) => new Set(current).add(captureId));
        } catch (failure) {
          setJob(captureId, { status: "failed", message: messageOf(failure) });
        }
        // Either way, show exactly what is stored. A failed run stores nothing, and the UI never builds objects itself.
        try {
          const stored = scopeRef.current === null ? [] : await client.listKnowledgeObjects({ projectId: scopeRef.current });
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
      if (scopeRef.current === null) return;
      setObjects(await client.listKnowledgeObjects({ projectId: scopeRef.current }));
      setStatus("ready");
    } catch (failure) {
      setError(messageOf(failure));
    }
  }, [client]);

  return { status, objects, distilling, jobs, organizationLoaded, organized, error, distill, refresh };
}
