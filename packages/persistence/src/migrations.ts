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
  {
    version: 3,
    name: 'finding_merge_results',
    sql: `
CREATE TABLE merge_results (id TEXT PRIMARY KEY, qa_run_id TEXT NOT NULL REFERENCES qa_runs(id) ON DELETE CASCADE, input_digest TEXT NOT NULL, payload TEXT NOT NULL) STRICT;
CREATE UNIQUE INDEX merge_results_run_digest_idx ON merge_results(qa_run_id,input_digest);
CREATE TABLE finding_clusters (id TEXT PRIMARY KEY, qa_run_id TEXT NOT NULL REFERENCES qa_runs(id) ON DELETE CASCADE, merge_result_id TEXT NOT NULL REFERENCES merge_results(id) ON DELETE CASCADE, payload TEXT NOT NULL) STRICT;
CREATE INDEX finding_clusters_merge_idx ON finding_clusters(merge_result_id);
CREATE TABLE finding_cluster_members (cluster_id TEXT NOT NULL REFERENCES finding_clusters(id) ON DELETE CASCADE, finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE, PRIMARY KEY (cluster_id,finding_id)) STRICT;
CREATE TABLE cluster_evidence (cluster_id TEXT NOT NULL REFERENCES finding_clusters(id) ON DELETE CASCADE, evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE, PRIMARY KEY (cluster_id,evidence_id)) STRICT;
CREATE TABLE cluster_disagreements (cluster_id TEXT NOT NULL REFERENCES finding_clusters(id) ON DELETE CASCADE, field TEXT NOT NULL, agent_stack_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (cluster_id,field,agent_stack_id)) STRICT;
CREATE TRIGGER merge_results_owner_update BEFORE UPDATE ON merge_results
WHEN NEW.qa_run_id IS NOT OLD.qa_run_id OR NEW.input_digest IS NOT OLD.input_digest
BEGIN SELECT RAISE(ABORT,'ENTITY_OWNERSHIP_IMMUTABLE'); END;
CREATE TRIGGER finding_clusters_owner_update BEFORE UPDATE ON finding_clusters
WHEN NEW.qa_run_id IS NOT OLD.qa_run_id OR NEW.merge_result_id IS NOT OLD.merge_result_id
BEGIN SELECT RAISE(ABORT,'ENTITY_OWNERSHIP_IMMUTABLE'); END;
`,
  },
  {
    version: 4,
    name: 'verification_runs',
    sql: `
CREATE TABLE verification_runs (id TEXT PRIMARY KEY, merge_result_id TEXT NOT NULL REFERENCES merge_results(id) ON DELETE CASCADE, qa_run_id TEXT NOT NULL REFERENCES qa_runs(id) ON DELETE CASCADE, payload TEXT NOT NULL) STRICT;
CREATE INDEX verification_runs_merge_idx ON verification_runs(merge_result_id);
CREATE TABLE verification_attempts (id TEXT PRIMARY KEY, verification_run_id TEXT NOT NULL REFERENCES verification_runs(id) ON DELETE CASCADE, finding_cluster_id TEXT NOT NULL REFERENCES finding_clusters(id) ON DELETE CASCADE, status TEXT NOT NULL, payload TEXT NOT NULL) STRICT;
CREATE INDEX verification_attempts_run_idx ON verification_attempts(verification_run_id);
CREATE TABLE verification_steps (id TEXT PRIMARY KEY, verification_attempt_id TEXT NOT NULL REFERENCES verification_attempts(id) ON DELETE CASCADE, type TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL) STRICT;
CREATE INDEX verification_steps_attempt_idx ON verification_steps(verification_attempt_id);
CREATE TABLE verification_observations (id TEXT PRIMARY KEY, verification_attempt_id TEXT NOT NULL REFERENCES verification_attempts(id) ON DELETE CASCADE, step_id TEXT NOT NULL REFERENCES verification_steps(id) ON DELETE CASCADE, payload TEXT NOT NULL) STRICT;
CREATE INDEX verification_observations_attempt_idx ON verification_observations(verification_attempt_id);
CREATE TABLE verification_assertions (verification_attempt_id TEXT NOT NULL REFERENCES verification_attempts(id) ON DELETE CASCADE, subject TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (verification_attempt_id,subject)) STRICT;
CREATE TRIGGER verification_attempts_owner_update BEFORE UPDATE ON verification_attempts
WHEN NEW.verification_run_id IS NOT OLD.verification_run_id OR NEW.finding_cluster_id IS NOT OLD.finding_cluster_id
BEGIN SELECT RAISE(ABORT,'ENTITY_OWNERSHIP_IMMUTABLE'); END;
`,
  },
] as const;
