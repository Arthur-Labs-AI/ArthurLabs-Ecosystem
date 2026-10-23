//! Read-only adapter over existing journal projections; no observer bypass.
use super::{
    codec::{EntityKind, RowImage},
    sql_effects, stream,
};
use crate::sync::{Error, Result};
use rusqlite::Connection;
pub(in crate::storage) fn ready(c: &Connection) -> Result<()> {
    stream::policy(c).map_err(|_| Error::Storage)
}
pub(in crate::storage) fn row(
    c: &Connection,
    entity: EntityKind,
    key: &[String],
) -> Result<Option<RowImage>> {
    sql_effects::reread(c, entity, key).map_err(|_| Error::Storage)
}
pub(in crate::storage) fn facet(
    c: &Connection,
    entity: EntityKind,
    key: &[String],
    facet: &str,
    row: &RowImage,
) -> Result<(String, Option<String>)> {
    let hash = stream::facet_hash(entity, key, facet, row).map_err(|_| Error::Storage)?;
    let head = stream::stored_head(c, &(entity, key.to_vec(), facet.to_owned()))
        .map_err(|_| Error::Storage)?
        .map(|(id, _)| id);
    Ok((super::codec::hash_hex(&hash), head))
}

pub(in crate::storage) fn catalog(
    c: &Connection,
    limit: usize,
) -> Result<Vec<(EntityKind, Vec<String>, RowImage)>> {
    let mut result = Vec::new();
    for entity in sql_effects::ENTITIES {
        let fields = entity.key_fields();
        let query = format!(
            "SELECT {} FROM {} ORDER BY {} LIMIT ?1",
            fields.join(","),
            entity.as_str(),
            fields.join(",")
        );
        let mut q = c.prepare(&query).map_err(|_| Error::Storage)?;
        let mut rows = q.query([limit as i64 + 1]).map_err(|_| Error::Storage)?;
        while let Some(r) = rows.next().map_err(|_| Error::Storage)? {
            if result.len() >= limit {
                return Err(Error::SnapshotTooLarge);
            }
            let mut key = Vec::new();
            for i in 0..fields.len() {
                key.push(if entity.key_element_is_decimal(i) {
                    r.get::<_, i64>(i).map_err(|_| Error::Storage)?.to_string()
                } else {
                    r.get(i).map_err(|_| Error::Storage)?
                });
            }
            let row = row(c, entity, &key)?.ok_or(Error::Storage)?;
            result.push((entity, key, row));
        }
    }
    Ok(result)
}
