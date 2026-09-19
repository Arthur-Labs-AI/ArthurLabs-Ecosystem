import React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CopyId } from '../components/CopyId.js';
import { sentryApi } from '../lib/sentry-api.js';

// Issue state comes from the backend projector (projectIssueState in main).
// The renderer never derives state from events on its own.

export function IssueDetail(): React.JSX.Element {
  const { issueId } = useParams();
  const queryClient = useQueryClient();
  const [error, setError] = React.useState<string | undefined>(undefined);
  const issue = useQuery({
    queryKey: ['issue', issueId],
    queryFn: () => sentryApi().issues.get(issueId as string),
    enabled: issueId !== undefined,
  });
  const history = useQuery({
    queryKey: ['issue-history', issueId],
    queryFn: () => sentryApi().issues.history(issueId as string),
    enabled: issueId !== undefined,
  });
  const navigate = useNavigate();
  const [retestExecution, setRetestExecution] = React.useState<'simulation' | 'production'>(
    'simulation',
  );
  const [confirmProductionRetest, setConfirmProductionRetest] = React.useState(false);
  const readiness = useQuery({
    queryKey: ['production-readiness'],
    queryFn: () => sentryApi().production.readiness(),
  });
  const productionBlocked = (readiness.data as { ready?: boolean } | undefined)?.ready !== true;
  const retest = useMutation({
    mutationFn: () =>
      sentryApi().retests.start(issueId as string, {
        ...(retestExecution === 'production' ? { executionKind: 'production' as const } : {}),
      }),
    onSuccess: (operation) => {
      setError(undefined);
      setConfirmProductionRetest(false);
      void queryClient.invalidateQueries({ queryKey: ['issue-history', issueId] });
      // Live Retest: navigate to the live Retest workspace immediately.
      const retestRunId = (operation as { retestRunId?: string }).retestRunId;
      if (retestRunId !== undefined) navigate('/retests/' + retestRunId);
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  const data = issue.data as
    | {
        id: string;
        title: string;
        severity: string;
        category?: string;
        createdAt?: string;
        updatedAt?: string;
      }
    | undefined;
  const historyData = history.data as
    | {
        occurrences: Array<{
          id: string;
          projectRevisionId?: string;
          projectSnapshotId?: string;
          qaRunId?: string;
          mergeResultId?: string;
          findingClusterId?: string;
          verificationRunId?: string;
          createdAt?: string;
        }>;
        events: Array<{
          kind?: string;
          fromState?: string;
          toState?: string;
          message?: string;
          createdAt?: string;
        }>;
        retests: Array<{ id: string; status: string }>;
        assessments: Array<{ id: string; result?: string; rationale?: string }>;
      }
    | undefined;
  const state =
    (historyData as { currentState?: string } | undefined)?.currentState ??
    (issue.data as { currentState?: string } | undefined)?.currentState ??
    'open';
  return (
    <div>
      <p className="muted" style={{ margin: 0 }}>
        <Link to="/issues">Issues</Link> / <CopyId id={issueId ?? ''} />
      </p>
      <h1 style={{ marginTop: 4 }}>{data?.title ?? 'Issue'}</h1>
      {data !== undefined ? (
        <p className="muted">
          {data.severity} · {data.category ?? ''} · State: {state}
        </p>
      ) : null}
      {error !== undefined ? (
        <div className="error-box" role="alert">
          {error}
        </div>
      ) : null}
      <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, marginBottom: 8 }}>
        <legend className="muted">Retest execution</legend>
        <label style={{ display: 'block' }}>
          <input
            type="radio"
            name="retest-execution"
            checked={retestExecution === 'simulation'}
            onChange={() => {
              setRetestExecution('simulation');
              setConfirmProductionRetest(false);
            }}
          />{' '}
          Simulation <span className="muted">(FakeHarness — never provider spend)</span>
        </label>
        <label style={{ display: 'block', opacity: productionBlocked ? 0.75 : 1 }}>
          <input
            type="radio"
            name="retest-execution"
            checked={retestExecution === 'production'}
            disabled={productionBlocked}
            onChange={() => {
              setRetestExecution('production');
              setConfirmProductionRetest(false);
            }}
          />{' '}
          Production <span className="muted">(real provider run — consumes budget)</span>
        </label>
      </fieldset>
      {retestExecution === 'production' && !confirmProductionRetest ? (
        <p className="error-box" style={{ marginBottom: 8 }} role="alert">
          Production retest: this calls the real provider APIs and consumes budget. Press Retest
          again to confirm.
        </p>
      ) : null}
      <button
        className="primary"
        onClick={() => {
          if (retestExecution === 'production' && !confirmProductionRetest) {
            setConfirmProductionRetest(true);
            return;
          }
          retest.mutate();
        }}
        disabled={retest.isPending}
      >
        {retest.isPending
          ? 'Starting retest…'
          : retestExecution === 'production'
            ? confirmProductionRetest
              ? 'Confirm Production Retest'
              : 'Retest Issue (Production)'
            : 'Retest Issue'}
      </button>
      <h2>Occurrences</h2>
      {(historyData?.occurrences ?? []).length === 0 ? (
        <p className="muted">No occurrences recorded.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Occurrence</th>
              <th>Revision</th>
              <th>Run</th>
              <th>Verification</th>
            </tr>
          </thead>
          <tbody>
            {(historyData?.occurrences ?? []).map((occ) => (
              <tr key={occ.id}>
                <td>
                  <CopyId id={occ.id} />
                </td>
                <td className="mono">{(occ.projectRevisionId ?? '').slice(0, 14)}</td>
                <td>
                  {occ.qaRunId !== undefined ? (
                    <Link to={'/runs/' + occ.qaRunId} className="mono">
                      {(occ.qaRunId ?? '').slice(0, 14)}
                    </Link>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="mono">{(occ.verificationRunId ?? '—').slice(0, 14)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>History</h2>
      {(historyData?.events ?? []).length === 0 && (historyData?.retests ?? []).length === 0 ? (
        <p className="muted">No events yet.</p>
      ) : (
        <div className="timeline">
          {(historyData?.events ?? []).map((event, index) => (
            <div key={index} className="item">
              <span className="time">{event.createdAt ?? ''}</span>
              <span>{event.kind ?? 'event'}</span>
              <span className="muted">
                {(event.fromState ?? '') !== '' ? event.fromState + ' → ' : ''}
                {event.toState ?? ''} {event.message ?? ''}
              </span>
            </div>
          ))}
          {(historyData?.retests ?? []).map((retestRun) => (
            <div key={retestRun.id} className="item">
              <span>Retest</span>
              <Link to={'/retests/' + retestRun.id} className="mono">
                {retestRun.id.slice(0, 14)}
              </Link>
              <span className="muted">{retestRun.status}</span>
            </div>
          ))}
        </div>
      )}
      <h2>Verification</h2>
      {(historyData?.assessments ?? []).length === 0 ? (
        <p className="muted">No retest assessments yet.</p>
      ) : (
        <ul>
          {(historyData?.assessments ?? []).map((assessment) => (
            <li key={assessment.id}>
              {assessment.result ?? ''} — {assessment.rationale ?? ''} <CopyId id={assessment.id} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
