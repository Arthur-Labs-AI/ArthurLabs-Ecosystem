import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CopyId } from '../components/CopyId.js';
import { StatusLabel } from '../components/StatusGlyph.js';
import { sentryApi } from '../lib/sentry-api.js';

export function Runs(): React.JSX.Element {
  const [projectId, setProjectId] = React.useState('');
  const [modeFilter, setModeFilter] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('');
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => sentryApi().projects.list() });
  const projectList =
    (projects.data as Array<{ projectId: string; name: string }> | undefined) ?? [];
  const effectiveProject = projectId !== '' ? projectId : (projectList[0]?.projectId ?? '');
  const runs = useQuery({
    queryKey: ['project-runs', effectiveProject],
    queryFn: () => sentryApi().runs.list(effectiveProject),
    enabled: effectiveProject !== '',
    refetchInterval: 5000,
  });
  const runList = (
    (runs.data as
      | Array<{
          id: string;
          mode: string;
          status: string;
          createdAt: string;
          executionKind?: string;
          agentSummary?: { completed?: number; configured?: number };
          findingCount?: number;
          issueCount?: number;
        }>
      | undefined) ?? []
  ).filter((run) => {
    if (modeFilter !== '' && run.mode !== modeFilter) return false;
    if (statusFilter !== '' && run.status !== statusFilter) return false;
    return true;
  });
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Runs</h1>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <label>
          Project{' '}
          <select value={effectiveProject} onChange={(e) => setProjectId(e.target.value)}>
            {projectList.map((project) => (
              <option key={project.projectId} value={project.projectId}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Mode{' '}
          <select value={modeFilter} onChange={(e) => setModeFilter(e.target.value)}>
            <option value="">FULL / TARGETED</option>
            <option value="full">FULL</option>
            <option value="targeted">TARGETED</option>
          </select>
        </label>
        <label>
          Status{' '}
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            <option value="agents_running">running</option>
            <option value="completed">completed</option>
            <option value="partial">partial</option>
            <option value="failed">failed</option>
            <option value="cancelled">cancelled</option>
          </select>
        </label>
      </div>
      {runList.length === 0 ? (
        <div className="empty" style={{ marginTop: 12 }}>
          No QA runs yet.
        </div>
      ) : (
        <div className="cards" style={{ marginTop: 12 }}>
          {runList.map((run) => (
            <div key={run.id} className="card">
              <p style={{ margin: '0 0 4px' }}>
                <strong>{run.mode.toUpperCase()}</strong> <StatusLabel status={run.status} />
              </p>
              <p className="muted">
                {run.agentSummary?.completed ?? '?'}/{run.agentSummary?.configured ?? '?'} agents ·{' '}
                {run.findingCount ?? 0} findings · {run.issueCount ?? 0} issues
              </p>
              <p className="mono muted">{run.createdAt}</p>
              <p>
                <Link to={'/runs/' + run.id}>Open workspace →</Link>
              </p>
              <CopyId id={run.id} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
