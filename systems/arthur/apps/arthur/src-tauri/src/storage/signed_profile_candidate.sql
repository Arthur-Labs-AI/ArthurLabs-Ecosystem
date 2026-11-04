-- R8 additive qualification metadata, never a production migration/import ledger.
-- Source cache owns only signatures of already committed local journal rows.
CREATE TABLE e2_export_signatures (
    event TEXT PRIMARY KEY REFERENCES sync_bundles(event_id),
    envelope BLOB NOT NULL CHECK(length(envelope) BETWEEN 1 AND 16384)
) STRICT;
CREATE TRIGGER e2_export_signature_no_update BEFORE UPDATE ON e2_export_signatures
BEGIN SELECT RAISE(ABORT,'immutable original signature'); END;
CREATE TRIGGER e2_export_signature_no_delete BEFORE DELETE ON e2_export_signatures
BEGIN SELECT RAISE(ABORT,'retained original signature'); END;
-- Deferred originals already live in import_events. This is their signature
-- evidence, not a second event body, outcome, cursor or source of domain truth.
CREATE TABLE e2_pending_signatures (
    event TEXT PRIMARY KEY REFERENCES import_events(event),
    envelope BLOB NOT NULL CHECK(length(envelope) BETWEEN 1 AND 16384)
) STRICT;
