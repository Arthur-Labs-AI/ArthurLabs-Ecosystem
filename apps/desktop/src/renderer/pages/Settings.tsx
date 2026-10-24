import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, KeyRound, ServerCog, SlidersHorizontal } from 'lucide-react';
import { sentryApi } from '../lib/sentry-api.js';
import { PageHeader, PageSection } from '../components/ui/PageHeader.js';
import { CollapsibleSection } from '../components/ui/CollapsibleSection.js';

export function Settings(): React.JSX.Element {
  const info = useQuery({ queryKey: ['system-info'], queryFn: () => sentryApi().system.info() });
  const data = info.data as { dataRoot?: string; versions?: Record<string, string> } | undefined;
  return (
    <div className="page">
      <PageHeader title="Settings" subtitle="Providers, runtime, and application preferences." />
      <PageSection title="Configure">
        <div className="cards">
          <Link to="/settings/providers" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="card agent-row">
              <KeyRound size={18} aria-hidden="true" className="faint" />
              <span className="grow">
                <span className="card-title" style={{ display: 'block' }}>
                  Providers
                </span>
                <span className="body-secondary">API keys, models, and harness transports</span>
              </span>
              <ArrowRight size={15} aria-hidden="true" className="faint" />
            </div>
          </Link>
          <Link to="/settings/runtime" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="card agent-row">
              <ServerCog size={18} aria-hidden="true" className="faint" />
              <span className="grow">
                <span className="card-title" style={{ display: 'block' }}>
                  Runtime
                </span>
                <span className="body-secondary">WSL distribution and runtime health</span>
              </span>
              <ArrowRight size={15} aria-hidden="true" className="faint" />
            </div>
          </Link>
          <Link to="/settings/application" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="card agent-row">
              <SlidersHorizontal size={18} aria-hidden="true" className="faint" />
              <span className="grow">
                <span className="card-title" style={{ display: 'block' }}>
                  Application
                </span>
                <span className="body-secondary">
                  Theme, language, local CLI, and developer diagnostics
                </span>
              </span>
              <ArrowRight size={15} aria-hidden="true" className="faint" />
            </div>
          </Link>
        </div>
      </PageSection>
      <CollapsibleSection title="Advanced / About">
        <div className="card" style={{ marginTop: 8 }}>
          <h3 className="card-title">Data root</h3>
          <p className="mono truncate" title={data?.dataRoot ?? ''}>
            {data?.dataRoot ?? '—'}
          </p>
          <h3 className="card-title">Versions</h3>
          <pre className="mono">{JSON.stringify(data?.versions ?? {}, null, 2)}</pre>
        </div>
      </CollapsibleSection>
    </div>
  );
}
