//! Closed SQL-image boundary. JSON integers here are SQLite integers, not wire decimals.
use super::codec::{self, EntityKind, FieldValue, RowImage};
use super::reducer::{MapResolver, ObservedEffect};
use super::storage::{JournalError as E, Result};
use rusqlite::{params_from_iter, Connection, OptionalExtension};
use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

pub(super) const SPOOL_LIMIT: u64 = 8 * 1024 * 1024;
pub(super) const ENTITIES: [EntityKind; 12] = [
    EntityKind::Projects,
    EntityKind::Captures,
    EntityKind::DistillationRuns,
    EntityKind::KnowledgeObjects,
    EntityKind::ObjectSources,
    EntityKind::ThoughtRevisions,
    EntityKind::RevisionParents,
    EntityKind::Relations,
    EntityKind::IdentityDecisions,
    EntityKind::RevisionEvidence,
    EntityKind::PendingClaims,
    EntityKind::RevisionProposals,
];
pub(super) type Key = (EntityKind, Vec<String>);

struct UniqueObject(BTreeMap<String, Value>);
impl<'de> Deserialize<'de> for UniqueObject {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct ObjectVisitor;
        impl<'de> Visitor<'de> for ObjectVisitor {
            type Value = UniqueObject;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("unique row fields")
            }
            fn visit_map<M: MapAccess<'de>>(
                self,
                mut m: M,
            ) -> std::result::Result<Self::Value, M::Error> {
                let mut fields = BTreeMap::new();
                while let Some((k, v)) = m.next_entry::<String, Value>()? {
                    if fields.insert(k, v).is_some() {
                        return Err(serde::de::Error::custom("duplicate field"));
                    }
                }
                Ok(UniqueObject(fields))
            }
        }
        d.deserialize_map(ObjectVisitor)
    }
}

pub(super) fn image(entity: EntityKind, raw: &str) -> Result<RowImage> {
    if raw.len() as u64 > SPOOL_LIMIT {
        return Err(E::SpoolLimit);
    }
    let UniqueObject(fields) = serde_json::from_str(raw).map_err(|_| E::InvalidEffect)?;
    if fields.len() != entity.all_fields().len() {
        return Err(E::InvalidEffect);
    }
    let mut result = RowImage::new();
    for (name, value) in fields {
        if !entity.all_fields().contains(&name.as_str()) {
            return Err(E::InvalidEffect);
        }
        let value = if value.is_null() {
            FieldValue::Null
        } else if entity.int_fields().contains(&name.as_str()) {
            let n = value.as_i64().filter(|n| *n >= 0).ok_or(E::InvalidEffect)?;
            FieldValue::Decimal(n.to_string())
        } else {
            FieldValue::Text(value.as_str().ok_or(E::InvalidEffect)?.to_owned())
        };
        result.insert(name, value);
    }
    codec::validate_row_image(entity, &result).map_err(|_| E::InvalidEffect)?;
    Ok(result)
}

pub(super) fn key(entity: EntityKind, raw: &str) -> Result<Vec<String>> {
    if raw.len() as u64 > SPOOL_LIMIT {
        return Err(E::SpoolLimit);
    }
    let key: Vec<String> = serde_json::from_str(raw).map_err(|_| E::InvalidEffect)?;
    codec::validate_key(entity, &key).map_err(|_| E::InvalidEffect)?;
    for (i, v) in key.iter().enumerate() {
        if entity.key_element_is_decimal(i) && v.parse::<i64>().is_err() {
            return Err(E::InvalidEffect);
        }
    }
    Ok(key)
}

pub(super) fn key_json(key: &[String]) -> Result<String> {
    String::from_utf8(serde_jcs::to_vec(key).map_err(|_| E::Codec)?).map_err(|_| E::Codec)
}

pub(super) fn image_key(entity: EntityKind, row: &RowImage) -> Result<Vec<String>> {
    entity
        .key_fields()
        .iter()
        .map(|f| text(row, f).map(str::to_owned))
        .collect()
}

pub(super) fn text<'a>(row: &'a RowImage, f: &str) -> Result<&'a str> {
    match row.get(f) {
        Some(FieldValue::Text(s) | FieldValue::Decimal(s)) => Ok(s),
        _ => Err(E::IncompleteClosure),
    }
}

fn projection(entity: EntityKind) -> String {
    format!(
        "json_object({})",
        entity
            .all_fields()
            .iter()
            .map(|c| format!("'{c}',{c}"))
            .collect::<Vec<_>>()
            .join(",")
    )
}

