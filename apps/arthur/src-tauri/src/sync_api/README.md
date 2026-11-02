# Native sync contracts

This extraction is incremental. The canonical codec is the first cluster;
production imports will be checked against the final contract after the shared
values and store port have been extracted.

The intended direction is `sync -> sync_api <- storage`. This module owns shared
values and contracts, not an engine, database, transport pool or native owner.

1. **Truth:** the existing owner's SQLite database remains authoritative.
2. **Ownership:** CaptureStore keeps its connection and transaction boundaries;
   no writer or connection is added here.
3. **Direction:** contracts have no imports from either implementation layer.
4. **Boundary:** bounded values, errors and traits cross it; SQL handles do not.
5. **Failure:** existing validation and typed refusal behavior is preserved.
6. **Lifecycle:** extracted values add no worker, lock, callback or resource owner.
7. **Tests:** existing canonical-byte and native qualification tests retain their
   paths and compile guards. Any allowed lab dependency must be explicit.
8. **Compatibility:** existing module paths re-export the same definitions;
   canonical bytes, schema v9 and the dormant activation policy are unchanged.
   Source reverts require no data migration.
9. **Observation:** existing outcomes remain; no new logging is introduced.
10. **Security:** capability construction and platform validation must retain
    their existing checks and visibility. Extraction does not approve activation.

No existing file below `storage/` is moved or renamed. In particular,
`storage/journal/codec.rs` remains the compatibility entry point while the
unchanged codec definitions live here.
