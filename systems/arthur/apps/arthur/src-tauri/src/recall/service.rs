//! Recall orchestration: scope, the overlap of lexical retrieval with query embedding, fusion, and the lazy indexer.
//!
//! ```text
//!                      +--> lexical (FTS5, current)  -> gated historical nomination --+
//! scope + query -------+                                                              +--> RRF --> RetrievalResult
//!   consent ON only -> +--> query embedding (network, spawned FIRST) -> vector scan ---+
//! ```
//!
//! The embedding request is spawned before any local work starts, so the network wait overlaps the lexical search. If it fails or
//! times out, retrieval continues lexically and says so. When consent is OFF no embedding request is ever made.
//!
//! The service never writes authoritative data. Its only writes are `recall_embeddings` rows (the lazy indexer).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::evidence::{
    evidence_list, LexicalStatus, RecallError, RetrievalDiagnostics, RetrievalOutcome,
    RetrievalResult, RetrievalScope, SemanticStatus, Timings,
};
use super::lexical::fallback_scan;
use super::query::{interpret, match_expression, InterpretedQuery, QueryProblem};
use super::ranking::{
    admit_historical, admit_lexical, fuse, historical_path_allowed, SemanticSignal, CHANNEL_LIMIT,
    HISTORICAL_LIMIT,
};
use super::settings::SemanticSettings;
use crate::providers::embed::{
    embedding_text, text_hash, EmbedFailure, EmbedPurpose, EmbeddingProvider, ModelKey,
};
use crate::storage::capture_store::{CaptureStore, StoreError};
use crate::storage::project_store::ProjectError;
use crate::storage::recall_store::CurrentObject;

type SemanticScan = (
    Vec<(CurrentObject, SemanticSignal)>,
    SemanticStatus,
    Option<f64>,
);

/// Similarity floor (M04A `tau_sem`) for `text-embedding-3-small` @ 512, calibrated by the live sweep on the golden corpus (see
/// docs/architecture/cognitive-recall/m04b-implementation-notes.md): a floor on the plateau where every question that must return
/// nothing has zero false evidence and paraphrase recall is unchanged. 0.35 meets the same gates but sits only 0.014 above the highest
/// false cosine (0.336); 0.40 gives a 0.064 margin for ~1 pp of hybrid recall. It is a property of this model; another model key needs its own sweep.
pub const DEFAULT_MIN_COSINE: f32 = 0.40;
/// How long retrieval waits for the query embedding before degrading to lexical.
pub const DEFAULT_QUERY_EMBED_TIMEOUT: Duration = Duration::from_millis(1_500);
/// Objects embedded per provider request, and per indexing run.
pub const INDEX_BATCH: usize = 64;
pub const INDEX_RUN_LIMIT: usize = 256;

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}

fn storage(error: StoreError) -> RecallError {
    RecallError::Storage(error.to_string())
}

fn failure_reason(failure: &EmbedFailure) -> &'static str {
    match failure {
        EmbedFailure::NotConfigured => "notConfigured",
        EmbedFailure::Network => "network",
        EmbedFailure::Auth(_) => "auth",
        EmbedFailure::Provider(_) => "provider",
        EmbedFailure::Unreadable(_) => "unreadable",
    }
}

/// What one indexing run did.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct IndexReport {
    pub embedded: usize,
    /// Vectors re-pointed at a new current revision whose text was byte-identical (no provider call).
    pub adopted: usize,
    pub embedding_requests: u32,
    pub uploaded_texts: u32,
    /// The run stopped because semantic Recall is not enabled (at the start or in the middle).
    pub stopped_by_consent: bool,
    /// The provider failed (a code); the caller backs off.
    pub failure: Option<&'static str>,
    /// Objects that still lack a valid vector after the run (`None` if the run stopped before looking).
    pub remaining: Option<usize>,
}

/// What the user (and a future settings screen) needs to know about semantic Recall. Contains no stored text.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticRecallStatus {
    /// The effective state: opted in FOR THIS provider.
    pub enabled: bool,
    pub saved_enabled: bool,
    pub saved_model_key: Option<String>,
    pub settings_corrupt: bool,
    pub active_model_key: String,
    /// Vectors stored for the active key (valid or stale).
    pub stored_vectors: i64,
    /// Vectors stored under any key (what a purge would remove).
    pub stored_vectors_all_keys: i64,
    /// Objects that currently lack a valid vector for the active key.
    pub pending_objects: i64,
}

