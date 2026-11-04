# ADR-0008: Recoverable streaming project-copy updates

Status: accepted

## Context

Sentry must copy complete projects, including large files and file counts, without
mutating the source or losing the last healthy managed copy when an update fails.
Cross-platform directory replacement is not universally atomic.

## Decision

Walk with `lstat`, preserve symlinks without following them, fail unsupported
special files, stream regular files, and cap concurrent file operations. Do not
apply implicit ignore rules. Imports and updates are cancellation-aware and expose
file/byte progress. Workspaces prefer reflinks and fall back to streamed copies;
mutable hardlinks are prohibited.

Updates build and hash revision-named staging first. The previous working copy is
renamed to a backup, staging is promoted, and only then is current revision metadata
committed. Failure restores the backup. Startup recovery treats staging as
incomplete and restores backup if the working copy is missing.

## Consequences

The operation is recoverable transactional replacement, not claimed filesystem
atomicity. Old runs remain immutable. A completed run-start hash must match the
recorded revision or agents do not start. Flat directories are sorted in memory
per directory for deterministic traversal, but the complete project manifest and
file-operation queue are never accumulated in memory.
