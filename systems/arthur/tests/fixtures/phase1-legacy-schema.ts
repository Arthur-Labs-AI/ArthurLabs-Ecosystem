import { DatabaseSync } from "node:sqlite";

/** Exact schema released by the original Phase 1 migrations 1 and 2. */
export function createLegacyPhase1Database(path: string): void {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  try {
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, 'initial_schema'), (2, 'approval_persistence');

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK(mode IN ('personal','business')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived'))
      );
      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('completed','needs_approval','failed','pending')),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_turns_session ON turns(session_id, created_at);
      CREATE TABLE model_calls (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        latency_ms INTEGER NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cached_tokens INTEGER,
        status TEXT NOT NULL,
        provider_request_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
      );
      CREATE TABLE tool_calls (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        risk_level TEXT NOT NULL CHECK(risk_level IN ('read','low_write','approval_required','high_risk')),
        status TEXT NOT NULL CHECK(status IN ('completed','pending_approval','rejected','failed')),
        result_summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
      );
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        arguments_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','failed','expired')),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (tool_call_id) REFERENCES tool_calls(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_approvals_status ON approvals(status);

      INSERT INTO sessions VALUES ('legacy-session', 'personal', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', 'active');
      INSERT INTO turns VALUES ('legacy-turn', 'legacy-session', 'user', 'legacy text', '2025-01-01T00:00:00.000Z', 'legacy-trace', 'completed');
      INSERT INTO model_calls VALUES ('legacy-model', 'legacy-turn', 'fake', 'legacy-model', 12, 3, 4, 0, 'completed', 'provider-1', '2025-01-01T00:00:00.000Z');
      INSERT INTO tool_calls VALUES ('legacy-tool', 'legacy-turn', 'system.echo', '{"text":"legacy"}', 'read', 'completed', 'legacy result', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
      INSERT INTO approvals VALUES ('legacy-approval', 'legacy-turn', 'legacy-session', 'legacy-tool', 'system.echo', '{"text":"legacy"}', 'legacy-hash', 'approved', '2025-01-02T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-01-01T00:01:00.000Z');
    `);
  } finally {
    db.close();
  }
}
