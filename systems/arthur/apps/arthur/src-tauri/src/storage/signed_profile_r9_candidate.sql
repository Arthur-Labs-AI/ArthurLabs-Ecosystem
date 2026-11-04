-- Explicit dormant qualification extension. Never registered in production STEPS.
-- This marker selects the one authoritative accepted-proof representation.
CREATE TABLE r9_signed_profile(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL CHECK(version=1)) STRICT;
CREATE TABLE r9_origin_seals(origin TEXT NOT NULL,incarnation TEXT NOT NULL UNIQUE,author BLOB NOT NULL CHECK(length(author)=65),seq INTEGER NOT NULL CHECK(seq BETWEEN 1 AND 256),hash BLOB NOT NULL CHECK(length(hash)=32),signature BLOB NOT NULL CHECK(length(signature)=64),PRIMARY KEY(origin,incarnation),FOREIGN KEY(origin) REFERENCES e_origins(origin)) STRICT;
CREATE TABLE r9_originals(event TEXT PRIMARY KEY REFERENCES import_events(event),origin TEXT NOT NULL,incarnation TEXT NOT NULL,seq INTEGER NOT NULL CHECK(seq BETWEEN 1 AND 256),hash BLOB NOT NULL CHECK(length(hash)=32),envelope BLOB NOT NULL CHECK(length(envelope) BETWEEN 1 AND 16384),UNIQUE(origin,incarnation,seq),FOREIGN KEY(origin,incarnation) REFERENCES r9_origin_seals(origin,incarnation)) STRICT;
-- Event PK and composite unique index serve retry and prefix-chain scans.
CREATE TRIGGER r9_original_fixed BEFORE UPDATE ON r9_originals BEGIN SELECT RAISE(ABORT,'immutable signed original'); END;
CREATE TRIGGER r9_original_retained BEFORE DELETE ON r9_originals BEGIN SELECT RAISE(ABORT,'retained signed original'); END;
CREATE TRIGGER r9_seal_identity BEFORE UPDATE OF origin,incarnation,author ON r9_origin_seals BEGIN SELECT RAISE(ABORT,'fixed origin incarnation author'); END;
CREATE TRIGGER r9_seal_monotone BEFORE UPDATE ON r9_origin_seals WHEN NEW.seq<=OLD.seq BEGIN SELECT RAISE(ABORT,'monotone accepted prefix'); END;
CREATE TRIGGER r9_seal_retained BEFORE DELETE ON r9_origin_seals BEGIN SELECT RAISE(ABORT,'retained signed prefix'); END;
-- Original E2 rows stay byte-identical, read-only historical compatibility evidence.
CREATE TRIGGER r9_e2_seal_insert BEFORE INSERT ON e2_origin_seals WHEN EXISTS(SELECT 1 FROM r9_signed_profile) BEGIN SELECT RAISE(ABORT,'R9 owns accepted prefixes'); END;
CREATE TRIGGER r9_e2_seal_update BEFORE UPDATE ON e2_origin_seals WHEN EXISTS(SELECT 1 FROM r9_signed_profile) BEGIN SELECT RAISE(ABORT,'R9 owns accepted prefixes'); END;
CREATE TRIGGER r9_e2_seal_delete BEFORE DELETE ON e2_origin_seals WHEN EXISTS(SELECT 1 FROM r9_signed_profile) BEGIN SELECT RAISE(ABORT,'retained E2 compatibility'); END;
CREATE TRIGGER r9_e2_original_insert BEFORE INSERT ON e2_originals WHEN EXISTS(SELECT 1 FROM r9_signed_profile) BEGIN SELECT RAISE(ABORT,'R9 owns accepted originals'); END;
CREATE TRIGGER r9_e2_original_update BEFORE UPDATE ON e2_originals WHEN EXISTS(SELECT 1 FROM r9_signed_profile) BEGIN SELECT RAISE(ABORT,'retained E2 compatibility'); END;
CREATE TRIGGER r9_e2_original_delete BEFORE DELETE ON e2_originals WHEN EXISTS(SELECT 1 FROM r9_signed_profile) BEGIN SELECT RAISE(ABORT,'retained E2 compatibility'); END;
-- Sidecar belongs to the existing bootstrap unit, never another history ledger.
CREATE TABLE r9_bootstrap_evidence(id TEXT PRIMARY KEY REFERENCES bootstrap_units(id),hash BLOB NOT NULL CHECK(length(hash)=32),bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 1114112),chunks INTEGER NOT NULL CHECK(chunks BETWEEN 1 AND 5),manifest BLOB CHECK(manifest IS NULL OR length(manifest)<=1114112)) STRICT;
CREATE TABLE r9_evidence_chunks(id TEXT NOT NULL REFERENCES r9_bootstrap_evidence(id),ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 4),hash BLOB NOT NULL CHECK(length(hash)=32),bytes BLOB NOT NULL CHECK(length(bytes) BETWEEN 1 AND 262144),PRIMARY KEY(id,ordinal)) STRICT;
CREATE TRIGGER r9_evidence_fixed BEFORE UPDATE ON r9_bootstrap_evidence BEGIN SELECT RAISE(ABORT,'immutable evidence manifest'); END;
CREATE TRIGGER r9_evidence_retained BEFORE DELETE ON r9_bootstrap_evidence BEGIN SELECT RAISE(ABORT,'retained signed staging'); END;
CREATE TRIGGER r9_evidence_chunk_fixed BEFORE UPDATE ON r9_evidence_chunks BEGIN SELECT RAISE(ABORT,'immutable evidence chunk'); END;
CREATE TRIGGER r9_evidence_chunk_retained BEFORE DELETE ON r9_evidence_chunks BEGIN SELECT RAISE(ABORT,'retained signed staging'); END;
CREATE TRIGGER r9_profile_fixed BEFORE UPDATE ON r9_signed_profile BEGIN SELECT RAISE(ABORT,'fixed R9 version'); END;
CREATE TRIGGER r9_profile_retained BEFORE DELETE ON r9_signed_profile BEGIN SELECT RAISE(ABORT,'retained R9 version'); END;
