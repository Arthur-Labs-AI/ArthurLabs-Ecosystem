-- Synthetic MEGA E extension, installed only by test fixtures. Never a migration.
CREATE TABLE e_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),slot TEXT NOT NULL UNIQUE,key BLOB CHECK(key IS NULL OR length(key)=65),state TEXT NOT NULL CHECK(state IN('creating','active','invalidated')));
CREATE TABLE e_registry(singleton INTEGER PRIMARY KEY CHECK(singleton=1),network TEXT NOT NULL,admin BLOB NOT NULL CHECK(length(admin)=65),epoch INTEGER NOT NULL CHECK(epoch BETWEEN 1 AND 4096),digest BLOB NOT NULL CHECK(length(digest)=32));
CREATE TABLE e_updates(epoch INTEGER PRIMARY KEY CHECK(epoch BETWEEN 1 AND 4096),bytes BLOB NOT NULL CHECK(length(bytes) BETWEEN 1 AND 16384));
CREATE TRIGGER e_updates_immutable_update BEFORE UPDATE ON e_updates BEGIN SELECT RAISE(ABORT,'immutable registry'); END;
CREATE TRIGGER e_updates_immutable_delete BEFORE DELETE ON e_updates BEGIN SELECT RAISE(ABORT,'immutable registry'); END;
CREATE TABLE e_members(device TEXT PRIMARY KEY,key BLOB NOT NULL CHECK(length(key)=65),enrollment TEXT UNIQUE,enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),expires INTEGER NOT NULL CHECK(expires>0),capabilities INTEGER NOT NULL CHECK(capabilities BETWEEN 1 AND 3));
CREATE TABLE e_origins(origin TEXT PRIMARY KEY,device TEXT NOT NULL REFERENCES e_members(device));
CREATE TABLE e_abuse(singleton INTEGER PRIMARY KEY CHECK(singleton=1),boot TEXT NOT NULL,attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 5),issued INTEGER NOT NULL CHECK(issued BETWEEN 0 AND 8));
CREATE TABLE e_enrollments(id TEXT PRIMARY KEY,boot TEXT NOT NULL,started INTEGER NOT NULL CHECK(started>=0),state TEXT NOT NULL CHECK(state IN('issued','reserved','approval','consumed','received','expired','cancelled','locked')),attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 5),ticket TEXT,candidate BLOB CHECK(candidate IS NULL OR length(candidate)=65),transcript BLOB CHECK(transcript IS NULL OR length(transcript)=32),grant_bytes BLOB CHECK(grant_bytes IS NULL OR length(grant_bytes)<=16384));
CREATE UNIQUE INDEX e_one_active ON e_enrollments((1)) WHERE state IN('issued','reserved','approval');
