-- D3 forward-only immutable-history profile. No production schema version.
CREATE TABLE import_history_policy(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL CHECK(revision=1)) STRICT;
INSERT INTO import_history_policy VALUES(1,1);
CREATE TRIGGER import_history_policy_fixed BEFORE UPDATE ON import_history_policy BEGIN SELECT RAISE(ABORT,'fixed history policy'); END;
CREATE TRIGGER import_history_policy_retained BEFORE DELETE ON import_history_policy BEGIN SELECT RAISE(ABORT,'history policy retained'); END;
CREATE TABLE import_history_heads(entity TEXT NOT NULL CHECK(entity IN('distillation_runs','knowledge_objects','object_sources','thought_revisions','revision_parents','revision_evidence')),key_json TEXT NOT NULL CHECK(json_valid(key_json)),facet TEXT NOT NULL CHECK(facet IN('record','membership','head')),event TEXT NOT NULL REFERENCES import_g3_commits(event),hash BLOB NOT NULL CHECK(length(hash)=32),PRIMARY KEY(entity,key_json,facet)) STRICT;
CREATE TRIGGER import_history_head_fixed BEFORE UPDATE ON import_history_heads BEGIN SELECT RAISE(ABORT,'immutable history creation head'); END;
CREATE TRIGGER import_history_head_retained BEFORE DELETE ON import_history_heads BEGIN SELECT RAISE(ABORT,'history creation head retained'); END;
CREATE TABLE import_recall_suppression(object_id TEXT PRIMARY KEY REFERENCES knowledge_objects(id)) STRICT;
CREATE TRIGGER import_recall_suppression_fixed BEFORE UPDATE ON import_recall_suppression BEGIN SELECT RAISE(ABORT,'fixed import recall suppression'); END;
CREATE TRIGGER import_recall_suppression_retained BEFORE DELETE ON import_recall_suppression BEGIN SELECT RAISE(ABORT,'import recall suppression requires reviewed release'); END;
