-- Forward upgrade from the original MEGA D1 candidate is also permitted.
-- Old cores have no retained admission epoch: never infer/backfill permission.
-- A fresh authenticated receipt must explicitly authorize those originals.
CREATE TABLE IF NOT EXISTS import_event_epochs(event TEXT PRIMARY KEY REFERENCES import_events(event),epoch INTEGER NOT NULL CHECK(epoch>0)) STRICT;
CREATE TRIGGER IF NOT EXISTS import_event_epoch_fixed BEFORE UPDATE ON import_event_epochs BEGIN SELECT RAISE(ABORT,'immutable received epoch'); END;
CREATE TRIGGER IF NOT EXISTS import_event_epoch_retained BEFORE DELETE ON import_event_epochs BEGIN SELECT RAISE(ABORT,'received epoch retained'); END;
CREATE TABLE IF NOT EXISTS import_origin_permissions(peer TEXT NOT NULL REFERENCES import_members(peer),origin TEXT NOT NULL CHECK(length(origin)=36),epoch INTEGER NOT NULL CHECK(epoch>0),enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),PRIMARY KEY(peer,origin)) STRICT;
-- G3 create-only synthetic policy 1. Test-installed, no production version.
-- Originals/commit proofs are retained authority; heads/cursor are derived.
CREATE TABLE import_g3_policy(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL CHECK(version=1),cursor INTEGER NOT NULL CHECK(cursor>=0)) STRICT;
INSERT INTO import_g3_policy VALUES(1,1,0);
CREATE TRIGGER import_g3_policy_fixed BEFORE UPDATE OF singleton,version ON import_g3_policy BEGIN SELECT RAISE(ABORT,'fixed G3 policy'); END;
CREATE TRIGGER import_g3_policy_retained BEFORE DELETE ON import_g3_policy BEGIN SELECT RAISE(ABORT,'G3 policy retained'); END;
CREATE TABLE import_g3_commits(event TEXT PRIMARY KEY REFERENCES import_events(event),version INTEGER NOT NULL CHECK(version=1)) STRICT;
CREATE TRIGGER import_g3_commit_fixed BEFORE UPDATE ON import_g3_commits BEGIN SELECT RAISE(ABORT,'immutable materialization proof'); END;
CREATE TRIGGER import_g3_commit_retained BEFORE DELETE ON import_g3_commits BEGIN SELECT RAISE(ABORT,'materialization proof retained'); END;
CREATE TABLE import_g3_heads(entity TEXT NOT NULL CHECK(entity IN('projects','captures')),key_json TEXT NOT NULL CHECK(json_valid(key_json)),facet TEXT NOT NULL CHECK(facet IN('record','membership','lifecycle')),event TEXT NOT NULL REFERENCES import_g3_commits(event),hash BLOB NOT NULL CHECK(length(hash)=32),PRIMARY KEY(entity,key_json,facet)) STRICT;
CREATE TRIGGER import_g3_head_fixed BEFORE UPDATE ON import_g3_heads BEGIN SELECT RAISE(ABORT,'immutable creation head'); END;
CREATE TRIGGER import_g3_head_retained BEFORE DELETE ON import_g3_heads BEGIN SELECT RAISE(ABORT,'creation head retained'); END;
CREATE TRIGGER import_g3_applied_requires_commit BEFORE UPDATE OF outcome ON import_events
WHEN NEW.outcome='applied' AND OLD.outcome<>'applied' AND NOT EXISTS(SELECT 1 FROM import_g3_commits WHERE event=NEW.event AND version=1)
BEGIN SELECT RAISE(ABORT,'applied requires original materialization commit'); END;