pub(super) fn reread(
    c: &Connection,
    entity: EntityKind,
    key: &[String],
) -> Result<Option<RowImage>> {
    codec::validate_key(entity, key).map_err(|_| E::InvalidEffect)?;
    let expr = projection(entity);
    let predicate = entity
        .key_fields()
        .iter()
        .enumerate()
        .map(|(i, k)| format!("{k}=?{}", i + 1))
        .collect::<Vec<_>>()
        .join(" AND ");
    // Avoid copying an oversized JSON result into the Rust collector.
    let sql = format!("SELECT CASE WHEN length(CAST({expr} AS BLOB))<={SPOOL_LIMIT} THEN {expr} END FROM {} WHERE {predicate}",entity.as_str());
    let raw: Option<Option<String>> = c
        .query_row(&sql, params_from_iter(key), |r| r.get(0))
        .optional()
        .map_err(|_| E::FinalRead)?;
    match raw {
        None => Ok(None),
        Some(None) => Err(E::SpoolLimit),
        Some(Some(s)) => image(entity, &s).map(Some),
    }
}

pub(super) fn final_map(c: &Connection, effects: &[ObservedEffect]) -> Result<MapResolver> {
    let mut result = MapResolver::new();
    let mut seen = BTreeSet::new();
    let mut bytes = 0u64;
    for e in effects {
        if seen.insert((e.entity, e.key.clone())) {
            if let Some(row) = reread(c, e.entity, &e.key)? {
                bytes = bytes
                    .checked_add(
                        row.values()
                            .map(|v| match v {
                                FieldValue::Text(s) | FieldValue::Decimal(s) => s.len() as u64,
                                FieldValue::Null => 0,
                            })
                            .sum::<u64>(),
                    )
                    .ok_or(E::SpoolLimit)?;
                if bytes > SPOOL_LIMIT {
                    return Err(E::SpoolLimit);
                }
                result.insert(e.entity, e.key.clone(), row);
            }
        }
    }
    Ok(result)
}

pub(super) fn effects(c: &Connection, event: &str) -> Result<Vec<ObservedEffect>> {
    let (count,bytes,keys): (i64,i64,i64) = c.query_row(
        "SELECT count(*),coalesce(sum(coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)),0),coalesce(sum(length(CAST(entity_key AS BLOB))+length(CAST(entity_kind AS BLOB))),0) FROM sync_effects WHERE event_id=?1",
        [event],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_|E::InvalidEffect)?;
    if count < 0 || count > codec::MAX_EFFECTS as i64 {
        return Err(E::EffectLimit);
    }
    if bytes < 0 || keys < 0 || bytes as u64 > SPOOL_LIMIT || keys as u64 > SPOOL_LIMIT {
        return Err(E::SpoolLimit);
    }
    let counters:(i64,i64)=c.query_row("SELECT effect_count,staged_bytes FROM sync_write_context WHERE singleton=1 AND event_id=?1",[event],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|E::InvalidEffect)?;
    if counters != (count, bytes) {
        return Err(E::InvalidEffect);
    }
    let mut q=c.prepare("SELECT entity_kind,entity_key,before_json,after_json FROM sync_effects WHERE event_id=?1 ORDER BY event_id,effect_no").map_err(|_|E::Sql)?;
    let mut rows = q.query([event]).map_err(|_| E::Sql)?;
    let mut result = Vec::with_capacity(count as usize);
    while let Some(r) = rows.next().map_err(|_| E::Sql)? {
        let name: String = r.get(0).map_err(|_| E::InvalidEffect)?;
        let entity = EntityKind::from_str(&name).map_err(|_| E::InvalidEffect)?;
        let k: String = r.get(1).map_err(|_| E::InvalidEffect)?;
        let k = key(entity, &k)?;
        let before: Option<String> = r.get(2).map_err(|_| E::InvalidEffect)?;
        let after: Option<String> = r.get(3).map_err(|_| E::InvalidEffect)?;
        if before.is_none() && after.is_none() {
            return Err(E::InvalidEffect);
        }
        let before = before.as_deref().map(|s| image(entity, s)).transpose()?;
        let after = after.as_deref().map(|s| image(entity, s)).transpose()?;
        for row in [&before, &after].into_iter().flatten() {
            if image_key(entity, row)? != k {
                return Err(E::InvalidEffect);
            }
        }
        result.push(ObservedEffect {
            entity,
            key: k,
            before,
            after,
        });
    }
    Ok(result)
}
