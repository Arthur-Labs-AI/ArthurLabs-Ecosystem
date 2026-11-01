//! The `CognitiveAnswer` contract returned by `ask` and the orchestration behind it (query -> result; nothing is persisted).
//!
//! ```text
//! retrieve (M04B)  ->  EvidencePackage  ->  insufficient? --> no model call
//!                                         ->  bounded context -> ONE synthesis request (+ at most one repair) -> deterministic validation
//! ```
//!
//! Outcomes: `answered`, `insufficient_evidence` (nothing relevant enough, or the model said so) and `retrieval_only` (evidence was found but
//! no grounded answer could be produced: the answer model is missing, offline, refused, or returned unusable output twice). Degradation
//! RESOLVES with an outcome and diagnostics; only an impossible request (bad query, unknown project, unreadable store) is an error.

use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;

use super::context::{build_context, ContextReport, BUDGET_TOKENS};
use super::evidence::{RecallError, RetrievalDiagnostics, RetrievalScope};
use super::package::{build_package, CognitiveEvidence, EnrichmentConfig, EnrichmentStats};
use super::prompt;
use super::service::RecallService;
use super::synthesis::{
    validate, AnswerModel, ModelOutcome, Paragraph, SynthesisFailure, SynthesisRequest,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AskOutcome {
    Answered,
    InsufficientEvidence,
    RetrievalOnly,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerBody {
    pub paragraphs: Vec<Paragraph>,
    /// What the evidence did not contain (from the model, only when it said so).
    pub gaps: Vec<String>,
}

/// One entry of the evidence package as returned to the caller.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerEvidence {
    #[serde(flatten)]
    pub entry: CognitiveEvidence,
    /// A validated paragraph of the answer rests on this entry (or one of its history entries).
    pub cited: bool,
    /// The entry was part of what the model was shown (it may have been dropped for the token budget).
    pub in_context: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisReport {
    /// `ok`, `skipped` (no model call was needed or allowed), `unavailable`, `failed`, `invalidOutput`.
    pub state: &'static str,
    pub reason: Option<&'static str>,
    pub model: Option<String>,
    pub retried: bool,
    pub requests: u32,
    pub stripped_refs: usize,
    pub dropped_paragraphs: usize,
    pub temporal_corrected: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AskTimings {
    pub retrieval_ms: f64,
    pub graph_ms: f64,
    pub lineage_ms: f64,
    pub provenance_ms: f64,
    pub context_ms: f64,
    /// The answer model's network time, reported separately and never added to local time.
    pub synthesis_ms: f64,
    /// Everything local: retrieval (without the embedding wait), enrichment and context construction.
    pub local_total_ms: f64,
    pub wall_ms: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AskCounts {
    pub entries: usize,
    pub primary: usize,
    pub graph: usize,
    pub external: usize,
    pub history: usize,
    pub chat_requests: u32,
    pub embedding_requests: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskDiagnostics {
    pub retrieval: RetrievalDiagnostics,
    pub enrichment: EnrichmentStats,
    pub context: Option<ContextReport>,
    pub synthesis: SynthesisReport,
    pub timings: AskTimings,
    pub counts: AskCounts,
    /// Store calls in total (retrieval plus enrichment): each one batched, none per object.
    pub sql_reads: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CognitiveAnswer {
    pub query: String,
    pub scope: RetrievalScope,
    pub outcome: AskOutcome,
    pub answer: Option<AnswerBody>,
    /// The whole package, deterministic order, handles E1.. (cited and uncited; `inContext` says what the model saw).
    pub evidence: Vec<AnswerEvidence>,
    pub diagnostics: AskDiagnostics,
}

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}

fn skipped(reason: Option<&'static str>) -> SynthesisReport {
    SynthesisReport {
        state: "skipped",
        reason,
        model: None,
        retried: false,
        requests: 0,
        stripped_refs: 0,
        dropped_paragraphs: 0,
        temporal_corrected: 0,
    }
}

impl RecallService {
    pub fn with_answer_model(mut self, model: Arc<dyn AnswerModel>) -> Self {
        self.answer_model = Some(model);
        self
    }

    pub fn with_enrichment(mut self, config: EnrichmentConfig) -> Self {
        self.enrichment = config;
        self
    }

    /// Answers one question inside ONE explicit project. The model never chooses what to read: retrieval and enrichment have already
    /// built the complete, bounded evidence package, and the model sees only that.
    pub async fn ask(
        &self,
        store: &crate::storage::capture_store::CaptureStore,
        query: &str,
        project_id: &str,
    ) -> Result<CognitiveAnswer, RecallError> {
        let started = Instant::now();
        let retrieval_started = Instant::now();
        let retrieval = self.retrieve(store, query, project_id).await?;
        let retrieval_ms = ms(retrieval_started);

        let package = build_package(store, &retrieval, &self.enrichment)?;
        let local_before_context = retrieval.diagnostics.timings.total_ms
            + package.stats.graph_ms
            + package.stats.lineage_ms
            + package.stats.provenance_ms;

        let mut timings = AskTimings {
            retrieval_ms,
            graph_ms: package.stats.graph_ms,
            lineage_ms: package.stats.lineage_ms,
            provenance_ms: package.stats.provenance_ms,
            ..Default::default()
        };
        let counts = |package: &super::package::EvidencePackage, chat: u32| AskCounts {
            entries: package.entries.len(),
            primary: package
                .entries
                .iter()
                .filter(|e| e.role == "primary")
                .count(),
            graph: package.entries.iter().filter(|e| e.role == "graph").count(),
            external: package
                .entries
                .iter()
                .filter(|e| e.external_project)
                .count(),
            history: package
                .entries
                .iter()
                .map(|e| e.lineage.as_ref().map_or(0, |l| l.entries.len()))
                .sum(),
            chat_requests: chat,
            embedding_requests: retrieval.diagnostics.embedding_requests,
        };

        let finish = |outcome: AskOutcome,
                      answer: Option<AnswerBody>,
                      cited: &std::collections::HashSet<String>,
                      in_context: &std::collections::HashSet<String>,
                      context: Option<ContextReport>,
                      synthesis: SynthesisReport,
                      mut timings: AskTimings,
                      package: super::package::EvidencePackage,
                      sql_extra: u32| {
            timings.wall_ms = ms(started);
            let chat = synthesis.requests;
            let counts = counts(&package, chat);
            let sql_reads = retrieval.diagnostics.sql_reads + package.stats.sql_reads + sql_extra;
            let evidence = package
                .entries
                .iter()
                .cloned()
                .map(|entry| {
                    let cited_here = cited.contains(&entry.handle)
                        || entry
                            .lineage
                            .iter()
                            .flat_map(|l| l.entries.iter())
                            .any(|h| cited.contains(&h.handle));
                    let in_ctx = in_context.contains(&entry.handle);
                    AnswerEvidence {
                        entry,
                        cited: cited_here,
                        in_context: in_ctx,
                    }
                })
                .collect();
            CognitiveAnswer {
                query: retrieval.query.clone(),
                scope: retrieval.scope.clone(),
                outcome,
                answer,
                evidence,
                diagnostics: AskDiagnostics {
                    retrieval: retrieval.diagnostics.clone(),
                    enrichment: package.stats.clone(),
                    context,
                    synthesis,
                    timings,
                    counts,
                    sql_reads,
                },
            }
        };
        let none = std::collections::HashSet::new();

        // Nothing relevant (or nothing sufficient on its own): say so, and spend no model call.
        if !package.sufficient {
            timings.local_total_ms = local_before_context;
            let reason = package.insufficiency;
            return Ok(finish(
                AskOutcome::InsufficientEvidence,
                None,
                &none,
                &none,
                None,
                skipped(reason),
                timings,
                package,
                0,
            ));
        }

        let context_started = Instant::now();
        let context = build_context(&package, BUDGET_TOKENS);
        timings.context_ms = ms(context_started);
        timings.local_total_ms = local_before_context + timings.context_ms;

        let Some(model) = self.answer_model.clone() else {
            let synthesis = SynthesisReport {
                state: "unavailable",
                reason: Some("llmNotConfigured"),
                ..skipped(None)
            };
            return Ok(finish(
                AskOutcome::RetrievalOnly,
                None,
                &none,
                &context.allowed_handles,
                Some(context.report),
                synthesis,
                timings,
                package,
                0,
            ));
        };

        let mut report = SynthesisReport {
            state: "ok",
            reason: None,
            model: Some(model.model_name()),
            retried: false,
            requests: 0,
            stripped_refs: 0,
            dropped_paragraphs: 0,
            temporal_corrected: 0,
        };
        let synthesis_started = Instant::now();
        let mut repair_note: Option<String> = None;
        let mut result: Option<super::synthesis::Validated> = None;
        for attempt in 0..2 {
            let request = SynthesisRequest {
                system: prompt::system_prompt(),
                user: prompt::user_message(
                    &retrieval.query,
                    &retrieval.scope.project_name,
                    &context.evidence_json,
                    repair_note.as_deref(),
                ),
                schema: prompt::response_schema(),
            };
            report.requests += 1;
            report.retried = attempt == 1;
            match model.complete(&request).await {
                Err(failure) => {
                    report.state = if matches!(
                        failure,
                        SynthesisFailure::NotConfigured
                            | SynthesisFailure::Network
                            | SynthesisFailure::Provider(_)
                    ) {
                        "unavailable"
                    } else {
                        "failed"
                    };
                    report.reason = Some(failure.code());
                    // A transport or provider failure is not a repairable answer: no second request.
                    if !matches!(failure, SynthesisFailure::Unreadable(_)) {
                        break;
                    }
                    repair_note = Some("the response could not be read".into());
                }
                Ok(raw) => match validate(&raw, &package, &context.allowed_handles) {
                    Ok(validated) => {
                        report.stripped_refs += validated.report.stripped_refs;
                        report.dropped_paragraphs += validated.report.dropped_paragraphs;
                        report.temporal_corrected += validated.report.temporal_corrected;
                        report.state = "ok";
                        report.reason = None;
                        result = Some(validated);
                        break;
                    }
                    Err(problem) => {
                        report.state = "invalidOutput";
                        report.reason = Some("llmInvalidOutput");
                        repair_note = Some(problem.0);
                    }
                },
            }
        }
        timings.synthesis_ms = ms(synthesis_started);

        let Some(validated) = result else {
            return Ok(finish(
                AskOutcome::RetrievalOnly,
                None,
                &none,
                &context.allowed_handles,
                Some(context.report),
                report,
                timings,
                package,
                0,
            ));
        };
        let cited: std::collections::HashSet<String> = validated
            .paragraphs
            .iter()
            .flat_map(|p| p.based_on.iter().cloned())
            .collect();
        let (outcome, answer) = match validated.outcome {
            ModelOutcome::Answered => (
                AskOutcome::Answered,
                Some(AnswerBody {
                    paragraphs: validated.paragraphs,
                    gaps: validated.gaps,
                }),
            ),
            ModelOutcome::InsufficientEvidence => (
                AskOutcome::InsufficientEvidence,
                Some(AnswerBody {
                    paragraphs: validated.paragraphs,
                    gaps: validated.gaps,
                }),
            ),
        };
        Ok(finish(
            outcome,
            answer,
            &cited,
            &context.allowed_handles,
            Some(context.report),
            report,
            timings,
            package,
            0,
        ))
    }
}
