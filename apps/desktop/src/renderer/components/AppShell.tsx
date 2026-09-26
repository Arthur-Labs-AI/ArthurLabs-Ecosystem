import React from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronsLeft,
  ChevronsRight,
  FolderKanban,
  LayoutDashboard,
  ServerCog,
  Settings as SettingsIcon,
  SquareTerminal,
} from 'lucide-react';
import { sentryApi } from '../lib/sentry-api.js';
import { CommandPalette } from './CommandPalette.js';

const NAV: Array<{ to: string; label: string; end?: boolean; icon: React.ReactNode }> = [
  {
    to: '/',
    label: 'Dashboard',
    end: true,
    icon: React.createElement(LayoutDashboard, { size: 17 }),
  },
  { to: '/projects', label: 'Projects', icon: React.createElement(FolderKanban, { size: 17 }) },
  { to: '/environment', label: 'Environment', icon: React.createElement(ServerCog, { size: 17 }) },
  { to: '/settings', label: 'Settings', icon: React.createElement(SettingsIcon, { size: 17 }) },
];

const SIDEBAR_KEY = 'sentry:shell:sidebar-collapsed';

function pageCrumb(pathname: string): React.ReactNode {
  if (pathname.startsWith('/projects/')) return 'Projects / Project';
  if (pathname === '/projects') return 'Workspace / Projects';
  if (pathname === '/environment') return 'System / Environment';
  if (pathname === '/settings') return 'System / Settings';
  if (pathname.startsWith('/settings/')) return 'System / Settings';
  if (pathname.startsWith('/runs/')) return 'Project / QA Run';
  return 'Overview / Dashboard';
}

export function AppShell(): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = React.useState<boolean>(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_KEY) === '1';
    } catch {
      return false;
    }
  });
  const activeRuns = useQuery({
    queryKey: ['system', 'active-runs'],
    queryFn: () => sentryApi().system.activeRuns(),
    refetchInterval: 5000,
  });
  const runtime = useQuery({
    queryKey: ['runtime-status'],
    queryFn: () => sentryApi().runtime.status(),
    refetchInterval: 10000,
  });
  const runs = Array.isArray(activeRuns.data) ? activeRuns.data : [];
  const count = runs.length;
  const runtimeData = runtime.data as { connected?: boolean } | undefined;
  const runtimeConnected = runtimeData?.connected === true;
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  const toggleSidebar = (): void => {
    setCollapsed((v) => {
      try {
        window.localStorage.setItem(SIDEBAR_KEY, v ? '0' : '1');
      } catch {
        /* non-persistent */
      }
      return !v;
    });
  };

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

  const recentRunId = (runs[0] as { runId?: string } | undefined)?.runId;
  return (
    <div className="app-shell">
      <aside className={'sidebar' + (collapsed ? ' collapsed' : '')} aria-label="Primary">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <img src="./sentry-logo.png" alt="" />
          </span>
          {collapsed ? null : (
            <span className="brand-text">
              SENTRY<small>OBSERVATION SYSTEM</small>
            </span>
          )}
        </div>
        {collapsed ? null : <div className="nav-group">Overview</div>}
        <nav aria-label="Primary navigation">
          <NavLink
            key="/"
            to="/"
            end
            title={collapsed ? 'Dashboard' : undefined}
            className={({ isActive }) => (isActive ? 'active' : '')}
          >
            {NAV[0]?.icon}
            {collapsed ? null : <span className="nav-label">{NAV[0]?.label}</span>}
          </NavLink>
          {collapsed ? null : <div className="nav-group">Workspace</div>}
          <NavLink
            key="/projects"
            to="/projects"
            title={collapsed ? 'Projects' : undefined}
            className={({ isActive }) => (isActive ? 'active' : '')}
          >
            {NAV[1]?.icon}
            {collapsed ? null : <span className="nav-label">{NAV[1]?.label}</span>}
          </NavLink>
          {collapsed ? null : <div className="nav-group">System</div>}
          {NAV.slice(2).map((item) =>
            item.end === true ? (
              <NavLink
                key={item.to}
                to={item.to}
                end
                title={collapsed ? item.label : undefined}
                className={({ isActive }) => (isActive ? 'active' : '')}
              >
                {item.icon}
                {collapsed ? null : <span className="nav-label">{item.label}</span>}
              </NavLink>
            ) : (
              <NavLink
                key={item.to}
                to={item.to}
                title={collapsed ? item.label : undefined}
                className={({ isActive }) => (isActive ? 'active' : '')}
              >
                {item.icon}
                {collapsed ? null : <span className="nav-label">{item.label}</span>}
              </NavLink>
            ),
          )}
        </nav>
        <button
          className="icon-btn ghost collapse-btn"
          onClick={toggleSidebar}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
        </button>
        <div className="active-strip" aria-live="polite">
          {count > 0 ? (
            recentRunId !== undefined ? (
              <Link to={'/runs/' + recentRunId} title="Open most recent active run">
                <span className="status-dot status-running pulse" aria-hidden="true" />
                {collapsed ? null : (
                  <span>
                    {count} active run{count === 1 ? '' : 's'} · Open
                  </span>
                )}
              </Link>
            ) : (
              <span>
                <span className="status-dot status-running pulse" aria-hidden="true" />
                {collapsed ? null : (
                  <span>
                    {' '}
                    {count} active run{count === 1 ? '' : 's'}
                  </span>
                )}
              </span>
            )
          ) : (
            <span className="faint">
              <SquareTerminal size={14} aria-hidden="true" />
              {collapsed ? null : ' No active runs'}
            </span>
          )}
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <nav className="crumbs" aria-label="Breadcrumb">
            {pageCrumb(location.pathname)}
          </nav>
          <span
            className={'status-pill ' + (runtimeConnected ? 'tone-success' : 'tone-danger')}
            title={runtimeConnected ? 'Runtime connected' : 'Runtime offline'}
          >
            <span
              className={
                runtimeConnected ? 'status-dot status-completed' : 'status-dot status-failed'
              }
              aria-hidden="true"
            />
            {runtimeConnected ? 'Runtime connected' : 'Runtime offline'}
          </span>
          <button
            className="palette-btn"
            onClick={() => setPaletteOpen(true)}
            aria-label="Open command palette (Ctrl+K)"
            title="Command palette (Ctrl+K)"
          >
            Ctrl+K
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
