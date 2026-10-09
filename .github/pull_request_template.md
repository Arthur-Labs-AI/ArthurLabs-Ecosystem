## Change

Describe the concrete problem and resulting behavior. Link the task/issue.
List affected files and any architecture or historical-data compatibility impact.

## Validation

List executed commands/results and platform scope. Mark unavailable gates as
unverified. Do not claim security boundary verification from a fixture alone.
Record the candidate SHA and CI jobs. Distinguish Windows/WSL, native CachyOS,
and owner-reported earlier acceptance from results executed for this candidate.
List required manual acceptance tests, known limitations and risks of merging.

## Release impact

For release/hotfix PRs, link validation/notes, list blockers/limitations, and
identify the source commit. Owner review and passing candidate CI precede
merge, immutable tagging, and publication.
All changes require owner review before merging; agents stop after PR creation.
See [branching and manual gates](../docs/development/branching.md). A development
PR does not authorize version tags, release publication or future phases.
