import { useEffect, useState } from "react";
import type { ApprovalInfo, RevisionOrigin, ThoughtRevision } from "@arthur/contracts";
import { useArthurClient } from "../../hooks/use-arthur-client";
import { ORIGIN_LABELS } from "../lineage/revision-captions";

/**
 * Which revisions of one idea a person approved from a suggestion. Re-read whenever the current revision changes, so a revision approved
 * a moment ago is labelled at once. A failed read changes nothing: revisions then keep their ordinary labels.
 */
export function useApprovals(objectId: string | null, currentRevisionId: string | undefined): ReadonlyMap<string, ApprovalInfo> {
  const client = useArthurClient();
  const [approvals, setApprovals] = useState<ReadonlyMap<string, ApprovalInfo>>(new Map());

  useEffect(() => {
    if (objectId === null) {
      setApprovals(new Map());
      return;
    }
    let cancelled = false;
    client.listObjectApprovals(objectId).then(
      (loaded) => {
        if (!cancelled) setApprovals(new Map(loaded.map((entry) => [entry.revisionId, entry])));
      },
      () => {
        if (!cancelled) setApprovals(new Map());
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, objectId, currentRevisionId]);

  return approvals;
}

/**
 * Who made a revision, truthfully. An approved suggestion is stored as an automatic revision (that is the only kind that can carry its
 * evidence), so the approval record is what says a person approved it and whether the words are theirs.
 */
export function originLabel(revision: Pick<ThoughtRevision, "origin">, approval: ApprovalInfo | undefined): string {
  if (approval) return approval.userEdited ? "Suggested by Arthur · your wording, approved by you" : "Suggested by Arthur · approved by you";
  return ORIGIN_LABELS[revision.origin as RevisionOrigin];
}

/** The short form for a rail row or a tag. */
export function originTag(revision: Pick<ThoughtRevision, "origin">, approval: ApprovalInfo | undefined): string {
  if (approval) return approval.userEdited ? "approved · edited by you" : "approved by you";
  return ORIGIN_LABELS[revision.origin as RevisionOrigin];
}

/**
 * The plain statement of where a revision's words come from, for a revision with no capture span of its own. It never calls a person's
 * wording AI-authored, and never calls an AI suggestion the person's own text. `null`: nothing special to say.
 */
export function provenanceNote(revision: Pick<ThoughtRevision, "origin">, approval: ApprovalInfo | undefined): string | null {
  if (approval) {
    return approval.userEdited
      ? "You wrote these words when you approved Arthur’s suggestion. The new capture is what prompted them, and Arthur’s own draft is kept with the suggestion."
      : "Arthur drafted these words and you approved them as written. The new capture is what prompted them, and the earlier text stays in this history.";
  }
  if (revision.origin === "system") return "Arthur wrote this text on its own, before suggestions needed your approval.";
  return null;
}
