import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { sentryApi } from '../lib/sentry-api.js';

interface RuntimeStatus {
  connected: boolean;
  distro: string | undefined;
  hello:
    | {
        protocolVersion: number;
        runtimeVersion: string;
        platform: string;
        isWsl: boolean;
        nodeVersion: string;
        processExecPath: string;
        distro?: string;
        dataRoot: string;
      }
    | undefined;
  lastError: string | undefined;
}

export function Environment(): React.JSX.Element {
  const environment = useQuery({
    queryKey: ['environment'],
    queryFn: () => sentryApi().doctors.environment(),
  });
  const runtime = useQuery({
    queryKey: ['runtime-status'],
    queryFn: () => sentryApi().runtime.status(),
    refetchInterval: 5000,
  });
  const data = environment.data as
    | {
        runtime?: {
          protocolVersion: number;
          runtimeVersion: string;
          platform: string;
          isWsl: boolean;
          nodeVersion: string;
          processExecPath: string;
          distro?: string;
          dataRoot: string;
        };
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
      }
    | undefined;
  const status = runtime.data as RuntimeStatus | undefined;
  const hello = data?.runtime ?? status?.hello;
  const connected = status?.connected === true;
  if (environment.isLoading) return <div className="skeleton">Loading environment…</div>;
  if (environment.isError || data === undefined)
    return (
      <div>
        <h1 style={{ marginTop: 0 }}>Environment</h1>
        <div className="error-box" role="alert">
          <strong>Sentry Runtime Offline.</strong> Sentry Desktop is running, but the WSL2 execution
          runtime could not be reached.
          {status?.lastError !== undefined ? ' ' + status.lastError : ''}
          <span>
            ' QA execution is disabled. '<Link to="/settings">Runtime settings</Link>
          </span>
        </div>
      </div>
    );
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Environment</h1>
      {!connected ? (
        <div className="error-box" style={{ marginBottom: 12 }} role="alert">
          <strong>Sentry Runtime Offline.</strong> QA execution is disabled until the WSL2 runtime
          reconnects. {status?.lastError ?? ''}
        </div>
      ) : null}
      <div className="card" style={{ marginBottom: 12 }}>
        <h3 style={{ marginTop: 0 }}>Sentry runtime</h3>
        <p className="mono muted">
          Windows Desktop: connected · WSL2 distribution: {status?.distro ?? hello?.distro ?? '—'}
          {' · '}Status: {connected ? 'Connected' : 'Offline'}
        </p>
        {hello !== undefined ? (
          <p className="mono muted">
            Runtime: Node {hello.nodeVersion} · Protocol v{hello.protocolVersion} · Sentry Runtime{' '}
            {hello.runtimeVersion}
          </p>
        ) : null}
        {hello !== undefined ? (
          <p className="mono muted">
            platform: {hello.platform}
            {hello.isWsl ? ' (WSL)' : ''} · Node host: {hello.processExecPath}
          </p>
        ) : null}
        {hello !== undefined ? (
          <p className="mono muted">Filesystem: Linux-managed data root {hello.dataRoot}</p>
        ) : null}
      </div>
      {data.verifier?.sandboxAvailable === false ? (
        <div className="error-box" style={{ marginBottom: 12 }}>
          Verifier sandbox unavailable — {data.verifier.reason ?? 'sandbox unavailable'}. WSL2 is
          installed, but systemd user services may be unavailable; Sentry requires systemd for
          isolated runtime verification. See docs/setup/wsl-runtime.md.
        </div>
      ) : null}
      <div className="cards">
        {(data.agentStacks ?? []).map((stack) => (
          <div className="card" key={stack.id}>
            <h3>{stack.displayName}</h3>
            <p className="mono muted">{stack.modelId}</p>
            <p>
              Credential: {stack.configured === true ? 'Configured' : 'Missing'} · Binary:{' '}
              {stack.binaryAvailable === true ? 'Available' : 'Missing'} · Runtime verification:{' '}
              {stack.runtimeVerified === true ? 'Verified' : 'Not tested'}
            </p>
            <p className="muted">
              Status: {stack.readiness ?? 'unknown'} — a saved credential does not imply the
              provider works until a non-billable doctor verifies it inside the WSL runtime.
            </p>
          </div>
        ))}
        <div className="card">
          <h3>Verifier</h3>
          <p>
            {data.verifier?.sandboxAvailable === true ? '✓' : '!'} systemd sandbox:{' '}
            {data.verifier?.sandboxAvailable === true ? 'available' : 'unavailable'} · Runtime
            replay: {data.verifier?.runtimeReplaySupported === true ? 'supported' : 'unsupported'}
          </p>
          {data.verifier?.reason !== undefined ? (
            <p className="muted">{data.verifier.reason}</p>
          ) : null}
        </div>
        <div className="card">
          <h3>Execution</h3>
          <p>
            Production only — every new FULL, TARGETED, and RETEST run executes inside the WSL2
            runtime and consumes provider budget.
          </p>
        </div>
      </div>
    </div>
  );
}
