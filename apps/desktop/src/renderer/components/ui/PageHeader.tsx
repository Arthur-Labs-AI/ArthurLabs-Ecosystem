import React from 'react';

export function PageHeader({
  title,
  subtitle,
  actions,
  crumbs,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  crumbs?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="page-header">
      <div style={{ minWidth: 0 }}>
        {crumbs !== undefined ? <div className="metadata">{crumbs}</div> : null}
        <h1 className="page-title">{title}</h1>
        {subtitle !== undefined ? <div className="body-secondary">{subtitle}</div> : null}
      </div>
      {actions !== undefined ? <div className="actions">{actions}</div> : null}
    </div>
  );
}

export function PageSection({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="page-section" aria-label={title}>
      <div className="page-header">
        <h2 className="section-title">{title}</h2>
        {actions !== undefined ? <div className="actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
