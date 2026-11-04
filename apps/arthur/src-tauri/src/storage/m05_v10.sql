-- M05 candidate v10, artifact revision 1. DORMANT: NOT in production STEPS.
-- This file is the authoritative executable candidate. Task 05 document SQL is
-- its historical design input, not another migration source. Future activation
-- must reuse include_str!("m05_v10.sql") in ONE migration transaction with the
-- version bump; never execute this script from application startup today.
-- No BEGIN/COMMIT, PRAGMA, random IDs, time defaults, backfill or key provisioning.
-- All nine tables contain private local knowledge/metadata. Domain rows and
-- immutable bundles are canonical; facet heads are derived; effects/context
-- are transient and MUST be empty after native finalization. Snapshot rows are
-- immutable captured images, not a second mutable domain store.
-- Index purposes: active-origin uniqueness; bundle stream-range and ID lookup;
-- effects by event/order; facet lookup/by-event retention pin; snapshot packing
-- by snapshot/ordinal and duplicate logical-row detection.
-- SQL coverage checks bundle presence/counts, NOT JCS, hashes, domain closure,
-- authenticity, aggregate quotas, manifest completeness or safe owner activation.
-- Review candidates: 4 MiB core, 4096 effects, 8 MiB spool, 256 MiB pending
-- payloads, 32 MiB/20000 snapshot records, 256 KiB chunks. Native admission and
-- large-history evidence remain gates; quota failure must roll back ALL domain
-- data. >256 KiB export needs later authenticated atomic staging, never splitting
-- a logical commit. No production writer/observer bypass is provided.
-- Closed v1 projection catalog (entity | logical key | ordered fields):
-- projects | id | id,name,created_at,updated_at,archived_at
-- captures | id | id,source,content,created_at,project_id
-- distillation_runs | capture_id | capture_id,created_at
-- knowledge_objects | id | id,kind,title,body,created_at,current_revision_id,project_id
-- object_sources | object_id | object_id,capture_id,source_start,source_end
-- thought_revisions | id | id,object_id,kind,title,body,origin,created_at,capture_id,source_start,source_end
-- revision_parents | child_revision_id,parent_revision_id | child_revision_id,parent_revision_id
-- relations | id | id,kind,source_object_id,target_object_id,origin,created_at
-- identity_decisions | capture_id,ordinal | capture_id,ordinal,outcome,unchecked_reason,target_object_id,base_revision_id,result_revision_id,created_object_id,policy_version,model_id,decided_by,vetoes_json,audit_json,decided_at
-- revision_evidence | revision_id,ordinal | revision_id,ordinal,object_id,capture_id,source_start,source_end,role,retracts_revision_id,retracts_ordinal,interpretation_label,created_at
-- pending_claims | id | id,capture_id,ordinal,kind,title,body,source_start,source_end,candidate_ids_json,reasons_json,reframing,state,due_at,created_at,updated_at,deferred_at,resolved_at,resolved_method,resolved_object_id,resolved_revision_id
-- revision_proposals | id | id,pending_claim_id,object_id,base_revision_id,change,kind,title,proposed_body,retracts_revision_id,retracts_ordinal,evidence_json,synthesis_model,verifier_model,verification_mode,verification_status,policy_version,state,user_edited,final_body,result_revision_id,created_at,updated_at,reviewed_at


-- candidate-core
CREATE TABLE sync_origins (
    origin_id TEXT NOT NULL CHECK(length(origin_id)=36),
    incarnation TEXT NOT NULL CHECK(length(incarnation)=36),
    status TEXT NOT NULL CHECK(status IN ('active','sealed')),
    last_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_seq>=0),
    last_hash BLOB NOT NULL DEFAULT (zeroblob(32)) CHECK(length(last_hash)=32),
    opened_at TEXT NOT NULL CHECK(length(opened_at)>0),
    sealed_at TEXT,
    PRIMARY KEY(origin_id,incarnation),
    CHECK((status='active' AND sealed_at IS NULL) OR (status='sealed' AND sealed_at IS NOT NULL)),
    CHECK(last_seq<>0 OR last_hash=zeroblob(32))
) STRICT;
CREATE UNIQUE INDEX sync_one_active_origin ON sync_origins(status) WHERE status='active';

CREATE TABLE sync_local (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    origin_id TEXT NOT NULL CHECK(length(origin_id)=36),
    active_incarnation TEXT NOT NULL CHECK(length(active_incarnation)=36),
    bootstrap_required INTEGER NOT NULL DEFAULT 1 CHECK(bootstrap_required IN (0,1)),
    FOREIGN KEY(origin_id,active_incarnation) REFERENCES sync_origins(origin_id,incarnation)
) STRICT;

