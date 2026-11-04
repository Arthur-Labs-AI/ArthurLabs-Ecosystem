-- E2 additive candidate extension. Never registered in production migrations.
-- The original locally accepted genesis is pinned separately from projections.
CREATE TABLE e2_network_pin(singleton INTEGER PRIMARY KEY CHECK(singleton=1),genesis BLOB NOT NULL CHECK(length(genesis) BETWEEN 1 AND 16384),local_key BLOB NOT NULL CHECK(length(local_key)=65),signature BLOB NOT NULL CHECK(length(signature)=64));
CREATE TRIGGER e2_pin_no_update BEFORE UPDATE ON e2_network_pin BEGIN SELECT RAISE(ABORT,'immutable network pin'); END;
CREATE TRIGGER e2_pin_no_delete BEFORE DELETE ON e2_network_pin BEGIN SELECT RAISE(ABORT,'immutable network pin'); END;
CREATE TABLE e2_enrollment_clock(enrollment TEXT PRIMARY KEY REFERENCES e_enrollments(id),seen INTEGER NOT NULL CHECK(seen>=0));
-- Accepted prefixes are sealed by the local OS-held identity in the import transaction.
CREATE TABLE e2_origin_seals(origin TEXT PRIMARY KEY,incarnation TEXT NOT NULL UNIQUE,author BLOB NOT NULL CHECK(length(author)=65),seq INTEGER NOT NULL CHECK(seq BETWEEN 1 AND 256),hash BLOB NOT NULL CHECK(length(hash)=32),signature BLOB NOT NULL CHECK(length(signature)=64));
CREATE TABLE e2_originals(event TEXT PRIMARY KEY,origin TEXT NOT NULL REFERENCES e2_origin_seals(origin),seq INTEGER NOT NULL CHECK(seq BETWEEN 1 AND 256),hash BLOB NOT NULL CHECK(length(hash)=32),envelope BLOB NOT NULL CHECK(length(envelope) BETWEEN 1 AND 16384),UNIQUE(origin,seq));
CREATE TABLE e2_quarantine(event TEXT PRIMARY KEY,hash BLOB NOT NULL CHECK(length(hash)=32),core BLOB NOT NULL CHECK(length(core) BETWEEN 1 AND 4194304),envelope BLOB NOT NULL CHECK(length(envelope) BETWEEN 1 AND 16384));
