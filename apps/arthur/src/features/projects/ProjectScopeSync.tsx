import { useEffect, useRef } from "react";
import { useNavigation } from "../../app/navigation";
import { useProjects } from "./projects-context";

/**
 * Switching project leaves whatever idea was in focus: it belongs to the project being left. Renders nothing.
 * (Moving an idea out of the active project clears the focus the same way, from the screen that moved it.)
 */
export function ProjectScopeSync() {
  const { activeProjectId } = useProjects();
  const { focus } = useNavigation();
  const previous = useRef(activeProjectId);
  useEffect(() => {
    if (previous.current !== null && activeProjectId !== null && previous.current !== activeProjectId) focus(null);
    previous.current = activeProjectId;
  }, [activeProjectId, focus]);
  return null;
}
