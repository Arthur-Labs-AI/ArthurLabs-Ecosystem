//! Dormant typed adapters over the same native domain implementations as v9.
//! No adapter locks a store, begins a transaction, finalizes, or publishes success.
//! A failed step remains fatal even when a composition closure catches its error.
use super::storage::{self, JournalError, JournalKernel, JournalTx};
use crate::storage::capture_store::{self, Capture, CreateCaptureInput, StoreError};
use crate::storage::lineage_store::ReviseConflict;
use crate::storage::project_store::ProjectError;
use crate::storage::{
    integration_store as graph, knowledge_store as knowledge, lineage_store as lineage,
    project_store as projects, relation_store as relations,
};
use std::sync::Arc;

pub(super) type Result<T> = std::result::Result<T, WriterError>;

/// Retain the original typed errors for eventual owner-level public mapping.
/// Debug/Display expose categories only, never SQL details or private row text.
#[derive(Clone)]
pub(super) enum WriterError {
    Store(Arc<StoreError>),
    Project(ProjectError),
    Conflict(Arc<ReviseConflict>),
    Journal(JournalError),
}
impl From<StoreError> for WriterError {
    fn from(e: StoreError) -> Self {
        Self::Store(Arc::new(e))
    }
}
impl From<ProjectError> for WriterError {
    fn from(e: ProjectError) -> Self {
        Self::Project(e)
    }
}
impl From<ReviseConflict> for WriterError {
    fn from(e: ReviseConflict) -> Self {
        Self::Conflict(Arc::new(e))
    }
}
impl std::fmt::Debug for WriterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(e) => f.write_str(match e.as_ref() {
                StoreError::Invalid(_) => "Invalid",
                StoreError::NotFound(_) => "NotFound",
                StoreError::MissingRevision(_) => "MissingRevision",
                StoreError::Corrupt(_) => "Corrupt",
                StoreError::Database(_) => "Database",
                StoreError::Poisoned => "Unavailable",
            }),
            Self::Project(e) => f.write_str(e.code()),
            Self::Conflict(e) => f.write_str(match e.as_ref() {
                ReviseConflict::ObjectNotFound => "ObjectNotFound",
                ReviseConflict::ProjectMismatch { .. } => "ProjectMismatch",
                ReviseConflict::ProjectArchived => "ProjectArchived",
                ReviseConflict::Stale { .. } => "Stale",
                ReviseConflict::Rejected(_) => "Rejected",
                ReviseConflict::Store(_) => "Storage",
            }),
            Self::Journal(e) => std::fmt::Debug::fmt(e, f),
        }
    }
}
impl std::fmt::Display for WriterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "writer {self:?}")
    }
}
impl std::error::Error for WriterError {}

