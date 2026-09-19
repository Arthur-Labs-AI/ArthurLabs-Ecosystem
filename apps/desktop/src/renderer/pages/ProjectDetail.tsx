import React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CopyId } from '../components/CopyId.js';
import { sentryApi } from '../lib/sentry-api.js';

export function ProjectDetail(): React.JSX.Element {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [targetPaths, setTargetPaths] = React.useState('');
  const detail = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => sentryApi().projects.get(projectId as string),
    enabled: projectId !== undefined,
  });
  const runs = useQuery({
    queryKey: ['project-runs', projectId],
    queryFn: () => sentryApi().runs.list(projectId as string),
    enabled: projectId !== undefined,
  });
  const revisions = useQuery({
    queryKey: ['project-revisions', projectId],
    queryFn: () => sentryApi().projects.revisions(projectId as string),
    enabled: projectId !== undefined,
  });
  const issues = useQuery({
    queryKey: ['project-issues', projectId],
    queryFn: () => sentryApi().issues.list(projectId as string),
    enabled: projectId !== undefined,
  });
  const environment = useQuery({
    queryKey: ['environment'],
    queryFn: () => sentryApi().doctors.environment(),
  });
  const stacks = (
    (
      environment.data as
        { agentStacks?: Array<{ id: string; displayName: string; readiness?: string }> } | undefined
    )?.agentStacks ?? []
  ).filter(
    (s) =>
      s.id === 'stack_muse_main' || s.id === 'stack_deepseek_main' || s.id === 'stack_glm_main',
  );
  const [selectedStacks, setSelectedStacks] = React.useState<string[] | undefined>(undefined);
  const effectiveStacks = selectedStacks ?? stacks.map((s) => s.id);
  const toggleStack = (id: string): void => {
    const base = selectedStacks ?? stacks.map((s) => s.id);
    setSelectedStacks(base.includes(id) ? base.filter((s) => s !== id) : [...base, id]);
  };
  const startFull = useMutation({
    mutationFn: () =>
      sentryApi().runs.startSimulation(projectId as string, {
        mode: 'full',
        ...(effectiveStacks.length === 0 ? {} : { agentStackIds: effectiveStacks }),
      }),
    onSuccess: (operation) => {
      const runId = (operation as { runId?: string }).runId;
      if (runId !== undefined) navigate('/runs/' + runId);
      void queryClient.invalidateQueries({ queryKey: ['project-runs', projectId] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  const startTargeted = useMutation({
    mutationFn: () =>
      sentryApi().runs.startSimulation(projectId as string, {
        mode: 'targeted',
        includePaths: targetPaths
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
        ...(effectiveStacks.length === 0 ? {} : { agentStackIds: effectiveStacks }),
      }),
    onSuccess: (operation) => {
      const runId = (operation as { runId?: string }).runId;
      if (runId !== undefined) navigate('/runs/' + runId);
      void queryClient.invalidateQueries({ queryKey: ['project-runs', projectId] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  const update = useMutation({
    mutationFn: () => sentryApi().projects.update(projectId as string),
    onSuccess: () => {
      setError(undefined);
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['project-revisions', projectId] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  const doctor = useQuery({
    queryKey: ['project-doctor', projectId],
    queryFn: () => sentryApi().projects.doctor(projectId as string),
    enabled: projectId !== undefined,
  });
  const doctorData = doctor.data as
    | {
        ready?: boolean;
        managedCopyState?: string;
        warnings?: string[];
        detectedEcosystem?: string[];
      }
    | undefined;
  const record = detail.data as
    | {
        project: { name: string; sourcePath: string };
        revision: { id: string };
        managedCopy: { state: string; lockedByQARunId?: string };
      }
    | undefined;
  const runList =
    (runs.data as Array<{ id: string; mode: string; status: string }> | undefined) ?? [];
  const revisionList =
    (revisions.data as Array<{ id: string; importedAt: string }> | undefined) ?? [];
  const issueList = (issues.data as unknown[] | undefined) ?? [];
  return (
    <div>
      <p className="muted" style={{ margin: 0 }}>
        <Link to="/projects">Projects</Link> / {record?.project.name ?? projectId}
      </p>
      <h1 style={{ marginTop: 4 }}>{record?.project.name ?? 'Project'}</h1>
      {error !== undefined ? (
        <div className="error-box" role="alert">
          {error}
        </div>
      ) : null}
      <div className="cards">
        <div className="card">
          <h3>Overview</h3>
          <p className="mono muted">{record?.project.sourcePath ?? ''}</p>
          <p>State: {record?.managedCopy.state ?? '—'}</p>
          <p className="mono">
            Revision: <CopyId id={record?.revision.id ?? ''} />
          </p>
          <p>Open issues: {issueList.length}</p>
          <button onClick={() => update.mutate()} disabled={update.isPending}>
            {update.isPending ? 'Updating…' : 'Update Project'}
          </button>
          {record?.managedCopy.state === 'locked_for_run' ? (
            <p className="error-box" style={{ marginTop: 8 }}>
              Project is currently used by {record?.managedCopy.lockedByQARunId ?? 'an active run'}.
              Update cannot start until the run finishes.
            </p>
          ) : null}
        </div>
        <div className="card">
          <h3>Readiness</h3>
          {doctorData === undefined ? (
            <p className="muted">Probing…</p>
          ) : (
            <>
              <p>Ready: {doctorData.ready === true ? 'yes' : 'no'}</p>
              <p className="muted">
                Ecosystem: {(doctorData.detectedEcosystem ?? []).join(', ') || '—'}
              </p>
              {(doctorData.warnings ?? []).map((warning) => (
                <p key={warning} className="muted">
                  ! {warning}
                </p>
              ))}
            </>
          )}
        </div>
        <div className="card">
          <h3>Start QA (simulation)</h3>
          <p className="muted">Simulation mode — no provider tokens used.</p>
          <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, marginBottom: 8 }}>
            <legend className="muted">Agents</legend>
            {stacks.length === 0 ? (
              <span className="muted">Loading agent readiness…</span>
            ) : (
              stacks.map((stack) => (
                <label key={stack.id} style={{ display: 'block' }}>
                  <input
                    type="checkbox"
                    checked={effectiveStacks.includes(stack.id)}
                    onChange={() => toggleStack(stack.id)}
                  />{' '}
                  {stack.displayName}{' '}
                  <span className="muted">({stack.readiness ?? 'unknown'})</span>
                </label>
              ))
            )}
            {stacks.length > 0 && effectiveStacks.length === 0 ? (
              <p className="error-box" style={{ marginTop: 8 }}>
                Select at least one agent to start a run.
              </p>
            ) : null}
          </fieldset>
          <button
            className="primary"
            onClick={() => startFull.mutate()}
            disabled={startFull.isPending || effectiveStacks.length === 0}
          >
            Start Full QA
          </button>
          <div style={{ marginTop: 8 }}>
            <TargetPathInput
              projectId={projectId as string}
              value={targetPaths}
              onChange={setTargetPaths}
            />
            <p className="muted">
              Agents remain full-strength QA workers; findings should relate to the selected scope.
            </p>
            <button
              onClick={() => startTargeted.mutate()}
              disabled={startTargeted.isPending || effectiveStacks.length === 0}
            >
              Start Targeted QA
            </button>
          </div>
        </div>
      </div>
      <h2>Revisions</h2>
      <div className="timeline">
        {revisionList.map((revision) => (
          <div key={revision.id} className="item">
            <CopyId id={revision.id} />
            <span className="time">{revision.importedAt}</span>
          </div>
        ))}
      </div>
      <h2>Runs</h2>
      {runList.length === 0 ? (
        <div className="empty">No QA runs yet.</div>
      ) : (
        <ul>
          {runList.map((run) => (
            <li key={run.id}>
              <Link to={'/runs/' + run.id}>
                {run.mode} — {run.status}
              </Link>{' '}
              <span className="mono faint">{run.id.slice(0, 14)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TargetPathInput({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const suggestions = useQuery({
    queryKey: ['target-suggest', projectId],
    queryFn: () => sentryApi().projects.suggestTargets(projectId),
  });
  const paths = ((suggestions.data as { paths?: string[] } | undefined)?.paths ?? []).filter((q) =>
    q.endsWith('/'),
  );
  return (
    <>
      <label>
        Target paths (comma-separated)
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={paths[0] ?? 'src/auth'}
          style={{ width: '100%', marginTop: 4 }}
        />
      </label>
      {paths.length > 0 ? (
        <p className="muted">
          In this project:{' '}
          {paths.slice(0, 8).map((q) => (
            <button
              key={q}
              onClick={() =>
                onChange(value.trim().length === 0 ? q.slice(0, -1) : value + ',' + q.slice(0, -1))
              }
              title={'Add ' + q}
              style={{ padding: '0 6px', fontSize: 11, marginRight: 4 }}
            >
              +{q}
            </button>
          ))}
        </p>
      ) : null}
    </>
  );
}
