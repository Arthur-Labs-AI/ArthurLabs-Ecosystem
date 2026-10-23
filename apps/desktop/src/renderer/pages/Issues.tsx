import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { sentryApi } from '../lib/sentry-api.js';
import { PageHeader } from '../components/ui/PageHeader.js';
import { EmptyState } from '../components/ui/EmptyState.js';
import { StatusPill } from '../components/ui/StatusPill.js';

const STATE_FILTERS = [
  { value: '', label: 'All states' },
  { value: 'open', label: 'Open' },
  { value: 'still_reproducible', label: 'Still reproducible' },
  { value: 'partially_fixed', label: 'Partially fixed' },
  { value: 'fixed', label: 'Fixed' },
  { value: 'inconclusive', label: 'Inconclusive' },
] as const;

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
      | Array<{
          id: string;
          title: string;
          severity: string;
          currentState?: string;
          state?: string;
          status?: string;
        }>
      | undefined) ?? []
  ).filter((issue) => {
    // Backend-projected currentState is authoritative; renderer never derives.
    const state = issue.currentState ?? issue.state ?? issue.status;
    if (stateFilter !== '' && state !== stateFilter) return false;
    if (severityFilter !== '' && issue.severity !== severityFilter) return false;
    if (search !== '' && !issue.title.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });
  return (
    <div className="page">
      <PageHeader
        title="Issues"
        subtitle="Track findings and follow their verified resolution history."
      />
      <div className="filter-toolbar">
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
          {STATE_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
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
        <EmptyState
          title="No issues have been ingested."
          body="Issues matching your project and filters will appear here."
        />
      ) : (
        <div className="table-wrap">
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
                  <td>
                    <span className={'severity-badge severity-' + issue.severity}>
                      {issue.severity}
                    </span>
                  </td>
                  <td>
                    <Link to={'/issues/' + issue.id}>{issue.title}</Link>
                  </td>
                  <td>
                    <StatusPill
                      status={issue.currentState ?? issue.state ?? issue.status ?? 'unknown'}
                      label={issue.currentState ?? issue.state ?? issue.status ?? '—'}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
