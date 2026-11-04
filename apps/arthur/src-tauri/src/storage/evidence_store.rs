//! Evidence behind automatic revisions (M04.7B Phase 2, schema v8). STORAGE ONLY.
//!
//! Three things are kept apart and never conflated:
//!
//! * HISTORICAL evidence: every span that ever contributed to a revision in the current revision's ancestry. The evolution story.
//! * ACTIVE evidence: spans that legitimately support the CURRENT revision, derived conservatively (below).
//! * WITHDRAWN evidence: spans a later revision corrected or replaced, where that can be shown. Never support for current truth.
//!
//! A synthesized (`system`) revision carries NO span of its own; its evidence rows are the verbatim spans it was built from. What the
//! data can prove is "these spans contributed", not which sentence rests on which span, so no sentence-level or claim-level attribution
//! is ever reported. Where even "these spans contribute" cannot be shown (a user wrote or merged the text, or a revision has no evidence)
//! the answer is `Attribution::Unknown`, not a guess.
//!
//! Derivation (read time; revisions and evidence are immutable, so nothing is copied or cached):
//! 1. Walk back from the revision through `system` revisions (exactly one parent each) to the first revision that is not automatic.
//! 2. If that base is an `initial`/`distillation` revision, its own span is the starting active evidence; otherwise (a user edit or a
//!    merge) nothing is active and the attribution is unknown: the person's words are not claimed to rest on any capture.
//! 3. Replay the automatic revisions oldest first. `asserts` adds active evidence and keeps what was active. `corrects`/`replaces` with
//!    named targets withdraw exactly those spans. Without a named target ALL previously active evidence becomes merely historical
//!    (under-claiming support is the safe error). The revision's own spans become active.
//! 4. A revision with no evidence rows demotes everything to historical and makes the attribution unknown.

#![allow(dead_code)] // Phase 2 is storage only: nothing outside the tests calls these yet (Phase 3 wires the pipeline)

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use super::capture_store::{now_rfc3339, CaptureStore, StoreError};
use super::identity_store::IdentityStoreError;
use super::knowledge_store::validate_span;

type Res<T> = Result<T, IdentityStoreError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvidenceRole {
    /// Adds support (additive refinement); earlier support stays.
    Asserts,
    /// Corrects a value of the same proposition.
    Corrects,
    /// Replaces an explicit earlier choice.
    Replaces,
}

