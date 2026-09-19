import React from 'react';
import { summarizeVerificationAttempts } from '../lib/verify-summary.js';
import { CopyId } from './CopyId.js';
import { StatusLabel } from './StatusGlyph.js';

export function MergerInspector({
  payload,
}: {
  payload: Record<string, unknown>;
}): React.JSX.Element {
  const mergeResultId = payload['mergeResultId'] as string | undefined;
  const clusters = (payload['clusters'] as Array<Record<string, unknown>> | undefined) ?? [];
  const usable = payload['usableAgentCount'] as number | undefined;
  const expected = payload['expectedAgentCount'] as number | undefined;
  const unavailable = (payload['unavailableAgentStackIds'] as string[] | undefined) ?? [];
  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Merger v2</h3>
      <p className="muted">
        Merger Version 2 · Normalizer Version {String(payload['normalizerVersion'] ?? 1)}
      </p>
      {mergeResultId !== undefined ? (
        <p>
          <CopyId id={mergeResultId} />
        </p>
      ) : null}
      <p>
        Usable agents {usable ?? '—'}
        {expected !== undefined ? ' / ' + expected : ''}
      </p>
      {unavailable.length > 0 ? (
        <p>Unavailable: {unavailable.join(', ')}</p>
      ) : (
        <p>Unavailable: none</p>
      )}
      <p>Clusters: {clusters.length}</p>
      {clusters.map((cluster) => (
        <div key={String(cluster['id'])} className="card" style={{ marginBottom: 8 }}>
          <strong>Issue candidate</strong>
          <p>
            <CopyId id={String(cluster['id'])} />
          </p>
          <p className="muted">
            Agreement: {String(cluster['agreementState'] ?? 'unknown')} ·{' '}
            {String(cluster['supportingAgentCount'] ?? '?')} supporting /{' '}
            {String(cluster['usableAgentCount'] ?? '?')} usable (expected{' '}
            {String(cluster['expectedAgentCount'] ?? '?')})
          </p>
          <p className="muted">
            Reported by:{' '}
            {((cluster['sourceAgentStackIds'] as string[] | undefined) ?? []).join(', ') || '—'}
          </p>
          <p className="faint">Agreement is not confidence.</p>
        </div>
      ))}
    </div>
  );
}

export function VerifierInspector({
  payload,
}: {
  payload: Record<string, unknown>;
}): React.JSX.Element {
  const attempts = (payload['attempts'] as Array<Record<string, unknown>> | undefined) ?? [];
  const counts = summarizeVerificationAttempts(attempts as Array<{ outcome?: string }>);
  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Verifier v3</h3>
      <p className="muted">
        Verifier {String(payload['verifierVersion'] ?? 3)} · Recipe{' '}
        {String(payload['recipeVersion'] ?? 3)} · Signature{' '}
        {String(payload['signatureVersion'] ?? 3)}
      </p>
      <p>
        Attempts {counts.attempts} · Reproduced {counts.reproduced} · Partial {counts.partial} · Not
        repro {counts.notReproducible} · Inconclusive {counts.inconclusive}
      </p>
      {attempts.map((attempt, index) => (
        <div key={String(attempt['id'] ?? index)} className="card" style={{ marginBottom: 8 }}>
          <strong>
            Cluster <CopyId id={String(attempt['findingClusterId'] ?? 'unknown')} short={12} />
          </strong>
          <p>
            Outcome:{' '}
            {String(attempt['outcome'] ?? attempt['status'] ?? 'pending')
              .toUpperCase()
              .replace(/_/g, ' ')}
          </p>
          {attempt['matchStrength'] !== undefined ? (
            <p className="muted">Match: {String(attempt['matchStrength']).replace(/_/g, ' ')}</p>
          ) : null}
          {((attempt['steps'] as Array<Record<string, unknown>> | undefined) ?? []).length > 0 ? (
            <p className="muted">
              Steps:{' '}
              {((attempt['steps'] as Array<Record<string, unknown>>) ?? [])
                .map(
                  (s) =>
                    String(s['type'] ?? '?') + ':' + String(s['outcome'] ?? s['status'] ?? '?'),
                )
                .join(' · ')}
            </p>
          ) : null}
          {attempt['outcome'] === 'inconclusive' ? (
            <p className="muted">? INCONCLUSIVE — runtime observation unavailable.</p>
          ) : null}
        </div>
      ))}
      {attempts.length === 0 ? (
        <p className="muted">No verification attempts yet. Run Verify after merging.</p>
      ) : null}
    </div>
  );
}

export function IssuesInspector({
  payload,
  occurrences,
}: {
  payload: Record<string, unknown>;
  occurrences: unknown[];
}): React.JSX.Element {
  const count = (payload['count'] as number | undefined) ?? 0;
  if (count === 0) {
    return (
      <div>
        <h3 style={{ marginTop: 0 }}>Issues</h3>
        <p className="muted">No issues ingested.</p>
      </div>
    );
  }
  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Issues</h3>
      <p>{count} created</p>
      {(occurrences as Array<Record<string, unknown>>).slice(0, 20).map((occ, index) => (
        <div key={String(occ['id'] ?? index)} className="card" style={{ marginBottom: 8 }}>
          <CopyId id={String(occ['issueId'] ?? occ['id'] ?? 'unknown')} />
          <p className="muted">Cluster {String(occ['findingClusterId'] ?? '—')}</p>
        </div>
      ))}
    </div>
  );
}

export function EdgeInspector({
  edge,
}: {
  edge: { source: string; target: string };
}): React.JSX.Element {
  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Edge</h3>
      <p className="mono muted">
        {edge.source} → {edge.target}
      </p>
      {edge.source.startsWith('agent-') && edge.target === 'merger' ? (
        <p className="muted">Agent output flows into Merger v2 once the agent is terminal.</p>
      ) : null}
      {edge.source === 'merger' && edge.target === 'verifier' ? (
        <p className="muted">
          Merge clusters flow into Verifier v3 for attempt-based verification.
        </p>
      ) : null}
    </div>
  );
}

export function NodeStatusHeader({
  label,
  status,
}: {
  label: string;
  status: string;
}): React.JSX.Element {
  return (
    <div>
      <h3 style={{ marginTop: 0 }}>{label}</h3>
      <p className="muted">
        <StatusLabel status={status} />
      </p>
    </div>
  );
}
