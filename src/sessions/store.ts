/**
 * SQLite-backed session store with migrations (spec section 9; audit MEDIUM 6).
 *
 * This is not the future RAG memory system. It persists conversations, turns,
 * modes, statuses, model-call telemetry, tool-call records, approvals, and
 * idempotency keys across restarts. Multi-row state transitions are exposed as
 * transactional methods so a crash cannot leave partial state. No API keys or
 * full sensitive tool results are stored here.
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ArthurMode } from "../core/modes/mode";
import type { ToolRisk } from "../tools/contracts";
import { SecretSanitizer } from "../security/sanitize";
import type {
  ApprovalRecord,
  ApprovalStatus,
  ConversationLoopRecord,
  ConversationLoopState,
  IdempotencyRecord,
  LoopTranscriptEntry,
  ModelCallRecord,
  SessionRecord,
  ToolCallRecord,
  ToolCallStatus,
  TurnRecord,
  TurnRole,
} from "./models";
import { TOOL_EXECUTIONS_DDL } from "./execution_store";

interface Migration {
  version: number;
  name: string;
  up: string | ((db: DatabaseSync) => void);
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function columnNames(db: DatabaseSync, table: string): Set<string> {
  if (!tableExists(db, table)) return new Set();
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
}

function reconcileSecureSchema(db: DatabaseSync): void {
  const turnColumns = columnNames(db, "turns");
  const approvalColumns = columnNames(db, "approvals");
  const hasIdempotency = tableExists(db, "idempotency_keys");

  db.exec(`
    CREATE TABLE __new_sessions (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL CHECK(mode IN ('personal','business')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived'))
    );
    INSERT INTO __new_sessions SELECT id, mode, created_at, updated_at, status FROM sessions;

    CREATE TABLE __new_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('completed','needs_approval','failed','pending')),
      mode TEXT NOT NULL CHECK(mode IN ('personal','business')),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);
  const turnMode = turnColumns.has("mode") ? "COALESCE(t.mode, s.mode)" : "s.mode";
  db.exec(`INSERT INTO __new_turns
    SELECT t.id, t.session_id, t.role, t.text, t.created_at, t.trace_id, t.status, ${turnMode}
    FROM turns t JOIN sessions s ON s.id = t.session_id`);

  db.exec(`
    CREATE TABLE __new_model_calls (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      latency_ms INTEGER NOT NULL CHECK(latency_ms >= 0),
      input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
      output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0),
      cached_tokens INTEGER CHECK(cached_tokens IS NULL OR cached_tokens >= 0),
      status TEXT NOT NULL,
      provider_request_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
    );
    INSERT INTO __new_model_calls SELECT id, turn_id, provider, model, latency_ms,
      input_tokens, output_tokens, cached_tokens, status, provider_request_id, created_at FROM model_calls;

    CREATE TABLE __new_tool_calls (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      risk_level TEXT NOT NULL CHECK(risk_level IN ('read','low_write','approval_required','high_risk')),
      status TEXT NOT NULL CHECK(status IN ('completed','pending_approval','rejected','failed','executing','cancelled','timed_out','outcome_unknown')),
      result_summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
    );
    INSERT INTO __new_tool_calls SELECT id, turn_id, tool_name, arguments_json, risk_level,
      status, result_summary, created_at, updated_at FROM tool_calls;

    CREATE TABLE __new_approvals (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL UNIQUE,
      tool_name TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      arguments_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','executing','approved','rejected','failed','expired','invalidated')),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      claimed_at TEXT,
      risk_level TEXT NOT NULL DEFAULT 'approval_required'
        CHECK(risk_level IN ('read','low_write','approval_required','high_risk')),
      binding_version INTEGER NOT NULL DEFAULT 1,
      consumed_at TEXT,
      mode TEXT,
      tool_version TEXT,
      tool_definition_hash TEXT,
      presentation_json TEXT,
      presentation_hash TEXT,
      authorization_digest TEXT,
      signing_key_id TEXT,
      invalidated_reason TEXT,
      decision_channel TEXT,
      FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (tool_call_id) REFERENCES tool_calls(id) ON DELETE CASCADE
    );
  `);
  const claimedAt = approvalColumns.has("claimed_at") ? "claimed_at" : "NULL";
  const riskLevel = approvalColumns.has("risk_level") ? "risk_level" : "'approval_required'";
  const bindingVersion = approvalColumns.has("binding_version") ? "binding_version" : "1";
  const modeCol = approvalColumns.has("mode") ? "mode" : "NULL";
  const toolVersion = approvalColumns.has("tool_version") ? "tool_version" : "NULL";
  const toolDefHash = approvalColumns.has("tool_definition_hash") ? "tool_definition_hash" : "NULL";
  const presentationJson = approvalColumns.has("presentation_json") ? "presentation_json" : "NULL";
  const presentationHash = approvalColumns.has("presentation_hash") ? "presentation_hash" : "NULL";
  const authDigest = approvalColumns.has("authorization_digest") ? "authorization_digest" : "NULL";
  const signingKeyId = approvalColumns.has("signing_key_id") ? "signing_key_id" : "NULL";
  const invalidatedReason = approvalColumns.has("invalidated_reason") ? "invalidated_reason" : "NULL";
  const decisionChannel = approvalColumns.has("decision_channel") ? "decision_channel" : "NULL";
  const consumedAt = approvalColumns.has("consumed_at") ? "consumed_at" : "NULL";
  db.exec(`INSERT INTO __new_approvals
    SELECT id, turn_id, session_id, tool_call_id, tool_name, arguments_json, arguments_hash,
      status, expires_at, created_at, resolved_at, ${claimedAt}, ${riskLevel},
      ${bindingVersion}, ${consumedAt}, ${modeCol}, ${toolVersion}, ${toolDefHash}, ${presentationJson},
      ${presentationHash}, ${authDigest}, ${signingKeyId}, ${invalidatedReason}, ${decisionChannel} FROM approvals`);

  db.exec(`
    CREATE TABLE __new_idempotency_keys (
      id TEXT PRIMARY KEY,
      client_request_id TEXT NOT NULL UNIQUE,
      request_hash TEXT NOT NULL,
      session_id TEXT,
      turn_id TEXT,
      status TEXT NOT NULL DEFAULT 'in_progress'
        CHECK(status IN ('in_progress','completed','failed')),
      response_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  if (hasIdempotency) {
    db.exec(`INSERT INTO __new_idempotency_keys
      SELECT id, client_request_id, request_hash, session_id, turn_id, status,
        response_json, created_at, updated_at FROM idempotency_keys`);
  }

  db.exec(`
    DROP TABLE approvals;
    DROP TABLE tool_calls;
    DROP TABLE model_calls;
    DROP TABLE turns;
    DROP TABLE sessions;
    DROP TABLE IF EXISTS idempotency_keys;

    ALTER TABLE __new_sessions RENAME TO sessions;
    ALTER TABLE __new_turns RENAME TO turns;
    ALTER TABLE __new_model_calls RENAME TO model_calls;
    ALTER TABLE __new_tool_calls RENAME TO tool_calls;
    ALTER TABLE __new_approvals RENAME TO approvals;
    ALTER TABLE __new_idempotency_keys RENAME TO idempotency_keys;

    CREATE INDEX idx_turns_session ON turns(session_id, mode, created_at);
    CREATE INDEX idx_approvals_status ON approvals(status);
    CREATE INDEX idx_idempotency_client_request ON idempotency_keys(client_request_id);
  `);
}

function validateSecureSchema(db: DatabaseSync): void {
  const required: Record<string, string[]> = {
    sessions: ["id", "mode", "created_at", "updated_at", "status"],
    turns: ["id", "session_id", "role", "text", "created_at", "trace_id", "status", "mode"],
    model_calls: ["id", "turn_id", "provider", "model", "latency_ms", "status", "created_at"],
    tool_calls: ["id", "turn_id", "tool_name", "arguments_json", "risk_level", "status",
      "provider_call_id", "round_no", "sequence_no", "invocation_fingerprint"],
    conversation_loops: ["id", "turn_id", "session_id", "mode", "state", "current_round",
      "model_calls_used", "tool_calls_used", "active_runtime_ms", "waiting_approval_id",
      "last_batch_fingerprint", "trace_id", "client_request_id", "budgets_json",
      "tool_schema_fingerprint", "transcript_json", "created_at", "updated_at",
      "rejected_fingerprints", "consecutive_repeats"],
    approvals: ["id", "turn_id", "session_id", "tool_call_id", "status", "claimed_at", "risk_level",
      "binding_version", "consumed_at", "mode", "tool_version", "tool_definition_hash", "presentation_json",
      "presentation_hash", "authorization_digest", "signing_key_id", "invalidated_reason", "decision_channel"],
    idempotency_keys: ["id", "client_request_id", "request_hash", "status", "created_at", "updated_at"],
    tool_executions: ["id", "tool_call_id", "session_id", "turn_id", "state", "attempt_count", "max_attempts", "deadline_at", "result_data_json"],
    tool_execution_attempts: ["id", "execution_id", "attempt_no", "state", "started_at"],
  };
  for (const [table, columns] of Object.entries(required)) {
    const actual = columnNames(db, table);
    if (columns.some((column) => !actual.has(column))) {
      throw new Error(`Schema validation failed for ${table}`);
    }
  }
  const indexes = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((row) => row.name));
  for (const index of ["idx_turns_session", "idx_approvals_status", "idx_idempotency_client_request", "idx_executions_state", "idx_attempts_execution",
    "idx_loops_turn", "idx_loops_state", "idx_loops_waiting_approval", "idx_tool_calls_provider", "idx_tool_calls_turn_status"]) {
    if (!indexes.has(index)) throw new Error(`Schema validation failed for index ${index}`);
  }
  const foreignKeyFailures = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyFailures.length > 0) throw new Error("Schema validation failed: foreign key violation");
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    up: `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK(mode IN ('personal','business')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived'))
      );

      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('completed','needs_approval','failed','pending')),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, created_at);

      CREATE TABLE IF NOT EXISTS model_calls (
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

      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        risk_level TEXT NOT NULL CHECK(risk_level IN ('read','low_write','approval_required','high_risk')),
        status TEXT NOT NULL CHECK(status IN ('completed','pending_approval','rejected','failed','executing')),
        result_summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
      );

    `,
  },
  {
    version: 2,
    name: "approval_persistence",
    up: `
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        arguments_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','approved','rejected','failed','expired')),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (tool_call_id) REFERENCES tool_calls(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
    `,
  },
  {
    version: 3,
    name: "approval_claimed_at",
    up: `
      ALTER TABLE approvals ADD COLUMN claimed_at TEXT;
    `,
  },
  {
    version: 4,
    name: "approval_risk_binding",
    up: `
      ALTER TABLE approvals ADD COLUMN risk_level TEXT NOT NULL DEFAULT 'approval_required'
        CHECK(risk_level IN ('read','low_write','approval_required','high_risk'));
    `,
  },
  {
    version: 5,
    name: "secure_schema_reconciliation",
    up: reconcileSecureSchema,
  },
  {
    version: 6,
    name: "turn_interrupted_status",
    // Phase 3: interrupted assistant turns (barge-in) are persisted for
    // audit with an explicit status instead of being recorded as a normal
    // completed answer (spec section 17). The turns table CHECK constraint
    // is widened by rebuilding the table with the same columns/data.
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE __new_turns_v6 (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
          text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          trace_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('completed','needs_approval','failed','pending','interrupted')),
          mode TEXT NOT NULL CHECK(mode IN ('personal','business')),
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        INSERT INTO __new_turns_v6 SELECT id, session_id, role, text, created_at, trace_id, status, mode FROM turns;
        DROP TABLE turns;
        ALTER TABLE __new_turns_v6 RENAME TO turns;
        CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, mode, created_at);
      `);
    },
  },
  {
    version: 7,
    name: "approval_binding_v2",
    up: (db: DatabaseSync) => {
      const cols = columnNames(db, "approvals");
      const add = (name: string, ddl: string): void => {
        if (!cols.has(name)) db.exec(`ALTER TABLE approvals ADD COLUMN ${ddl}`);
      };
      add("binding_version", "binding_version INTEGER NOT NULL DEFAULT 1");
      // SC-03 section 13: single-use approval consumption timestamp. Set exactly
      // once in the atomic consume+create-execution transaction; NULL = unconsumed.
      add("consumed_at", "consumed_at TEXT");
      add("mode", "mode TEXT");
      add("tool_version", "tool_version TEXT");
      add("tool_definition_hash", "tool_definition_hash TEXT");
      add("presentation_json", "presentation_json TEXT");
      add("presentation_hash", "presentation_hash TEXT");
      add("authorization_digest", "authorization_digest TEXT");
      add("signing_key_id", "signing_key_id TEXT");
      add("invalidated_reason", "invalidated_reason TEXT");
      add("decision_channel", "decision_channel TEXT");
      // Legacy (v1) non-terminal approvals can never be "upgraded": the user
      // never saw a v2 transaction presentation (SC-02 section 44). Fail them
      // closed via the new terminal INVALIDATED state and terminalize their
      // tool calls so they can never execute.
      db.exec(`
        UPDATE approvals SET status = 'invalidated', resolved_at = COALESCE(resolved_at, CURRENT_TIMESTAMP),
          invalidated_reason = COALESCE(invalidated_reason, 'sc02-migration: v1 approval without v2 binding')
          WHERE status IN ('pending', 'executing') AND (binding_version IS NULL OR binding_version < 2);
        UPDATE tool_calls SET status = 'failed',
          result_summary = COALESCE(result_summary, 'invalidated by SC-02 migration: v1 approval without v2 binding')
          WHERE status = 'pending_approval' AND NOT EXISTS (
            SELECT 1 FROM approvals a WHERE a.tool_call_id = tool_calls.id AND a.status = 'pending'
          );
      `);
    },
  },
  {
    version: 8,
    name: "tool_execution_lifecycle",
    up: (db: DatabaseSync) => {
      // SC-03 section 91: execution tables share arthur.db so approval
      // consumption + tool call + execution creation commit atomically.
      // Additive only: existing rows are never rewritten or dropped here.
      db.exec(TOOL_EXECUTIONS_DDL);
      // Pre-v8 databases carry the narrow tool_calls CHECK from migration v1.
      // Rebuild once to admit the durable terminal mirrors
      // (cancelled/timed_out/outcome_unknown) without touching row data.
      const ddl = String(
        (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tool_calls'").get() as { sql?: string } | undefined)?.sql ?? "",
      );
      if (!ddl.includes("'cancelled'")) {
        db.exec(`
          CREATE TABLE __new_tool_calls_v8 (
            id TEXT PRIMARY KEY,
            turn_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            arguments_json TEXT NOT NULL,
            risk_level TEXT NOT NULL CHECK(risk_level IN ('read','low_write','approval_required','high_risk')),
            status TEXT NOT NULL CHECK(status IN ('completed','pending_approval','rejected','failed','executing','cancelled','timed_out','outcome_unknown')),
            result_summary TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
          );
          INSERT INTO __new_tool_calls_v8 SELECT id, turn_id, tool_name, arguments_json, risk_level,
            status, result_summary, created_at, updated_at FROM tool_calls;
          DROP TABLE tool_calls;
          ALTER TABLE __new_tool_calls_v8 RENAME TO tool_calls;
        `);
      }
    },
  },
  {
    version: 9,
    name: "approval_consumed_at",
    up: (db: DatabaseSync) => {
      // SC-03 section 13: single-use consumption marker. Pure ADD COLUMN:
      // existing rows keep consumed_at = NULL (unconsumed); only the new
      // atomic consume path ever sets it. Idempotent for re-runs.
      const cols = columnNames(db, "approvals");
      if (!cols.has("consumed_at")) db.exec("ALTER TABLE approvals ADD COLUMN consumed_at TEXT");
    },
  },
  {
    version: 10,
    name: "execution_result_data",
    up: (db: DatabaseSync) => {
      // SC-03 section 79: bounded structured result persistence for
      // result_persistence = 'bounded_json' tools. Pure ADD COLUMN; existing
      // rows keep NULL (summary_only semantics preserved retroactively).
      const cols = columnNames(db, "tool_executions");
      if (!cols.has("result_data_json")) db.exec("ALTER TABLE tool_executions ADD COLUMN result_data_json TEXT");
    },
  },
  {
    version: 11,
    name: "conversation_loop_journal",
    up: (db: DatabaseSync) => {
      // SC-06 Increment 2: durable loop journal + provider protocol identity.
      // Additive only. Existing tool_calls rows keep NULL provider_call_id /
      // round_no / sequence_no (pre-SC-06 semantics preserved retroactively).
      const toolCols = columnNames(db, "tool_calls");
      if (!toolCols.has("provider_call_id")) db.exec("ALTER TABLE tool_calls ADD COLUMN provider_call_id TEXT");
      if (!toolCols.has("round_no")) db.exec("ALTER TABLE tool_calls ADD COLUMN round_no INTEGER");
      if (!toolCols.has("sequence_no")) db.exec("ALTER TABLE tool_calls ADD COLUMN sequence_no INTEGER");
      db.exec(`
        CREATE TABLE IF NOT EXISTS conversation_loops (
          id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          mode TEXT NOT NULL CHECK(mode IN ('personal','business')),
          state TEXT NOT NULL CHECK(state IN ('CREATED','MODEL_RUNNING','ROUND_READY','TOOL_EXECUTING','WAITING_APPROVAL','RESUMING','COMPLETED','FAILED','INTERRUPTED','LIMIT_REACHED')),
          current_round INTEGER NOT NULL DEFAULT 0 CHECK(current_round >= 0),
          model_calls_used INTEGER NOT NULL DEFAULT 0 CHECK(model_calls_used >= 0),
          tool_calls_used INTEGER NOT NULL DEFAULT 0 CHECK(tool_calls_used >= 0),
          active_runtime_ms INTEGER NOT NULL DEFAULT 0 CHECK(active_runtime_ms >= 0),
          waiting_approval_id TEXT,
          last_batch_fingerprint TEXT,
          trace_id TEXT NOT NULL,
          client_request_id TEXT NOT NULL,
          budgets_json TEXT NOT NULL DEFAULT '{}',
          tool_schema_fingerprint TEXT,
          transcript_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_loops_turn ON conversation_loops(turn_id);
        CREATE INDEX IF NOT EXISTS idx_loops_state ON conversation_loops(state);
        CREATE INDEX IF NOT EXISTS idx_loops_waiting_approval ON conversation_loops(waiting_approval_id);
        CREATE INDEX IF NOT EXISTS idx_tool_calls_provider ON tool_calls(turn_id, provider_call_id);
      `);
    },
  },
  {
    version: 12,
    name: "loop_anti_nag_cycle",
    up: (db: DatabaseSync) => {
      // SC-06 Increment 3: bounded rejected-intent fingerprints (§50-51) +
      // consecutive-batch-repeat counter (§57-58). Additive only; existing
      // rows default to empty/no-repeat.
      const cols = columnNames(db, "conversation_loops");
      if (!cols.has("rejected_fingerprints")) {
        db.exec("ALTER TABLE conversation_loops ADD COLUMN rejected_fingerprints TEXT NOT NULL DEFAULT '[]'");
      }
      if (!cols.has("consecutive_repeats")) {
        db.exec("ALTER TABLE conversation_loops ADD COLUMN consecutive_repeats INTEGER NOT NULL DEFAULT 0");
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_turn_status ON tool_calls(turn_id, status);`);
    },
  },
  {
    version: 13,
    name: "invocation_fingerprint",
    up: (db: DatabaseSync) => {
      // SC-06 Increment 3.1: exact semantic invocation identity per tool-call
      // row (SHA-256 hex or NULL for pre-3.1 rows). Only the fingerprint is
      // stored; argument persistence rules are unchanged (sanitized JSON).
      const cols = columnNames(db, "tool_calls");
      if (!cols.has("invocation_fingerprint")) db.exec("ALTER TABLE tool_calls ADD COLUMN invocation_fingerprint TEXT");
    },
  },
];

/** SC-02 fail-closed migration helper for legacy databases (tested directly). */
export function invalidateLegacyV1Approvals(db: DatabaseSync): void {
  db.exec(`
    UPDATE approvals SET status = 'invalidated', resolved_at = COALESCE(resolved_at, CURRENT_TIMESTAMP),
      invalidated_reason = COALESCE(invalidated_reason, 'sc02-migration: v1 approval without v2 binding')
      WHERE status IN ('pending', 'executing') AND (binding_version IS NULL OR binding_version < 2);
  `);
}

