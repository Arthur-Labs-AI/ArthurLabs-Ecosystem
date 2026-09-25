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

export function Projects(): React.JSX.Element {
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => sentryApi().projects.list() });
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [manualPath, setManualPath] = React.useState('');
  const [addStartedAt, setAddStartedAt] = React.useState<number | undefined>(undefined);
  const [addElapsed, setAddElapsed] = React.useState(0);
  const add = useMutation({
    mutationFn: async (sourcePath?: string) => {
      const picked = sourcePath ?? (await pickDirectory());
      if (picked === null || picked.trim().length === 0) throw new Error('No directory selected');
      return sentryApi().projects.add(picked.trim());
    },
    onMutate: () => {
      setAddStartedAt(Date.now());
      setAddElapsed(0);
    },
    onSuccess: () => {
      setError(undefined);
      setManualPath('');
      setAddStartedAt(undefined);
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e) => {
      setError(e instanceof Error ? e.message : String(e));
      setAddStartedAt(undefined);
    },
  });
  React.useEffect(() => {
    if (addStartedAt === undefined) return;
    const timer = setInterval(() => setAddElapsed(Date.now() - addStartedAt), 500);
    return () => clearInterval(timer);
  }, [addStartedAt]);
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
  return (
    <div className="page">
      <PageHeader
        title="Projects"
        subtitle="Local repositories under independent AI QA."
        actions={
          <button
            className="primary"
            onClick={() => add.mutate(undefined)}
            disabled={add.isPending}
          >
            <Plus size={15} /> {add.isPending ? 'Adding…' : 'Add Project'}
          </button>
        }
      />
      {add.isPending ? (
        <p className="muted" aria-live="polite">
          Copying project into the Sentry store… {Math.round(addElapsed / 1000)}s elapsed. Large
          folders (especially ones containing node_modules) can take a while.
        </p>
      ) : null}
      {error !== undefined ? (
        <div className="error-box" role="alert">
          {error}{' '}
          <button className="compact ghost" onClick={() => setError(undefined)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {add.error !== undefined && add.error !== null && error === undefined ? (
        <div className="error-box" role="alert">
          {String((add.error as { message?: unknown }).message ?? add.error)}
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
            <button className="primary" onClick={() => add.mutate(undefined)}>
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
                <dd>
                  {project.runCount} run{project.runCount === 1 ? '' : 's'}
                </dd>
              </dl>
              <div style={{ marginTop: 10 }}>
                <Link to={'/projects/' + project.projectId}>
                  <button className="compact primary">
                    Open <ArrowRight size={13} />
                  </button>
                </Link>
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
                add.mutate(manualPath);
              }
            }}
            placeholder="Paste a folder path, then Enter"
            aria-label="Project folder path"
            style={{ minWidth: 280, flex: 1 }}
          />
          <button
            disabled={manualPath.trim().length === 0 || add.isPending}
            onClick={() => add.mutate(manualPath)}
          >
            Add by path
          </button>
        </div>
      </CollapsibleSection>
    </div>
  );
}
