-- Synthetic forward-only D4 policy. Never registered in production STEPS.
-- Original cores/commit proofs are canonical. This exact-head cache is derived.
CREATE TABLE import_d4_policy(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL CHECK(version=1)) STRICT;
INSERT INTO import_d4_policy VALUES(1,1);
CREATE TRIGGER import_d4_policy_fixed BEFORE UPDATE ON import_d4_policy BEGIN SELECT RAISE(ABORT,'fixed D4 policy'); END;
CREATE TRIGGER import_d4_policy_retained BEFORE DELETE ON import_d4_policy BEGIN SELECT RAISE(ABORT,'D4 policy retained'); END;
CREATE TABLE import_d4_heads(entity TEXT NOT NULL CHECK(entity IN('projects','captures','distillation_runs','knowledge_objects','object_sources','thought_revisions','revision_parents','relations','identity_decisions','revision_evidence','pending_claims','revision_proposals')),key_json TEXT NOT NULL CHECK(json_valid(key_json)),facet TEXT NOT NULL CHECK(facet IN('record','membership','head','lifecycle')),event TEXT NOT NULL REFERENCES import_g3_commits(event),hash BLOB NOT NULL CHECK(length(hash)=32),PRIMARY KEY(entity,key_json,facet)) STRICT;
INSERT INTO import_d4_heads SELECT * FROM import_g3_heads UNION ALL SELECT * FROM import_history_heads;
CREATE TRIGGER import_d4_head_identity_fixed BEFORE UPDATE OF entity,key_json,facet ON import_d4_heads BEGIN SELECT RAISE(ABORT,'fixed head identity'); END;
CREATE TRIGGER import_d4_head_retained BEFORE DELETE ON import_d4_heads BEGIN SELECT RAISE(ABORT,'D4 heads retained'); END;
CREATE TABLE import_d4_commits(event TEXT PRIMARY KEY REFERENCES import_g3_commits(event)) STRICT;
CREATE TRIGGER import_d4_commit_fixed BEFORE UPDATE ON import_d4_commits BEGIN SELECT RAISE(ABORT,'immutable D4 proof'); END;
CREATE TRIGGER import_d4_commit_retained BEFORE DELETE ON import_d4_commits BEGIN SELECT RAISE(ABORT,'D4 proof retained'); END;
-- Lifecycle is conservative: no automatic retirement and no evidence deletion.
CREATE TABLE bootstrap_lifecycle(id TEXT PRIMARY KEY REFERENCES bootstrap_units(id),state TEXT NOT NULL CHECK(state IN('receiving','interrupted','expired','complete','conflict','unsupported','deferred','rejected'))) STRICT;
INSERT INTO bootstrap_lifecycle SELECT id,CASE outcome WHEN 'staged' THEN 'receiving' WHEN 'applied' THEN 'complete' ELSE outcome END FROM bootstrap_units;
CREATE TRIGGER bootstrap_lifecycle_start AFTER INSERT ON bootstrap_units BEGIN INSERT INTO bootstrap_lifecycle VALUES(NEW.id,'receiving'); END;
CREATE TRIGGER bootstrap_lifecycle_identity_fixed BEFORE UPDATE OF id ON bootstrap_lifecycle BEGIN SELECT RAISE(ABORT,'fixed lifecycle identity'); END;
CREATE TRIGGER bootstrap_lifecycle_retained BEFORE DELETE ON bootstrap_lifecycle BEGIN SELECT RAISE(ABORT,'recovery evidence retained'); END;
CREATE TRIGGER bootstrap_lifecycle_transition BEFORE UPDATE OF state ON bootstrap_lifecycle
WHEN NOT (NEW.state=OLD.state OR (OLD.state IN('receiving','interrupted','expired','unsupported','deferred') AND NEW.state IN('receiving','interrupted','expired','complete','conflict','unsupported','deferred','rejected')))
BEGIN SELECT RAISE(ABORT,'invalid bootstrap lifecycle transition'); END;
CREATE TRIGGER bootstrap_outcome_transition BEFORE UPDATE OF outcome ON bootstrap_units
WHEN NOT (NEW.outcome=OLD.outcome OR (OLD.outcome IN('staged','unsupported','deferred') AND NEW.outcome IN('applied','conflict','unsupported','deferred','rejected')))
BEGIN SELECT RAISE(ABORT,'invalid bootstrap outcome transition'); END;
CREATE TRIGGER bootstrap_lifecycle_outcome AFTER UPDATE OF outcome ON bootstrap_units
BEGIN UPDATE bootstrap_lifecycle SET state=CASE NEW.outcome WHEN 'applied' THEN 'complete' WHEN 'staged' THEN 'receiving' ELSE NEW.outcome END WHERE id=NEW.id; END;
