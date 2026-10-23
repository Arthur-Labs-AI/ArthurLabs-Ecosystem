-- Synthetic bootstrap v1, separate from accepted snapshot v2. No activation.
-- Immutable original manifest/chunks are private staging, never applied knowledge.
CREATE TABLE bootstrap_units(id TEXT PRIMARY KEY,peer TEXT NOT NULL REFERENCES import_members(peer),network TEXT NOT NULL,epoch INTEGER NOT NULL,hash BLOB NOT NULL CHECK(length(hash)=32),bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 4194304),chunks INTEGER NOT NULL CHECK(chunks BETWEEN 1 AND 16),direction TEXT NOT NULL CHECK(direction IN('in','out')),session TEXT NOT NULL,outcome TEXT NOT NULL CHECK(outcome IN('staged','applied','conflict','unsupported','deferred','rejected')),manifest BLOB CHECK(manifest IS NULL OR length(manifest)<=4194304)) STRICT;
CREATE TRIGGER bootstrap_identity_fixed BEFORE UPDATE OF id,peer,network,epoch,hash,bytes,chunks,direction,manifest ON bootstrap_units BEGIN SELECT RAISE(ABORT,'fixed bootstrap identity'); END;
CREATE TRIGGER bootstrap_retained BEFORE DELETE ON bootstrap_units BEGIN SELECT RAISE(ABORT,'bootstrap retained'); END;
CREATE TABLE bootstrap_chunks(id TEXT NOT NULL REFERENCES bootstrap_units(id),ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 15),hash BLOB NOT NULL CHECK(length(hash)=32),bytes BLOB NOT NULL CHECK(length(bytes) BETWEEN 1 AND 262144),PRIMARY KEY(id,ordinal)) STRICT;
CREATE TRIGGER bootstrap_chunk_fixed BEFORE UPDATE ON bootstrap_chunks BEGIN SELECT RAISE(ABORT,'fixed bootstrap chunk'); END;
CREATE TRIGGER bootstrap_chunk_retained BEFORE DELETE ON bootstrap_chunks BEGIN SELECT RAISE(ABORT,'bootstrap chunk retained'); END;