pub struct RecallService {
    provider: Arc<dyn EmbeddingProvider>,
    settings: Arc<SemanticSettings>,
    indexing: AtomicBool,
    rebuild_attempted: AtomicBool,
    pub(super) answer_model: Option<Arc<dyn super::synthesis::AnswerModel>>,
    pub(super) enrichment: super::package::EnrichmentConfig,
    #[cfg(test)]
    pub lexical_enabled: AtomicBool,
    #[cfg(test)]
    pub lexical_probe: std::sync::Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
    min_cosine: f32,
    query_embed_timeout: Duration,
}

/// Held while an indexing run is in progress; releases the single-run guard on drop.
pub struct IndexingGuard<'a>(&'a AtomicBool);

impl Drop for IndexingGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl RecallService {
    pub fn new(provider: Arc<dyn EmbeddingProvider>, settings: Arc<SemanticSettings>) -> Self {
        Self {
            provider,
            settings,
            indexing: AtomicBool::new(false),
            rebuild_attempted: AtomicBool::new(false),
            answer_model: None,
            enrichment: super::package::EnrichmentConfig::default(),
            #[cfg(test)]
            lexical_enabled: AtomicBool::new(true),
            #[cfg(test)]
            lexical_probe: std::sync::Mutex::new(None),
            min_cosine: DEFAULT_MIN_COSINE,
            query_embed_timeout: DEFAULT_QUERY_EMBED_TIMEOUT,
        }
    }

    #[cfg(test)]
    pub fn with_query_embed_timeout(mut self, timeout: Duration) -> Self {
        self.query_embed_timeout = timeout;
        self
    }

    #[cfg(test)]
    #[allow(dead_code)]
    pub fn with_min_cosine(mut self, min_cosine: f32) -> Self {
        self.min_cosine = min_cosine;
        self
    }

    pub fn model_key(&self) -> &ModelKey {
        self.provider.model_key()
    }

    pub fn settings(&self) -> &SemanticSettings {
        &self.settings
    }

    /// Whether the user has opted in to semantic Recall for THIS provider. Read from the settings file on every call.
    pub fn semantic_enabled(&self) -> bool {
        self.settings.is_enabled_for(self.provider.model_key())
    }

