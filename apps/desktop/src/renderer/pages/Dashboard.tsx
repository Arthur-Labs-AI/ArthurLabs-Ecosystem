import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, FolderKanban, Plus } from 'lucide-react';
import { sentryApi } from '../lib/sentry-api.js';
import { PageHeader, PageSection } from '../components/ui/PageHeader.js';
import { StatusPill, dotClassForStatus } from '../components/ui/StatusPill.js';
import { EmptyState } from '../components/ui/EmptyState.js';

interface ProjectListItem {
  projectId: string;
  name: string;
  currentRevisionId?: string;
  runCount?: number;
}

interface ActiveRunItem {
  runId: string;
  status: string;
  projectId?: string;
  mode?: string;
}

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
  const projectList = (projects.data as ProjectListItem[] | undefined) ?? [];
  const active = (activeRuns.data as ActiveRunItem[] | undefined) ?? [];
  const envReady = environment.data !== undefined;
  return (
    <div className="page">
      <PageHeader
        title="Dashboard"
        subtitle="Independent AI QA across OpenCode, DeepSeek, and GLM."
        actions={
          <Link to="/projects">
            <button className="primary">
              <Plus size={15} /> Add Project
            </button>
          </Link>
        }
      />
      <div className="metric-grid" role="list" aria-label="Workspace metrics">
        <div className="metric-card" role="listitem">
          <div className="metric-value">{projects.data === undefined ? '—' : projectList.length}</div>
          <div className="metric-label">Projects</div>
        </div>
        <div className="metric-card" role="listitem">
          <div className="metric-value">{active.length}</div>
          <div className="metric-label">Active QA</div>
        </div>
        <div className="metric-card" role="listitem">
          <div className="metric-value" style={{ fontSize: 15 }}>
            {envReady ? (
              <StatusPill status="ready" label="Runtime ready" />
            ) : (
              <StatusPill status="probing" label="Probing runtime" />
            )}
          </div>
          <div className="metric-label">Runtime</div>
        </div>
      </div>
      <PageSection title="Active QA">
        {active.length === 0 ? (
          <div className="empty" role="status">
            <span>No QA running right now.</span>
            <Link to="/projects">Open Projects to start a run</Link>
          </div>
        ) : (
          <div className="cards">
            {active.slice(0, 3).map((run) => (
              <div className="card" key={run.runId}>
                <div className="chip-row">
                  <span className="badge">{(run.mode ?? 'full').toUpperCase()} QA</span>
                  <StatusPill status={run.status} pulse />
                </div>
                <p className="metadata mono truncate" title={run.runId} style={{ margin: '8px 0' }}>
                  {run.runId}
                </p>
                <Link to={'/runs/' + run.runId}>
                  <button className="compact primary">
                    Open Run <ArrowRight size={13} />
                  </button>
                </Link>
              </div>
            ))}
          </div>
        )}
      </PageSection>
      <PageSection
        title="Recent projects"
        actions={
          <Link to="/projects" className="metadata">
            Open Projects
          </Link>
        }
      >
        {projectList.length === 0 ? (
          <EmptyState
            title="No projects yet"
            body="Add a local repository and run your first independent AI QA scan."
            action={
              <Link to="/projects">
                <button className="primary">
                  <Plus size={15} /> Add Project
                </button>
              </Link>
            }
          />
        ) : (
          <div className="project-grid">
            {projectList.slice(0, 6).map((project) => (
              <div className="card" key={project.projectId}>
                <div className="agent-row">
                  <FolderKanban size={16} aria-hidden="true" className="faint" />
                  <span className="grow truncate card-title" title={project.name}>
                    {project.name}
                  </span>
                  <Link to={'/projects/' + project.projectId}>
                    <button className="compact ghost">
                      Open <ArrowRight size={13} />
                    </button>
                  </Link>
                </div>
                <div className="metadata" style={{ marginTop: 6 }}>
                  {project.runCount !== undefined ? (
                    <span>
                      {project.runCount} run{project.runCount === 1 ? '' : 's'}
                    </span>
                  ) : null}
                  {project.currentRevisionId !== undefined && project.currentRevisionId !== '' ? (
                    <span className="mono" title={project.currentRevisionId}>
                      {' '}· rev {project.currentRevisionId.slice(0, 12)}
                    </span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </PageSection>
      {active.length > 0 ? (
        <div className="metadata" aria-live="polite">
          <span className={dotClassForStatus('running') + ' pulse'} aria-hidden="true" />{' '}
          {active.length} QA run{active.length === 1 ? '' : 's'} in progress
        </div>
      ) : null}
    </div>
  );
}
