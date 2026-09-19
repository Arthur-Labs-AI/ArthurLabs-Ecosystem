import React from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { Dashboard } from './pages/Dashboard.js';
import { Projects } from './pages/Projects.js';
import { ProjectDetail } from './pages/ProjectDetail.js';
import { Runs } from './pages/Runs.js';
import { RunWorkspace } from './pages/RunWorkspace.js';
import { Issues } from './pages/Issues.js';
import { IssueDetail } from './pages/IssueDetail.js';
import { RetestWorkspace } from './pages/RetestWorkspace.js';
import { History } from './pages/History.js';
import { Environment } from './pages/Environment.js';
import { Providers } from './pages/Providers.js';
import { Settings } from './pages/Settings.js';

export function App(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <HashRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<Dashboard />} />
            <Route path="projects" element={<Projects />} />
            <Route path="projects/:projectId" element={<ProjectDetail />} />
            <Route path="runs" element={<Runs />} />
            <Route path="runs/:runId" element={<RunWorkspace />} />
            <Route path="issues" element={<Issues />} />
            <Route path="issues/:issueId" element={<IssueDetail />} />
            <Route path="retests/:retestRunId" element={<RetestWorkspace />} />
            <Route path="history" element={<History />} />
            <Route path="environment" element={<Environment />} />
            <Route path="settings" element={<Settings />} />
            <Route path="settings/providers" element={<Providers />} />
          </Route>
        </Routes>
      </HashRouter>
    </ErrorBoundary>
  );
}
