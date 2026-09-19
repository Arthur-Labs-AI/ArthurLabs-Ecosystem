import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { sentryApi } from '../lib/sentry-api.js';

export function Dashboard(): React.JSX.Element {
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => sentryApi().projects.list() });
  const activeRuns = useQuery({
    queryKey: ['system', 'active-runs'],
    queryFn: () => sentryApi().system.activeRuns(),
    refetchInterval: 5000,
  });
  const environment = useQuery({
    queryKey: ['environment'],
    queryFn: () => sentryApi().doctors.environment(),
  });
  const projectList =
    (projects.data as Array<{ projectId: string; name: string }> | undefined) ?? [];
  const active = (activeRuns.data as Array<{ runId: string; status: string }> | undefined) ?? [];
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Dashboard</h1>
      <div className="cards">
        <div className="card">
          <div className="muted">Projects</div>
          <h2 style={{ margin: '4px 0' }}>
            {projects.data === undefined ? '—' : projectList.length}
          </h2>
          <Link to="/projects">Open projects</Link>
        </div>
        <div className="card">
          <div className="muted">Active runs</div>
          <h2 style={{ margin: '4px 0' }}>{active.length}</h2>
          {active[0] !== undefined ? (
            <Link to={'/runs/' + active[0].runId}>Open active run</Link>
          ) : (
            <span className="faint">No active runs</span>
          )}
        </div>
        <div className="card">
          <div className="muted">Environment</div>
          <h2 style={{ margin: '4px 0' }}>{environment.data === undefined ? '—' : 'Ready'}</h2>
          <Link to="/environment">Environment health</Link>
        </div>
      </div>
      <h2>Recent projects</h2>
      {projectList.length === 0 ? (
        <div className="empty">
          No projects yet. Add a local project to start QA. <Link to="/projects">Add project</Link>
        </div>
      ) : (
        <ul>
          {projectList.slice(0, 5).map((project) => (
            <li key={project.projectId}>
              <Link to={'/projects/' + project.projectId}>{project.name}</Link>{' '}
              <span className="mono faint">{project.projectId.slice(0, 14)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