pub(super) struct Writers<'a, 'tx> {
    tx: &'a mut JournalTx<'tx>,
    failure: Option<WriterError>,
}
impl JournalKernel<'_> {
    pub(super) fn write<T>(
        &self,
        work: impl FnOnce(&mut Writers<'_, '_>) -> Result<T>,
    ) -> Result<T> {
        let mut failure = None;
        let result = self.run(|tx| execute(tx, work, &mut failure));
        finish(result, failure)
    }
    #[cfg(test)]
    pub(super) fn write_fault<T>(
        &self,
        fault: super::storage::Fault,
        work: impl FnOnce(&mut Writers<'_, '_>) -> Result<T>,
    ) -> Result<T> {
        let mut failure = None;
        let result = self.run_fault(fault, |tx| execute(tx, work, &mut failure));
        finish(result, failure)
    }
}
fn execute<T>(
    tx: &mut JournalTx<'_>,
    work: impl FnOnce(&mut Writers<'_, '_>) -> Result<T>,
    failure: &mut Option<WriterError>,
) -> storage::Result<T> {
    let mut writers = Writers { tx, failure: None };
    let result = work(&mut writers);
    match (writers.failure, result) {
        (Some(e), _) | (None, Err(e)) => {
            *failure = Some(e);
            Err(JournalError::Domain)
        }
        (None, Ok(value)) => Ok(value),
    }
}
fn finish<T>(result: storage::Result<T>, failure: Option<WriterError>) -> Result<T> {
    match result {
        Err(JournalError::Domain) => {
            Err(failure.unwrap_or(WriterError::Journal(JournalError::Domain)))
        }
        Err(e) => Err(WriterError::Journal(e)),
        Ok(value) => Ok(value),
    }
}
impl Writers<'_, '_> {
    #[cfg(test)]
    pub(super) fn observed_effect_count(&self) -> i64 {
        self.tx
            .sql()
            .query_row("SELECT effect_count FROM sync_write_context", [], |r| {
                r.get(0)
            })
            .unwrap()
    }
    fn step<T, E: Into<WriterError>>(
        &mut self,
        work: impl FnOnce(&rusqlite::Connection) -> std::result::Result<T, E>,
    ) -> Result<T> {
        if let Some(e) = &self.failure {
            return Err(e.clone());
        }
        match self.tx.with_domain(work) {
            Ok(value) => Ok(value),
            Err(e) => {
                let e = e.into();
                self.failure = Some(e.clone());
                Err(e)
            }
        }
    }
    pub(super) fn create_capture(&mut self, input: CreateCaptureInput) -> Result<Capture> {
        self.step(|c| capture_store::insert_capture_in(c, capture_store::prepare_capture(input)?))
    }
    pub(super) fn create_project(&mut self, name: &str) -> Result<projects::Project> {
        self.step(|c| projects::create_project_in(c, name))
    }
    pub(super) fn rename_project(&mut self, id: &str, name: &str) -> Result<projects::Project> {
        self.step(|c| projects::rename_project_in(c, id, name))
    }
    pub(super) fn archive_project(&mut self, id: &str) -> Result<projects::Project> {
        self.step(|c| projects::archive_project_in(c, id))
    }
    pub(super) fn restore_project(&mut self, id: &str) -> Result<projects::Project> {
        self.step(|c| projects::restore_project_in(c, id))
    }
    pub(super) fn move_capture(&mut self, id: &str, project: &str) -> Result<Capture> {
        self.step(|c| projects::move_capture_in(c, id, project))
    }
    pub(super) fn move_knowledge_object(
        &mut self,
        id: &str,
        project: &str,
    ) -> Result<knowledge::KnowledgeObject> {
        self.step(|c| projects::move_knowledge_object_in(c, id, project))
    }
    pub(super) fn set_active_project(&mut self, id: &str) -> Result<String> {
        self.step(|c| projects::set_active_project_in(c, id))
    }
    pub(super) fn record_distillation(
        &mut self,
        id: &str,
        objects: Vec<knowledge::NewKnowledgeObject>,
    ) -> Result<Vec<knowledge::KnowledgeObject>> {
        self.step(|c| knowledge::record_distillation_in(c, id, objects).map(|(rows, _)| rows))
    }
    pub(super) fn update_object(
        &mut self,
        id: &str,
        changes: lineage::Changes,
    ) -> Result<lineage::Revision> {
        self.step(|c| lineage::update_object_in(c, id, changes))
    }
    pub(super) fn create_revision_from(
        &mut self,
        id: &str,
        parent: &str,
        changes: lineage::Changes,
        current: bool,
    ) -> Result<lineage::Revision> {
        self.step(|c| lineage::create_revision_from_in(c, id, parent, changes, current))
    }
    pub(super) fn merge_revisions(
        &mut self,
        id: &str,
        parents: &[String],
        content: lineage::RevisionContent,
        current: bool,
    ) -> Result<lineage::Revision> {
        self.step(|c| lineage::merge_revisions_in(c, id, parents, content, current))
    }
    pub(super) fn revise_from_capture(
        &mut self,
        id: &str,
        parent: Option<&str>,
        span: lineage::SourceSpan,
        changes: lineage::Changes,
        current: bool,
    ) -> Result<lineage::Revision> {
        self.step(|c| lineage::revise_from_capture_in(c, id, parent, span, changes, current))
    }
    pub(super) fn revise_if_current(
        &mut self,
        expected: &lineage::ExpectedRevision<'_>,
        content: lineage::RevisionContent,
        origin: lineage::CasOrigin,
    ) -> Result<lineage::Revision> {
        self.step(|c| lineage::revise_if_current_in(c, expected, content, origin))
    }
    pub(super) fn restore_revision(
        &mut self,
        id: &str,
        target: &str,
        expected: &str,
    ) -> Result<lineage::Revision> {
        self.step(|c| lineage::restore_revision_in(c, id, target, expected))
    }
    pub(super) fn create_relation(
        &mut self,
        edge: relations::NewRelation,
        origin: &str,
    ) -> Result<relations::Relation> {
        self.step(|c| relations::create_relation_in(c, edge, origin))
    }
    pub(super) fn record_relations(
        &mut self,
        edges: Vec<relations::NewRelation>,
        origin: &str,
    ) -> Result<Vec<relations::Relation>> {
        self.step(|c| relations::record_relations_in(c, edges, origin))
    }
    pub(super) fn apply_integration(
        &mut self,
        write: graph::IntegrationWrite,
    ) -> Result<graph::IntegrationWritten> {
        self.step(|c| graph::apply_integration_in(c, write))
    }
}
