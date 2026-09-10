export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
CREATE TABLE projects (id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
CREATE TABLE managed_project_copies (project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, state TEXT NOT NULL, locked_by_run_id TEXT, payload TEXT NOT NULL) STRICT;
CREATE TABLE project_revisions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, payload TEXT NOT NULL) STRICT;
CREATE INDEX project_revisions_project_idx ON project_revisions(project_id);
CREATE TABLE artifacts (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE, qa_run_id TEXT, payload TEXT NOT NULL) STRICT;
CREATE TABLE project_snapshots (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, revision_id TEXT NOT NULL REFERENCES project_revisions(id), manifest_artifact_id TEXT NOT NULL REFERENCES artifacts(id), payload TEXT NOT NULL) STRICT;
CREATE TABLE project_context_snapshots (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, revision_id TEXT NOT NULL REFERENCES project_revisions(id), material_index_path TEXT, payload TEXT NOT NULL) STRICT;
CREATE TABLE qa_runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, snapshot_id TEXT NOT NULL REFERENCES project_snapshots(id), context_id TEXT NOT NULL REFERENCES project_context_snapshots(id), status TEXT NOT NULL, payload TEXT NOT NULL) STRICT;
CREATE INDEX qa_runs_project_idx ON qa_runs(project_id);
CREATE TABLE agent_runs (id TEXT PRIMARY KEY, qa_run_id TEXT NOT NULL REFERENCES qa_runs(id) ON DELETE CASCADE, status TEXT NOT NULL, payload TEXT NOT NULL) STRICT;
CREATE INDEX agent_runs_run_idx ON agent_runs(qa_run_id);
CREATE TABLE investigation_plans (id TEXT PRIMARY KEY, qa_run_id TEXT NOT NULL REFERENCES qa_runs(id) ON DELETE CASCADE, agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, payload TEXT NOT NULL) STRICT;
CREATE TABLE emergent_hypotheses (id TEXT PRIMARY KEY, qa_run_id TEXT NOT NULL REFERENCES qa_runs(id) ON DELETE CASCADE, agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, payload TEXT NOT NULL) STRICT;
CREATE TABLE findings (id TEXT PRIMARY KEY, qa_run_id TEXT NOT NULL REFERENCES qa_runs(id) ON DELETE CASCADE, agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, payload TEXT NOT NULL) STRICT;
CREATE INDEX findings_run_idx ON findings(qa_run_id);
CREATE TABLE evidence (id TEXT PRIMARY KEY, qa_run_id TEXT NOT NULL REFERENCES qa_runs(id) ON DELETE CASCADE, agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE CASCADE, payload TEXT NOT NULL) STRICT;
CREATE INDEX evidence_run_idx ON evidence(qa_run_id);
CREATE TABLE run_activities (id TEXT PRIMARY KEY, qa_run_id TEXT NOT NULL REFERENCES qa_runs(id) ON DELETE CASCADE, agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE CASCADE, payload TEXT NOT NULL) STRICT;
CREATE INDEX run_activities_run_idx ON run_activities(qa_run_id);
CREATE TABLE run_exports (qa_run_id TEXT NOT NULL REFERENCES qa_runs(id) ON DELETE CASCADE, format TEXT NOT NULL CHECK(format IN ('log','json')), artifact_id TEXT NOT NULL REFERENCES artifacts(id), payload TEXT NOT NULL, PRIMARY KEY (qa_run_id, format)) STRICT;
CREATE TABLE harness_events (agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, sequence INTEGER NOT NULL CHECK(sequence > 0), event_id TEXT NOT NULL UNIQUE, qa_run_id TEXT NOT NULL REFERENCES qa_runs(id) ON DELETE CASCADE, payload TEXT NOT NULL, PRIMARY KEY (agent_run_id, sequence)) STRICT;
CREATE INDEX harness_events_run_idx ON harness_events(qa_run_id, agent_run_id, sequence);
`,
  },
] as const;
