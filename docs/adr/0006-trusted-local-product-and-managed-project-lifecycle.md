# ADR-0006: Trusted local product and managed-project lifecycle

Status: accepted

## Context

Treating Sentry as a hosted multitenant service would introduce unrelated auth,
RBAC, tenant, billing, quota, cloud-import, and retention concerns. Running agents
directly in the user's original folder would risk destructive interference and
make historical results irreproducible.

## Decision

Sentry is a trusted local product for local folders. It keeps a managed copy under
a separate data root, creates immutable revisions and run snapshots, locks the
baseline during a run, and gives every agent a private isolated writable
workspace. Runs retain append-oriented history until explicit manual deletion.
Usage is token/runtime data only. Fix proposals are advice only and cannot apply
changes. One agent's crash becomes `interrupted` and may produce a partial run
without invalidating other agents' results.

There is no Sentry user authentication, RBAC, multitenancy, organization model,
billing, monetary cost tracking, quota, project-size cap, cloud/GitHub import, or
automatic retention cleanup in this baseline.

## Consequences

Phase 2 filesystem and persistence implementations must preserve old healthy
copies during updates, stream large-project work, isolate agent workspaces, and
recover observable pre-crash history. If a future hosted product is proposed, it
requires a new ADR and separate architecture rather than hidden fields in these
local contracts.