const nowIso = (): string => new Date().toISOString();

export type IdempotencyBeginResult =
  | { kind: "proceed" }
  | { kind: "replay"; responseJson: string }
  | { kind: "conflict" }
  | { kind: "in_progress" }
  | { kind: "failed" };

export class SessionStore {
  private db: DatabaseSync;
  private readonly sanitizer: SecretSanitizer;

  constructor(dbPath: string, sanitizer: SecretSanitizer = new SecretSanitizer([])) {
    this.sanitizer = sanitizer;
    const target = dbPath === ":memory:" ? ":memory:" : resolve(dbPath);
    if (target !== ":memory:") {
      mkdirSync(dirname(target), { recursive: true });
    }
    this.db = new DatabaseSync(target, { enableForeignKeyConstraints: true });
    try {
      // Install contention handling before any pragma or migration that may need
      // the schema lock during concurrent process startup.
      this.db.exec("PRAGMA busy_timeout = 10000;");
      this.migrate();
      this.execWithBusyRetry("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA synchronous = NORMAL;");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /** Run a set of store operations as a single unit of work. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private execWithBusyRetry(sql: string): void {
    for (let attempt = 0; ; attempt++) {
      try {
        this.db.exec(sql);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt >= 40 || !/locked|busy/i.test(message)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  }

  private migrate(): void {
    // Foreign keys are disabled only for the atomic table-rebuild migration;
    // validation runs before commit and enforcement is restored in all cases.
    this.db.exec("PRAGMA foreign_keys = OFF");
    // Serialize the complete create/read/apply sequence. The migration metadata
    // table itself is transactional, so a failed first install leaves no partial schema.
    this.execWithBusyRetry("BEGIN IMMEDIATE");
    try {
      this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL)");
      const rows = this.db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>;
      const applied = new Set(rows.map((r) => r.version));
      for (const migration of MIGRATIONS) {
        if (applied.has(migration.version)) continue;
        if (typeof migration.up === "string") this.db.exec(migration.up);
        else migration.up(this.db);
        this.db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(
          migration.version,
          migration.name,
        );
      }
      validateSecureSchema(this.db);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
  }

  // ---- sessions ----------------------------------------------------------

  createSession(id: string, mode: ArthurMode): SessionRecord {
    const now = nowIso();
    this.db
      .prepare("INSERT INTO sessions (id, mode, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?)")
      .run(id, mode, now, now, "active");
    return { id, mode, created_at: now, updated_at: now, status: "active" };
  }

  getSession(id: string): SessionRecord | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as unknown as
      | SessionRecord
      | undefined;
  }

  listSessions(): SessionRecord[] {
    return this.db
      .prepare("SELECT * FROM sessions ORDER BY created_at ASC")
      .all() as unknown as SessionRecord[];
  }

  deleteSession(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id).changes) === 1;
  }

  updateSessionMode(id: string, mode: ArthurMode): SessionRecord | undefined {
    const now = nowIso();
    this.db.prepare("UPDATE sessions SET mode = ?, updated_at = ? WHERE id = ?").run(mode, now, id);
    return this.getSession(id);
  }

  touchSession(id: string): void {
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(nowIso(), id);
  }

  // ---- turns -------------------------------------------------------------

  createTurn(input: {
    id: string;
    sessionId: string;
    role: TurnRole;
    text: string;
    traceId: string;
    status: string;
    mode: ArthurMode;
  }): TurnRecord {
    const created_at = nowIso();
    this.db
      .prepare(
        `INSERT INTO turns (id, session_id, role, text, created_at, trace_id, status, mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.sessionId, input.role, this.sanitizer.sanitizeText(input.text), created_at, input.traceId, input.status, input.mode);
    this.touchSession(input.sessionId);
    return {
      id: input.id,
      session_id: input.sessionId,
      role: input.role,
      text: this.sanitizer.sanitizeText(input.text),
      created_at,
      trace_id: input.traceId,
      status: input.status,
      mode: input.mode,
    };
  }

  getTurn(id: string): TurnRecord | undefined {
    return this.db.prepare("SELECT * FROM turns WHERE id = ?").get(id) as unknown as TurnRecord | undefined;
  }

  /** Most recent user/assistant turns for a given mode, oldest first, capped. */
  getRecentTurns(sessionId: string, mode: ArthurMode, limit: number): TurnRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM turns
         WHERE session_id = ? AND mode = ? AND role IN ('user','assistant')
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(sessionId, mode, limit) as unknown as TurnRecord[];
    return rows.reverse();
  }

  /** All turns for a session, oldest first (including boundary markers). */
  getTurns(sessionId: string): TurnRecord[] {
    return this.db
      .prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(sessionId) as unknown as TurnRecord[];
  }

  // ---- model calls -------------------------------------------------------

  createModelCall(input: {
    id: string;
    turnId: string;
    provider: string;
    model: string;
    latencyMs: number;
    status: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    providerRequestId?: string;
  }): ModelCallRecord {
    if (!Number.isSafeInteger(input.latencyMs) || input.latencyMs < 0) {
      throw new Error("model call latency must be a non-negative safe integer");
    }
    const created_at = nowIso();
    this.db
      .prepare(
        `INSERT INTO model_calls
         (id, turn_id, provider, model, latency_ms, input_tokens, output_tokens, cached_tokens, status, provider_request_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.turnId,
        input.provider,
        input.model,
        input.latencyMs,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.cachedTokens ?? null,
        input.status,
        input.providerRequestId ?? null,
        created_at,
      );
    return {
      id: input.id,
      turn_id: input.turnId,
      provider: input.provider,
      model: input.model,
      latency_ms: input.latencyMs,
      input_tokens: input.inputTokens,
      output_tokens: input.outputTokens,
      cached_tokens: input.cachedTokens,
      status: input.status,
      provider_request_id: input.providerRequestId,
      created_at,
    };
  }

  getModelCallsForTurn(turnId: string): ModelCallRecord[] {
    return this.db
      .prepare("SELECT * FROM model_calls WHERE turn_id = ? ORDER BY created_at ASC")
      .all(turnId) as unknown as ModelCallRecord[];
  }

  // ---- tool calls --------------------------------------------------------

  createToolCall(input: {
    id: string;
    turnId: string;
    toolName: string;
    argumentsJson: string;
    riskLevel: ToolRisk;
    status: ToolCallStatus;
    resultSummary?: string;
    /** SC-06 §15-18 provider protocol correlation id (NULL = pre-SC-06). */
    providerCallId?: string;
    roundNo?: number;
    sequenceNo?: number;
    /** Increment 3.1 exact semantic fingerprint (NULL = pre-3.1/unhashable). */
    invocationFingerprint?: string;
  }): ToolCallRecord {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO tool_calls (id, turn_id, tool_name, arguments_json, risk_level, status, result_summary, created_at, updated_at,
          provider_call_id, round_no, sequence_no, invocation_fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,

      )
      .run(
        input.id,
        input.turnId,
        input.toolName,
        this.sanitizeJson(input.argumentsJson),
        input.riskLevel,
        input.status,
        input.resultSummary === undefined ? null : this.sanitizer.capSummary(input.resultSummary),
        now,
        now,
        input.providerCallId ?? null,
        input.roundNo ?? null,
        input.sequenceNo ?? null,
        input.invocationFingerprint ?? null,
      );
    return {
      id: input.id,
      turn_id: input.turnId,
      tool_name: input.toolName,
      arguments_json: this.sanitizeJson(input.argumentsJson),
      risk_level: input.riskLevel,
      status: input.status,
      result_summary: input.resultSummary === undefined ? undefined : this.sanitizer.capSummary(input.resultSummary),
      created_at: now,
      updated_at: now,
      provider_call_id: input.providerCallId ?? null,
      round_no: input.roundNo ?? null,
      sequence_no: input.sequenceNo ?? null,
      invocation_fingerprint: input.invocationFingerprint ?? null,
    };
  }

  /** SC-06 §21: look up a durable tool call by provider protocol id within a turn. */
  getToolCallByProvider(turnId: string, providerCallId: string): ToolCallRecord | undefined {
    return this.db.prepare("SELECT * FROM tool_calls WHERE turn_id = ? AND provider_call_id = ?").get(turnId, providerCallId) as unknown as
      | ToolCallRecord
      | undefined;
  }

  getToolCall(id: string): ToolCallRecord | undefined {
    return this.db.prepare("SELECT * FROM tool_calls WHERE id = ?").get(id) as unknown as
      | ToolCallRecord
      | undefined;
  }

  getToolCallsForTurn(turnId: string): ToolCallRecord[] {
    return this.db
      .prepare("SELECT * FROM tool_calls WHERE turn_id = ? ORDER BY created_at ASC")
      .all(turnId) as unknown as ToolCallRecord[];
  }

  updateToolCall(id: string, patch: { status?: ToolCallStatus; resultSummary?: string }): void {
    const now = nowIso();
    if (patch.status !== undefined && patch.resultSummary !== undefined) {
      this.db
        .prepare("UPDATE tool_calls SET status = ?, result_summary = ?, updated_at = ? WHERE id = ?")
        .run(patch.status, this.sanitizer.capSummary(patch.resultSummary), now, id);
    } else if (patch.status !== undefined) {
      this.db.prepare("UPDATE tool_calls SET status = ?, updated_at = ? WHERE id = ?").run(patch.status, now, id);
    } else if (patch.resultSummary !== undefined) {
      this.db.prepare("UPDATE tool_calls SET result_summary = ?, updated_at = ? WHERE id = ?").run(
        this.sanitizer.capSummary(patch.resultSummary),
        now,
        id,
      );
    }
  }

  // ---- conversation loops (SC-06 §90-91 durable journal) ------------------

  /**
   * Persist a new loop journal row BEFORE active progression begins (§1).
   * Identity is server-generated; no model/provider value chooses it.
   */
  createLoop(input: {
    id: string;
    turnId: string;
    sessionId: string;
    mode: ArthurMode;
    traceId: string;
    clientRequestId: string;
    budgetsJson: string;
    toolSchemaFingerprint?: string;
  }): ConversationLoopRecord {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO conversation_loops
          (id, turn_id, session_id, mode, state, current_round, model_calls_used, tool_calls_used,
           active_runtime_ms, waiting_approval_id, last_batch_fingerprint, trace_id, client_request_id,
           budgets_json, tool_schema_fingerprint, transcript_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'CREATED', 0, 0, 0, 0, NULL, NULL, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        input.id, input.turnId, input.sessionId, input.mode,
        input.traceId, input.clientRequestId, input.budgetsJson,
        input.toolSchemaFingerprint ?? null, now, now,
      );
    const row = this.getLoop(input.id);
    if (!row) throw new Error("loop journal row could not be created");
    return row;
  }

  getLoop(id: string): ConversationLoopRecord | undefined {
    return this.db.prepare("SELECT * FROM conversation_loops WHERE id = ?").get(id) as unknown as
      | ConversationLoopRecord
      | undefined;
  }

  getLoopByTurn(turnId: string): ConversationLoopRecord | undefined {
    return this.db.prepare("SELECT * FROM conversation_loops WHERE turn_id = ? ORDER BY created_at DESC LIMIT 1").get(turnId) as unknown as
      | ConversationLoopRecord
      | undefined;
  }

  getLoopByApproval(approvalId: string): ConversationLoopRecord | undefined {
    return this.db.prepare("SELECT * FROM conversation_loops WHERE waiting_approval_id = ? ORDER BY updated_at DESC LIMIT 1").get(approvalId) as unknown as
      | ConversationLoopRecord
      | undefined;
  }

  /**
   * Conditional state transition (CAS): UPDATE succeeds only when the current
   * state is one of `from`. NEVER read-then-write without this gate (§3).
   * Returns true only for the single caller that won the transition.
   */
  casLoopState(
    id: string,
    from: ConversationLoopState[],
    to: ConversationLoopState,
    patch?: {
      currentRound?: number;
      modelCallsUsed?: number;
      toolCallsUsed?: number;
      activeRuntimeMs?: number;
      lastBatchFingerprint?: string;
    },
  ): boolean {
    if (from.length === 0) return false;
    const placeholders = from.map(() => "?").join(",");
    const sets: string[] = ["state = ?", "updated_at = ?"];
    const params: unknown[] = [to, nowIso()];
    if (patch?.currentRound !== undefined) { sets.push("current_round = ?"); params.push(patch.currentRound); }
    if (patch?.modelCallsUsed !== undefined) { sets.push("model_calls_used = ?"); params.push(patch.modelCallsUsed); }
    if (patch?.toolCallsUsed !== undefined) { sets.push("tool_calls_used = ?"); params.push(patch.toolCallsUsed); }
    if (patch?.activeRuntimeMs !== undefined) { sets.push("active_runtime_ms = ?"); params.push(patch.activeRuntimeMs); }
    if (patch?.lastBatchFingerprint !== undefined) { sets.push("last_batch_fingerprint = ?"); params.push(patch.lastBatchFingerprint); }
    params.push(id);
    for (const s of from) params.push(s);
    const result = this.db
      .prepare(`UPDATE conversation_loops SET ${sets.join(", ")} WHERE id = ? AND state IN (${placeholders})`)
      .run(...(params as []));
    return Number(result.changes) === 1;
  }

  /**
   * Durably attach the approval barrier (§6-7): active-state row enters
   * WAITING_APPROVAL with the single waiting_approval_id, ONLY when no
   * unresolved barrier is already attached (waiting_approval_id IS NULL).
   * Concurrent second-barrier attempts lose this CAS and fail closed.
   */
  setLoopBarrierCAS(input: {
    id: string;
    approvalId: string;
    currentRound: number;
    modelCallsUsed: number;
    toolCallsUsed: number;
    activeRuntimeMs: number;
    lastBatchFingerprint?: string;
    budgetsJson?: string;
  }): boolean {
    const sets = ["state = 'WAITING_APPROVAL'", "waiting_approval_id = ?", "current_round = ?",
      "model_calls_used = ?", "tool_calls_used = ?", "active_runtime_ms = ?", "updated_at = ?"];
    const params: unknown[] = [input.approvalId, input.currentRound, input.modelCallsUsed,
      input.toolCallsUsed, input.activeRuntimeMs, nowIso()];
    if (input.lastBatchFingerprint !== undefined) { sets.push("last_batch_fingerprint = ?"); params.push(input.lastBatchFingerprint); }
    if (input.budgetsJson !== undefined) { sets.push("budgets_json = ?"); params.push(input.budgetsJson); }
    params.push(input.id);
    const result = this.db
      .prepare(
        `UPDATE conversation_loops SET ${sets.join(", ")}
         WHERE id = ? AND waiting_approval_id IS NULL
           AND state IN ('CREATED','MODEL_RUNNING','ROUND_READY','TOOL_EXECUTING')`,
      )
      .run(...(params as []));
    return Number(result.changes) === 1;
  }

  /**
   * Single-flight resume claim (§47, F20): WAITING_APPROVAL -> RESUMING.
   * Exactly one concurrent caller wins; all others observe truth.
   * Optionally binds the expected approval so a stale decision for a
   * superseded barrier cannot claim the row.
   */
  claimLoopResumeCAS(id: string, expectedApprovalId?: string): boolean {
    const extra = expectedApprovalId !== undefined ? " AND waiting_approval_id = ?" : "";
    const params: unknown[] = expectedApprovalId !== undefined ? [nowIso(), id, expectedApprovalId] : [nowIso(), id];
    const result = this.db
      .prepare(
        `UPDATE conversation_loops SET state = 'RESUMING', updated_at = ?
         WHERE id = ? AND state = 'WAITING_APPROVAL'${extra}`,
      )
      .run(...(params as []));
    return Number(result.changes) === 1;
  }

  /** Clear the resolved barrier after a successful resume claim (same txn as follow-up). */
  clearLoopBarrier(id: string): void {
    this.db.prepare("UPDATE conversation_loops SET waiting_approval_id = NULL, updated_at = ? WHERE id = ?").run(nowIso(), id);
  }

  /** Non-state bookkeeping: counters/round/fingerprint/transcript/budgets. */
  updateLoopProgress(id: string, patch: {
    currentRound?: number;
    modelCallsUsed?: number;
    toolCallsUsed?: number;
    activeRuntimeMs?: number;
    lastBatchFingerprint?: string | null;
    budgetsJson?: string;
    transcriptJson?: string;
    consecutiveRepeats?: number;
  }): void {
    const sets: string[] = ["updated_at = ?"];
    const params: unknown[] = [nowIso()];
    if (patch.currentRound !== undefined) { sets.push("current_round = ?"); params.push(patch.currentRound); }
    if (patch.modelCallsUsed !== undefined) { sets.push("model_calls_used = ?"); params.push(patch.modelCallsUsed); }
    if (patch.toolCallsUsed !== undefined) { sets.push("tool_calls_used = ?"); params.push(patch.toolCallsUsed); }
    if (patch.activeRuntimeMs !== undefined) { sets.push("active_runtime_ms = ?"); params.push(patch.activeRuntimeMs); }
    if (patch.lastBatchFingerprint !== undefined) { sets.push("last_batch_fingerprint = ?"); params.push(patch.lastBatchFingerprint); }
    if (patch.budgetsJson !== undefined) { sets.push("budgets_json = ?"); params.push(patch.budgetsJson); }
    if (patch.transcriptJson !== undefined) { sets.push("transcript_json = ?"); params.push(patch.transcriptJson); }
    if (patch.consecutiveRepeats !== undefined) { sets.push("consecutive_repeats = ?"); params.push(patch.consecutiveRepeats); }
    params.push(id);
    this.db.prepare(`UPDATE conversation_loops SET ${sets.join(", ")} WHERE id = ?`).run(...(params as []));
  }

  /** Increment 3 §50-51: read bounded rejected-intent fingerprints. */
  getLoopRejectedFingerprints(loopId: string): string[] {
    const loop = this.getLoop(loopId);
    if (!loop?.rejected_fingerprints) return [];
    try {
      const parsed: unknown = JSON.parse(loop.rejected_fingerprints);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((v): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v)).slice(0, 32);
    } catch {
      return [];
    }
  }

  /**
   * Increment 3 §50-51: append a rejected invocation fingerprint (bounded
   * 32, set semantics). Called when the USER rejects an approval-requiring
   * action — the fingerprint is recorded at decision time so re-proposals
   * in the same turn never re-prompt (§50) and the record survives restart.
   */
  addLoopRejectedFingerprint(loopId: string, fingerprint: string): void {
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) return;
    const current = this.getLoopRejectedFingerprints(loopId);
    if (current.includes(fingerprint)) return;
    const next = [...current, fingerprint].slice(-32);
    this.db.prepare("UPDATE conversation_loops SET rejected_fingerprints = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(next), nowIso(), loopId);
  }

  /** Increment 3 §57-58: read the consecutive-repeat counter. */
  getLoopConsecutiveRepeats(loopId: string): number {
    return this.getLoop(loopId)?.consecutive_repeats ?? 0;
  }

  /**
   * Increment 3.1 durable completed-mutation fingerprints (F24 authority).
   * Returns persisted invocation_fingerprint values for completed +
   * non-read-risk rows. NULL entries (pre-3.1 rows) are returned as null
   * and skipped by callers — never rehashed from sanitized args.
   * Reads excluded (§8).
   */
  getCompletedMutationFingerprints(turnId: string): Array<string | null> {
    const rows = this.db
      .prepare("SELECT invocation_fingerprint FROM tool_calls WHERE turn_id = ? AND status = 'completed' AND risk_level != 'read'")
      .all(turnId) as Array<{ invocation_fingerprint: string | null }>;
    return rows.map((r) => r.invocation_fingerprint);
  }

  /**
   * Append bounded compact transcript entries (§16, §95-97): operational
   * continuation metadata only. Caps at 64 entries (oldest dropped) and caps
   * each summary; sanitizes args JSON. Never stores rich payloads/reasoning.
   */
  appendLoopTranscript(loopId: string, entries: LoopTranscriptEntry[]): void {
    const loop = this.getLoop(loopId);
    if (!loop) throw new Error("loop journal row not found");
    let current: LoopTranscriptEntry[] = [];
    try {
      current = loop.transcript_json ? (JSON.parse(loop.transcript_json) as LoopTranscriptEntry[]) : [];
      if (!Array.isArray(current)) current = [];
    } catch {
      current = [];
    }
    const safe = entries.map((e) => ({
      round_no: e.round_no,
      sequence_no: e.sequence_no,
      ...(e.note !== undefined ? { note: e.note } : {}),
      provider_call_id: String(e.provider_call_id).slice(0, 256),
      tool_call_id: String(e.tool_call_id),
      tool_name: String(e.tool_name).slice(0, 256),
      arguments_json: this.sanitizeJson(e.arguments_json).slice(0, 4096),
      status: String(e.status).slice(0, 32),
      result_summary: e.result_summary === undefined ? undefined : this.sanitizer.capSummary(e.result_summary).slice(0, 500),
    }));
    const merged = [...current, ...safe].slice(-64);
    this.db.prepare("UPDATE conversation_loops SET transcript_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(merged), nowIso(), loopId);
  }

  /**
   * Startup recovery (§102, F46): every loop left in a non-suspended,
   * non-terminal state by a crash is marked FAILED — never auto-resumed.
   * WAITING_APPROVAL rows are left untouched (explicit human barrier).
   * Returns the number of rows failed closed.
   */
  failClosedActiveLoops(): number {
    const result = this.db
      .prepare(
        `UPDATE conversation_loops SET state = 'FAILED', updated_at = ?
         WHERE state IN ('CREATED','MODEL_RUNNING','ROUND_READY','TOOL_EXECUTING','RESUMING')`,
      )
      .run(nowIso());
    return Number(result.changes);
  }

  // ---- approvals ---------------------------------------------------------

  createApproval(input: {
    id: string;
    turnId: string;
    sessionId: string;
    toolCallId: string;
    toolName: string;
    argumentsJson: string;
    argumentsHash: string;
    riskLevel?: ToolRisk;
    expiresAt: string;
    bindingVersion?: number;
    mode?: ArthurMode;
    toolVersion?: string;
    toolDefinitionHash?: string;
    presentationJson?: string;
    presentationHash?: string;
    authorizationDigest?: string;
    signingKeyId?: string;
    createdAt?: string;
  }): ApprovalRecord {
    if (!/^[0-9a-f]{64}$/.test(input.argumentsHash)) throw new Error("approval argument hash is invalid");
    const created_at = input.createdAt ?? nowIso();
    if (input.createdAt !== undefined && !Number.isFinite(Date.parse(input.createdAt))) {
      throw new Error("approval creation time is invalid");
    }
    if (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.parse(created_at)) {
      throw new Error("approval expiry must be after creation");
    }
    this.db
      .prepare(
        `INSERT INTO approvals
         (id, turn_id, session_id, tool_call_id, tool_name, arguments_json, arguments_hash, risk_level, status, expires_at, created_at,
          binding_version, mode, tool_version, tool_definition_hash, presentation_json, presentation_hash, authorization_digest, signing_key_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.turnId,
        input.sessionId,
        input.toolCallId,
        input.toolName,
        this.sanitizeJson(input.argumentsJson),
        input.argumentsHash,
        input.riskLevel ?? "approval_required",
        input.expiresAt,
        created_at,
        input.bindingVersion ?? 1,
        input.mode ?? null,
        input.toolVersion ?? null,
        input.toolDefinitionHash ?? null,
        input.presentationJson === undefined ? null : this.sanitizer.sanitizeText(input.presentationJson),
        input.presentationHash ?? null,
        input.authorizationDigest ?? null,
        input.signingKeyId ?? null,
      );
    return {
      id: input.id,
      turn_id: input.turnId,
      session_id: input.sessionId,
      tool_call_id: input.toolCallId,
      tool_name: input.toolName,
      arguments_json: this.sanitizeJson(input.argumentsJson),
      arguments_hash: input.argumentsHash,
      risk_level: input.riskLevel ?? "approval_required",
      status: "pending",
      expires_at: input.expiresAt,
      created_at,
      binding_version: input.bindingVersion ?? 1,
      mode: input.mode,
      tool_version: input.toolVersion,
      tool_definition_hash: input.toolDefinitionHash,
      presentation_json: input.presentationJson === undefined ? undefined : this.sanitizer.sanitizeText(input.presentationJson),
      presentation_hash: input.presentationHash,
      authorization_digest: input.authorizationDigest,
      signing_key_id: input.signingKeyId,
    };
  }

  /**
   * Atomically persist a pending tool call AND its approval so a crash can never
   * leave a pending tool call without an approval (audit MEDIUM 6).
   */
  createPendingApprovalAtomic(input: {
    toolCall: {
      id: string;
      turnId: string;
      toolName: string;
      argumentsJson: string;
      riskLevel: ToolRisk;
      providerCallId?: string;
      roundNo?: number;
      sequenceNo?: number;
      invocationFingerprint?: string;
    };
    approval: {
      id: string;
      turnId: string;
      sessionId: string;
      toolCallId: string;
      toolName: string;
      argumentsJson: string;
      argumentsHash: string;
      riskLevel: ToolRisk;
      expiresAt: string;
      bindingVersion?: number;
      mode?: ArthurMode;
      toolVersion?: string;
      toolDefinitionHash?: string;
      presentationJson?: string;
      presentationHash?: string;
      authorizationDigest?: string;
      signingKeyId?: string;
      createdAt?: string;
    };
  }): ApprovalRecord {
    return this.transaction(() => {
      this.createToolCall({
        id: input.toolCall.id,
        turnId: input.toolCall.turnId,
        toolName: input.toolCall.toolName,
        argumentsJson: input.toolCall.argumentsJson,
        riskLevel: input.toolCall.riskLevel,
        status: "pending_approval",
        providerCallId: input.toolCall.providerCallId,
        roundNo: input.toolCall.roundNo,
        sequenceNo: input.toolCall.sequenceNo,
        invocationFingerprint: input.toolCall.invocationFingerprint,
      });
      return this.createApproval({
        id: input.approval.id,
        turnId: input.approval.turnId,
        sessionId: input.approval.sessionId,
        toolCallId: input.approval.toolCallId,
        toolName: input.approval.toolName,
        argumentsJson: input.approval.argumentsJson,
        argumentsHash: input.approval.argumentsHash,
        riskLevel: input.approval.riskLevel,
        expiresAt: input.approval.expiresAt,
        createdAt: input.approval.createdAt,
        bindingVersion: input.approval.bindingVersion,
        mode: input.approval.mode,
        toolVersion: input.approval.toolVersion,
        toolDefinitionHash: input.approval.toolDefinitionHash,
        presentationJson: input.approval.presentationJson,
        presentationHash: input.approval.presentationHash,
        authorizationDigest: input.approval.authorizationDigest,
        signingKeyId: input.approval.signingKeyId,
      });
    });
  }

  /** Terminal invalidation of a pending approval whose context drifted (SC-02 section 41). */
  invalidatePendingApproval(approvalId: string, toolCallId: string, reason: string): boolean {
    return this.transaction(() => {
      const result = this.db
        .prepare("UPDATE approvals SET status = 'invalidated', resolved_at = ?, invalidated_reason = ? WHERE id = ? AND status = 'pending'")
        .run(nowIso(), this.sanitizer.capSummary(reason), approvalId);
      if (Number(result.changes) === 1) {
        this.updateToolCall(toolCallId, { status: "failed", resultSummary: "invalidated: " + reason });
        return true;
      }
      return false;
    });
  }

  /** Mark an approval decision channel (audit metadata only, never authority). */
  recordApprovalDecisionChannel(approvalId: string, channel: string): void {
    this.db.prepare("UPDATE approvals SET decision_channel = ? WHERE id = ?").run(channel, approvalId);
  }

  getApproval(id: string): ApprovalRecord | undefined {
    return this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as unknown as
      | ApprovalRecord
      | undefined;
  }

  updateApproval(id: string, patch: { status: ApprovalStatus; resolvedAt?: string }): void {
    const resolved_at = patch.resolvedAt ?? nowIso();
    this.db.prepare("UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?").run(patch.status, resolved_at, id);
  }

  /**
   * Atomic compare-and-swap: pending -> executing. Returns true only for the
   * single caller that wins the claim; all others receive false.
   */
  claimApproval(id: string): boolean {
    const result = this.db
      .prepare("UPDATE approvals SET status = 'executing', claimed_at = ? WHERE id = ? AND status = 'pending'")
      .run(nowIso(), id);
    return Number(result.changes) === 1;
  }

  /** Claim only if every persisted binding still matches in one SQL CAS (SC-02 v2). */
  claimApprovalBound(input: {
    id: string;
    sessionId: string;
    sessionMode: ArthurMode;
    turnId: string;
    toolCallId: string;
    toolName: string;
    toolVersion?: string;
    toolDefinitionHash?: string;
    presentationHash?: string;
    authorizationDigest?: string;
    argumentsJson: string;
    argumentsHash: string;
    riskLevel: ToolRisk;
  }): boolean {
    const versionMatch = input.toolVersion === undefined ? "approvals.tool_version IS NULL" : "approvals.tool_version = ?";
    const defMatch = input.toolDefinitionHash === undefined ? "approvals.tool_definition_hash IS NULL" : "approvals.tool_definition_hash = ?";
    const presMatch = input.presentationHash === undefined ? "approvals.presentation_hash IS NULL" : "approvals.presentation_hash = ?";
    const digestMatch = input.authorizationDigest === undefined ? "approvals.authorization_digest IS NULL" : "approvals.authorization_digest = ?";
    const now = nowIso();
    const params: unknown[] = [now, input.id, input.sessionId, input.turnId, input.toolCallId,
      input.toolName, input.argumentsJson, input.argumentsHash, input.riskLevel, input.sessionMode];
    if (input.toolVersion !== undefined) params.push(input.toolVersion);
    if (input.toolDefinitionHash !== undefined) params.push(input.toolDefinitionHash);
    if (input.presentationHash !== undefined) params.push(input.presentationHash);
    if (input.authorizationDigest !== undefined) params.push(input.authorizationDigest);
    params.push(now, input.sessionMode);
    const result = this.db
      .prepare(
        `UPDATE approvals SET status = 'executing', claimed_at = ?
         WHERE id = ? AND status = 'pending' AND session_id = ? AND turn_id = ?
           AND tool_call_id = ? AND tool_name = ? AND arguments_json = ?
           AND arguments_hash = ? AND risk_level = ? AND mode = ?
           AND ${versionMatch} AND ${defMatch} AND ${presMatch} AND ${digestMatch}
           AND binding_version = 2
           AND expires_at > ?
           AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = approvals.session_id AND s.mode = ?)
           AND EXISTS (SELECT 1 FROM tool_calls t WHERE t.id = approvals.tool_call_id
             AND t.turn_id = approvals.turn_id AND t.tool_name = approvals.tool_name
             AND t.arguments_json = approvals.arguments_json AND t.risk_level = approvals.risk_level
             AND t.status = 'pending_approval')`,
      )
      .run(...(params as []));
    return Number(result.changes) === 1;
  }

  /**
   * SC-03 section 13 binding re-check for the consume winner: verifies the FULL
   * v2 binding still holds on the just-consumed (APPROVED + consumed_at) row.
   * Read-only CAS: sets nothing, requires changes-free match. Returns true only
   * when every binding field (including consumed_at) matches exactly one row.
   */
  claimApprovalBoundConsumed(input: {
    id: string;
    sessionId: string;
    sessionMode: ArthurMode;
    turnId: string;
    toolCallId: string;
    toolName: string;
    toolVersion?: string;
    toolDefinitionHash?: string;
    presentationHash?: string;
    authorizationDigest?: string;
    argumentsJson: string;
    argumentsHash: string;
    riskLevel: ToolRisk;
    consumedAt: string;
  }): boolean {
    const versionMatch = input.toolVersion === undefined ? "approvals.tool_version IS NULL" : "approvals.tool_version = ?";
    const defMatch = input.toolDefinitionHash === undefined ? "approvals.tool_definition_hash IS NULL" : "approvals.tool_definition_hash = ?";
    const presMatch = input.presentationHash === undefined ? "approvals.presentation_hash IS NULL" : "approvals.presentation_hash = ?";
    const digestMatch = input.authorizationDigest === undefined ? "approvals.authorization_digest IS NULL" : "approvals.authorization_digest = ?";
    const params: unknown[] = [input.id, input.sessionId, input.turnId, input.toolCallId,
      input.toolName, input.argumentsJson, input.argumentsHash, input.riskLevel, input.sessionMode];
    if (input.toolVersion !== undefined) params.push(input.toolVersion);
    if (input.toolDefinitionHash !== undefined) params.push(input.toolDefinitionHash);
    if (input.presentationHash !== undefined) params.push(input.presentationHash);
    if (input.authorizationDigest !== undefined) params.push(input.authorizationDigest);
    params.push(input.consumedAt, input.sessionMode);
    const row = this.db
      .prepare(
        `SELECT id FROM approvals WHERE id = ? AND status = 'approved' AND consumed_at IS NOT NULL
           AND session_id = ? AND turn_id = ? AND tool_call_id = ? AND tool_name = ?
           AND arguments_json = ? AND arguments_hash = ? AND risk_level = ? AND mode = ?
           AND ${versionMatch} AND ${defMatch} AND ${presMatch} AND ${digestMatch}
           AND binding_version = 2 AND consumed_at = ?
           AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = approvals.session_id AND s.mode = ?)
           AND EXISTS (SELECT 1 FROM tool_calls t WHERE t.id = approvals.tool_call_id
             AND t.turn_id = approvals.turn_id AND t.tool_name = approvals.tool_name
             AND t.arguments_json = approvals.arguments_json AND t.risk_level = approvals.risk_level)
           AND EXISTS (SELECT 1 FROM tool_executions e WHERE e.approval_id = approvals.id)`,
      )
      .get(...(params as [])) as unknown as { id: string } | undefined;
    return row?.id === input.id;
  }

  /** Legacy-shaped bound claim kept for pre-v2 tests: exact v1 binding only. */
  claimApprovalBoundLegacy(input: {
    id: string;
    sessionId: string;
    sessionMode: ArthurMode;
    turnId: string;
    toolCallId: string;
    toolName: string;
    argumentsJson: string;
    argumentsHash: string;
    riskLevel: ToolRisk;
  }): boolean {
    const result = this.db
      .prepare(
        `UPDATE approvals SET status = 'executing', claimed_at = ?
         WHERE id = ? AND status = 'pending' AND session_id = ? AND turn_id = ?
           AND tool_call_id = ? AND tool_name = ? AND arguments_json = ?
           AND arguments_hash = ? AND risk_level = ?
           AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = approvals.session_id AND s.mode = ?)
           AND EXISTS (SELECT 1 FROM tool_calls t WHERE t.id = approvals.tool_call_id
             AND t.turn_id = approvals.turn_id AND t.tool_name = approvals.tool_name
             AND t.arguments_json = approvals.arguments_json AND t.risk_level = approvals.risk_level
             AND t.status = 'pending_approval')`,
      )
      .run(
        nowIso(), input.id, input.sessionId, input.turnId, input.toolCallId,
        input.toolName, input.argumentsJson, input.argumentsHash, input.riskLevel, input.sessionMode,
      );
    return Number(result.changes) === 1;
  }

  /**
   * Terminalize a consumed approval (SC-03 section 13): the approval was
   * already consumed (APPROVED + consumed_at + bound execution) in the atomic
   * consume transaction; this step only stamps resolved_at. The status CAS
   * accepts 'approved' (consumed, terminalizing now) and legacy 'executing'
   * rows (pre-§13 path / in-flight upgrades). Never transitions backwards.
   */
  completeApproval(approvalId: string, toolCallId: string, resultSummary: string): void {
    this.transaction(() => {
      const approval = this.db
        .prepare("UPDATE approvals SET resolved_at = COALESCE(resolved_at, ?) WHERE id = ? AND tool_call_id = ? AND status IN ('approved','executing') AND consumed_at IS NOT NULL")
        .run(nowIso(), approvalId, toolCallId);
      // SC-03: the coordinator terminal commit may already have mirrored
      // completed onto the tool call; accept either pending_approval (legacy
      // direct path) or the durable completed mirror, refreshing the summary.
      const tool = this.db
        .prepare("UPDATE tool_calls SET status = 'completed', result_summary = ?, updated_at = ? WHERE id = ? AND status IN ('pending_approval','completed')")
        .run(this.sanitizer.capSummary(resultSummary), nowIso(), toolCallId);
      if (Number(approval.changes) !== 1 || Number(tool.changes) !== 1) {
        throw new Error("approval completion state transition failed");
      }
    });
  }

  /**
   * Persist diagnostic context for a consumed approval (SC-03 section 13).
   * The execution row carries the quarantine/retry truth; this only refreshes
   * the tool-call summary. Gated on the consumed (approved + consumed_at) row
   * so diagnostics can never attach to an unconsumed or foreign approval.
   */
  recordApprovalExecutionError(approvalId: string, toolCallId: string, message: string): void {
    const capped = this.sanitizer.capSummary(message);
    const now = nowIso();
    const gate = `EXISTS (SELECT 1 FROM approvals a WHERE a.id = ? AND a.tool_call_id = tool_calls.id
      AND a.status = 'approved' AND a.consumed_at IS NOT NULL)`;
    const pending = this.db
      .prepare(
        `UPDATE tool_calls SET result_summary = ?, updated_at = ? WHERE id = ?
         AND status = 'pending_approval' AND ${gate}`,
      )
      .run(capped, now, toolCallId, approvalId);
    if (Number(pending.changes) === 1) return;
    const mirrored = this.db
      .prepare(
        `UPDATE tool_calls SET result_summary = ?, updated_at = ? WHERE id = ?
         AND status IN ('failed','outcome_unknown','timed_out','cancelled','completed','executing') AND ${gate}`,
      )
      .run(capped, now, toolCallId, approvalId);
    if (Number(mirrored.changes) !== 1) throw new Error("approval execution diagnostic could not be persisted");
  }

  failApproval(approvalId: string, toolCallId: string, message: string): void {
    this.transaction(() => {
      const approval = this.db
        .prepare("UPDATE approvals SET status = 'failed', resolved_at = ? WHERE id = ? AND tool_call_id = ? AND status = 'executing'")
        .run(nowIso(), approvalId, toolCallId);
      const tool = this.db
        .prepare("UPDATE tool_calls SET status = 'failed', result_summary = ?, updated_at = ? WHERE id = ? AND status = 'pending_approval'")
        .run(this.sanitizer.capSummary(message), nowIso(), toolCallId);
      if (Number(approval.changes) !== 1 || Number(tool.changes) !== 1) {
        throw new Error("approval failure state transition failed");
      }
    });
  }

  /** Terminal rejection of an approval that never reached the executing state. */
  failPendingApproval(approvalId: string, toolCallId: string, message: string): void {
    this.transaction(() => {
      this.db
        .prepare("UPDATE approvals SET status = 'failed', resolved_at = ? WHERE id = ? AND status = 'pending'")
        .run(nowIso(), approvalId);
      this.updateToolCall(toolCallId, { status: "failed", resultSummary: message });
    });
  }

  /**
   * SC-06 §49 expiry: atomic pending -> expired when past expiry. Returns
   * true only for the caller that marked it. Terminal; never auto-resumes
   * execution. The loop resume path converts it to an approval_expired
   * envelope with at most one bounded model continuation.
   */
  expireApprovalCAS(approvalId: string): boolean {
    const result = this.db
      .prepare("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending' AND expires_at <= ?")
      .run(nowIso(), approvalId, nowIso());
    return Number(result.changes) === 1;
  }

  /** Atomic pending -> rejected; returns false if the approval was not pending. */
  rejectApproval(approvalId: string, toolCallId: string): boolean {
    return this.transaction(() => {
      const result = this.db
        .prepare("UPDATE approvals SET status = 'rejected', resolved_at = ? WHERE id = ? AND status = 'pending'")
        .run(nowIso(), approvalId);
      if (Number(result.changes) === 1) {
        this.updateToolCall(toolCallId, { status: "rejected", resultSummary: "rejected by user" });
        return true;
      }
      return false;
    });
  }

  listPendingApprovals(sessionId?: string): ApprovalRecord[] {
    if (sessionId) {
      return this.db
        .prepare("SELECT * FROM approvals WHERE status = 'pending' AND expires_at > ? AND session_id = ? ORDER BY created_at ASC")
        .all(nowIso(), sessionId) as unknown as ApprovalRecord[];
    }
    return this.db
      .prepare("SELECT * FROM approvals WHERE status = 'pending' AND expires_at > ? ORDER BY created_at ASC")
      .all(nowIso()) as unknown as ApprovalRecord[];
  }

  // ---- idempotency -------------------------------------------------------

  getIdempotency(id: string): IdempotencyRecord | undefined {
    return this.db.prepare("SELECT * FROM idempotency_keys WHERE id = ?").get(id) as unknown as
      | IdempotencyRecord
      | undefined;
  }

  /**
   * Atomically reserve an idempotency key and drive its state machine. Returns
   * "proceed" (caller owns the key), "replay" (completed; return cached
   * response), "conflict" (key reused with a different request hash),
   * "in_progress" (concurrent duplicate), or "failed" (a prior attempt failed
   * or its lease expired and requires a new request id).
   */
  beginIdempotency(id: string, clientRequestId: string, requestHash: string, staleMs: number): IdempotencyBeginResult {
    const now = nowIso();
    for (let attempt = 0; attempt < 4; attempt++) {
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO idempotency_keys (id, client_request_id, request_hash, status, created_at, updated_at)
           VALUES (?, ?, ?, 'in_progress', ?, ?)`,
        )
        .run(id, clientRequestId, requestHash, now, now);
      if (Number(inserted.changes) === 1) return { kind: "proceed" };

      const record = this.getIdempotency(id);
      if (!record) continue;

      if (record.request_hash !== requestHash) return { kind: "conflict" };
      if (record.status === "completed" && record.response_json) {
        return { kind: "replay", responseJson: record.response_json };
      }
      if (record.status === "failed") {
        // Failed/crashed attempts are terminal for this key. Re-executing an
        // unknown partial attempt could duplicate tools or external writes.
        return { kind: "failed" };
      }
      if (record.status === "in_progress") {
        const staleBefore = new Date(Date.now() - staleMs).toISOString();
        const abandoned = this.db
          .prepare(
            `UPDATE idempotency_keys SET status = 'failed', updated_at = ?
             WHERE id = ? AND status = 'in_progress' AND updated_at < ?`,
          )
          .run(now, id, staleBefore);
        if (Number(abandoned.changes) === 1) return { kind: "failed" };
        return { kind: "in_progress" };
      }
      return { kind: "conflict" };
    }
    return { kind: "in_progress" };
  }

  completeIdempotency(id: string, sessionId: string, turnId: string, responseJson: string): void {
    this.db
      .prepare(
        `UPDATE idempotency_keys SET status = 'completed', response_json = ?, session_id = ?, turn_id = ?, updated_at = ?
         WHERE id = ? AND status = 'in_progress'`,
      )
      .run(this.sanitizeJson(responseJson), sessionId, turnId, nowIso(), id);
  }

  failIdempotency(id: string): void {
    this.db
      .prepare("UPDATE idempotency_keys SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'in_progress'")
      .run(nowIso(), id);
  }

  // ---- atomic multi-row transitions -------------------------------------

  createSessionAndUserTurn(input: {
    sessionId: string;
    mode: ArthurMode;
    idempotencyId?: string;
    turn: { id: string; text: string; traceId: string };
  }): SessionRecord {
    return this.transaction(() => {
      const session = this.createSession(input.sessionId, input.mode);
      this.createTurn({
        id: input.turn.id,
        sessionId: input.sessionId,
        role: "user",
        text: input.turn.text,
        traceId: input.turn.traceId,
        status: "completed",
        mode: input.mode,
      });
      if (input.idempotencyId) this.bindIdempotency(input.idempotencyId, input.sessionId, input.turn.id);
      return session;
    });
  }

  /** Bind the reserved request to its durable session and user turn. */
  bindIdempotency(id: string, sessionId: string, turnId: string): void {
    const result = this.db
      .prepare(
        `UPDATE idempotency_keys SET session_id = ?, turn_id = ?, updated_at = ?
         WHERE id = ? AND status = 'in_progress' AND session_id IS NULL AND turn_id IS NULL`,
      )
      .run(sessionId, turnId, nowIso(), id);
    if (Number(result.changes) !== 1) throw new Error("idempotency reservation could not be bound");
  }

  /** Existing-session user turn plus request binding as one durable unit. */
  createUserTurnForIdempotency(input: {
    idempotencyId: string;
    id: string;
    sessionId: string;
    text: string;
    traceId: string;
    mode: ArthurMode;
  }): TurnRecord {
    return this.transaction(() => {
      const turn = this.createTurn({
        id: input.id,
        sessionId: input.sessionId,
        role: "user",
        text: input.text,
        traceId: input.traceId,
        status: "completed",
        mode: input.mode,
      });
      this.bindIdempotency(input.idempotencyId, input.sessionId, input.id);
      return turn;
    });
  }

  /** Persist the assistant turn and replay response atomically. */
  finalizeIdempotentTurn(input: {
    idempotencyId: string;
    assistant: { id: string; sessionId: string; text: string; traceId: string; status: string; mode: ArthurMode };
    responseJson: string;
  }): void {
    this.transaction(() => {
      this.createTurn({ ...input.assistant, role: "assistant" });
      const result = this.db
        .prepare(
          `UPDATE idempotency_keys SET status = 'completed', response_json = ?, updated_at = ?
           WHERE id = ? AND status = 'in_progress' AND session_id = ?`,
        )
        .run(this.sanitizeJson(input.responseJson), nowIso(), input.idempotencyId, input.assistant.sessionId);
      if (Number(result.changes) !== 1) throw new Error("idempotency reservation could not be completed");
    });
  }

  changeModeAtomic(
    sessionId: string,
    mode: ArthurMode,
    marker: { id: string; text: string; traceId: string },
  ): void {
    this.transaction(() => {
      // SC-03 section 13: an in-flight operation is either a legacy 'executing'
      // claim or a consumed-but-unresolved approval (APPROVED + consumed_at
      // with a non-terminal bound execution). Both block mode changes.
      const activeApproval = this.db
        .prepare(`SELECT 1 FROM approvals WHERE session_id = ? AND (status = 'executing'
           OR (status = 'approved' AND consumed_at IS NOT NULL AND resolved_at IS NULL)) LIMIT 1`)
        .get(sessionId);
      if (activeApproval) throw new Error("session mode cannot change while an approval is executing");
      const activeTurn = this.db
        .prepare("SELECT 1 FROM idempotency_keys WHERE session_id = ? AND status = 'in_progress' LIMIT 1")
        .get(sessionId);
      if (activeTurn) throw new Error("session mode cannot change while a turn is in progress");
      // SC-02 section 6/42: mode switch atomically invalidates old-mode pending
      // approvals (even for tools allowed in both modes) plus their tool calls.
      const pending = this.db
        .prepare("SELECT id, tool_call_id FROM approvals WHERE session_id = ? AND status = 'pending'")
        .all(sessionId) as Array<{ id: string; tool_call_id: string }>;
      const now = nowIso();
      for (const row of pending) {
        this.db
          .prepare("UPDATE approvals SET status = 'invalidated', resolved_at = ?, invalidated_reason = ? WHERE id = ? AND status = 'pending'")
          .run(now, "session mode changed", row.id);
        this.db
          .prepare("UPDATE tool_calls SET status = 'failed', result_summary = ?, updated_at = ? WHERE id = ? AND status = 'pending_approval'")
          .run(this.sanitizer.capSummary("invalidated: session mode changed"), now, row.tool_call_id);
      }
      this.updateSessionMode(sessionId, mode);
      this.createTurn({
        id: marker.id,
        sessionId,
        role: "system",
        text: marker.text,
        traceId: marker.traceId,
        status: "completed",
        mode,
      });
    });
  }

  /** SC-03 section 92: share the SAME connection/transaction with ExecutionStore. */
  unsafeDbHandle(): DatabaseSync {
    return this.db;
  }

  sanitizerHandle(): SecretSanitizer {
    return this.sanitizer;
  }

  private sanitizeJson(value: string): string {
    try {
      return JSON.stringify(this.sanitizer.sanitizeObject(JSON.parse(value) as Record<string, unknown>));
    } catch {
      return this.sanitizer.sanitizeText(value);
    }
  }

  close(): void {
    this.db.close();
  }
}