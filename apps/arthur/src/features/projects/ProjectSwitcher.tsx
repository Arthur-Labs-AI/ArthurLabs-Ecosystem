import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { INBOX_PROJECT_ID } from "@arthur/contracts";
import { Icon } from "../../components/icons";
import { useProjects } from "./projects-context";
import "./projects.css";

type Mode = "list" | "new" | "rename";

/**
 * Marginalia Desktop's project selector: a quiet line under the Arthur mark that names the active project and opens a
 * small raised list. Choosing, creating, renaming and archiving all live in that one list; nothing else on screen
 * changes shape. The Inbox is first and set apart by a hairline, not by colour.
 */
export function ProjectSwitcher() {
  const { projects, archived, active, error, clearError, switchTo, create, rename, archive, restore, refresh } = useProjects();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("list");
  const [draft, setDraft] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const menuId = useId();

  const close = () => {
    setOpen(false);
    setMode("list");
    setDraft("");
    setShowArchived(false);
    clearError();
  };

  useEffect(() => {
    if (!open) return;
    void refresh(); // the counts shown are read when the list opens
    const onPointerDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (mode !== "list") field.current?.focus();
  }, [mode]);

  if (!active) return <div className="proj" aria-hidden="true" />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!active) return;
    const done = mode === "new" ? (await create(draft)) !== null : await rename(active.id, draft);
    if (done) close();
  }

  return (
    <div className="proj" ref={root}>
      <button type="button" className="proj-btn" aria-haspopup="true" aria-expanded={open} aria-controls={open ? menuId : undefined} aria-label={`Project: ${active.name}`} onClick={() => (open ? close() : setOpen(true))}>
        <span className={active.isInbox ? "proj-name inbox" : "proj-name"}>{active.name}</span>
        <span className="proj-caret" aria-hidden="true">
          <Icon name="chev" small />
        </span>
      </button>
      {open && (
        <div className="proj-menu" id={menuId} role="group" aria-label="Projects">
          <ul className="proj-list" aria-label="Switch project">
            {projects.map((project) => (
              <li key={project.id} className={project.id === INBOX_PROJECT_ID ? "proj-inbox" : undefined}>
                <button
                  type="button"
                  aria-current={project.id === active.id ? "true" : undefined}
                  onClick={async () => {
                    if (project.id === active.id || (await switchTo(project.id))) close();
                  }}
                >
                  <span className="proj-item-name">{project.name}</span>
                  <span className="proj-count" aria-label={`${project.objectCount} ${project.objectCount === 1 ? "idea" : "ideas"}`}>
                    {project.objectCount}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {mode === "list" ? (
            <div className="proj-actions">
              <button type="button" className="link" onClick={() => { clearError(); setDraft(""); setMode("new"); }}>
                New project
              </button>
              {!active.isInbox && (
                <>
                  <button type="button" className="link" onClick={() => { clearError(); setDraft(active.name); setMode("rename"); }}>
                    Rename
                  </button>
                  <button type="button" className="link" onClick={async () => { if (await archive(active.id)) close(); }}>
                    Archive
                  </button>
                </>
              )}
            </div>
          ) : (
            <form className="proj-form" onSubmit={submit} aria-label={mode === "new" ? "New project" : "Rename project"}>
              <label className="field">
                {mode === "new" ? "Project name" : "New name"}
                <input ref={field} value={draft} maxLength={80} onChange={(event) => setDraft(event.target.value)} autoComplete="off" />
              </label>
              <div className="proj-form-actions">
                <button type="submit" className="btn" disabled={draft.trim() === ""}>
                  {mode === "new" ? "Create" : "Rename"}
                </button>
                <button type="button" className="btn ghost" onClick={() => { clearError(); setMode("list"); }}>
                  Cancel
                </button>
              </div>
            </form>
          )}

          {archived.length > 0 && (
            <div className="proj-archived">
              <button type="button" className="link" aria-expanded={showArchived} onClick={() => setShowArchived((now) => !now)}>
                Archived ({archived.length})
              </button>
              {showArchived && (
                <ul aria-label="Archived projects">
                  {archived.map((project) => (
                    <li key={project.id}>
                      <span className="proj-item-name">{project.name}</span>
                      <button type="button" className="link" aria-label={`Restore ${project.name}`} onClick={() => void restore(project.id)}>
                        Restore
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {error && (
            <p className="proj-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
