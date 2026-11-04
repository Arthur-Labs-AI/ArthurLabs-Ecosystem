import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "@arthur/contracts";
import { useArthurClient } from "../../hooks/use-arthur-client";

export interface ProjectsState {
  status: "loading" | "ready" | "error";
  /** Open projects: the Inbox first, then by name. */
  projects: Project[];
  /** Archived projects, kept so they can be restored. */
  archived: Project[];
  /** The active project, or `null` until the first answer. The ONE source of truth for scope: screens read it from here. */
  active: Project | null;
  activeProjectId: string | null;
  /**
   * Bumps whenever a move changed which project owns something, so every scoped list (captures, ideas, graph, summaries)
   * re-reads exactly what is stored instead of patching its own copy.
   */
  dataVersion: number;
  /**
   * An ARCHIVED project the user explicitly opened to read and ask about. It is never the active project (that invariant is
   * unchanged), so nothing can be captured into, created in, edited in or moved into it; it only supplies the scope of Ask Arthur.
   * Switching, creating, archiving or restoring any project ends it.
   */
  readOnlyProject: Project | null;
  /** Opens an archived project read-only. Resolves false when it is not (or no longer) archived. */
  openArchived: (projectId: string) => boolean;
  closeArchived: () => void;
  /** Last failure of a project operation. Safe to show. Cleared by the next successful operation. */
  error: string | null;
  clearError: () => void;
  /** Makes `projectId` the active project (persisted natively). Resolves true on success. */
  switchTo: (projectId: string) => Promise<boolean>;
  /** Creates a project and, by default, switches to it. Resolves the new project, or `null` on failure (see `error`). */
  create: (name: string, options?: { activate?: boolean }) => Promise<Project | null>;
  rename: (projectId: string, name: string) => Promise<boolean>;
  /** Archives a project. If it was active, the Inbox becomes active. */
  archive: (projectId: string) => Promise<boolean>;
  restore: (projectId: string) => Promise<boolean>;
  moveCapture: (captureId: string, projectId: string) => Promise<boolean>;
  moveObject: (objectId: string, projectId: string) => Promise<boolean>;
  /** Re-reads the project list (counts included), e.g. when a selector opens. */
  refresh: () => Promise<void>;
  /** The name of a project, from what is loaded. */
  nameOf: (projectId: string) => string | undefined;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function useProjectsState(): ProjectsState {
  const client = useArthurClient();
  const [status, setStatus] = useState<ProjectsState["status"]>("loading");
  const [projects, setProjects] = useState<Project[]>([]);
  const [archived, setArchived] = useState<Project[]>([]);
  const [active, setActive] = useState<Project | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [readOnlyId, setReadOnlyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const read = useCallback(async () => {
    // Two bounded requests: every project with its counts (open ones are derived, in the same order), and the active one.
    const [all, current] = await Promise.all([client.listProjects({ includeArchived: true }), client.getActiveProject()]);
    if (!alive.current) return;
    setProjects(all.filter((project) => project.archivedAt === null));
    setArchived(all.filter((project) => project.archivedAt !== null));
    setActive(current);
    setStatus("ready");
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    read().catch((failure: unknown) => {
      if (cancelled || !alive.current) return;
      setError(messageOf(failure));
      setStatus("error");
    });
    return () => {
      cancelled = true;
    };
  }, [read]);

  /** Runs one operation, then re-reads the truth. A failure is shown and changes nothing. */
  const run = useCallback(
    async (work: () => Promise<unknown>, options: { bump?: boolean } = {}): Promise<boolean> => {
      try {
        await work();
        setError(null);
        await read();
        if (options.bump && alive.current) setDataVersion((version) => version + 1);
        return true;
      } catch (failure) {
        if (alive.current) setError(messageOf(failure));
        // A rejected operation may mean our picture is stale (e.g. the project was archived elsewhere): re-read quietly.
        void read().catch(() => undefined);
        return false;
      }
    },
    [read],
  );

  const switchTo = useCallback(
    (projectId: string) => {
      setReadOnlyId(null);
      return run(() => client.setActiveProject(projectId));
    },
    [client, run],
  );
  const create = useCallback(
    async (name: string, options?: { activate?: boolean }): Promise<Project | null> => {
      setReadOnlyId(null);
      let created: Project | null = null;
      const ok = await run(async () => {
        created = await client.createProject(name);
        if (options?.activate !== false) await client.setActiveProject(created.id);
      });
      return ok ? created : null;
    },
    [client, run],
  );
  const rename = useCallback((projectId: string, name: string) => run(() => client.renameProject(projectId, name)), [client, run]);
  const archive = useCallback(
    (projectId: string) => {
      setReadOnlyId(null);
      return run(() => client.archiveProject(projectId));
    },
    [client, run],
  );
  const restore = useCallback(
    (projectId: string) => {
      setReadOnlyId(null);
      return run(() => client.restoreProject(projectId));
    },
    [client, run],
  );
  const openArchived = useCallback(
    (projectId: string): boolean => {
      if (!archived.some((project) => project.id === projectId)) return false;
      setReadOnlyId(projectId);
      return true;
    },
    [archived],
  );
  const closeArchived = useCallback(() => setReadOnlyId(null), []);
  const moveCapture = useCallback((captureId: string, projectId: string) => run(() => client.moveCapture(captureId, projectId), { bump: true }), [client, run]);
  const moveObject = useCallback((objectId: string, projectId: string) => run(() => client.moveKnowledgeObject(objectId, projectId), { bump: true }), [client, run]);
  const refresh = useCallback(async () => {
    try {
      await read();
    } catch {
      /* the list on screen stays; the next operation reports a real failure */
    }
  }, [read]);
  const clearError = useCallback(() => setError(null), []);

  const names = useMemo(() => new Map([...projects, ...archived].map((project) => [project.id, project.name])), [projects, archived]);
  const nameOf = useCallback((projectId: string) => names.get(projectId), [names]);

  const readOnlyProject = archived.find((project) => project.id === readOnlyId) ?? null;

  return { status, projects, archived, active, activeProjectId: active?.id ?? null, readOnlyProject, openArchived, closeArchived, dataVersion, error, clearError, switchTo, create, rename, archive, restore, moveCapture, moveObject, refresh, nameOf };
}
