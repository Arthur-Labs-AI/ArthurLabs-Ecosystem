import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { sentryApi } from '../lib/sentry-api.js';
import { runtimeConnectionState, useRuntimeStatus } from '../lib/use-runtime-status.js';
import { PageHeader, PageSection } from '../components/ui/PageHeader.js';
import { StatusPill } from '../components/ui/StatusPill.js';
import { CollapsibleSection } from '../components/ui/CollapsibleSection.js';

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

interface AgentStackHealth {
  id: string;
  displayName: string;
  modelId: string;
  configured?: boolean;
  binaryAvailable?: boolean;
  runtimeVerified?: boolean;
  readiness?: string;
  executionPath?: string;
  executableSource?: string;
  wrapperNote?: string;
  note?: string;
}

function HealthRow({ ok, label }: { ok: boolean; label: string }): React.JSX.Element {
  return (
    <div className="metadata" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {ok ? (
        <Check size={13} aria-label="yes" color="var(--success)" />
      ) : (
        <X size={13} aria-label="no" color="var(--text-tertiary)" />
      )}
      {label}
    </div>
  );
}

export function Environment(): React.JSX.Element {
  const environment = useQuery({
    queryKey: ['environment'],
    queryFn: () => sentryApi().doctors.environment(),
  });
  const runtime = useRuntimeStatus();
  const cli = useQuery({
    queryKey: ['cli-status'],
    queryFn: () => sentryApi().cli.status(),
    refetchInterval: 3000,
  });
  const cliStatus = cli.data as
    | { started: boolean; error?: string; connectedClients: Array<{ id: string; name: string }> }
    | undefined;
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
        agentStacks: AgentStackHealth[];
      }
    | undefined;
  const status = runtime.data as RuntimeStatus | undefined;
  const hello = data?.runtime ?? status?.hello;
  const connection = runtimeConnectionState(runtime);
  const connected = connection === 'connected';
  if (environment.isLoading) return <div className="skeleton">Loading environment…</div>;
  if (environment.isError || data === undefined)
    return (
      <div className="page">
        <PageHeader title="Environment" subtitle="Runtime and agent health." />
        <div className="error-box" role="alert">
          <strong>
            {connection === 'unavailable'
              ? 'Sentry Runtime Offline.'
              : 'Environment details unavailable.'}
          </strong>{' '}
          Could not load environment details. Check runtime connectivity before starting another
          run. <Link to="/settings">Runtime settings</Link>
        </div>
      </div>
    );
  return (
    <div className="page">
      <PageHeader title="Environment" subtitle="Runtime and agent health." />
      {connection === 'unavailable' ? (
        <div className="error-box" style={{ marginBottom: 12 }} role="alert">
          <strong>Sentry Runtime Offline.</strong> QA execution is disabled until the WSL2 runtime
          reconnects. {status?.lastError ?? ''}{' '}
          <button className="compact ghost" onClick={() => void runtime.refetch()}>
            Retry
          </button>
        </div>
      ) : null}
      <PageSection title="Runtime health">
        <div className="card">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <StatusPill
              status={connection === 'checking' ? 'checking' : connected ? 'connected' : 'offline'}
              label={
                connection === 'checking'
                  ? 'Checking runtime…'
                  : connected
                    ? 'Runtime connected'
                    : 'Runtime offline'
              }
              pulse={connected}
            />
            <span className="metadata">
              WSL distribution: {status?.distro ?? hello?.distro ?? '—'}
            </span>
          </div>
          {hello !== undefined ? (
            <dl className="kv" style={{ marginTop: 10 }}>
              <dt>Runtime</dt>
              <dd className="mono">
                Node {hello.nodeVersion} · Protocol v{hello.protocolVersion} · Sentry{' '}
                {hello.runtimeVersion}
              </dd>
              <dt>Platform</dt>
              <dd className="mono">
                {hello.platform}
                {hello.isWsl ? ' (WSL)' : ''}
              </dd>
            </dl>
          ) : null}
          <CollapsibleSection title="Advanced details">
            <dl className="kv" style={{ marginTop: 8 }}>
              {hello !== undefined ? (
                <>
                  <dt>Node host path</dt>
                  <dd className="mono truncate" title={hello.processExecPath}>
                    {hello.processExecPath}
                  </dd>
                  <dt>Data root</dt>
                  <dd className="mono truncate" title={hello.dataRoot}>
                    {hello.dataRoot}
                  </dd>
                  <dt>Protocol version</dt>
                  <dd className="mono">v{hello.protocolVersion}</dd>
                </>
              ) : (
                <>
                  <dt>Status</dt>
                  <dd className="metadata">Runtime details not recorded.</dd>
                </>
              )}
            </dl>
          </CollapsibleSection>
        </div>
      </PageSection>
      <PageSection title="Local CLI">
        <div className="card">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <StatusPill
              status={cliStatus?.started === true ? 'connected' : 'offline'}
              label={cliStatus?.started === true ? 'CLI started' : 'CLI unavailable'}
              pulse={cliStatus?.started === true}
            />
            {(cliStatus?.connectedClients ?? []).map((client) => (
              <span key={client.id} className="metadata">
                {client.name} connected
              </span>
            ))}
            {(cliStatus?.connectedClients ?? []).length === 0 && cliStatus?.started === true ? (
              <span className="metadata">No external clients</span>
            ) : null}
          </div>
          {cliStatus?.error !== undefined ? (
            <p className="metadata" style={{ marginBottom: 0 }}>
              {cliStatus.error}
            </p>
          ) : (
            <p className="metadata" style={{ marginBottom: 0 }}>
              External automation (for example Nexus) can drive this same Sentry instance with
              `sentry cli ...` while the Desktop stays open.
            </p>
          )}
        </div>
      </PageSection>
      <PageSection title="Agent health">
        <div className="cards">
          {(data.agentStacks ?? []).map((stack) => (
            <div className="card" key={stack.id}>
              <div className="agent-row">
                <span className="grow card-title">{stack.displayName}</span>
                <StatusPill status={stack.readiness ?? 'unknown'} />
              </div>
              <div
                className="mono metadata truncate"
                style={{ margin: '4px 0 8px' }}
                title={stack.modelId}
              >
                {stack.modelId}
              </div>
              <HealthRow
                ok={stack.configured === true}
                label={'Credential ' + (stack.configured === true ? 'saved' : 'missing')}
              />
              <HealthRow
                ok={stack.binaryAvailable === true}
                label={'Binary ' + (stack.binaryAvailable === true ? 'available' : 'missing')}
              />
              <HealthRow
                ok={stack.runtimeVerified === true}
                label={'Runtime ' + (stack.runtimeVerified === true ? 'verified' : 'not tested')}
              />
              {stack.executionPath !== undefined && stack.executionPath !== '' ? (
                <div className="mono metadata truncate" title={stack.executionPath}>
                  {'Execution runtime: ' +
                    stack.executionPath +
                    (stack.executableSource !== undefined && stack.executableSource !== ''
                      ? ' (source: ' + stack.executableSource + ')'
                      : '')}
                </div>
              ) : null}
              {stack.wrapperNote !== undefined && stack.wrapperNote !== '' ? (
                <p className="metadata" style={{ marginBottom: 0 }}>
                  {stack.wrapperNote}
                </p>
              ) : null}
              {stack.note !== undefined && stack.note !== '' ? (
                <p className="metadata" style={{ marginBottom: 0 }}>
                  {stack.note}
                </p>
              ) : null}
              <p className="metadata" style={{ marginBottom: 0 }}>
                A saved credential does not imply the provider works until a non-billable doctor
                verifies it inside the WSL runtime.
              </p>
            </div>
          ))}
        </div>
      </PageSection>
      <PageSection title="Execution">
        <div className="card">
          <p className="body-secondary" style={{ margin: 0 }}>
            Production only — FULL and TARGETED runs execute inside the WSL2 runtime and consume
            provider budget.
          </p>
        </div>
      </PageSection>
    </div>
  );
}
