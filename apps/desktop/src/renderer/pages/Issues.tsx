import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { sentryApi } from '../lib/sentry-api.js';

export function Issues(): React.JSX.Element {
  const [projectId, setProjectId] = React.useState('');
  const [stateFilter, setStateFilter] = React.useState('');
  const [severityFilter, setSeverityFilter] = React.useState('');
  const [search, setSearch] = React.useState('');
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => sentryApi().projects.list() });
  const projectList =
    (projects.data as Array<{ projectId: string; name: string }> | undefined) ?? [];
  const effectiveProject = projectId !== '' ? projectId : (projectList[0]?.projectId ?? '');
  const issues = useQuery({
    queryKey: ['project-issues', effectiveProject],
    queryFn: () => sentryApi().issues.list(effectiveProject),
    enabled: effectiveProject !== '',
  });
  const list = (
    (issues.data as
      | Array<{ id: string; title: string; severity: string; state?: string; status?: string }>
      | undefined) ?? []
  ).filter((issue) => {
    if (stateFilter !== '' && (issue.state ?? issue.status) !== stateFilter) return false;
    if (severityFilter !== '' && issue.severity !== severityFilter) return false;
    if (search !== '' && !issue.title.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Issues</h1>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <select
          value={effectiveProject}
          onChange={(e) => setProjectId(e.target.value)}
          aria-label="Project"
        >
          {projectList.map((project) => (
            <option key={project.projectId} value={project.projectId}>
              {project.name}
            </option>
          ))}
        </select>
        <select
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value)}
          aria-label="State filter"
        >
          <option value="">All states</option>
          <option value="open">open</option>
          <option value="acknowledged">acknowledged</option>
          <option value="resolved">resolved</option>
          <option value="closed">closed</option>
        </select>
        <select
          value={severityFilter}
          onChange={(e) => setSeverityFilter(e.target.value)}
          aria-label="Severity filter"
        >
          <option value="">All severities</option>
          <option value="critical">critical</option>
          <option value="high">high</option>
          <option value="medium">medium</option>
          <option value="low">low</option>
          <option value="info">info</option>
        </select>
        <input
          placeholder="Search titles"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search issues"
        />
      </div>
      {list.length === 0 ? (
        <div className="empty" style={{ marginTop: 12 }}>
          No issues have been ingested.
        </div>
      ) : (
        <table className="table" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Severity</th>
              <th>Title</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {list.map((issue) => (
              <tr key={issue.id}>
                <td>{issue.severity}</td>
                <td>
                  <Link to={'/issues/' + issue.id}>{issue.title}</Link>
                </td>
                <td>{issue.state ?? issue.status ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
