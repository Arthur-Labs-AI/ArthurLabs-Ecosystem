import React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, FlaskConical } from 'lucide-react';
import { CopyId } from '../components/CopyId.js';
import { PageHeader, PageSection } from '../components/ui/PageHeader.js';
import { StatusPill, dotClassForStatus } from '../components/ui/StatusPill.js';
import { SegmentedControl } from '../components/ui/Tabs.js';
import { sentryApi } from '../lib/sentry-api.js';

const AGENT_ORDER = ['stack_opencode_main', 'stack_deepseek_main', 'stack_glm_main'];

function shortModel(modelId: string | undefined): string {
  if (modelId === undefined || modelId === '') return 'Default model';
  const parts = modelId.split('/');
  return parts[parts.length - 1] ?? modelId;
}

export function ProjectDetail(): React.JSX.Element {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [mode, setMode] = React.useState<'full' | 'targeted'>('full');
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
  const environment = useQuery({
    queryKey: ['environment'],
    queryFn: () => sentryApi().doctors.environment(),
  });
  const stacks = (
    (
      environment.data as
        | {
            agentStacks?: Array<{
              id: string;
              displayName: string;
              readiness?: string;
              modelId?: string;
            }>;
          }
        | undefined
    )?.agentStacks ?? []
  )
    .filter(
      (s) =>
        s.id === 'stack_opencode_main' ||
        s.id === 'stack_deepseek_main' ||
        s.id === 'stack_glm_main',
    )
    .sort((a, b) => AGENT_ORDER.indexOf(a.id) - AGENT_ORDER.indexOf(b.id));
  const [selectedStacks, setSelectedStacks] = React.useState<string[] | undefined>(undefined);
  const effectiveStacks = selectedStacks ?? stacks.map((s) => s.id);
  const toggleStack = (id: string): void => {
    const base = selectedStacks ?? stacks.map((s) => s.id);
    setSelectedStacks(base.includes(id) ? base.filter((s) => s !== id) : [...base, id]);
  };
  const [confirmStart, setConfirmStart] = React.useState<'full' | 'targeted' | undefined>(
    undefined,
  );
  const readiness = useQuery({
    queryKey: ['production-readiness', [...effectiveStacks].sort()],
    queryFn: () => sentryApi().production.readiness({ agentStackIds: effectiveStacks }),
  });
  const gate = readiness.data as
    | { ready?: boolean; reasons?: string[]; productionWired?: boolean }
    | undefined;
  const startOptions = (runMode: 'full' | 'targeted'): Record<string, unknown> => ({
    mode: runMode,
    ...(runMode === 'targeted'
      ? {
          includePaths: targetPaths
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
        }
      : {}),
    ...(effectiveStacks.length === 0 ? {} : { agentStackIds: effectiveStacks }),
  });
  const onStarted = (operation: unknown): void => {
    const runId = (operation as { runId?: string }).runId;
    if (runId !== undefined) navigate('/runs/' + runId);
    setConfirmStart(undefined);
    void queryClient.invalidateQueries({ queryKey: ['project-runs', projectId] });
  };
  const onStartError = (e: unknown): void => setError(e instanceof Error ? e.message : String(e));
  const startFull = useMutation({
    mutationFn: () => sentryApi().runs.start(projectId as string, startOptions('full') as never),
    onSuccess: onStarted,
    onError: onStartError,
  });
  const startTargeted = useMutation({
    mutationFn: () =>
      sentryApi().runs.start(projectId as string, startOptions('targeted') as never),
    onSuccess: onStarted,
    onError: onStartError,
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
  const pendingStart = confirmStart !== undefined;
  const startPending = startFull.isPending || startTargeted.isPending;
  return (
    <div className="page">
      <PageHeader
        title={record?.project.name ?? 'Project'}
        subtitle={record?.project.sourcePath ?? projectId}
        crumbs={
          <>
            <Link to="/projects">Projects</Link> / {record?.project.name ?? 'Project'}
          </>
        }
        actions={
          <button onClick={() => update.mutate()} disabled={update.isPending}>
            {update.isPending ? 'Updating…' : 'Update Project'}
          </button>
        }
      />
      {error !== undefined ? (
        <div className="error-box" role="alert">
          {error}{' '}
          <button className="compact ghost" onClick={() => setError(undefined)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {record?.managedCopy.state === 'locked_for_run' ? (
        <div className="inline-notice tone-warning" role="status">
          Project is in use by {record?.managedCopy.lockedByQARunId ?? 'an active run'}. Update
          cannot start until the run finishes.
        </div>
      ) : null}
      <PageSection title="Overview">
        <div className="cards">
          <div className="card">
            <h3 className="card-title">Project state</h3>
            <div style={{ marginTop: 8 }}>
              <StatusPill status={record?.managedCopy.state ?? 'unknown'} />
            </div>
            <dl className="kv" style={{ marginTop: 8 }}>
              <dt>Revision</dt>
              <dd>
                <CopyId id={record?.revision.id ?? ''} />
              </dd>
              <dt>Runs</dt>
              <dd>{runList.length}</dd>
            </dl>
          </div>
          <div className="card">
            <h3 className="card-title">Readiness</h3>
            {doctorData === undefined ? (
              <p className="muted">Probing…</p>
            ) : (
              <>
                <div style={{ marginTop: 8 }}>
                  <StatusPill
                    status={doctorData.ready === true ? 'ready' : 'not ready'}
                    label={doctorData.ready === true ? 'Ready' : 'Not ready'}
                  />
                </div>
                <p className="metadata">
                  Ecosystem: {(doctorData.detectedEcosystem ?? []).join(', ') || '—'}
                </p>
                {(doctorData.warnings ?? []).map((warning) => (
                  <p key={warning} className="metadata">
                    ! {warning}
                  </p>
                ))}
              </>
            )}
          </div>
        </div>
      </PageSection>
      <PageSection title="Run QA">
        <div className="card">
          <p className="body-secondary" style={{ marginTop: 0 }}>
            Real provider run — selected agents execute against this project and consume provider
            budget.
          </p>
          {gate !== undefined && gate.ready !== true ? (
            <div className="error-box" role="alert" style={{ marginBottom: 12 }}>
              <strong>Cannot start QA</strong>
              <ul style={{ margin: '4px 0 8px', paddingLeft: 18 }}>
                {(gate.reasons ?? []).map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
              <span>
                <Link to="/settings">Open Provider Settings</Link> ·{' '}
                <Link to="/environment">Open Environment</Link>
              </span>
            </div>
          ) : null}
          <SegmentedControl
            label="QA mode"
            value={mode}
            onChange={(value) => setMode(value as 'full' | 'targeted')}
            options={[
              { value: 'full', label: 'Full QA' },
              { value: 'targeted', label: 'Targeted QA' },
            ]}
          />
          <div className="metadata" style={{ margin: '12px 0 6px' }}>
            Agents
          </div>
          {stacks.length === 0 ? (
            <span className="muted">Loading agent readiness…</span>
          ) : (
            <div className="project-grid">
              {stacks.map((stack) => {
                const selected = effectiveStacks.includes(stack.id);
                return (
                  <button
                    key={stack.id}
                    className="card agent-card"
                    aria-pressed={selected}
                    onClick={() => toggleStack(stack.id)}
                    title={(selected ? 'Deselect ' : 'Select ') + stack.displayName}
                    style={
                      selected ? { borderColor: 'var(--accent)' } : undefined
                    }
                  >
                    <span
                      className={dotClassForStatus(stack.readiness ?? '')}
                      aria-hidden="true"
                      style={{ marginTop: 4 }}
                    />
                    <span className="grow">
                      <span className="card-title" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        {selected ? <Check size={14} aria-hidden="true" /> : null}
                        {stack.displayName}
                      </span>
                      <span
                        className="mono metadata truncate"
                        style={{ display: 'block' }}
                        title={stack.modelId ?? 'Default model'}
                      >
                        {shortModel(stack.modelId)}
                      </span>
                      <span className="metadata">{stack.readiness ?? 'unknown'}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {stacks.length > 0 && effectiveStacks.length === 0 ? (
            <p className="error-box" style={{ marginTop: 8 }} role="alert">
              Select at least one agent to start a run.
            </p>
          ) : null}
          {mode === 'targeted' ? (
            <div style={{ marginTop: 12 }}>
              <TargetPathInput
                projectId={projectId as string}
                value={targetPaths}
                onChange={setTargetPaths}
              />
              <p className="metadata">
                Agents remain full-strength QA workers; findings should relate to the selected
                scope.
              </p>
            </div>
          ) : null}
          <div style={{ marginTop: 12 }}>
            <button
              className="primary"
              onClick={() => setConfirmStart(mode)}
              disabled={startPending || effectiveStacks.length === 0 || gate?.ready !== true}
            >
              <FlaskConical size={15} />{' '}
              {mode === 'full' ? 'Start Full QA' : 'Start Targeted QA'}
            </button>
          </div>
        </div>
      </PageSection>
      <PageSection title="Recent runs">
        {runList.length === 0 ? (
          <div className="empty">No QA runs yet.</div>
        ) : (
          <div className="project-grid">
            {runList.slice(0, 6).map((run) => (
              <article className="card" key={run.id} aria-label={run.mode + ' QA ' + run.status}>
                <div className="chip-row">
                  <span className="badge">{run.mode.toUpperCase()} QA</span>
                  <StatusPill status={run.status} />
                </div>
                <div className="metadata mono truncate" style={{ margin: '8px 0' }} title={run.id}>
                  {run.id}
                </div>
                <Link to={'/runs/' + run.id}>
                  <button className="compact primary">
                    Open <ArrowRight size={13} />
                  </button>
                </Link>
              </article>
            ))}
          </div>
        )}
      </PageSection>
      <PageSection title="Revisions">
        <div className="timeline">
          {revisionList.map((revision) => (
            <div key={revision.id} className="item">
              <CopyId id={revision.id} />
              <span className="time">{revision.importedAt}</span>
            </div>
          ))}
          {revisionList.length === 0 ? <p className="muted">No revisions yet.</p> : null}
        </div>
      </PageSection>
      {pendingStart ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={'Confirm start ' + confirmStart + ' QA'}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            zIndex: 60,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
          onClick={() => setConfirmStart(undefined)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setConfirmStart(undefined);
          }}
        >
          <div
            className="card"
            style={{ maxWidth: 420, width: '100%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="section-title">
              Start {confirmStart === 'full' ? 'Full' : 'Targeted'} QA?
            </h2>
            <p className="body-secondary">
              {effectiveStacks.length} agent{effectiveStacks.length === 1 ? '' : 's'} · uses real
              provider budget.
            </p>
            {confirmStart === 'targeted' && targetPaths.trim() !== '' ? (
              <p className="mono metadata">Scope: {targetPaths}</p>
            ) : null}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="ghost" onClick={() => setConfirmStart(undefined)}>
                Cancel
              </button>
              <button
                className="primary"
                autoFocus
                disabled={startPending}
                onClick={() =>
                  confirmStart === 'full' ? startFull.mutate() : startTargeted.mutate()
                }
              >
                {startPending ? 'Starting…' : 'Start QA'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
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
  const allPaths = ((suggestions.data as { paths?: string[] } | undefined)?.paths ?? []).map((q) =>
    q.endsWith('/') ? q.slice(0, -1) : q,
  );
  const [draft, setDraft] = React.useState('');
  const [invalid, setInvalid] = React.useState<string | undefined>(undefined);
  const chips = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const addDraft = (raw: string): void => {
    const candidate = raw.trim();
    if (candidate.length === 0) return;
    if (candidate.startsWith('/') || candidate.includes('..')) {
      setInvalid('Paths must be project-relative (no leading / or ..): ' + candidate);
      return;
    }
    setInvalid(undefined);
    if (chips.includes(candidate)) {
      setDraft('');
      return;
    }
    onChange([...chips, candidate].join(','));
    setDraft('');
  };
  const removeChip = (chip: string): void => {
    onChange(chips.filter((c) => c !== chip).join(','));
  };
  return (
    <div>
      <div className="metadata">Target scope</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addDraft(draft);
            }
          }}
          placeholder="Search files… (e.g. src/auth/token.ts)"
          aria-label="Add target path"
          style={{ flex: 1 }}
        />
        <button onClick={() => addDraft(draft)} disabled={draft.trim().length === 0}>
          Add path
        </button>
      </div>
      {invalid !== undefined ? (
        <p className="error-box" style={{ marginTop: 8 }} role="alert">
          {invalid}
        </p>
      ) : null}
      {chips.length > 0 ? (
        <div className="chip-row" style={{ marginTop: 8 }}>
          {chips.map((chip) => (
            <span key={chip} className="copy-chip" title={chip}>
              <span className="truncate" style={{ maxWidth: 220 }}>
                {chip}
              </span>
              <button onClick={() => removeChip(chip)} aria-label={'Remove ' + chip}>
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {allPaths.length > 0 ? (
        <div className="chip-row" style={{ marginTop: 8 }}>
          <span className="metadata">In this project:</span>
          {allPaths.slice(0, 8).map((q) => (
            <button
              key={q}
              className="compact ghost"
              onClick={() => addDraft(q)}
              title={'Add ' + q}
            >
              +{q}
            </button>
          ))}
        </div>
      ) : null}
      <p className="mono metadata" style={{ fontSize: 11 }}>
        TargetSpec preview: includePaths=[{chips.length === 0 ? '—' : chips.join(', ')}]
      </p>
    </div>
  );
}

