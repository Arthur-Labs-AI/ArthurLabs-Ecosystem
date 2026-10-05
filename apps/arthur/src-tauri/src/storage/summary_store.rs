//! Per-object summary counts in one query, so a list of ideas does not need one read per idea.
//!
//! This is deliberately small: the number of connections, the number of revisions, when the object last changed and
//! which revision is current. It is not an analytics layer and it caches nothing: every call reads the tables.

use rusqlite::params_from_iter;
use serde::Serialize;

use super::capture_store::{CaptureStore, StoreError};

/// The most ids one call may ask about. Asking for none means every object.
pub const MAX_SUMMARY_IDS: usize = 1_000;

/// Mirrors `KnowledgeSummary` in `packages/contracts/cognitive.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSummary {
    pub object_id: String,
    /// Relations the object is an end of. A symmetric relation is stored once and counts once for each of its objects.
    pub relation_count: i64,
    pub revision_count: i64,
    /// When the current revision was created: the last time the object changed.
    pub updated_at: String,
    pub current_revision_id: String,
}

impl CaptureStore {
    pub fn knowledge_summaries(&self, object_ids: Option<&[String]>) -> Result<Vec<KnowledgeSummary>, StoreError> {
        if let Some(ids) = object_ids {
            if ids.len() > MAX_SUMMARY_IDS {
                return Err(StoreError::Invalid(format!("more than {MAX_SUMMARY_IDS} ids")));
            }
            if ids.is_empty() {
                return Ok(Vec::new());
            }
        }
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let filter = match object_ids {
            Some(ids) => format!("WHERE o.id IN ({})", vec!["?"; ids.len()].join(",")),
            None => String::new(),
        };
        let sql = format!(
            "SELECT o.id, \
                    (SELECT count(*) FROM relations r WHERE r.source_object_id = o.id OR r.target_object_id = o.id), \
                    (SELECT count(*) FROM thought_revisions t WHERE t.object_id = o.id), \
                    cur.created_at, cur.id \
             FROM knowledge_objects o \
             JOIN thought_revisions cur ON cur.id = o.current_revision_id AND cur.object_id = o.id \
             {filter} ORDER BY o.seq"
        );
        let mut statement = connection.prepare(&sql)?;
        let params = object_ids.unwrap_or(&[]).iter();
        let rows = statement.query_map(params_from_iter(params), |row| {
            Ok(KnowledgeSummary {
                object_id: row.get(0)?,
                relation_count: row.get(1)?,
                revision_count: row.get(2)?,
                updated_at: row.get(3)?,
                current_revision_id: row.get(4)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::capture_store::CreateCaptureInput;
    use crate::storage::knowledge_store::NewKnowledgeObject;
    use crate::storage::lineage_store::Changes;
    use crate::storage::relation_store::NewRelation;

    fn relate(store: &CaptureStore, kind: &str, a: &str, b: &str) {
        store.create_relation(NewRelation { kind: kind.into(), source_object_id: a.into(), target_object_id: b.into() }, "user").unwrap();
    }
    fn edit(store: &CaptureStore, id: &str) {
        store.update_object(id, Changes { kind: None, title: Some(format!("edit {}", uuid::Uuid::new_v4())), body: None }).unwrap();
    }

    /// `objects` objects, spread over captures of at most twelve (the most one distillation may produce).
    fn seeded(objects: usize) -> (CaptureStore, Vec<String>) {
        let store = CaptureStore::open_in_memory().unwrap();
        let mut ids = Vec::new();
        for batch in (0..objects).collect::<Vec<_>>().chunks(12) {
            let text: String = batch.iter().map(|i| format!("word{i:03} ")).collect();
            let capture = store.create(CreateCaptureInput { source: "text".into(), content: text }).unwrap();
            let new: Vec<NewKnowledgeObject> = batch
                .iter()
                .enumerate()
                .map(|(at, i)| NewKnowledgeObject { kind: "idea".into(), title: format!("T{i}"), body: "B".into(), source_start: (at * 8) as i64, source_end: (at * 8 + 7) as i64 })
                .collect();
            ids.extend(store.record_distillation(&capture.id, new).unwrap().into_iter().map(|o| o.id));
        }
        (store, ids)
    }

    #[test]
    fn a_new_object_has_no_relations_and_exactly_one_revision() {
        let (store, ids) = seeded(2);
        let all = store.knowledge_summaries(None).unwrap();
        assert_eq!(all.len(), 2);
        for summary in &all {
            assert_eq!((summary.relation_count, summary.revision_count), (0, 1));
            assert!(!summary.updated_at.is_empty());
            assert!(ids.contains(&summary.object_id));
        }
    }

    #[test]
    fn relations_count_for_both_ends_once_each_and_revisions_follow_edits() {
        let (store, ids) = seeded(3);
        relate(&store, "extends", &ids[0], &ids[1]);
        relate(&store, "related_to", &ids[0], &ids[2]);
        relate(&store, "depends_on", &ids[1], &ids[0]);
        edit(&store, &ids[0]);
        edit(&store, &ids[0]);

        let by_id = |id: &String| store.knowledge_summaries(Some(std::slice::from_ref(id))).unwrap().remove(0);
        assert_eq!((by_id(&ids[0]).relation_count, by_id(&ids[0]).revision_count), (3, 3), "a hub: three relations, two edits");
        assert_eq!((by_id(&ids[1]).relation_count, by_id(&ids[1]).revision_count), (2, 1));
        assert_eq!((by_id(&ids[2]).relation_count, by_id(&ids[2]).revision_count), (1, 1));
    }

    #[test]
    fn updated_at_and_current_revision_follow_the_current_revision() {
        let (store, ids) = seeded(1);
        let before = store.knowledge_summaries(None).unwrap().remove(0);
        edit(&store, &ids[0]);
        let after = store.knowledge_summaries(None).unwrap().remove(0);
        assert_ne!(before.current_revision_id, after.current_revision_id);
        assert!(after.updated_at >= before.updated_at);
    }

    #[test]
    fn asking_for_some_ids_returns_only_those_and_asking_for_none_returns_nothing() {
        let (store, ids) = seeded(4);
        let two = store.knowledge_summaries(Some(&ids[1..3])).unwrap();
        assert_eq!(two.iter().map(|s| s.object_id.clone()).collect::<Vec<_>>(), ids[1..3].to_vec());
        assert!(store.knowledge_summaries(Some(&[])).unwrap().is_empty());
        assert!(store.knowledge_summaries(Some(&["unknown".to_string()])).unwrap().is_empty());
    }

    #[test]
    fn the_request_is_bounded() {
        let (store, _) = seeded(1);
        let too_many: Vec<String> = (0..=MAX_SUMMARY_IDS).map(|i| i.to_string()).collect();
        assert!(matches!(store.knowledge_summaries(Some(&too_many)), Err(StoreError::Invalid(_))));
    }

    #[test]
    fn forty_nine_objects_are_summarised_by_one_statement() {
        let (store, ids) = seeded(49);
        for i in 0..48 {
            relate(&store, "related_to", &ids[i], &ids[i + 1]);
        }
        let all = store.knowledge_summaries(None).unwrap();
        assert_eq!(all.len(), 49);
        let total: i64 = all.iter().map(|s| s.relation_count).sum();
        assert_eq!(total, 96, "48 relations, each counted for both of its ends");
        assert_eq!((all[0].relation_count, all[1].relation_count, all[48].relation_count), (1, 2, 1));
    }
}
