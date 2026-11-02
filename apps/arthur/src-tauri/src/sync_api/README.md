# Native sync contracts

Canonical codec and protocol/bootstrap values have been extracted, including
the clock/transport contracts and cancellation.
Bootstrap decoding also needs the sealed validated event and its pure canonical
dependency reduction; those unchanged functions are part of the same cluster.
The store port and sealed session value are also shared contracts.

The intended direction is `sync -> sync_api <- storage`. This module owns shared
values and contracts, not an engine, database, transport pool or native owner.

1. **Truth:** the existing owner's SQLite database remains authoritative.
2. **Ownership:** CaptureStore keeps its connection and transaction boundaries;
   no writer or connection is added here.
3. **Direction:** contracts have no imports from either implementation layer.
4. **Boundary:** bounded values, errors and traits cross it; SQL handles do not.
5. **Failure:** existing validation and typed refusal behavior is preserved.
6. **Lifecycle:** extracted values add no worker, lock or resource owner.
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

The revocation port is injected by the existing runtime owner. CaptureStore
holds a weak trait object backed by that owner's existing pool; binding does not
retain the pool or create a new one. Notification still happens after the durable
registry commit, and its failure still means committed-but-unavailable rather
than rollback. The pool's owner-only constructor is unchanged.

## Source paths and module ownership

All existing source paths are retained, including test and qualification files.
The pure codec/reducer bodies are here and the original storage files re-export
them. `SyncStore` is here; the engine and storage implementer depend on that port.
The original `sync/trust.rs` and `sync/security/signed.rs` sources are compiled as
contract modules using `#[path]`, preserving existing source-based assertions.

`native_security` owns the existing key, signature, TLS, enrollment and route
primitives. Its `#[path]` declarations retain their existing files and private
construction scopes. These primitives use only the leaf protocol/error contracts;
the sealed session references their registry metadata. They do not call the engine
or storage in production. Security contract names are compatibility re-exports,
not duplicate types or new validation implementations.

The concrete transport pool is compiled in `runtime`, beside its private owner
token. Existing sync paths re-export it for compatibility. Qualification-only
composition retains its original cfg guards. The pool's read/waker operations
are crate-visible to those existing labs; construction still requires the same
private runtime token. The engine has no pool dependency.

No schema, query, journal output, key validation, capability factory or activation
decision changes in this extraction.
