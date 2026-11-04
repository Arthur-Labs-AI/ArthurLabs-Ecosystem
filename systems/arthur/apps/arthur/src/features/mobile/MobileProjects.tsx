import { useState, type FormEvent } from "react";
import { INBOX_PROJECT_ID, type Project } from "@arthur/contracts";
import { Icon } from "../../components/icons";
import { useProjects } from "../projects/projects-context";
import { MobileSheet } from "./MobileSheet";
import { useMobileNav } from "./mobile-nav";

/**
 * The active project, in the top chrome next to Settings: "A.R.T.H.U.R ▾". It takes no slot in the bottom bar, and it is
 * the same state Marginalia Desktop reads (`useProjects`), not a copy of it.
 */
export function ProjectChip() {
  const { active } = useProjects();
  const { openProjectSheet } = useMobileNav();
  if (!active) return null;
  return (
    <button type="button" className="m-pchip" aria-haspopup="dialog" aria-label={`Project: ${active.name}. Change project`} onClick={openProjectSheet}>
      <span className={active.isInbox ? "m-pchip-name inbox" : "m-pchip-name"}>{active.name}</span>
      <span className="m-pchip-caret" aria-hidden="true">
        <Icon name="chev" small />
      </span>
    </button>
  );
}

type Draft = { kind: "new" } | { kind: "rename"; project: Project } | null;

/** Choose a project, create one, and (secondarily) rename, archive or restore. A sheet, so every target is touch-sized. */
export function ProjectSheet() {
  const { projects, archived, active, error, clearError, switchTo, create, rename, archive, restore, openArchived } = useProjects();
  const { closeProjectSheet, openAsk } = useMobileNav();
  const [managing, setManaging] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(null);
  const [name, setName] = useState("");

  const startDraft = (next: Draft, initial: string) => {
    clearError();
    setDraft(next);
    setName(initial);
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    if (draft.kind === "new") {
      if ((await create(name)) !== null) closeProjectSheet();
    } else if (await rename(draft.project.id, name)) {
      setDraft(null);
      setManaging(null);
    }
  }

  return (
    <MobileSheet label="Projects" onClose={closeProjectSheet}>
      <div className="m-sbody">
        <h2>Projects</h2>
        <p className="m-sheet-note">Home, Ideas and Connections show one project at a time. New captures go into it.</p>
        <ul className="m-plist" aria-label="Switch project">
          {projects.map((project) => (
            <li key={project.id} className={project.id === INBOX_PROJECT_ID ? "m-prow-wrap inbox" : "m-prow-wrap"}>
              <div className="m-prow-line">
                <button
                  type="button"
                  className="m-prow"
                  aria-current={project.id === active?.id ? "true" : undefined}
                  onClick={async () => {
                    if (project.id === active?.id || (await switchTo(project.id))) closeProjectSheet();
                  }}
                >
                  <span className="m-prow-name">{project.name}</span>
                  <span className="m-prow-count">
                    {project.objectCount} {project.objectCount === 1 ? "idea" : "ideas"}
                  </span>
                  {project.id === active?.id && <Icon name="check" small />}
                </button>
                {!project.isInbox && (
                  <button type="button" className="m-tlink" aria-expanded={managing === project.id} aria-label={`Manage ${project.name}`} onClick={() => { setManaging(managing === project.id ? null : project.id); setDraft(null); clearError(); }}>
                    Manage
                  </button>
                )}
              </div>
              {managing === project.id && (
                <div className="m-pmanage">
                  {draft?.kind === "rename" && draft.project.id === project.id ? (
                    <form onSubmit={submit} aria-label="Rename project">
                      <label className="m-field">
                        <span>New name</span>
                        <input value={name} maxLength={80} autoFocus onChange={(event) => setName(event.target.value)} autoComplete="off" />
                      </label>
                      <div className="m-sbar" style={{ padding: "12px 0 0", borderTop: 0 }}>
                        <button type="submit" className="m-pbtn sm" disabled={name.trim() === ""}>
                          Rename
                        </button>
                        <button type="button" className="m-pbtn sm ghost" onClick={() => setDraft(null)}>
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="m-sbar" style={{ padding: 0, borderTop: 0 }}>
                      <button type="button" className="m-pbtn sm" onClick={() => startDraft({ kind: "rename", project }, project.name)}>
                        Rename
                      </button>
                      <button type="button" className="m-pbtn sm ghost" onClick={async () => { if (await archive(project.id)) setManaging(null); }}>
                        Archive
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>

        {draft?.kind === "new" ? (
          <form onSubmit={submit} aria-label="New project">
            <label className="m-field">
              <span>Project name</span>
              <input value={name} maxLength={80} autoFocus onChange={(event) => setName(event.target.value)} autoComplete="off" />
            </label>
            <div className="m-sbar" style={{ padding: "12px 0 0", borderTop: 0 }}>
              <button type="submit" className="m-pbtn" disabled={name.trim() === ""}>
                Create
              </button>
              <button type="button" className="m-pbtn ghost" onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="m-pbtn m-pnew" onClick={() => { setManaging(null); startDraft({ kind: "new" }, ""); }}>
            <Icon name="plus" small />
            New project
          </button>
        )}

        {archived.length > 0 && (
          <>
            <h3 className="m-sec-t">
              Archived<span className="m-n">{archived.length}</span>
            </h3>
            <ul className="m-plist" aria-label="Archived projects">
              {archived.map((project) => (
                <li key={project.id} className="m-prow-line">
                  <span className="m-prow archived">
                    <span className="m-prow-name">{project.name}</span>
                  </span>
                  <button
                    type="button"
                    className="m-tlink"
                    aria-label={`Open ${project.name} read-only`}
                    onClick={() => {
                      if (openArchived(project.id)) {
                        closeProjectSheet();
                        openAsk();
                      }
                    }}
                  >
                    Open read-only
                  </button>
                  <button type="button" className="m-tlink" aria-label={`Restore ${project.name}`} onClick={() => void restore(project.id)}>
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {error && (
          <p role="alert" className="m-note-block err" style={{ margin: "14px 0 0" }}>
            {error}
          </p>
        )}
      </div>
    </MobileSheet>
  );
}

/** Where an idea lives, and a touch-sized way to move it. Moving changes the project and nothing about the idea. */
export function MoveSheet({ subject, currentProjectId, onMove, onClose }: { subject: string; currentProjectId: string; onMove: (projectId: string) => Promise<boolean>; onClose: () => void }) {
  const { projects, error } = useProjects();
  const [busy, setBusy] = useState(false);
  return (
    <MobileSheet label="Move to project" onClose={onClose}>
      <div className="m-sbody">
        <h2>Move to project</h2>
        <p className="m-sheet-note">“{subject}” keeps its words, its source and its history. Only its project changes.</p>
        <ul className="m-plist" aria-label="Projects">
          {projects
            .filter((project) => project.id !== currentProjectId)
            .map((project) => (
              <li key={project.id} className="m-prow-wrap">
                <button
                  type="button"
                  className="m-prow"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    const moved = await onMove(project.id);
                    setBusy(false);
                    if (moved) onClose();
                  }}
                >
                  <span className="m-prow-name">{project.name}</span>
                  <span className="m-prow-count">
                    {project.objectCount} {project.objectCount === 1 ? "idea" : "ideas"}
                  </span>
                </button>
              </li>
            ))}
        </ul>
        {error && (
          <p role="alert" className="m-note-block err" style={{ margin: "14px 0 0" }}>
            {error}
          </p>
        )}
      </div>
    </MobileSheet>
  );
}
