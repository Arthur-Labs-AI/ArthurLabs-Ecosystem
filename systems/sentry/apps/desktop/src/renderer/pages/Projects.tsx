import React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, FolderKanban, Plus } from 'lucide-react';
import { pickDirectory, sentryApi } from '../lib/sentry-api.js';
import { PageHeader } from '../components/ui/PageHeader.js';
import { StatusPill } from '../components/ui/StatusPill.js';
import { CollapsibleSection } from '../components/ui/CollapsibleSection.js';
import { CopyId } from '../components/CopyId.js';
import { EmptyState } from '../components/ui/EmptyState.js';
import { RemoveProjectButton } from '../components/RemoveProjectButton.js';

function folderLeafName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function Projects(): React.JSX.Element {
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => sentryApi().projects.list() });
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [manualPath, setManualPath] = React.useState('');
  const [activeFolder, setActiveFolder] = React.useState<string | undefined>(undefined);
  const [addStartedAt, setAddStartedAt] = React.useState<number | undefined>(undefined);
  const [addElapsed, setAddElapsed] = React.useState(0);
  const [cancelling, setCancelling] = React.useState(false);
  const cancelledByUserRef = React.useRef(false);

  const add = useMutation({
    mutationFn: async (selectedPath: string) => {
      return sentryApi().projects.add(selectedPath.trim());
    },
    onMutate: (selectedPath: string) => {
      cancelledByUserRef.current = false;
      setCancelling(false);
      setError(undefined);
      setActiveFolder(selectedPath.trim());
      setAddStartedAt(Date.now());
      setAddElapsed(0);
    },
    onSuccess: () => {
      setError(undefined);
      setManualPath('');
      setActiveFolder(undefined);
      setAddStartedAt(undefined);
      setCancelling(false);
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e) => {
      setActiveFolder(undefined);
      setAddStartedAt(undefined);
      setCancelling(false);
      if (cancelledByUserRef.current) {
        cancelledByUserRef.current = false;
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      if (/cancelled|aborted/i.test(message)) return;
      setError(message);
    },
  });

  const chooseFolderAndStart = async (): Promise<void> => {
    if (add.isPending) return;
    try {
      const picked = await pickDirectory();
      if (picked === null || picked.trim().length === 0) return;
      add.mutate(picked.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const cancelImport = async (): Promise<void> => {
    cancelledByUserRef.current = true;
    setCancelling(true);
    try {
      await sentryApi().projects.cancelAdd?.();
    } catch {
      /* best-effort */
    } finally {
      setActiveFolder(undefined);
      setAddStartedAt(undefined);
      setCancelling(false);
    }
  };

  React.useEffect(() => {
    if (addStartedAt === undefined) return;
    const timer = setInterval(() => setAddElapsed(Date.now() - addStartedAt), 250);
    return () => clearInterval(timer);
  }, [addStartedAt]);

  React.useEffect(() => {
    if (!add.isPending || activeFolder === undefined) return;
    const onBeforeUnload = (): void => {
      cancelledByUserRef.current = true;
      void sentryApi().projects.cancelAdd?.();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [add.isPending, activeFolder]);

  const list =
    (projects.data as
      | Array<{
          projectId: string;
          name: string;
          state: string;
          currentRevisionId: string;
          runCount: number;
        }>
      | undefined) ?? [];
  const listError = projects.error as unknown;
  const modalOpen = add.isPending && activeFolder !== undefined;
  const elapsedSeconds = Math.max(0, Math.floor(addElapsed / 1000));

  return (
    <div className="page">
      <PageHeader
        title="Projects"
        subtitle="Local repositories under independent AI QA."
        actions={
          <button
            className="primary"
            onClick={() => void chooseFolderAndStart()}
            disabled={add.isPending}
          >
            <Plus size={15} /> {add.isPending ? 'Adding…' : 'Add Project'}
          </button>
        }
      />
      {error !== undefined ? (
        <div className="error-box" role="alert">
          {error}{' '}
          <button className="compact ghost" onClick={() => setError(undefined)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {projects.isLoading ? (
        <div className="skeleton">Loading projects…</div>
      ) : projects.isError ? (
        <div className="error-box" role="alert">
          Could not load projects:{' '}
          {listError instanceof Error ? listError.message : String(listError ?? 'unknown error')}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          title="No projects yet"
          body="Add a local repository and run your first independent AI QA scan."
          action={
            <button
              className="primary"
              onClick={() => void chooseFolderAndStart()}
              disabled={add.isPending}
            >
              <Plus size={15} /> Add Project
            </button>
          }
        />
      ) : (
        <div className="project-grid">
          {list.map((project) => (
            <article className="card" key={project.projectId} aria-label={project.name}>
              <div className="agent-row">
                <FolderKanban size={16} aria-hidden="true" className="faint" />
                <span className="grow truncate card-title" title={project.name}>
                  {project.name}
                </span>
                <StatusPill status={project.state} />
              </div>
              <dl className="kv" style={{ marginTop: 10 }}>
                <dt>Revision</dt>
                <dd>
                  <CopyId id={project.currentRevisionId} />
                </dd>
                <dt>Runs</dt>
                <dd>{String(project.runCount) + (project.runCount === 1 ? ' run' : ' runs')}</dd>
              </dl>
              <div className="actions actions-spread" style={{ marginTop: 10 }}>
                <Link to={'/projects/' + project.projectId}>
                  <button className="compact primary">
                    Open <ArrowRight size={13} />
                  </button>
                </Link>
                <RemoveProjectButton
                  projectId={project.projectId}
                  name={project.name}
                  state={project.state}
                />
              </div>
            </article>
          ))}
        </div>
      )}
      <CollapsibleSection title="Advanced: add by path">
        <div
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}
        >
          <input
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && manualPath.trim().length > 0 && !add.isPending) {
                add.mutate(manualPath.trim());
              }
            }}
            placeholder="Paste a folder path, then Enter"
            aria-label="Project folder path"
            style={{ minWidth: 280, flex: 1 }}
          />
          <button
            disabled={manualPath.trim().length === 0 || add.isPending}
            onClick={() => add.mutate(manualPath.trim())}
          >
            Add by path
          </button>
        </div>
      </CollapsibleSection>
      {modalOpen ? (
        <div
          className="project-import-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Adding project to Sentry"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
        >
          <div className="project-import-modal">
            <img
              src="./smooth_loader_flat_logo.gif"
              alt=""
              className="project-import-loader"
              aria-hidden="true"
            />
            <h2 className="section-title" style={{ fontSize: 16 }}>
              Adding project to Sentry
            </h2>
            <div
              className="mono metadata truncate"
              style={{ maxWidth: '100%' }}
              title={activeFolder}
              data-no-translate="true"
            >
              {folderLeafName(activeFolder)}
            </div>
            <div className="project-import-timer" aria-live="polite">
              <span>Elapsed:</span>
              <span data-no-translate="true">{elapsedSeconds}s</span>
            </div>
            <p className="body-secondary" style={{ margin: 0 }}>
              Copying and indexing project files into the isolated Sentry runtime store. This window
              will close automatically when the import completes.
            </p>
            <div style={{ marginTop: 6 }}>
              <button
                type="button"
                className="danger compact"
                disabled={cancelling}
                onClick={() => void cancelImport()}
              >
                {cancelling ? 'Cancelling…' : 'Cancel import'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
