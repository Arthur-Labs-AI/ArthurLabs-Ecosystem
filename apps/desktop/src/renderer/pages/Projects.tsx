import React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { pickDirectory, sentryApi } from '../lib/sentry-api.js';

export function Projects(): React.JSX.Element {
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => sentryApi().projects.list() });
  const [error, setError] = React.useState<string | undefined>(undefined);
  const add = useMutation({
    mutationFn: async () => {
      const picked = await pickDirectory();
      if (picked === null) throw new Error('No directory selected');
      return sentryApi().projects.add(picked);
    },
    onSuccess: () => {
      setError(undefined);
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
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
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Projects</h1>
      <button className="primary" onClick={() => add.mutate()} disabled={add.isPending}>
        {add.isPending ? 'Adding…' : 'Add Project'}
      </button>
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
