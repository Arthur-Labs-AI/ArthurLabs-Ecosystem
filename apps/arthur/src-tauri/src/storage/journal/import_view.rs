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