CREATE TABLE sync_bundles (
    event_id TEXT PRIMARY KEY NOT NULL CHECK(length(event_id)=36),
    bundle_id TEXT NOT NULL UNIQUE CHECK(length(bundle_id)=36),
    origin_id TEXT NOT NULL,
    incarnation TEXT NOT NULL,
    origin_seq INTEGER NOT NULL CHECK(origin_seq>0),
    payload_schema INTEGER NOT NULL CHECK(payload_schema=1),
    raw_effect_count INTEGER NOT NULL CHECK(raw_effect_count BETWEEN 1 AND 4096),
    canonical_bytes BLOB NOT NULL CHECK(length(canonical_bytes) BETWEEN 1 AND 4194304),
    canonical_hash BLOB NOT NULL CHECK(length(canonical_hash)=32),
    previous_hash BLOB NOT NULL CHECK(length(previous_hash)=32),
    committed_at TEXT NOT NULL CHECK(length(committed_at)>0),
    UNIQUE(origin_id,incarnation,origin_seq),
    FOREIGN KEY(origin_id,incarnation) REFERENCES sync_origins(origin_id,incarnation)
) STRICT;

CREATE TABLE sync_write_context (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    event_id TEXT NOT NULL UNIQUE CHECK(length(event_id)=36),
    effect_count INTEGER NOT NULL DEFAULT 0 CHECK(effect_count BETWEEN 0 AND 4096),
    staged_bytes INTEGER NOT NULL DEFAULT 0 CHECK(staged_bytes BETWEEN 0 AND 8388608),
    FOREIGN KEY(event_id) REFERENCES sync_bundles(event_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE sync_commit_fences (
    event_id TEXT PRIMARY KEY NOT NULL,
    FOREIGN KEY(event_id) REFERENCES sync_bundles(event_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE sync_effects (
    effect_no INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES sync_commit_fences(event_id),
    entity_kind TEXT NOT NULL,
    entity_key TEXT NOT NULL CHECK(json_valid(entity_key) AND json_type(entity_key)='array'),
    before_json TEXT CHECK(before_json IS NULL OR (json_valid(before_json) AND json_type(before_json)='object')),
    after_json TEXT CHECK(after_json IS NULL OR (json_valid(after_json) AND json_type(after_json)='object')),
    CHECK(before_json IS NOT NULL OR after_json IS NOT NULL)
) STRICT;
CREATE INDEX sync_effects_by_event ON sync_effects(event_id,effect_no);

CREATE TABLE sync_entity_heads (
    entity_kind TEXT NOT NULL,
    entity_key TEXT NOT NULL CHECK(json_valid(entity_key) AND json_type(entity_key)='array'),
    facet TEXT NOT NULL CHECK(facet IN ('record','membership','head','lifecycle')),
    event_id TEXT NOT NULL REFERENCES sync_bundles(event_id),
    state_hash BLOB NOT NULL CHECK(length(state_hash)=32),
    PRIMARY KEY(entity_kind,entity_key,facet)
) STRICT;
CREATE INDEX sync_heads_by_event ON sync_entity_heads(event_id);

CREATE TABLE sync_snapshots (
    snapshot_id TEXT PRIMARY KEY NOT NULL CHECK(length(snapshot_id)=36),
    state TEXT NOT NULL CHECK(state IN ('pending','materialized','ready','aborted')),
    profile TEXT NOT NULL CHECK(profile='knowledge-v1-full'),
    requested_at TEXT NOT NULL CHECK(length(requested_at)>0),
    boundary_bytes BLOB,
    row_count INTEGER NOT NULL DEFAULT 0 CHECK(row_count BETWEEN 0 AND 20000),
    total_bytes INTEGER NOT NULL DEFAULT 0 CHECK(total_bytes BETWEEN 0 AND 33554432),
    manifest_bytes BLOB CHECK(manifest_bytes IS NULL OR length(manifest_bytes) BETWEEN 1 AND 262144),
    manifest_hash BLOB CHECK(manifest_hash IS NULL OR length(manifest_hash)=32),
    CHECK(state NOT IN ('materialized','ready') OR boundary_bytes IS NOT NULL),
    CHECK((state='ready' AND manifest_bytes IS NOT NULL AND manifest_hash IS NOT NULL)
       OR (state<>'ready' AND manifest_bytes IS NULL AND manifest_hash IS NULL))
) STRICT;

CREATE TABLE sync_snapshot_rows (
    snapshot_id TEXT NOT NULL REFERENCES sync_snapshots(snapshot_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 19999),
    entity_kind TEXT NOT NULL,
    entity_key TEXT NOT NULL CHECK(json_valid(entity_key) AND json_type(entity_key)='array'),
    row_bytes BLOB NOT NULL CHECK(length(row_bytes) BETWEEN 1 AND 262144),
    row_hash BLOB NOT NULL CHECK(length(row_hash)=32),
    PRIMARY KEY(snapshot_id,ordinal),
    UNIQUE(snapshot_id,entity_kind,entity_key)
) STRICT;

-- candidate-guards
CREATE TRIGGER sync_context_identity_fixed BEFORE UPDATE OF singleton,event_id ON sync_write_context
BEGIN SELECT RAISE(ABORT,'journal context identity is fixed'); END;
CREATE TRIGGER sync_fences_no_update BEFORE UPDATE ON sync_commit_fences
BEGIN SELECT RAISE(ABORT,'journal fence is immutable'); END;
CREATE TRIGGER sync_fences_no_delete BEFORE DELETE ON sync_commit_fences
BEGIN SELECT RAISE(ABORT,'journal fence cannot be deleted'); END;
CREATE TRIGGER sync_bundles_no_update BEFORE UPDATE ON sync_bundles
BEGIN SELECT RAISE(ABORT,'journal bundle is immutable'); END;
CREATE TRIGGER sync_bundles_no_delete BEFORE DELETE ON sync_bundles
BEGIN SELECT RAISE(ABORT,'journal compaction is not enabled'); END;

CREATE TRIGGER sync_bundle_admission BEFORE INSERT ON sync_bundles
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_origins o JOIN sync_local l
          ON l.origin_id=o.origin_id AND l.active_incarnation=o.incarnation
        JOIN sync_write_context c ON c.singleton=1 AND c.event_id=NEW.event_id
        JOIN sync_commit_fences f ON f.event_id=c.event_id
        WHERE l.singleton=1 AND o.status='active'
          AND NEW.origin_id=o.origin_id AND NEW.incarnation=o.incarnation
          AND o.last_seq<9223372036854775807 AND NEW.origin_seq=o.last_seq+1
          AND NEW.previous_hash=o.last_hash AND NEW.raw_effect_count=c.effect_count
          AND NEW.raw_effect_count=(SELECT count(*) FROM sync_effects e WHERE e.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal bundle is not the active complete next transaction') END;
END;
CREATE TRIGGER sync_origin_cursor_guard BEFORE UPDATE OF last_seq,last_hash ON sync_origins
WHEN OLD.status<>'active' OR NEW.last_seq<>OLD.last_seq+1 OR NOT EXISTS (
    SELECT 1 FROM sync_bundles b WHERE b.origin_id=OLD.origin_id AND b.incarnation=OLD.incarnation
      AND b.origin_seq=NEW.last_seq AND b.previous_hash=OLD.last_hash AND b.canonical_hash=NEW.last_hash
)
BEGIN SELECT RAISE(ABORT,'origin cursor must advance through its next bundle'); END;
CREATE TRIGGER sync_bundle_moves_tip AFTER INSERT ON sync_bundles
BEGIN
    UPDATE sync_origins SET last_seq=NEW.origin_seq,last_hash=NEW.canonical_hash
     WHERE origin_id=NEW.origin_id AND incarnation=NEW.incarnation;
END;
CREATE TRIGGER sync_origin_identity_fixed BEFORE UPDATE OF origin_id,incarnation,opened_at ON sync_origins
BEGIN SELECT RAISE(ABORT,'origin identity is immutable'); END;
CREATE TRIGGER sync_origin_seal_final BEFORE UPDATE OF status,sealed_at ON sync_origins
WHEN OLD.status='sealed' OR NEW.status<>'sealed' OR NEW.sealed_at IS NULL
BEGIN SELECT RAISE(ABORT,'an origin may only be sealed once'); END;
CREATE TRIGGER sync_origins_no_delete BEFORE DELETE ON sync_origins
BEGIN SELECT RAISE(ABORT,'origin seals must be retained'); END;

CREATE TRIGGER sync_snapshot_rows_no_update BEFORE UPDATE ON sync_snapshot_rows
BEGIN SELECT RAISE(ABORT,'snapshot rows are immutable'); END;
CREATE TRIGGER sync_snapshot_rows_insert_pending BEFORE INSERT ON sync_snapshot_rows
WHEN (SELECT state FROM sync_snapshots WHERE snapshot_id=NEW.snapshot_id) IS NOT 'pending'
BEGIN SELECT RAISE(ABORT,'snapshot is already materialized'); END;
CREATE TRIGGER sync_snapshot_rows_delete_aborted BEFORE DELETE ON sync_snapshot_rows
WHEN (SELECT state FROM sync_snapshots WHERE snapshot_id=OLD.snapshot_id) IS NOT 'aborted'
BEGIN SELECT RAISE(ABORT,'snapshot is retained'); END;
CREATE TRIGGER sync_snapshots_no_delete BEFORE DELETE ON sync_snapshots
BEGIN SELECT RAISE(ABORT,'snapshot retirement needs reviewed retention'); END;
CREATE TRIGGER sync_snapshot_transition BEFORE UPDATE ON sync_snapshots
WHEN OLD.state IN ('ready','aborted') OR NEW.snapshot_id<>OLD.snapshot_id
  OR NEW.profile<>OLD.profile OR NEW.requested_at<>OLD.requested_at
  OR NOT ((OLD.state='pending' AND NEW.state IN ('materialized','aborted'))
       OR (OLD.state='materialized' AND NEW.state IN ('ready','aborted')))
  OR (OLD.state='materialized' AND (NEW.boundary_bytes IS NOT OLD.boundary_bytes
       OR NEW.row_count<>OLD.row_count OR NEW.total_bytes<>OLD.total_bytes))
BEGIN SELECT RAISE(ABORT,'invalid snapshot transition'); END;

CREATE TRIGGER sync_observe_projects_insert AFTER INSERT ON projects
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'projects',json_array(NEW.id),NULL,
               json_object('id',NEW.id,'name',NEW.name,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'archived_at',NEW.archived_at)
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_projects_update AFTER UPDATE ON projects
WHEN NOT (OLD.id IS NEW.id AND OLD.name IS NEW.name AND OLD.created_at IS NEW.created_at AND OLD.updated_at IS NEW.updated_at AND OLD.archived_at IS NEW.archived_at)
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'projects',json_array(NEW.id),json_object('id',OLD.id,'name',OLD.name,'created_at',OLD.created_at,'updated_at',OLD.updated_at,'archived_at',OLD.archived_at),
               json_object('id',NEW.id,'name',NEW.name,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'archived_at',NEW.archived_at)
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_projects_delete AFTER DELETE ON projects
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'projects',json_array(OLD.id),json_object('id',OLD.id,'name',OLD.name,'created_at',OLD.created_at,'updated_at',OLD.updated_at,'archived_at',OLD.archived_at),
               NULL
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_captures_insert AFTER INSERT ON captures
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'captures',json_array(NEW.id),NULL,
               json_object('id',NEW.id,'source',NEW.source,'content',NEW.content,'created_at',NEW.created_at,'project_id',NEW.project_id)
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_captures_update AFTER UPDATE ON captures
WHEN NOT (OLD.id IS NEW.id AND OLD.source IS NEW.source AND OLD.content IS NEW.content AND OLD.created_at IS NEW.created_at AND OLD.project_id IS NEW.project_id)
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'captures',json_array(NEW.id),json_object('id',OLD.id,'source',OLD.source,'content',OLD.content,'created_at',OLD.created_at,'project_id',OLD.project_id),
               json_object('id',NEW.id,'source',NEW.source,'content',NEW.content,'created_at',NEW.created_at,'project_id',NEW.project_id)
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_captures_delete AFTER DELETE ON captures
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'captures',json_array(OLD.id),json_object('id',OLD.id,'source',OLD.source,'content',OLD.content,'created_at',OLD.created_at,'project_id',OLD.project_id),
               NULL
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_distillation_runs_insert AFTER INSERT ON distillation_runs
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'distillation_runs',json_array(NEW.capture_id),NULL,
               json_object('capture_id',NEW.capture_id,'created_at',NEW.created_at)
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_distillation_runs_update AFTER UPDATE ON distillation_runs
WHEN NOT (OLD.capture_id IS NEW.capture_id AND OLD.created_at IS NEW.created_at)
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'distillation_runs',json_array(NEW.capture_id),json_object('capture_id',OLD.capture_id,'created_at',OLD.created_at),
               json_object('capture_id',NEW.capture_id,'created_at',NEW.created_at)
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_distillation_runs_delete AFTER DELETE ON distillation_runs
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'distillation_runs',json_array(OLD.capture_id),json_object('capture_id',OLD.capture_id,'created_at',OLD.created_at),
               NULL
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_knowledge_objects_insert AFTER INSERT ON knowledge_objects
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'knowledge_objects',json_array(NEW.id),NULL,
               json_object('id',NEW.id,'kind',NEW.kind,'title',NEW.title,'body',NEW.body,'created_at',NEW.created_at,'current_revision_id',NEW.current_revision_id,'project_id',NEW.project_id)
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_knowledge_objects_update AFTER UPDATE ON knowledge_objects
WHEN NOT (OLD.id IS NEW.id AND OLD.kind IS NEW.kind AND OLD.title IS NEW.title AND OLD.body IS NEW.body AND OLD.created_at IS NEW.created_at AND OLD.current_revision_id IS NEW.current_revision_id AND OLD.project_id IS NEW.project_id)
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'knowledge_objects',json_array(NEW.id),json_object('id',OLD.id,'kind',OLD.kind,'title',OLD.title,'body',OLD.body,'created_at',OLD.created_at,'current_revision_id',OLD.current_revision_id,'project_id',OLD.project_id),
               json_object('id',NEW.id,'kind',NEW.kind,'title',NEW.title,'body',NEW.body,'created_at',NEW.created_at,'current_revision_id',NEW.current_revision_id,'project_id',NEW.project_id)
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_knowledge_objects_delete AFTER DELETE ON knowledge_objects
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'knowledge_objects',json_array(OLD.id),json_object('id',OLD.id,'kind',OLD.kind,'title',OLD.title,'body',OLD.body,'created_at',OLD.created_at,'current_revision_id',OLD.current_revision_id,'project_id',OLD.project_id),
               NULL
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_object_sources_insert AFTER INSERT ON object_sources
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'object_sources',json_array(NEW.object_id),NULL,
               json_object('object_id',NEW.object_id,'capture_id',NEW.capture_id,'source_start',NEW.source_start,'source_end',NEW.source_end)
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_object_sources_update AFTER UPDATE ON object_sources
WHEN NOT (OLD.object_id IS NEW.object_id AND OLD.capture_id IS NEW.capture_id AND OLD.source_start IS NEW.source_start AND OLD.source_end IS NEW.source_end)
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'object_sources',json_array(NEW.object_id),json_object('object_id',OLD.object_id,'capture_id',OLD.capture_id,'source_start',OLD.source_start,'source_end',OLD.source_end),
               json_object('object_id',NEW.object_id,'capture_id',NEW.capture_id,'source_start',NEW.source_start,'source_end',NEW.source_end)
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_object_sources_delete AFTER DELETE ON object_sources
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'object_sources',json_array(OLD.object_id),json_object('object_id',OLD.object_id,'capture_id',OLD.capture_id,'source_start',OLD.source_start,'source_end',OLD.source_end),
               NULL
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_thought_revisions_insert AFTER INSERT ON thought_revisions
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'thought_revisions',json_array(NEW.id),NULL,
               json_object('id',NEW.id,'object_id',NEW.object_id,'kind',NEW.kind,'title',NEW.title,'body',NEW.body,'origin',NEW.origin,'created_at',NEW.created_at,'capture_id',NEW.capture_id,'source_start',NEW.source_start,'source_end',NEW.source_end)
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_thought_revisions_update AFTER UPDATE ON thought_revisions
WHEN NOT (OLD.id IS NEW.id AND OLD.object_id IS NEW.object_id AND OLD.kind IS NEW.kind AND OLD.title IS NEW.title AND OLD.body IS NEW.body AND OLD.origin IS NEW.origin AND OLD.created_at IS NEW.created_at AND OLD.capture_id IS NEW.capture_id AND OLD.source_start IS NEW.source_start AND OLD.source_end IS NEW.source_end)
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'thought_revisions',json_array(NEW.id),json_object('id',OLD.id,'object_id',OLD.object_id,'kind',OLD.kind,'title',OLD.title,'body',OLD.body,'origin',OLD.origin,'created_at',OLD.created_at,'capture_id',OLD.capture_id,'source_start',OLD.source_start,'source_end',OLD.source_end),
               json_object('id',NEW.id,'object_id',NEW.object_id,'kind',NEW.kind,'title',NEW.title,'body',NEW.body,'origin',NEW.origin,'created_at',NEW.created_at,'capture_id',NEW.capture_id,'source_start',NEW.source_start,'source_end',NEW.source_end)
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_thought_revisions_delete AFTER DELETE ON thought_revisions
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'thought_revisions',json_array(OLD.id),json_object('id',OLD.id,'object_id',OLD.object_id,'kind',OLD.kind,'title',OLD.title,'body',OLD.body,'origin',OLD.origin,'created_at',OLD.created_at,'capture_id',OLD.capture_id,'source_start',OLD.source_start,'source_end',OLD.source_end),
               NULL
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_revision_parents_insert AFTER INSERT ON revision_parents
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'revision_parents',json_array(NEW.child_revision_id,NEW.parent_revision_id),NULL,
               json_object('child_revision_id',NEW.child_revision_id,'parent_revision_id',NEW.parent_revision_id)
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_revision_parents_update AFTER UPDATE ON revision_parents
WHEN NOT (OLD.child_revision_id IS NEW.child_revision_id AND OLD.parent_revision_id IS NEW.parent_revision_id)
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'revision_parents',json_array(NEW.child_revision_id,NEW.parent_revision_id),json_object('child_revision_id',OLD.child_revision_id,'parent_revision_id',OLD.parent_revision_id),
               json_object('child_revision_id',NEW.child_revision_id,'parent_revision_id',NEW.parent_revision_id)
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_revision_parents_delete AFTER DELETE ON revision_parents
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'revision_parents',json_array(OLD.child_revision_id,OLD.parent_revision_id),json_object('child_revision_id',OLD.child_revision_id,'parent_revision_id',OLD.parent_revision_id),
               NULL
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_relations_insert AFTER INSERT ON relations
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'relations',json_array(NEW.id),NULL,
               json_object('id',NEW.id,'kind',NEW.kind,'source_object_id',NEW.source_object_id,'target_object_id',NEW.target_object_id,'origin',NEW.origin,'created_at',NEW.created_at)
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_relations_update AFTER UPDATE ON relations
WHEN NOT (OLD.id IS NEW.id AND OLD.kind IS NEW.kind AND OLD.source_object_id IS NEW.source_object_id AND OLD.target_object_id IS NEW.target_object_id AND OLD.origin IS NEW.origin AND OLD.created_at IS NEW.created_at)
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'relations',json_array(NEW.id),json_object('id',OLD.id,'kind',OLD.kind,'source_object_id',OLD.source_object_id,'target_object_id',OLD.target_object_id,'origin',OLD.origin,'created_at',OLD.created_at),
               json_object('id',NEW.id,'kind',NEW.kind,'source_object_id',NEW.source_object_id,'target_object_id',NEW.target_object_id,'origin',NEW.origin,'created_at',NEW.created_at)
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_relations_delete AFTER DELETE ON relations
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'relations',json_array(OLD.id),json_object('id',OLD.id,'kind',OLD.kind,'source_object_id',OLD.source_object_id,'target_object_id',OLD.target_object_id,'origin',OLD.origin,'created_at',OLD.created_at),
               NULL
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_identity_decisions_insert AFTER INSERT ON identity_decisions
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'identity_decisions',json_array(NEW.capture_id,CAST(NEW.ordinal AS TEXT)),NULL,
               json_object('capture_id',NEW.capture_id,'ordinal',NEW.ordinal,'outcome',NEW.outcome,'unchecked_reason',NEW.unchecked_reason,'target_object_id',NEW.target_object_id,'base_revision_id',NEW.base_revision_id,'result_revision_id',NEW.result_revision_id,'created_object_id',NEW.created_object_id,'policy_version',NEW.policy_version,'model_id',NEW.model_id,'decided_by',NEW.decided_by,'vetoes_json',NEW.vetoes_json,'audit_json',NEW.audit_json,'decided_at',NEW.decided_at)
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_identity_decisions_update AFTER UPDATE ON identity_decisions
WHEN NOT (OLD.capture_id IS NEW.capture_id AND OLD.ordinal IS NEW.ordinal AND OLD.outcome IS NEW.outcome AND OLD.unchecked_reason IS NEW.unchecked_reason AND OLD.target_object_id IS NEW.target_object_id AND OLD.base_revision_id IS NEW.base_revision_id AND OLD.result_revision_id IS NEW.result_revision_id AND OLD.created_object_id IS NEW.created_object_id AND OLD.policy_version IS NEW.policy_version AND OLD.model_id IS NEW.model_id AND OLD.decided_by IS NEW.decided_by AND OLD.vetoes_json IS NEW.vetoes_json AND OLD.audit_json IS NEW.audit_json AND OLD.decided_at IS NEW.decided_at)
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'identity_decisions',json_array(NEW.capture_id,CAST(NEW.ordinal AS TEXT)),json_object('capture_id',OLD.capture_id,'ordinal',OLD.ordinal,'outcome',OLD.outcome,'unchecked_reason',OLD.unchecked_reason,'target_object_id',OLD.target_object_id,'base_revision_id',OLD.base_revision_id,'result_revision_id',OLD.result_revision_id,'created_object_id',OLD.created_object_id,'policy_version',OLD.policy_version,'model_id',OLD.model_id,'decided_by',OLD.decided_by,'vetoes_json',OLD.vetoes_json,'audit_json',OLD.audit_json,'decided_at',OLD.decided_at),
               json_object('capture_id',NEW.capture_id,'ordinal',NEW.ordinal,'outcome',NEW.outcome,'unchecked_reason',NEW.unchecked_reason,'target_object_id',NEW.target_object_id,'base_revision_id',NEW.base_revision_id,'result_revision_id',NEW.result_revision_id,'created_object_id',NEW.created_object_id,'policy_version',NEW.policy_version,'model_id',NEW.model_id,'decided_by',NEW.decided_by,'vetoes_json',NEW.vetoes_json,'audit_json',NEW.audit_json,'decided_at',NEW.decided_at)
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_identity_decisions_delete AFTER DELETE ON identity_decisions
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'identity_decisions',json_array(OLD.capture_id,CAST(OLD.ordinal AS TEXT)),json_object('capture_id',OLD.capture_id,'ordinal',OLD.ordinal,'outcome',OLD.outcome,'unchecked_reason',OLD.unchecked_reason,'target_object_id',OLD.target_object_id,'base_revision_id',OLD.base_revision_id,'result_revision_id',OLD.result_revision_id,'created_object_id',OLD.created_object_id,'policy_version',OLD.policy_version,'model_id',OLD.model_id,'decided_by',OLD.decided_by,'vetoes_json',OLD.vetoes_json,'audit_json',OLD.audit_json,'decided_at',OLD.decided_at),
               NULL
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_revision_evidence_insert AFTER INSERT ON revision_evidence
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'revision_evidence',json_array(NEW.revision_id,CAST(NEW.ordinal AS TEXT)),NULL,
               json_object('revision_id',NEW.revision_id,'ordinal',NEW.ordinal,'object_id',NEW.object_id,'capture_id',NEW.capture_id,'source_start',NEW.source_start,'source_end',NEW.source_end,'role',NEW.role,'retracts_revision_id',NEW.retracts_revision_id,'retracts_ordinal',NEW.retracts_ordinal,'interpretation_label',NEW.interpretation_label,'created_at',NEW.created_at)
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_revision_evidence_update AFTER UPDATE ON revision_evidence
WHEN NOT (OLD.revision_id IS NEW.revision_id AND OLD.ordinal IS NEW.ordinal AND OLD.object_id IS NEW.object_id AND OLD.capture_id IS NEW.capture_id AND OLD.source_start IS NEW.source_start AND OLD.source_end IS NEW.source_end AND OLD.role IS NEW.role AND OLD.retracts_revision_id IS NEW.retracts_revision_id AND OLD.retracts_ordinal IS NEW.retracts_ordinal AND OLD.interpretation_label IS NEW.interpretation_label AND OLD.created_at IS NEW.created_at)
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'revision_evidence',json_array(NEW.revision_id,CAST(NEW.ordinal AS TEXT)),json_object('revision_id',OLD.revision_id,'ordinal',OLD.ordinal,'object_id',OLD.object_id,'capture_id',OLD.capture_id,'source_start',OLD.source_start,'source_end',OLD.source_end,'role',OLD.role,'retracts_revision_id',OLD.retracts_revision_id,'retracts_ordinal',OLD.retracts_ordinal,'interpretation_label',OLD.interpretation_label,'created_at',OLD.created_at),
               json_object('revision_id',NEW.revision_id,'ordinal',NEW.ordinal,'object_id',NEW.object_id,'capture_id',NEW.capture_id,'source_start',NEW.source_start,'source_end',NEW.source_end,'role',NEW.role,'retracts_revision_id',NEW.retracts_revision_id,'retracts_ordinal',NEW.retracts_ordinal,'interpretation_label',NEW.interpretation_label,'created_at',NEW.created_at)
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_revision_evidence_delete AFTER DELETE ON revision_evidence
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'revision_evidence',json_array(OLD.revision_id,CAST(OLD.ordinal AS TEXT)),json_object('revision_id',OLD.revision_id,'ordinal',OLD.ordinal,'object_id',OLD.object_id,'capture_id',OLD.capture_id,'source_start',OLD.source_start,'source_end',OLD.source_end,'role',OLD.role,'retracts_revision_id',OLD.retracts_revision_id,'retracts_ordinal',OLD.retracts_ordinal,'interpretation_label',OLD.interpretation_label,'created_at',OLD.created_at),
               NULL
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_pending_claims_insert AFTER INSERT ON pending_claims
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'pending_claims',json_array(NEW.id),NULL,
               json_object('id',NEW.id,'capture_id',NEW.capture_id,'ordinal',NEW.ordinal,'kind',NEW.kind,'title',NEW.title,'body',NEW.body,'source_start',NEW.source_start,'source_end',NEW.source_end,'candidate_ids_json',NEW.candidate_ids_json,'reasons_json',NEW.reasons_json,'reframing',NEW.reframing,'state',NEW.state,'due_at',NEW.due_at,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'deferred_at',NEW.deferred_at,'resolved_at',NEW.resolved_at,'resolved_method',NEW.resolved_method,'resolved_object_id',NEW.resolved_object_id,'resolved_revision_id',NEW.resolved_revision_id)
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_pending_claims_update AFTER UPDATE ON pending_claims
WHEN NOT (OLD.id IS NEW.id AND OLD.capture_id IS NEW.capture_id AND OLD.ordinal IS NEW.ordinal AND OLD.kind IS NEW.kind AND OLD.title IS NEW.title AND OLD.body IS NEW.body AND OLD.source_start IS NEW.source_start AND OLD.source_end IS NEW.source_end AND OLD.candidate_ids_json IS NEW.candidate_ids_json AND OLD.reasons_json IS NEW.reasons_json AND OLD.reframing IS NEW.reframing AND OLD.state IS NEW.state AND OLD.due_at IS NEW.due_at AND OLD.created_at IS NEW.created_at AND OLD.updated_at IS NEW.updated_at AND OLD.deferred_at IS NEW.deferred_at AND OLD.resolved_at IS NEW.resolved_at AND OLD.resolved_method IS NEW.resolved_method AND OLD.resolved_object_id IS NEW.resolved_object_id AND OLD.resolved_revision_id IS NEW.resolved_revision_id)
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'pending_claims',json_array(NEW.id),json_object('id',OLD.id,'capture_id',OLD.capture_id,'ordinal',OLD.ordinal,'kind',OLD.kind,'title',OLD.title,'body',OLD.body,'source_start',OLD.source_start,'source_end',OLD.source_end,'candidate_ids_json',OLD.candidate_ids_json,'reasons_json',OLD.reasons_json,'reframing',OLD.reframing,'state',OLD.state,'due_at',OLD.due_at,'created_at',OLD.created_at,'updated_at',OLD.updated_at,'deferred_at',OLD.deferred_at,'resolved_at',OLD.resolved_at,'resolved_method',OLD.resolved_method,'resolved_object_id',OLD.resolved_object_id,'resolved_revision_id',OLD.resolved_revision_id),
               json_object('id',NEW.id,'capture_id',NEW.capture_id,'ordinal',NEW.ordinal,'kind',NEW.kind,'title',NEW.title,'body',NEW.body,'source_start',NEW.source_start,'source_end',NEW.source_end,'candidate_ids_json',NEW.candidate_ids_json,'reasons_json',NEW.reasons_json,'reframing',NEW.reframing,'state',NEW.state,'due_at',NEW.due_at,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'deferred_at',NEW.deferred_at,'resolved_at',NEW.resolved_at,'resolved_method',NEW.resolved_method,'resolved_object_id',NEW.resolved_object_id,'resolved_revision_id',NEW.resolved_revision_id)
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_pending_claims_delete AFTER DELETE ON pending_claims
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'pending_claims',json_array(OLD.id),json_object('id',OLD.id,'capture_id',OLD.capture_id,'ordinal',OLD.ordinal,'kind',OLD.kind,'title',OLD.title,'body',OLD.body,'source_start',OLD.source_start,'source_end',OLD.source_end,'candidate_ids_json',OLD.candidate_ids_json,'reasons_json',OLD.reasons_json,'reframing',OLD.reframing,'state',OLD.state,'due_at',OLD.due_at,'created_at',OLD.created_at,'updated_at',OLD.updated_at,'deferred_at',OLD.deferred_at,'resolved_at',OLD.resolved_at,'resolved_method',OLD.resolved_method,'resolved_object_id',OLD.resolved_object_id,'resolved_revision_id',OLD.resolved_revision_id),
               NULL
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_revision_proposals_insert AFTER INSERT ON revision_proposals
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'revision_proposals',json_array(NEW.id),NULL,
               json_object('id',NEW.id,'pending_claim_id',NEW.pending_claim_id,'object_id',NEW.object_id,'base_revision_id',NEW.base_revision_id,'change',NEW.change,'kind',NEW.kind,'title',NEW.title,'proposed_body',NEW.proposed_body,'retracts_revision_id',NEW.retracts_revision_id,'retracts_ordinal',NEW.retracts_ordinal,'evidence_json',NEW.evidence_json,'synthesis_model',NEW.synthesis_model,'verifier_model',NEW.verifier_model,'verification_mode',NEW.verification_mode,'verification_status',NEW.verification_status,'policy_version',NEW.policy_version,'state',NEW.state,'user_edited',NEW.user_edited,'final_body',NEW.final_body,'result_revision_id',NEW.result_revision_id,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'reviewed_at',NEW.reviewed_at)
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_revision_proposals_update AFTER UPDATE ON revision_proposals
WHEN NOT (OLD.id IS NEW.id AND OLD.pending_claim_id IS NEW.pending_claim_id AND OLD.object_id IS NEW.object_id AND OLD.base_revision_id IS NEW.base_revision_id AND OLD.change IS NEW.change AND OLD.kind IS NEW.kind AND OLD.title IS NEW.title AND OLD.proposed_body IS NEW.proposed_body AND OLD.retracts_revision_id IS NEW.retracts_revision_id AND OLD.retracts_ordinal IS NEW.retracts_ordinal AND OLD.evidence_json IS NEW.evidence_json AND OLD.synthesis_model IS NEW.synthesis_model AND OLD.verifier_model IS NEW.verifier_model AND OLD.verification_mode IS NEW.verification_mode AND OLD.verification_status IS NEW.verification_status AND OLD.policy_version IS NEW.policy_version AND OLD.state IS NEW.state AND OLD.user_edited IS NEW.user_edited AND OLD.final_body IS NEW.final_body AND OLD.result_revision_id IS NEW.result_revision_id AND OLD.created_at IS NEW.created_at AND OLD.updated_at IS NEW.updated_at AND OLD.reviewed_at IS NEW.reviewed_at)
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'revision_proposals',json_array(NEW.id),json_object('id',OLD.id,'pending_claim_id',OLD.pending_claim_id,'object_id',OLD.object_id,'base_revision_id',OLD.base_revision_id,'change',OLD.change,'kind',OLD.kind,'title',OLD.title,'proposed_body',OLD.proposed_body,'retracts_revision_id',OLD.retracts_revision_id,'retracts_ordinal',OLD.retracts_ordinal,'evidence_json',OLD.evidence_json,'synthesis_model',OLD.synthesis_model,'verifier_model',OLD.verifier_model,'verification_mode',OLD.verification_mode,'verification_status',OLD.verification_status,'policy_version',OLD.policy_version,'state',OLD.state,'user_edited',OLD.user_edited,'final_body',OLD.final_body,'result_revision_id',OLD.result_revision_id,'created_at',OLD.created_at,'updated_at',OLD.updated_at,'reviewed_at',OLD.reviewed_at),
               json_object('id',NEW.id,'pending_claim_id',NEW.pending_claim_id,'object_id',NEW.object_id,'base_revision_id',NEW.base_revision_id,'change',NEW.change,'kind',NEW.kind,'title',NEW.title,'proposed_body',NEW.proposed_body,'retracts_revision_id',NEW.retracts_revision_id,'retracts_ordinal',NEW.retracts_ordinal,'evidence_json',NEW.evidence_json,'synthesis_model',NEW.synthesis_model,'verifier_model',NEW.verifier_model,'verification_mode',NEW.verification_mode,'verification_status',NEW.verification_status,'policy_version',NEW.policy_version,'state',NEW.state,'user_edited',NEW.user_edited,'final_body',NEW.final_body,'result_revision_id',NEW.result_revision_id,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'reviewed_at',NEW.reviewed_at)
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;

CREATE TRIGGER sync_observe_revision_proposals_delete AFTER DELETE ON revision_proposals
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'revision_proposals',json_array(OLD.id),json_object('id',OLD.id,'pending_claim_id',OLD.pending_claim_id,'object_id',OLD.object_id,'base_revision_id',OLD.base_revision_id,'change',OLD.change,'kind',OLD.kind,'title',OLD.title,'proposed_body',OLD.proposed_body,'retracts_revision_id',OLD.retracts_revision_id,'retracts_ordinal',OLD.retracts_ordinal,'evidence_json',OLD.evidence_json,'synthesis_model',OLD.synthesis_model,'verifier_model',OLD.verifier_model,'verification_mode',OLD.verification_mode,'verification_status',OLD.verification_status,'policy_version',OLD.policy_version,'state',OLD.state,'user_edited',OLD.user_edited,'final_body',OLD.final_body,'result_revision_id',OLD.result_revision_id,'created_at',OLD.created_at,'updated_at',OLD.updated_at,'reviewed_at',OLD.reviewed_at),
               NULL
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;
