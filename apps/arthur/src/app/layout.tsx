import type { ReactNode } from "react";

export function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="app-layout">
      <header className="app-header">
        <h1 className="app-title">A.R.T.H.U.R.</h1>
        <p className="app-subtitle">Cognitive Runtime</p>
      </header>
      <main className="app-main">{children}</main>
      <footer className="app-footer">Local only. Sync, lineage, recall and devices are not implemented yet.</footer>
    </div>
  );
}
