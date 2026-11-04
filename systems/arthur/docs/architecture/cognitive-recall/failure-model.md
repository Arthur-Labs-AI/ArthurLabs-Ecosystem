# Failure model

Recall fails in **understandable layers**. Each layer has its own outcome; a later layer failing never erases an earlier layer's
result, and a missing optional channel never makes Recall unusable.

```
scope/validation -> retrieval (lexical, semantic, graph, lineage, provenance) -> evidence package -> context budget -> synthesis -> validation
   hard reject         degrade, never reject                                      deterministic        degrade         degrade
```

Distinguish always: **"retrieval succeeded, synthesis failed"** (evidence exists) vs **"nothing relevant found"**
(`insufficient_evidence`) vs **"could not run"** (rejection).

## 1. Behaviour table

| Situation | Behaviour | Outcome / diagnostics | User sees |
|---|---|---|---|
| Blank/oversize query | Reject `invalid_query` | rejection | inline validation |
| Unknown project id | Reject `project_not_found` | rejection | message |
| Explicitly scoped archived project | Works, read-only; external graph neighbours that are archived are never admitted | `scope.archived: true` | project marked archived |
| Archived project as an external graph neighbour | Excluded from evidence; no content, no hint | counted only in `crossProjectOmitted` | nothing |
| **Embedding provider offline / no key / auth error / timeout (1.5 s)** | Semantic channel skipped; lexical + graph + lineage + provenance continue; synthesis continues | `semantic: unavailable`/`failed`/`disabled` | normal answer; subtle "searched by keywords only" note |
| **Semantic Recall not enabled (the default) or switched off** | No embedding request of any kind; existing vectors ignored; lexical + graph + lineage + provenance + synthesis | `semantic: disabled` | normal answer; optional unobtrusive invitation to enable semantic Recall |
| No vectors for active model yet | Semantic skipped | `semantic: no_index` | same |
| **One/some embeddings missing or stale** | Those objects are not semantic candidates (stale vectors are excluded by join, never used); still reachable lexically | `semantic: partial`, `semanticCoverage` | normal |
| **Stale embedding detected** (revision mismatch) | Ignored, queued for re-embedding by the lazy indexer | counted, not surfaced as error | none |
| **FTS unavailable / corrupt** (query error or failed integrity check) | Rust-side Unicode scan of the scope project's current objects; background rebuild scheduled | `lexical: degraded_scan` | answer, possibly lower quality |
| Query has no content terms (all stopwords) | Lexical skipped; semantic + phrase run | `lexical: skipped_no_terms` | normal |
| Both lexical and semantic unusable (FTS failed **and** scan errors) | Reject `storage_failed` | rejection | "Couldn't search your knowledge" |
| Nothing passes admission floors | **No synthesis request** (saves cost and prevents hallucination) | `outcome: insufficient_evidence`, `answer: null`, evidence `[]` | "Nothing in *this project* answers that" |
| **Only cross-project evidence exists** | Same as above: external objects are admitted only through an in-scope seed; with zero seeds there is nothing to follow | `insufficient_evidence` | no hint of other projects' content |
| Seeds exist but model deems evidence insufficient | Model returns `insufficient_evidence`; paragraphs (what was found) + `gaps` shown | `outcome: insufficient_evidence` | partial findings + what's missing |
| Evidence exceeds token budget | Deterministic degradation order (evidence-contract §2.2) | `truncation[]` lists steps | normal (sources note truncation if bodies cut) |
| **Answer model offline / not configured / refused / timeout (30 s)** | Retrieval kept; no answer | `outcome: retrieval_only`, `synthesis.state: unavailable/failed`, `reason` | "Here's what Arthur found" + evidence list; retry |
| **Model returns invalid structured output** | One retry; then `retrieval_only` | `synthesis.state: invalid_output`, `retried: true` | same as above |
| Model cites unknown handle | Handle stripped; paragraph dropped if left uncited | `strippedRefs > 0` | answer with only valid citations |
| Model labels history as current | Downgraded to `historical` deterministically | counted | correct styling |
| Index/embedding indexer failure | Background only, in-memory backoff, never affects distillation/capture/edit | none to user | none |
| Provider rate limit (HTTP 429) | Treated as `Provider(429)`: embedding -> semantic skipped; chat -> `retrieval_only`; indexer backs off | codes | as above |
| SQLite busy/poisoned lock | Reject `storage_failed` (retrieval impossible) | rejection | retry message |
| App closed mid-ask | Nothing persisted; no partial state exists | n/a | n/a |

## 2. Principles

1. **Resolve, don't reject, for degradation.** Only requests that cannot be served at all reject (`invalid_query`,
   `project_not_found`, `storage_failed`). Everything else returns a result with an explicit `outcome` and `diagnostics`.
2. **Optional channels are optional.** Semantic is a boost; lexical (always fresh, in-transaction) and the structural stages
   carry Recall alone. New knowledge is recallable the moment it is saved, before any embedding exists.
3. **Never fail open on scope or currency.** Every fallback (scan, stale vectors, degraded stages) keeps the project filter and the
   current-revision rule; a degraded path may be worse but is never wider or older.
4. **Never spend model calls on empty retrieval.** `insufficient_evidence` from retrieval skips synthesis entirely.
5. **Errors are safe to show.** Messages and diagnostics contain codes, counts and timings only, never prompts, provider bodies,
   query text or stored text (existing convention in `distillation`/`graph`).
6. **No partial writes.** Recall writes nothing authoritative; the only writes are rebuildable index rows by the indexer. A crash
   at any point leaves the Cognitive Store untouched.
7. **Bounded cost on failure.** At most 1 embedding + 2 chat requests per ask; no unbounded retry loops; the indexer's retries are
   in-memory and backed off.

## 3. Error codes (additions, mirrored Rust/TS)

```
RecallErrorCode (rejections):        invalid_query | project_not_found | storage_failed
RecallFailureReason (diagnostics):   llm_not_configured | llm_failed | llm_refused | llm_invalid_output | embedding_not_configured |
                                     embedding_failed | fts_failed | no_index
```

These reuse the vocabulary of `DistillationErrorCode` / `RelationErrorCode` where they overlap.
