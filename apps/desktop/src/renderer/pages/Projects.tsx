import React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { pickDirectory, sentryApi } from '../lib/sentry-api.js';

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
    <div>
      <h1 style={{ marginTop: 0 }}>Projects</h1>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="primary" onClick={() => add.mutate(undefined)} disabled={add.isPending}>
          {add.isPending ? 'Adding…' : 'Add Project'}
        </button>
        <input
          value={manualPath}
          onChange={(e) => setManualPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && manualPath.trim().length > 0 && !add.isPending) {
              add.mutate(manualPath);
            }
          }}
          placeholder="Or paste a folder path, then Enter"
          aria-label="Project folder path"
          style={{ minWidth: 280 }}
        />
        <button
          disabled={manualPath.trim().length === 0 || add.isPending}
          onClick={() => add.mutate(manualPath)}
        >
          Add by path
        </button>
      </div>
      {add.isPending ? (
        <p className="muted">
          Copying project into the Sentry store… {Math.round(addElapsed / 1000)}s elapsed. Large
          folders (especially ones containing node_modules) can take a while.
        </p>
      ) : null}
      {error !== undefined ? (
        <div className="error-box" style={{ marginTop: 12 }} role="alert">
          {error}
        </div>
      ) : null}
      {add.error !== undefined && add.error !== null && error === undefined ? (
        <div className="error-box" style={{ marginTop: 12 }} role="alert">
          {String((add.error as { message?: unknown }).message ?? add.error)}
        </div>
      ) : null}
      {projects.isLoading ? (
        <div className="skeleton">Loading projects…</div>
      ) : projects.isError ? (
        <div className="error-box" style={{ marginTop: 12 }} role="alert">
          Could not load projects:{' '}
          {listError instanceof Error ? listError.message : String(listError ?? 'unknown error')}
        </div>
      ) : list.length === 0 ? (
        <div className="empty" style={{ marginTop: 12 }}>
          No projects yet. Add a local project to start QA.
        </div>
      ) : (
        <table className="table" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>State</th>
              <th>Revision</th>
              <th>Runs</th>
            </tr>
          </thead>
          <tbody>
            {list.map((project) => (
              <tr key={project.projectId}>
                <td>
                  <Link to={'/projects/' + project.projectId}>{project.name}</Link>{' '}
                  <span className="mono faint">{project.projectId.slice(0, 12)}</span>
                </td>
                <td>{project.state}</td>
                <td className="mono">{project.currentRevisionId.slice(0, 14)}</td>
                <td>{project.runCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
