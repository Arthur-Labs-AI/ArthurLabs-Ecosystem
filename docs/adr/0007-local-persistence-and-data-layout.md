# ADR-0007: Local SQLite persistence and filesystem data layout

Status: accepted

## Context

Phase 2 requires durable, queryable metadata and incremental events while project
bytes, manifests, logs, screenshots, and exports may be arbitrarily large.

## Decision

Use one migrated SQLite database under the centralized OS-specific Sentry data
root. Use Node's built-in `node:sqlite` driver to avoid native-addon distribution
and install lifecycle. Enable foreign keys and WAL. Keep versioned bounded DTO JSON
in entity-specific tables with indexed identity/relationship columns and parse it
through Zod at repository boundaries.

Store large bytes in a filesystem ArtifactStore. Writes stream to a temporary file,
calculate SHA-256/size during the write, rename within the destination directory,
and then record bounded Artifact metadata. Snapshot manifests and context indexes
are NDJSON so producers and consumers need not create one enormous DTO.

## Consequences

SQLite is canonical for metadata and query state; the filesystem is canonical for
artifact bytes. Application APIs—not the future UI—query repositories. Schema
changes require ordered migrations. Node 22 currently labels the built-in driver
experimental, so the persistence adapter is the replacement seam if its API
changes; no domain contract depends on it.
