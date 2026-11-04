import { useCallback, useEffect, useRef, useState } from "react";
import type { CognitiveEvidence } from "@arthur/contracts";
import { useProjects } from "../projects/projects-context";

export type EvidenceTarget = "idea" | "capture" | "evolution" | "connections" | "project";

interface Pending {
  projectId: string;
  target: EvidenceTarget;
  objectId: string;
}

/**
 * Takes the user from a piece of evidence to the existing screens. It owns exactly one rule: evidence that belongs to ANOTHER
 * project is opened by first making that project the active one (the Ideas, Connections and Evolution screens only show the
 * active project), and only then opening the idea there. The screens themselves are reached through `open`, so Desktop and
 * Mobile each use their own navigation.
 */
export function useEvidenceNav(open: (target: EvidenceTarget, objectId: string) => void) {
  const { activeProjectId, switchTo, nameOf } = useProjects();
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef<Pending | null>(null);
  const latestOpen = useRef(open);
  latestOpen.current = open;

  // The switch has landed (and the screens have cleared the focus that belonged to the project being left): now go.
  useEffect(() => {
    const wanted = pending.current;
    if (wanted && wanted.projectId === activeProjectId) {
      pending.current = null;
      latestOpen.current(wanted.target, wanted.objectId);
    }
  }, [activeProjectId]);

  const go = useCallback(
    async (target: EvidenceTarget, evidence: CognitiveEvidence) => {
      setNotice(null);
      if (!evidence.externalProject || evidence.projectId === activeProjectId) {
        latestOpen.current(target, evidence.objectId);
        return;
      }
      pending.current = { projectId: evidence.projectId, target, objectId: evidence.objectId };
      const switched = await switchTo(evidence.projectId);
      if (!switched) {
        pending.current = null;
        setNotice(`${nameOf(evidence.projectId) ?? evidence.projectName} couldn't be opened.`);
      }
    },
    [activeProjectId, switchTo, nameOf],
  );

  return { go, notice, clearNotice: () => setNotice(null) };
}
