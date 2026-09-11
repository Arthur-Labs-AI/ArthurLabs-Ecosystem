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
  {
    version: 2,
    name: 'runtime_integrity',
    sql: `
CREATE TABLE runtime_instances (
  id TEXT PRIMARY KEY,
  process_id INTEGER NOT NULL CHECK(process_id >= 0),
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  released_at TEXT,
  payload TEXT NOT NULL
) STRICT;
CREATE TABLE runtime_operations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  runtime_instance_id TEXT NOT NULL REFERENCES runtime_instances(id),
  type TEXT NOT NULL CHECK(type IN ('project_update','project_delete')),
  stage TEXT NOT NULL,
  payload TEXT NOT NULL
) STRICT;
CREATE INDEX runtime_operations_project_idx ON runtime_operations(project_id);
ALTER TABLE qa_runs ADD COLUMN runtime_instance_id TEXT REFERENCES runtime_instances(id);
CREATE INDEX qa_runs_runtime_status_idx ON qa_runs(runtime_instance_id,status);
ALTER TABLE managed_project_copies ADD COLUMN runtime_instance_id TEXT REFERENCES runtime_instances(id);
CREATE INDEX managed_copies_runtime_state_idx ON managed_project_copies(runtime_instance_id,state);
CREATE UNIQUE INDEX agent_runs_id_run_idx ON agent_runs(id,qa_run_id);

CREATE TRIGGER agent_runs_owner_update BEFORE UPDATE ON agent_runs
WHEN NEW.qa_run_id IS NOT OLD.qa_run_id
BEGIN SELECT RAISE(ABORT,'ENTITY_OWNERSHIP_IMMUTABLE'); END;

CREATE TRIGGER investigation_plans_owner_insert BEFORE INSERT ON investigation_plans
WHEN NOT EXISTS (SELECT 1 FROM agent_runs WHERE id=NEW.agent_run_id AND qa_run_id=NEW.qa_run_id)
BEGIN SELECT RAISE(ABORT,'AGENT_QA_RUN_MISMATCH'); END;
CREATE TRIGGER emergent_hypotheses_owner_insert BEFORE INSERT ON emergent_hypotheses
WHEN NOT EXISTS (SELECT 1 FROM agent_runs WHERE id=NEW.agent_run_id AND qa_run_id=NEW.qa_run_id)
BEGIN SELECT RAISE(ABORT,'AGENT_QA_RUN_MISMATCH'); END;
CREATE TRIGGER findings_owner_insert BEFORE INSERT ON findings
WHEN NOT EXISTS (SELECT 1 FROM agent_runs WHERE id=NEW.agent_run_id AND qa_run_id=NEW.qa_run_id)
BEGIN SELECT RAISE(ABORT,'AGENT_QA_RUN_MISMATCH'); END;
CREATE TRIGGER evidence_owner_insert BEFORE INSERT ON evidence
WHEN NEW.agent_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE id=NEW.agent_run_id AND qa_run_id=NEW.qa_run_id)
BEGIN SELECT RAISE(ABORT,'AGENT_QA_RUN_MISMATCH'); END;
CREATE TRIGGER activities_owner_insert BEFORE INSERT ON run_activities
WHEN NEW.agent_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE id=NEW.agent_run_id AND qa_run_id=NEW.qa_run_id)
BEGIN SELECT RAISE(ABORT,'AGENT_QA_RUN_MISMATCH'); END;
CREATE TRIGGER harness_events_owner_insert BEFORE INSERT ON harness_events
WHEN NOT EXISTS (SELECT 1 FROM agent_runs WHERE id=NEW.agent_run_id AND qa_run_id=NEW.qa_run_id)
BEGIN SELECT RAISE(ABORT,'AGENT_QA_RUN_MISMATCH'); END;
CREATE TRIGGER investigation_plans_owner_update BEFORE UPDATE ON investigation_plans
WHEN NEW.qa_run_id IS NOT OLD.qa_run_id OR NEW.agent_run_id IS NOT OLD.agent_run_id
BEGIN SELECT RAISE(ABORT,'ENTITY_OWNERSHIP_IMMUTABLE'); END;
CREATE TRIGGER emergent_hypotheses_owner_update BEFORE UPDATE ON emergent_hypotheses
WHEN NEW.qa_run_id IS NOT OLD.qa_run_id OR NEW.agent_run_id IS NOT OLD.agent_run_id
BEGIN SELECT RAISE(ABORT,'ENTITY_OWNERSHIP_IMMUTABLE'); END;
CREATE TRIGGER findings_owner_update BEFORE UPDATE ON findings
WHEN NEW.qa_run_id IS NOT OLD.qa_run_id OR NEW.agent_run_id IS NOT OLD.agent_run_id
BEGIN SELECT RAISE(ABORT,'ENTITY_OWNERSHIP_IMMUTABLE'); END;
CREATE TRIGGER evidence_owner_update BEFORE UPDATE ON evidence
WHEN NEW.qa_run_id IS NOT OLD.qa_run_id OR NEW.agent_run_id IS NOT OLD.agent_run_id
BEGIN SELECT RAISE(ABORT,'ENTITY_OWNERSHIP_IMMUTABLE'); END;
CREATE TRIGGER activities_owner_update BEFORE UPDATE ON run_activities
WHEN NEW.qa_run_id IS NOT OLD.qa_run_id OR NEW.agent_run_id IS NOT OLD.agent_run_id
BEGIN SELECT RAISE(ABORT,'ENTITY_OWNERSHIP_IMMUTABLE'); END;
`,
  },
] as const;
