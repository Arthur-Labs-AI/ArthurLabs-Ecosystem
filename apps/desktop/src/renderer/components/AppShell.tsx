import React from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import { runtimeConnectionState, useRuntimeStatus } from '../lib/use-runtime-status.js';
import { StatusIcon } from './StatusGlyph.js';

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
  if (pathname === '/runs') return 'Workspace / Runs';
  if (pathname.startsWith('/issues')) return 'Workspace / Issues';
  if (pathname.startsWith('/retests/')) return 'Project / Retest';
  if (pathname === '/history') return 'Workspace / History';
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
  const runtime = useRuntimeStatus();
  const queryClient = useQueryClient();
  const wasUnavailable = React.useRef(false);
  React.useEffect(() => {
    if (runtime.isError || runtime.data?.connected === false) wasUnavailable.current = true;
    if (!runtime.isError && runtime.data?.connected === true && wasUnavailable.current) {
      wasUnavailable.current = false;
      // Read-only caches; snapshot hooks reconcile their own run/retest IDs.
      const keys = new Set([
        'projects',
        'project',
        'project-name',
        'project-runs',
        'project-revisions',
        'project-issues',
        'issue-history',
        'system',
        'environment',
        'production-readiness',
      ]);
      void queryClient.invalidateQueries({
        predicate: (query) => keys.has(String(query.queryKey[0])),
      });
    }
  }, [runtime.isError, runtime.data?.connected, queryClient]);
  const runs = Array.isArray(activeRuns.data) ? activeRuns.data : [];
  const count = runs.length;
  const connection = runtimeConnectionState(runtime);
  const runtimeConnected = connection === 'connected';
  const runtimeLabel =
    connection === 'checking'
      ? 'Checking runtime…'
      : runtimeConnected
        ? 'Runtime connected'
        : 'Runtime offline';
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
            aria-label="Dashboard"
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
            aria-label="Projects"
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
                aria-label={item.label}
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
                aria-label={item.label}
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
              <Link
                to={'/runs/' + recentRunId}
                title="Open most recent active run"
                aria-label={'Open most recent active run. ' + count + ' active runs'}
              >
                <span className="status-dot status-running pulse" aria-hidden="true" />
                {collapsed ? null : (
                  <span>
                    {count}{' '}
                    {runtimeConnected && !activeRuns.isError ? 'active' : 'last known active'} run
                    {count === 1 ? '' : 's'} · Open
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
              {collapsed
                ? null
                : runtimeConnected && !activeRuns.isError
                  ? ' No active runs'
                  : ' Active runs unavailable'}
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
            className={
              'status-pill ' +
              (connection === 'checking'
                ? 'tone-info'
                : runtimeConnected
                  ? 'tone-success'
                  : 'tone-danger')
            }
            title={runtimeLabel}
            aria-live="polite"
          >
            <StatusIcon
              status={
                connection === 'checking' ? 'probing' : runtimeConnected ? 'connected' : 'failed'
              }
            />
            {runtimeLabel}
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
          {connection === 'unavailable' ? (
            <div className="inline-notice tone-warning" role="status">
              Runtime communication unavailable. Cached results remain available; execution status
              may have changed. Check <Link to="/settings/runtime">Runtime settings</Link> before
              starting another run. No execution is restarted automatically.
            </div>
          ) : null}
          <Outlet />
        </div>
      </div>
    </div>
  );
}
