import { useCallback, useEffect, useState } from "react";
import type { KnowledgeObjectKind, ObjectLineage, RevisionChanges, RevisionDiff, ThoughtRevision } from "@arthur/contracts";
import { useArthurClient } from "../../hooks/use-arthur-client";

export interface LineageState {
  status: "idle" | "loading" | "ready" | "error";
  lineage: ObjectLineage | null;
  /** The diff between the selected revision and each of its parents, keyed by parent id. */
  diffs: ReadonlyMap<string, RevisionDiff>;
  busy: boolean;
  notice: string | null;
  error: string | null;
  /** Creates a revision from the current one; resolves true when it was stored. */
  edit: (changes: RevisionChanges) => Promise<boolean>;
  /** Creates a (non-current) branch from `parentRevisionId`. */
  branch: (parentRevisionId: string, changes: RevisionChanges) => Promise<boolean>;
  merge: (parentRevisionIds: string[], result: { kind: KnowledgeObjectKind; title: string; body: string }, makeCurrent: boolean) => Promise<boolean>;
  /**
   * Undo: brings an earlier revision's text back as a NEW revision pointing at both it and the text it replaces. History is never
   * rewritten. Refused (and shown) if the idea changed since it was opened.
   */
  restore: (targetRevisionId: string) => Promise<boolean>;
  reload: () => Promise<void>;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One object's history, plus the actions that extend it. `onChanged` runs after every stored revision. */
export function useLineage(objectId: string | null, selectedRevisionId: string | null, onChanged: () => Promise<void>): LineageState {
  const client = useArthurClient();
  const [status, setStatus] = useState<LineageState["status"]>("idle");
  const [lineage, setLineage] = useState<ObjectLineage | null>(null);
  const [diffs, setDiffs] = useState<ReadonlyMap<string, RevisionDiff>>(new Map());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (objectId === null) return;
    try {
      setLineage(await client.getObjectLineage(objectId));
      setStatus("ready");
    } catch (failure) {
      setError(messageOf(failure));
      setStatus("error");
    }
  }, [client, objectId]);

  useEffect(() => {
    setLineage(null);
    setNotice(null);
    setError(null);
    if (objectId === null) {
      setStatus("idle");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    client.getObjectLineage(objectId).then(
      (loaded) => {
        if (cancelled) return;
        setLineage(loaded);
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
  }, [client, objectId]);

  // The deterministic diff of the selected revision against each of its parents.
  const selected = lineage?.revisions.find((revision) => revision.id === (selectedRevisionId ?? lineage.currentRevisionId)) ?? lineage?.revisions.find((revision) => revision.id === lineage.currentRevisionId);
  useEffect(() => {
    setDiffs(new Map());
    if (!selected || selected.parentRevisionIds.length === 0) return;
    let cancelled = false;
    Promise.all(selected.parentRevisionIds.map((parentId) => client.diffRevisions(parentId, selected.id))).then(
      (results) => {
        if (!cancelled) setDiffs(new Map(results.map((diff) => [diff.oldRevisionId, diff])));
      },
      (failure: unknown) => {
        if (!cancelled) setError(messageOf(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, selected]);

  const run = useCallback(
    async (work: () => Promise<ThoughtRevision>, done: string): Promise<boolean> => {
      if (busy) return false;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await work();
        setNotice(done);
        await reload();
        await onChanged();
        return true;
      } catch (failure) {
        setError(messageOf(failure));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, reload, onChanged],
  );

  const edit = useCallback((changes: RevisionChanges) => (objectId === null ? Promise.resolve(false) : run(() => client.updateKnowledgeObject(objectId, changes), "New revision saved.")), [client, objectId, run]);
  const branch = useCallback(
    (parentRevisionId: string, changes: RevisionChanges) =>
      objectId === null ? Promise.resolve(false) : run(() => client.createRevisionFrom({ objectId, parentRevisionId, changes, makeCurrent: false }), "Branch saved. The current revision is unchanged."),
    [client, objectId, run],
  );
  const merge = useCallback(
    (parentRevisionIds: string[], result: { kind: KnowledgeObjectKind; title: string; body: string }, makeCurrent: boolean) =>
      objectId === null ? Promise.resolve(false) : run(() => client.mergeRevisions({ objectId, parentRevisionIds, result, makeCurrent }), "Merge saved."),
    [client, objectId, run],
  );

  const restore = useCallback(
    (targetRevisionId: string) => {
      const currentId = lineage?.currentRevisionId;
      if (objectId === null || currentId === undefined) return Promise.resolve(false);
      return run(() => client.restoreRevision(objectId, targetRevisionId, currentId), "Brought the earlier version back as a new revision. Nothing was deleted.");
    },
    [client, objectId, lineage, run],
  );

  return { status, lineage, diffs, busy, notice, error, edit, branch, merge, restore, reload };
}
