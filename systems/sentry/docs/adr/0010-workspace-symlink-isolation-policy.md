# ADR-0010: Workspace symlink isolation policy

Status: accepted

## Context

Copying source symlinks verbatim into a writable agent workspace can preserve an
absolute target or `..` traversal to the original project or another external
directory. An agent could then modify data outside its assigned workspace.
Broken links and Windows junctions also require an explicit policy.

## Decision

Classify links against canonical project-root and resolved-target paths as
internal, external, or broken. Snapshot identity records the link target and
classification without following links. Managed baseline import preserves links.

Writable agent workspaces recreate only internal links, rebased to the copied
workspace target. External and broken links become inert JSON descriptors that
state their path, target, and reason. Directory links/junctions are activated only
when their resolved target is internal and can be expressed against the workspace
copy; otherwise they receive the inert policy.

## Consequences

Safe internal project topology continues to work while autonomous writes cannot
escape through source links. Workspace bytes differ from the managed baseline for
unsafe links by design. Consumers can report exactly which link was blocked. The
policy depends on Node's exposed link/reparse behavior and deliberately fails
closed for targets it cannot safely classify.
