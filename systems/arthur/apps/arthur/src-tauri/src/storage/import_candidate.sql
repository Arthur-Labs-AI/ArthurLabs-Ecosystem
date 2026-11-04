-- Synthetic import-storage candidate D1. Installed ONLY by tests after v10.
-- No schema-number approval and no production migration/startup registration.
-- Original cores/identity, collision evidence and local conflict alternatives
-- are canonical. Cursors/outcomes are durable protocol state, recheckable from
-- retained cores and local projections. No domain trigger is modified.
CREATE TABLE import_candidate(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL CHECK(revision=1),local_id TEXT NOT NULL CHECK(length(local_id)=36),network TEXT NOT NULL CHECK(length(network)=36)) STRICT;
CREATE TABLE import_members(peer TEXT PRIMARY KEY CHECK(length(peer)=36),epoch INTEGER NOT NULL CHECK(epoch>0),enabled INTEGER NOT NULL CHECK(enabled IN(0,1))) STRICT;
CREATE TABLE import_events(
 event TEXT PRIMARY KEY CHECK(length(event)=36),bundle TEXT NOT NULL UNIQUE CHECK(length(bundle)=36),
 origin TEXT NOT NULL CHECK(length(origin)=36),incarnation TEXT NOT NULL CHECK(length(incarnation)=36),seq INTEGER NOT NULL CHECK(seq>0),
 hash BLOB NOT NULL CHECK(length(hash)=32),bytes BLOB NOT NULL CHECK(length(bytes) BETWEEN 1 AND 4194304),
 outcome TEXT NOT NULL CHECK(outcome IN('applied','conflict','deferred','unsupported','rejected')),
 chain_ok INTEGER NOT NULL CHECK(chain_ok IN(0,1)),peer TEXT NOT NULL REFERENCES import_members(peer),
 UNIQUE(origin,incarnation,seq)
) STRICT;
CREATE TRIGGER import_core_fixed BEFORE UPDATE OF event,bundle,origin,incarnation,seq,hash,bytes,peer ON import_events BEGIN SELECT RAISE(ABORT,'immutable received core'); END;
CREATE TRIGGER import_core_retained BEFORE DELETE ON import_events BEGIN SELECT RAISE(ABORT,'received history retained'); END;
CREATE TABLE import_pending(event TEXT NOT NULL REFERENCES import_events(event),dependency TEXT NOT NULL CHECK(length(CAST(dependency AS BLOB))<=4096),PRIMARY KEY(event,dependency)) STRICT;
CREATE TABLE import_conflicts(event TEXT NOT NULL REFERENCES import_events(event),ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 4095),entity TEXT NOT NULL,key_json TEXT NOT NULL CHECK(json_valid(key_json)),local_row BLOB NOT NULL CHECK(length(local_row)<=4194304),local_heads BLOB NOT NULL CHECK(length(local_heads)<=65536),PRIMARY KEY(event,ordinal)) STRICT;
CREATE TRIGGER import_conflict_fixed BEFORE UPDATE ON import_conflicts BEGIN SELECT RAISE(ABORT,'conflict alternative immutable'); END;
CREATE TRIGGER import_conflict_retained BEFORE DELETE ON import_conflicts BEGIN SELECT RAISE(ABORT,'conflict alternative retained'); END;
CREATE TABLE import_collisions(event TEXT NOT NULL,hash BLOB NOT NULL CHECK(length(hash)=32),bytes BLOB NOT NULL CHECK(length(bytes) BETWEEN 1 AND 4194304),reason TEXT NOT NULL CHECK(reason IN('identity','stream','bundle')),peer TEXT NOT NULL REFERENCES import_members(peer),PRIMARY KEY(event,hash)) STRICT;
CREATE TRIGGER import_collision_fixed BEFORE UPDATE ON import_collisions BEGIN SELECT RAISE(ABORT,'collision immutable'); END;
CREATE TRIGGER import_collision_retained BEFORE DELETE ON import_collisions BEGIN SELECT RAISE(ABORT,'collision retained'); END;
CREATE TABLE import_progress(peer TEXT NOT NULL REFERENCES import_members(peer),origin TEXT NOT NULL,incarnation TEXT NOT NULL,stored INTEGER NOT NULL CHECK(stored>=0),integrated INTEGER NOT NULL CHECK(integrated BETWEEN 0 AND stored),applied INTEGER NOT NULL CHECK(applied BETWEEN 0 AND integrated),PRIMARY KEY(peer,origin,incarnation)) STRICT;
CREATE TABLE import_sent(peer TEXT NOT NULL REFERENCES import_members(peer),event TEXT NOT NULL,session TEXT NOT NULL,hash BLOB NOT NULL CHECK(length(hash)=32),origin TEXT NOT NULL,incarnation TEXT NOT NULL,seq INTEGER NOT NULL CHECK(seq>0),outcome TEXT NOT NULL CHECK(outcome IN('offered','applied','conflict','deferred','unsupported','rejected')),PRIMARY KEY(peer,event)) STRICT;
CREATE TABLE import_delivery(peer TEXT NOT NULL REFERENCES import_members(peer),origin TEXT NOT NULL,incarnation TEXT NOT NULL,integrated INTEGER NOT NULL CHECK(integrated>=0),applied INTEGER NOT NULL CHECK(applied BETWEEN 0 AND integrated),PRIMARY KEY(peer,origin,incarnation)) STRICT;
CREATE TABLE import_receipts(peer TEXT NOT NULL REFERENCES import_members(peer),event TEXT NOT NULL REFERENCES import_events(event),PRIMARY KEY(peer,event)) STRICT;
CREATE TABLE import_creates(entity TEXT NOT NULL,key_json TEXT NOT NULL CHECK(json_valid(key_json)),event TEXT NOT NULL REFERENCES import_events(event),row_hash BLOB NOT NULL CHECK(length(row_hash)=32),PRIMARY KEY(entity,key_json)) STRICT;
CREATE TRIGGER import_create_fixed BEFORE UPDATE ON import_creates BEGIN SELECT RAISE(ABORT,'original creation claim immutable'); END;
CREATE TRIGGER import_create_retained BEFORE DELETE ON import_creates BEGIN SELECT RAISE(ABORT,'original creation claim retained'); END;

-- Admission epoch is immutable provenance for later policy reprocessing.
CREATE TABLE import_event_epochs(event TEXT PRIMARY KEY REFERENCES import_events(event),epoch INTEGER NOT NULL CHECK(epoch>0)) STRICT;
CREATE TRIGGER import_event_epoch_fixed BEFORE UPDATE ON import_event_epochs BEGIN SELECT RAISE(ABORT,'immutable received epoch'); END;
CREATE TRIGGER import_event_epoch_retained BEFORE DELETE ON import_event_epochs BEGIN SELECT RAISE(ABORT,'received epoch retained'); END;

CREATE TABLE import_origin_permissions(peer TEXT NOT NULL REFERENCES import_members(peer),origin TEXT NOT NULL CHECK(length(origin)=36),epoch INTEGER NOT NULL CHECK(epoch>0),enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),PRIMARY KEY(peer,origin)) STRICT;
