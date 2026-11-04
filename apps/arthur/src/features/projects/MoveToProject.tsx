import { useState, type FormEvent } from "react";
import type { Project } from "@arthur/contracts";
import { useProjects } from "./projects-context";

/**
 * "In Nexus · Move…": where an idea lives, and a quiet way to put it somewhere else. Moving changes which project owns
 * the idea and nothing about it: same words, same source, same history.
 */
export function MoveToProject({ currentProjectId, subject, onMove }: { currentProjectId: string; subject: string; onMove: (projectId: string) => Promise<boolean> }) {
  const { projects, nameOf, error } = useProjects();
  const targets: Project[] = projects.filter((project) => project.id !== currentProjectId);
  const [moving, setMoving] = useState(false);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const chosen = targets.some((project) => project.id === target) ? target : (targets[0]?.id ?? "");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (chosen === "" || busy) return;
    setBusy(true);
    try {
      await onMove(chosen);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="move">
      <p className="move-line">
        In <b>{nameOf(currentProjectId) ?? "this project"}</b>
        {targets.length > 0 && !moving && (
          <>
            {" · "}
            <button type="button" className="link" onClick={() => setMoving(true)} aria-label={`Move ${subject} to another project`}>
              Move…
            </button>
          </>
        )}
      </p>
      {moving && (
        <form className="move-form" onSubmit={submit} aria-label="Move to another project">
          <label className="field">
            Move to
            <select value={chosen} onChange={(event) => setTarget(event.target.value)}>
              {targets.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <div className="move-actions">
            <button type="submit" className="btn" disabled={chosen === "" || busy}>
              {busy ? "Moving…" : "Move"}
            </button>
            <button type="button" className="btn ghost" onClick={() => setMoving(false)}>
              Cancel
            </button>
          </div>
          <p className="note">Its words, source and history stay exactly as they are.</p>
          {error && (
            <p role="alert" className="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
