import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { sentryApi } from '../lib/sentry-api.js';

export function Environment(): React.JSX.Element {
  const environment = useQuery({
    queryKey: ['environment'],
    queryFn: () => sentryApi().doctors.environment(),
  });
  const data = environment.data as
    | {
        agentStacks: Array<{
          id: string;
          displayName: string;
          modelId: string;
          configured?: boolean;
          binaryAvailable?: boolean;
          runtimeVerified?: boolean;
          readiness?: string;
        }>;
        verifier?: {
          sandboxAvailable?: boolean;
          runtimeReplaySupported?: boolean;
          reason?: string;
        };
        simulation: { label: string };
      }
    | undefined;
  if (environment.isLoading) return <div className="skeleton">Loading environment…</div>;
  if (environment.isError || data === undefined)
    return (
      <div className="error-box" role="alert">
        Environment unavailable.
      </div>
    );
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Environment</h1>
      {data.verifier?.sandboxAvailable === false ? (
        <div className="error-box" style={{ marginBottom: 12 }}>
          Verifier runtime replay unavailable — {data.verifier.reason ?? 'sandbox unavailable'}.
          Source verification remains available.
        </div>
      ) : null}
      <div className="cards">
        {(data.agentStacks ?? []).map((stack) => (
          <div className="card" key={stack.id}>
            <h3>{stack.displayName}</h3>
            <p className="mono muted">{stack.modelId}</p>
            <p>
              Harness: {stack.configured === true ? 'Ready' : 'Not configured'} · Binary:{' '}
              {stack.binaryAvailable === true ? 'Found' : 'Missing'} · Model: {stack.modelId} ·
              Credential: {stack.configured === true ? 'Configured' : 'Missing'} (value never
              displayed)
            </p>
            <p className="muted">Status: {stack.readiness ?? 'unknown'}</p>
          </div>
        ))}
        <div className="card">
          <h3>Verifier</h3>
          <p>
            {data.verifier?.sandboxAvailable === true ? '\u2713' : '!'} WSL/sandbox:{' '}
            {data.verifier?.sandboxAvailable === true ? 'available' : 'unavailable'} · Runtime
            replay: {data.verifier?.runtimeReplaySupported === true ? 'supported' : 'unsupported'}
          </p>
          {data.verifier?.reason !== undefined ? (
            <p className="muted">{data.verifier.reason}</p>
          ) : null}
        </div>
        <div className="card">
          <h3>Simulation</h3>
          <p>{data.simulation.label}</p>
        </div>
      </div>
    </div>
  );
}