    /// Takes the single-run indexing guard, or `None` if a run is already in progress.
    pub fn begin_indexing(&self) -> Option<IndexingGuard<'_>> {
        self.indexing
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| IndexingGuard(&self.indexing))
    }

    pub fn semantic_status(
        &self,
        store: &CaptureStore,
    ) -> Result<SemanticRecallStatus, RecallError> {
        let state = self.settings.state();
        let key = self.provider.model_key().as_str();
        Ok(SemanticRecallStatus {
            enabled: self.semantic_enabled(),
            saved_enabled: state.saved_enabled,
            saved_model_key: state.saved_model_key,
            settings_corrupt: state.corrupt,
            active_model_key: key.to_string(),
            stored_vectors: store
                .recall_stored_vector_count(Some(key))
                .map_err(storage)?,
            stored_vectors_all_keys: store.recall_stored_vector_count(None).map_err(storage)?,
            pending_objects: store.recall_pending_count(key).map_err(storage)?,
        })
    }

    /// Deletes every stored vector. Authoritative knowledge is untouched. Returns how many vectors were removed.
    pub fn purge_semantic_index(&self, store: &CaptureStore) -> Result<usize, RecallError> {
        store.recall_purge_embeddings().map_err(storage)
    }

    /// One bounded retrieval. `project_id` is the single, explicit scope: it is never widened.
    pub async fn retrieve(
        &self,
        store: &CaptureStore,
        raw_query: &str,
        project_id: &str,
    ) -> Result<RetrievalResult, RecallError> {
        let started = Instant::now();
        let mut sql_reads: u32 = 0;
        let mut timings = Timings::default();

        let interpret_started = Instant::now();
        let query = interpret(raw_query).map_err(|problem| {
            RecallError::InvalidQuery(match problem {
                QueryProblem::Empty => "it is empty".to_string(),
                QueryProblem::TooLong => format!(
                    "it is longer than {} characters",
                    super::query::MAX_QUERY_CHARS
                ),
            })
        })?;
        timings.interpret_ms = ms(interpret_started);

        sql_reads += 1;
        let project = store.get_project(project_id).map_err(|error| match error {
            ProjectError::ProjectNotFound => RecallError::ProjectNotFound,
            other => RecallError::Storage(other.to_string()),
        })?;
        let scope = RetrievalScope {
            project_id: project.id.clone(),
            project_name: project.name.clone(),
            archived: project.archived_at.is_some(),
        };

        // 1. Start the query embedding first (consent permitting) so the network wait overlaps all local work.
        let mut embedding_requests: u32 = 0;
        let mut uploaded_texts: u32 = 0;
        let embedding_started = Instant::now();
        let pending_embedding = if self.semantic_enabled() {
            embedding_requests = 1;
            uploaded_texts = 1;
            let provider = self.provider.clone();
            let text = vec![query.raw.clone()];
            let timeout = self.query_embed_timeout;
            Some(tauri::async_runtime::spawn(async move {
                tokio::time::timeout(timeout, provider.embed(&text, EmbedPurpose::Query)).await
            }))
        } else {
            None
        };

        // 2. Lexical, current revisions only.
        let lexical_started = Instant::now();
        #[cfg(test)]
        if let Some(probe) = self.lexical_probe.lock().unwrap().as_ref() {
            probe();
        }
        #[cfg(test)]
        let lexical_on = self.lexical_enabled.load(Ordering::SeqCst);
        #[cfg(not(test))]
        let lexical_on = true;
        let (lexical_hits, lexical_status) = if lexical_on {
            self.lexical_current(store, &query, project_id, &mut sql_reads)?
        } else {
            (Vec::new(), LexicalStatus::SkippedNoTerms)
        };
        let lexical = admit_lexical(&query, lexical_hits);
        timings.lexical_ms = ms(lexical_started);

        // 3. Gated historical nomination: old wording is a recovery path, never an equal competitor of current text.
        let mut historical_ran = false;
        let mut historical_nominated = 0usize;
        let mut historical = Vec::new();
        if lexical_on
            && lexical_status == LexicalStatus::Ok
            && historical_path_allowed(&query, lexical.len())
        {
            if let Some(expression) = match_expression(&query) {
                let historical_started = Instant::now();
                historical_ran = true;
                sql_reads += 1;
                let hits = store
                    .recall_lexical_historical(&expression, project_id, HISTORICAL_LIMIT)
                    .map_err(storage)?;
                historical = admit_historical(&query, hits);
                historical_nominated = historical.len();
                timings.historical_ms = ms(historical_started);
            }
        }
        let local_before_semantic = ms(started);

        // 4. Semantic: wait for the embedding, then scan locally.
        let mut semantic: Vec<(CurrentObject, SemanticSignal)> = Vec::new();
        let mut semantic_status = SemanticStatus::Disabled;
        let mut semantic_reason = None;
        let mut semantic_coverage = None;
        if let Some(handle) = pending_embedding {
            let outcome = handle.await;
            timings.query_embedding_ms = ms(embedding_started);
            match outcome {
                Ok(Ok(Ok(mut vectors)))
                    if vectors.len() == 1 && vectors[0].len() == self.provider.dims() =>
                {
                    let semantic_started = Instant::now();
                    let vector = vectors.remove(0);
                    let scan =
                        self.semantic_scan(store, &query, project_id, &vector, &mut sql_reads)?;
                    semantic = scan.0;
                    semantic_status = scan.1;
                    semantic_coverage = scan.2;
                    timings.semantic_local_ms = ms(semantic_started);
                }
                Ok(Ok(Ok(_))) => {
                    semantic_status = SemanticStatus::Unavailable;
                    semantic_reason = Some("unreadable");
                }
                Ok(Ok(Err(failure))) => {
                    semantic_status = SemanticStatus::Unavailable;
                    semantic_reason = Some(failure_reason(&failure));
                }
                Ok(Err(_elapsed)) => {
                    semantic_status = SemanticStatus::Unavailable;
                    semantic_reason = Some("timeout");
                }
                Err(_join) => {
                    semantic_status = SemanticStatus::Unavailable;
                    semantic_reason = Some("failed");
                }
            }
        }

        // 5. Deterministic fusion.
        let merge_started = Instant::now();
        let fused = fuse(&query, lexical, semantic, historical);
        let (pool_size, seed_count, active_channels) =
            (fused.pool.len(), fused.seed_count, fused.active_channels);
        let evidence = evidence_list(fused);
        timings.merge_ms = ms(merge_started);
        // The FTS index failed this time: regenerate it from the authoritative revisions, once per process, best effort. The next
        // question benefits; this one was already answered by the fallback scan.
        if lexical_status == LexicalStatus::DegradedScan
            && !self.rebuild_attempted.swap(true, Ordering::SeqCst)
        {
            let _ = store.recall_rebuild_lexical_index();
        }
        timings.wall_ms = ms(started);
        // Local time excludes the embedding wait that overlapped the lexical work.
        timings.total_ms = (local_before_semantic + timings.semantic_local_ms + timings.merge_ms)
            .min(timings.wall_ms);

        Ok(RetrievalResult {
            query: query.raw.clone(),
            scope,
            outcome: if evidence.is_empty() {
                RetrievalOutcome::NoMatch
            } else {
                RetrievalOutcome::Results
            },
            evidence,
            diagnostics: RetrievalDiagnostics {
                intent: query.intent,
                lexical: lexical_status,
                semantic: semantic_status,
                semantic_reason,
                semantic_coverage,
                historical_ran,
                historical_nominated,
                timings,
                embedding_requests,
                uploaded_texts,
                sql_reads,
                pool_size,
                seed_count,
                active_channels,
            },
        })
    }

    /// FTS5 first. If it fails, the Rust scan answers and the status says so. If the scan fails too, that is a storage failure and
    /// is reported as one: a broken store is never presented as "no match".
    fn lexical_current(
        &self,
        store: &CaptureStore,
        query: &InterpretedQuery,
        project_id: &str,
        sql_reads: &mut u32,
    ) -> Result<
        (
            Vec<crate::storage::recall_store::CurrentLexicalHit>,
            LexicalStatus,
        ),
        RecallError,
    > {
        let Some(expression) = match_expression(query) else {
            return Ok((Vec::new(), LexicalStatus::SkippedNoTerms));
        };
        *sql_reads += 1;
        match store.recall_lexical_current(&expression, project_id, CHANNEL_LIMIT) {
            // Silence is suspicious: an emptied index also answers "no match". Verify before believing it.
            Ok(hits)
                if hits.is_empty()
                    && !store.recall_lexical_index_is_complete().unwrap_or(false) =>
            {
                *sql_reads += 2;
                let objects = store.recall_scan_current(project_id).map_err(storage)?;
                Ok((fallback_scan(query, objects), LexicalStatus::DegradedScan))
            }
            Ok(hits) => Ok((hits, LexicalStatus::Ok)),
            Err(StoreError::Poisoned) => {
                Err(RecallError::Storage(StoreError::Poisoned.to_string()))
            }
            Err(_fts_failure) => {
                *sql_reads += 1;
                let objects = store.recall_scan_current(project_id).map_err(storage)?;
                Ok((fallback_scan(query, objects), LexicalStatus::DegradedScan))
            }
        }
    }

    fn semantic_scan(
        &self,
        store: &CaptureStore,
        _query: &InterpretedQuery,
        project_id: &str,
        vector: &[f32],
        sql_reads: &mut u32,
    ) -> Result<SemanticScan, RecallError> {
        let key = self.provider.model_key().as_str();
        *sql_reads += 1;
        let coverage = store
            .recall_semantic_coverage(project_id, key)
            .map_err(storage)?;
        let ratio = if coverage.in_scope_objects == 0 {
            1.0
        } else {
            coverage.embedded_objects as f64 / coverage.in_scope_objects as f64
        };
        if coverage.embedded_objects == 0 {
            return Ok((Vec::new(), SemanticStatus::NoIndex, Some(0.0)));
        }
        *sql_reads += 1;
        let (hits, _scan) = store
            .recall_semantic_scan(
                project_id,
                key,
                self.provider.dims(),
                vector,
                CHANNEL_LIMIT,
                self.min_cosine,
            )
            .map_err(storage)?;
        let ids: Vec<String> = hits.iter().map(|hit| hit.object_id.clone()).collect();
        *sql_reads += 1;
        let objects = store
            .recall_current_objects(&ids, project_id)
            .map_err(storage)?;
        let mut resolved = Vec::new();
        for hit in hits {
            // An id that no longer resolves in scope (it moved between the scan and now) is simply dropped.
            if let Some(object) = objects.iter().find(|o| o.object_id == hit.object_id) {
                let rank = resolved.len() + 1;
                resolved.push((
                    object.clone(),
                    SemanticSignal {
                        rank,
                        cosine: hit.cosine,
                    },
                ));
            }
        }
        let status = if coverage.embedded_objects < coverage.in_scope_objects {
            SemanticStatus::Partial
        } else {
            SemanticStatus::Ok
        };
        Ok((resolved, status, Some(ratio)))
    }

    /// Embeds objects whose current revision has no valid vector, in bounded batches, for at most `max_objects` objects.
    ///
    /// Consent is re-read before every batch and again before results are stored: turning semantic Recall off stops the next
    /// request, and a batch already in flight is DISCARDED, not stored. A vector is stored only if its revision is still the
    /// object's current one. Never run for an object without consent; never embeds historical revisions.
    pub async fn index_pending(
        &self,
        store: &CaptureStore,
        max_objects: usize,
    ) -> Result<IndexReport, RecallError> {
        let mut report = IndexReport::default();
        let key = self.provider.model_key().clone();
        let dims = self.provider.dims();
        let batch_size = self.provider.max_batch().min(INDEX_BATCH);
        let mut seen = 0usize;
        while seen < max_objects {
            if !self.semantic_enabled() {
                report.stopped_by_consent = true;
                return Ok(report);
            }
            let pending = store
                .recall_pending_embeddings(key.as_str(), batch_size.min(max_objects - seen))
                .map_err(storage)?;
            if pending.is_empty() {
                break;
            }
            seen += pending.len();

            let mut to_embed = Vec::new();
            for item in pending {
                let text = embedding_text(&item.kind, &item.title, &item.body);
                let hash = text_hash(&text);
                // Byte-identical embedded text (for instance a merge adopting an existing wording): no provider call needed.
                if store
                    .recall_stored_text_hash(&item.object_id, key.as_str())
                    .map_err(storage)?
                    .as_deref()
                    == Some(hash.as_str())
                {
                    if store
                        .recall_adopt_revision(&item.object_id, key.as_str(), &item.revision_id)
                        .map_err(storage)?
                    {
                        report.adopted += 1;
                    }
                    continue;
                }
                to_embed.push((item, text, hash));
            }
            if to_embed.is_empty() {
                continue;
            }
            if !self.semantic_enabled() {
                report.stopped_by_consent = true;
                return Ok(report);
            }
            let texts: Vec<String> = to_embed.iter().map(|(_, text, _)| text.clone()).collect();
            report.embedding_requests += 1;
            report.uploaded_texts += texts.len() as u32;
            let vectors = match self.provider.embed(&texts, EmbedPurpose::Document).await {
                Ok(vectors)
                    if vectors.len() == texts.len() && vectors.iter().all(|v| v.len() == dims) =>
                {
                    vectors
                }
                Ok(_) => {
                    report.failure = Some("unreadable");
                    return Ok(report);
                }
                Err(failure) => {
                    report.failure = Some(failure_reason(&failure));
                    return Ok(report);
                }
            };
            if !self.semantic_enabled() {
                // Switched off while the request was in flight: the answer is discarded, nothing is stored.
                report.stopped_by_consent = true;
                return Ok(report);
            }
            for ((item, _text, hash), vector) in to_embed.into_iter().zip(vectors) {
                if store
                    .recall_put_embedding(
                        &item.object_id,
                        key.as_str(),
                        &item.revision_id,
                        dims,
                        &vector,
                        &hash,
                    )
                    .map_err(storage)?
                {
                    report.embedded += 1;
                }
            }
        }
        report.remaining =
            Some(store.recall_pending_count(key.as_str()).map_err(storage)? as usize);
        Ok(report)
    }
}
