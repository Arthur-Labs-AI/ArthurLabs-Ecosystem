import React from 'react';
import { Link } from 'react-router-dom';
import { useQueries, useQuery } from '@tanstack/react-query';
import { sentryApi } from '../lib/sentry-api.js';
import { PageHeader, PageSection } from '../components/ui/PageHeader.js';
import { EmptyState } from '../components/ui/EmptyState.js';
import { History as HistoryIcon } from 'lucide-react';

export function History(): React.JSX.Element {
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => sentryApi().projects.list() });
  const projectList =
    (projects.data as Array<{ projectId: string; name: string }> | undefined) ?? [];
  const [projectId, setProjectId] = React.useState('');
  const effective = projectId !== '' ? projectId : (projectList[0]?.projectId ?? '');
  const runs = useQuery({
    queryKey: ['project-runs', effective],
    queryFn: () => sentryApi().runs.list(effective),
    enabled: effective !== '',
  });
  const issues = useQuery({
    queryKey: ['project-issues', effective],
    queryFn: () => sentryApi().issues.list(effective),
    enabled: effective !== '',
  });
  const runList =
    (runs.data as
      Array<{ id: string; mode: string; status: string; createdAt: string }> | undefined) ?? [];
  const issueList =
    (issues.data as Array<{ id: string; title: string; severity: string }> | undefined) ?? [];
  const histories = useQueries({
    queries: issueList.slice(0, 20).map((issue) => ({
      queryKey: ['issue-history', issue.id],
      queryFn: () => sentryApi().issues.history(issue.id),
      enabled: effective !== '',
    })),
  });
  const timeline = [
    ...runList.map((run) => ({
      at: run.createdAt,
      label: run.mode + ' run ' + run.status,
      to: '/runs/' + run.id,
    })),
    ...histories.flatMap((h) => {
      const data = h.data as
        | { retests?: Array<{ id: string; status: string }>; assessments?: Array<{ id: string }> }
        | undefined;
      return (data?.retests ?? []).map((retest) => ({
        at: '',
        label: 'retest ' + retest.status,
        to: '/retests/' + retest.id,
      }));
    }),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));
  return (
    <div className="page">
      <PageHeader
        title="History"
        subtitle="Trace runs, retests, and issue activity across your workspace."
      />
      <div className="filter-toolbar">
        <select
          value={effective}
          onChange={(e) => setProjectId(e.target.value)}
          aria-label="Project"
        >
          {projectList.map((project) => (
            <option key={project.projectId} value={project.projectId}>
              {project.name}
            </option>
          ))}
        </select>
      </div>
      <PageSection title="Runs, retests & issues">
        {timeline.length === 0 && issueList.length === 0 ? (
          <EmptyState title="No history yet." body="Recorded project activity will appear here." />
        ) : (
          <div className="timeline">
            {timeline.map((item) => (
              <div key={item.to} className="item">
                <HistoryIcon size={14} className="faint" aria-hidden="true" />
                {item.at !== '' ? <span className="time">{item.at}</span> : null}
                <Link to={item.to}>{item.label}</Link>
              </div>
            ))}
            {issueList.map((issue) => (
              <div key={issue.id} className="item">
                <span>Issue</span>
                <Link to={'/issues/' + issue.id}>{issue.title}</Link>
                <span className="muted">{issue.severity}</span>
              </div>
            ))}
          </div>
        )}
      </PageSection>
    </div>
  );
}
