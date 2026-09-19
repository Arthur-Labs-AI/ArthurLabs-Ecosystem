import React from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { sentryApi } from '../lib/sentry-api.js';
import { CommandPalette } from './CommandPalette.js';

const NAV: Array<{ to: string; label: string; end?: boolean }> = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/projects', label: 'Projects' },
  { to: '/runs', label: 'Runs' },
  { to: '/issues', label: 'Issues' },
  { to: '/history', label: 'History' },
  { to: '/environment', label: 'Environment' },
  { to: '/settings', label: 'Settings' },
];

export function AppShell(): React.JSX.Element {
  const navigate = useNavigate();
  const activeRuns = useQuery({
    queryKey: ['system', 'active-runs'],
    queryFn: () => sentryApi().system.activeRuns(),
    refetchInterval: 5000,
  });
  const count = Array.isArray(activeRuns.data) ? activeRuns.data.length : 0;
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing = target !== null && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (typing) return;
      if (event.key === 'Escape') {
        if (paletteOpen) {
          setPaletteOpen(false);
          return;
        }
        window.dispatchEvent(new CustomEvent('sentry:escape'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, paletteOpen]);

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary">
        <div className="brand">SENTRY</div>
        <nav>
          {NAV.map((item) =>
            item.end === true ? (
              <NavLink
                key={item.to}
                to={item.to}
                end
                className={({ isActive }) => (isActive ? 'active' : '')}
              >
                {item.label}
              </NavLink>
            ) : (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => (isActive ? 'active' : '')}
              >
                {item.label}
              </NavLink>
            ),
          )}
        </nav>
        <div className="active-strip" aria-live="polite">
          {count > 0 ? (
            <NavLink
              to={
                activeRuns.data?.[0] !== undefined
                  ? '/runs/' + (activeRuns.data[0] as { runId: string }).runId
                  : '/runs'
              }
            >
              <span className="status-dot status-running pulse" aria-hidden="true" /> {count} active
              run{count === 1 ? '' : 's'}
            </NavLink>
          ) : (
            <span className="faint">No active runs</span>
          )}
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <strong>Sentry</strong>
          <span className="faint">local desktop QA workspace</span>
          <button
            onClick={() => setPaletteOpen(true)}
            aria-label="Open command palette (Ctrl+K)"
            title="Command palette (Ctrl+K)"
          >
            ⌘K
          </button>
        </div>
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