impl EvidenceRole {
    pub fn as_str(self) -> &'static str {
        match self {
            EvidenceRole::Asserts => "asserts",
            EvidenceRole::Corrects => "corrects",
            EvidenceRole::Replaces => "replaces",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewEvidence {
    pub capture_id: String,
    pub source_start: i64,
    pub source_end: i64,
    pub role: EvidenceRole,
    /// `(revision id, ordinal)` of the earlier evidence this withdraws. Only for `corrects`/`replaces`, and only where it can be shown.
    pub retracts: Option<(String, i64)>,
    /// A short model-written label of the proposition. Interpretation, never quoted as source text.
    pub interpretation_label: Option<String>,
}

/// One stored evidence row, or the origin span of an initial revision (`role == "origin"`, `ordinal == None`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceItem {
    pub revision_id: String,
    pub ordinal: Option<i64>,
    pub capture_id: String,
    pub source_start: i64,
    pub source_end: i64,
    /// `origin | asserts | corrects | replaces`
    pub role: String,
    pub retracts: Option<(String, i64)>,
    pub interpretation_label: Option<String>,
}

impl EvidenceItem {
    fn key(&self) -> (String, Option<i64>) {
        (self.revision_id.clone(), self.ordinal)
    }
}

pub type RevisionEvidence = EvidenceItem;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Attribution {
    /// The revision is an original capture interpretation: its own span is its source.
    OriginSpan,
    /// The text is synthesized from the active spans. Which sentence rests on which span is NOT known.
    /// `inherited_demoted`: some earlier evidence was set aside because a correction/replacement could not name what it withdrew.
    ContributingSpans { inherited_demoted: bool },
    /// What supports the current text cannot be established from the data.
    Unknown(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceSupport {
    pub revision_id: String,
    pub object_id: String,
    pub origin: String,
    /// The revision text was written by Arthur from several sources: it exists in no capture, and has no span of its own.
    pub synthesized: bool,
    pub active: Vec<EvidenceItem>,
    /// In the ancestry but not (or no longer) claimed as support.
    pub historical: Vec<EvidenceItem>,
    /// Explicitly corrected or replaced, with the evidence that withdrew it.
    pub withdrawn: Vec<(EvidenceItem, (String, i64))>,
    pub attribution: Attribution,
}

struct RevisionRow {
    id: String,
    object_id: String,
    origin: String,
    span: Option<(String, i64, i64)>,
}

fn revision_row(connection: &Connection, id: &str) -> Res<RevisionRow> {
    let row = connection
        .query_row("SELECT id, object_id, origin, capture_id, source_start, source_end FROM thought_revisions WHERE id = ?1", [id], |row| {
            let span = match (row.get::<_, Option<String>>(3)?, row.get::<_, Option<i64>>(4)?, row.get::<_, Option<i64>>(5)?) {
                (Some(capture), Some(start), Some(end)) => Some((capture, start, end)),
                _ => None,
            };
            Ok(RevisionRow { id: row.get(0)?, object_id: row.get(1)?, origin: row.get(2)?, span })
        })
        .optional()?;
    row.ok_or_else(|| {
        IdentityStoreError::Store(StoreError::MissingRevision(
            "revision does not exist".into(),
        ))
    })
}

fn parents(connection: &Connection, id: &str) -> Res<Vec<String>> {
    let mut statement = connection
        .prepare("SELECT parent_revision_id FROM revision_parents WHERE child_revision_id = ?1")?;
    let ids = statement
        .query_map([id], |row| row.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    Ok(ids)
}

fn rows_of(connection: &Connection, revision_id: &str) -> Res<Vec<EvidenceItem>> {
    let mut statement = connection.prepare(
        "SELECT revision_id, ordinal, capture_id, source_start, source_end, role, retracts_revision_id, retracts_ordinal, interpretation_label FROM revision_evidence WHERE revision_id = ?1 ORDER BY ordinal",
    )?;
    let rows = statement
        .query_map([revision_id], |row| {
            let retracts = match (
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<i64>>(7)?,
            ) {
                (Some(revision), Some(ordinal)) => Some((revision, ordinal)),
                _ => None,
            };
            Ok(EvidenceItem {
                revision_id: row.get(0)?,
                ordinal: Some(row.get(1)?),
                capture_id: row.get(2)?,
                source_start: row.get(3)?,
                source_end: row.get(4)?,
                role: row.get(5)?,
                retracts,
                interpretation_label: row.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn origin_item(row: &RevisionRow) -> Option<EvidenceItem> {
    row.span.as_ref().map(|(capture, start, end)| EvidenceItem {
        revision_id: row.id.clone(),
        ordinal: None,
        capture_id: capture.clone(),
        source_start: *start,
        source_end: *end,
        role: "origin".into(),
        retracts: None,
        interpretation_label: None,
    })
}

/// The evidence rows of one revision, in order. Direct rows only: nothing inherited.
pub fn revision_evidence_in(connection: &Connection, revision_id: &str) -> Res<Vec<EvidenceItem>> {
    revision_row(connection, revision_id)?;
    rows_of(connection, revision_id)
}

/// Attaches verbatim capture spans to an AUTOMATIC revision. Idempotent per span: re-attaching the identical evidence is a no-op, a
/// different role or target for the same span is a conflict. Every span is validated against the stored capture in code points, the
/// capture must belong to the object's project, and the schema re-checks reference, ancestry, span and immutability rules.
pub fn attach_revision_evidence_in(
    connection: &Connection,
    revision_id: &str,
    evidence: &[NewEvidence],
) -> Res<Vec<EvidenceItem>> {
    if evidence.is_empty() {
        return Err(IdentityStoreError::Invalid(
            "there is no evidence to attach".into(),
        ));
    }
    let revision = revision_row(connection, revision_id)?;
    if revision.origin != "system" {
        return Err(IdentityStoreError::Invalid(
            "evidence attaches only to an automatic revision".into(),
        ));
    }
    let object_project: String = connection.query_row(
        "SELECT project_id FROM knowledge_objects WHERE id = ?1",
        [&revision.object_id],
        |row| row.get(0),
    )?;
    let mut attached = Vec::with_capacity(evidence.len());
    for item in evidence {
        let capture: Option<(String, String)> = connection
            .query_row(
                "SELECT content, project_id FROM captures WHERE id = ?1",
                [&item.capture_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (content, capture_project) = capture.ok_or_else(|| {
            IdentityStoreError::Invalid("the evidence capture does not exist".into())
        })?;
        validate_span(&content, item.source_start, item.source_end)
            .map_err(IdentityStoreError::Invalid)?;
        if capture_project != object_project {
            return Err(IdentityStoreError::Conflict(
                "the evidence capture is not in the object's project".into(),
            ));
        }
        if item.retracts.is_some() && item.role == EvidenceRole::Asserts {
            return Err(IdentityStoreError::Invalid("`asserts` cannot withdraw evidence: only a correction or replacement may name what it withdraws".into()));
        }
        let existing = rows_of(connection, revision_id)?;
        if let Some(same_span) = existing.iter().find(|e| {
            e.capture_id == item.capture_id
                && e.source_start == item.source_start
                && e.source_end == item.source_end
        }) {
            if same_span.role == item.role.as_str()
                && same_span.retracts == item.retracts
                && same_span.interpretation_label == item.interpretation_label
            {
                attached.push(same_span.clone());
                continue;
            }
            return Err(IdentityStoreError::Conflict(
                "that span is already attached to this revision differently".into(),
            ));
        }
        let ordinal = existing
            .iter()
            .filter_map(|e| e.ordinal)
            .max()
            .map_or(0, |m| m + 1);
        connection.execute(
            "INSERT INTO revision_evidence (revision_id, ordinal, object_id, capture_id, source_start, source_end, role, retracts_revision_id, retracts_ordinal, interpretation_label, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                revision_id, ordinal, revision.object_id, item.capture_id, item.source_start, item.source_end, item.role.as_str(),
                item.retracts.as_ref().map(|r| r.0.as_str()), item.retracts.as_ref().map(|r| r.1), item.interpretation_label, now_rfc3339()?
            ],
        )?;
        attached.push(
            rows_of(connection, revision_id)?
                .into_iter()
                .find(|e| e.ordinal == Some(ordinal))
                .expect("just inserted"),
        );
    }
    Ok(attached)
}

/// Derives historical / active / withdrawn evidence for a revision. See the module docs for the exact, conservative rules.
pub fn evidence_support_in(connection: &Connection, revision_id: &str) -> Res<EvidenceSupport> {
    let revision = revision_row(connection, revision_id)?;

    // Every revision in the ancestry (including itself) and all the evidence it holds: the historical universe.
    let mut ancestry: Vec<String> = vec![revision.id.clone()];
    let mut cursor = 0;
    while cursor < ancestry.len() {
        for parent in parents(connection, &ancestry[cursor])? {
            if !ancestry.contains(&parent) {
                ancestry.push(parent);
            }
        }
        cursor += 1;
    }
    let mut universe: Vec<EvidenceItem> = Vec::new();
    for id in &ancestry {
        let row = revision_row(connection, id)?;
        universe.extend(origin_item(&row));
        universe.extend(rows_of(connection, id)?);
    }

    // The unbroken automatic chain, newest first, ending at the first non-automatic revision.
    let mut chain: Vec<RevisionRow> = Vec::new();
    let mut base = revision_row(connection, revision_id)?;
    while base.origin == "system" {
        let mut up = parents(connection, &base.id)?;
        if up.len() != 1 {
            return Err(IdentityStoreError::Store(StoreError::Corrupt(
                "an automatic revision must have exactly one parent".into(),
            )));
        }
        let next = revision_row(connection, &up.remove(0))?;
        chain.push(base);
        base = next;
    }
    chain.reverse();

    let mut active: Vec<EvidenceItem> = Vec::new();
    let mut withdrawn: Vec<(EvidenceItem, (String, i64))> = Vec::new();
    let mut attribution;
    if matches!(base.origin.as_str(), "initial" | "distillation") && base.span.is_some() {
        active.extend(origin_item(&base));
        attribution = Attribution::OriginSpan;
    } else {
        attribution = Attribution::Unknown(format!(
            "the base text is a `{}` revision, which claims no capture",
            base.origin
        ));
    }
    let mut inherited_demoted = false;
    for revision in &chain {
        let rows = rows_of(connection, &revision.id)?;
        if rows.is_empty() {
            active.clear();
            attribution =
                Attribution::Unknown("an automatic revision has no recorded evidence".into());
            continue;
        }
        let unnamed = rows
            .iter()
            .any(|r| r.role != "asserts" && r.retracts.is_none());
        if unnamed {
            inherited_demoted |= !active.is_empty();
            active.clear();
        }
        for row in rows.iter().filter(|r| r.retracts.is_some()) {
            let target = row.retracts.clone().expect("filtered");
            if let Some(position) = active
                .iter()
                .position(|a| a.key() == (target.0.clone(), Some(target.1)))
            {
                withdrawn.push((
                    active.remove(position),
                    (row.revision_id.clone(), row.ordinal.unwrap_or(0)),
                ));
            }
        }
        active.extend(rows);
        if matches!(attribution, Attribution::OriginSpan) {
            attribution = Attribution::ContributingSpans {
                inherited_demoted: false,
            };
        }
    }
    if let Attribution::ContributingSpans {
        inherited_demoted: flag,
    } = &mut attribution
    {
        *flag = inherited_demoted;
    }

    let withdrawn_keys: Vec<_> = withdrawn.iter().map(|(item, _)| item.key()).collect();
    let historical: Vec<EvidenceItem> = universe
        .into_iter()
        .filter(|item| {
            !active.iter().any(|a| a.key() == item.key()) && !withdrawn_keys.contains(&item.key())
        })
        .collect();
    Ok(EvidenceSupport {
        revision_id: revision.id.clone(),
        object_id: revision.object_id,
        origin: revision.origin.clone(),
        synthesized: revision.origin == "system",
        active,
        historical,
        withdrawn,
        attribution,
    })
}

impl CaptureStore {
    pub fn attach_revision_evidence(
        &self,
        revision_id: &str,
        evidence: &[NewEvidence],
    ) -> Res<Vec<EvidenceItem>> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| IdentityStoreError::Store(StoreError::Poisoned))?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let attached = attach_revision_evidence_in(&transaction, revision_id, evidence)?;
        transaction.commit()?;
        Ok(attached)
    }

    /// The direct evidence rows of one revision (nothing inherited).
    pub fn revision_evidence(&self, revision_id: &str) -> Res<Vec<EvidenceItem>> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| IdentityStoreError::Store(StoreError::Poisoned))?;
        revision_evidence_in(&connection, revision_id)
    }

    /// Historical, active and withdrawn evidence for a revision (default: ask for the current one). Conservative; see the module docs.
    pub fn evidence_support(&self, revision_id: &str) -> Res<EvidenceSupport> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| IdentityStoreError::Store(StoreError::Poisoned))?;
        evidence_support_in(&connection, revision_id)
    }
}
