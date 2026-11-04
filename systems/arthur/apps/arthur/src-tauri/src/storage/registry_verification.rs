//! E2 architecture plan (implemented below after adversarial characterization):
//! 1. Truth: original pinned genesis + signed updates; member/origin rows are projections.
//! 2. Ownership: one CaptureStore transaction; OS alone holds private identity keys.
//! 3. Direction: storage verification consumes pure signed security types, never UI.
//! 4. Contract: bounded verified registry values, public identity and typed refusals.
//! 5. Failure: malformed/missing history, projection or OS key refuses authorization.
//! 6. Lifecycle: immutable pin/tombstones; creating/invalidated anchors never regenerate.
//! 7. Seams: disposable native owners, real CNG keys, SQL corruption and barriers.
//! 8. Compatibility: separate test-only E2 SQL; accepted E/v10 and production v9 frozen.
//! 9. Observation: categorical errors only, no bodies, codes, keys or transcripts logged.
//! 10. Security: identity is not channel proof; ClosedTrust and every live gate stay closed.
use super::enrollment_store::unverified_root;
use crate::sync_api::security::{
    canonical, enrollment::*, identity::*, Result, SecurityError as E,
};
use rusqlite::Connection;
use std::collections::{BTreeMap, BTreeSet};

#[derive(PartialEq, Eq)]
pub(super) struct Member {
    pub key: PublicIdentity,
    pub role: Role,
    pub enrollment: Option<String>,
    pub enabled: bool,
    pub expires: i64,
    pub capabilities: u8,
}
pub(super) struct Registry {
    pub root: Root,
    pub local_key: PublicIdentity,
    pub members: BTreeMap<String, Member>,
    pub origins: BTreeMap<String, String>,
}
fn storage(_: rusqlite::Error) -> E {
    E::Storage
}
pub(super) fn pin_bytes(genesis: &[u8]) -> Result<Vec<u8>> {
    canonical(&("locally-confirmed-network-e2", genesis))
}

// This function never repairs a projection: a mismatch is a trust failure.
// At most 4096 signed updates, 8 members and 448 distinct origin mappings.
pub(super) fn verified(c: &Connection) -> Result<Registry> {
    let root = unverified_root(c)?;
    if !(1..=4096).contains(&root.epoch) {
        return Err(E::Trust);
    }
    let (pinned, local_key, signature): (Vec<u8>, Vec<u8>, Vec<u8>) = c
        .query_row(
            "SELECT genesis,local_key,signature FROM e2_network_pin WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| E::Trust)?;
    let local_key = PublicIdentity::from_sec1(local_key)?;
    verify(
        &local_key,
        Domain::Registry,
        &pin_bytes(&pinned)?,
        &signature,
    )?;
    let genesis = SignedUpdate::decode(&pinned)?;
    let Action::Genesis { admin } = &genesis.body.action else {
        return Err(E::Trust);
    };
    if admin != &root.admin || genesis.body.network != root.network {
        return Err(E::Trust);
    }
    genesis.verify(admin)?;
    let mut view = Registry {
        root,
        local_key,
        members: BTreeMap::new(),
        origins: BTreeMap::new(),
    };
    let mut previous = [0; 32];
    let mut count = 0i64;
    let mut enrollments = BTreeSet::new();
    let mut statement = c
        .prepare("SELECT epoch,bytes FROM e_updates ORDER BY epoch LIMIT 4097")
        .map_err(storage)?;
    let rows = statement
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))
        .map_err(storage)?;
    for row in rows {
        let (epoch, bytes) = row.map_err(storage)?;
        count += 1;
        if count > 4096 {
            return Err(E::Limit);
        }
        let update = SignedUpdate::decode(&bytes)?;
        if epoch != count
            || update.body.epoch != count
            || update.body.previous != previous
            || update.body.network != view.root.network
        {
            return Err(E::Fork);
        }
        if count == 1 && bytes != pinned {
            return Err(E::Trust);
        }
        update.verify(&view.root.admin)?;
        match &update.body.action {
            Action::Genesis { admin } => {
                if count != 1 || admin != &view.root.admin {
                    return Err(E::Trust);
                }
                view.members.insert(
                    admin.peer_id().to_string(),
                    Member {
                        key: admin.clone(),
                        role: Role::Admin,
                        enrollment: None,
                        enabled: true,
                        expires: i64::MAX,
                        capabilities: 3,
                    },
                );
            }
            Action::Grant {
                device,
                role,
                capabilities,
                enrollment,
                expires,
                origins,
            } => {
                let id = device.peer_id().to_string();
                if view.members.len() >= 8
                    || view.members.contains_key(&id)
                    || !enrollments.insert(*enrollment)
                {
                    return Err(E::Trust);
                }
                view.members.insert(
                    id.clone(),
                    Member {
                        key: device.clone(),
                        role: *role,
                        enrollment: Some(enrollment.to_string()),
                        enabled: true,
                        expires: *expires as i64,
                        capabilities: *capabilities,
                    },
                );
                for origin in origins {
                    if view
                        .origins
                        .insert(origin.to_string(), id.clone())
                        .is_some()
                    {
                        return Err(E::Trust);
                    }
                }
            }
            Action::Revoke { device } => {
                let member = view
                    .members
                    .get_mut(&device.peer_id().to_string())
                    .ok_or(E::Trust)?;
                if member.role == Role::Admin || member.key != *device || !member.enabled {
                    return Err(E::Trust);
                }
                member.enabled = false;
            }
        }
        previous = update.body.hash()?;
    }
    if count != view.root.epoch || previous != view.root.digest {
        return Err(E::Fork);
    }
    let mut statement = c
        .prepare("SELECT device,key,enrollment,enabled,expires,capabilities FROM e_members LIMIT 9")
        .map_err(storage)?;
    let rows = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Vec<u8>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
            ))
        })
        .map_err(storage)?;
    let mut count = 0;
    for row in rows {
        let (id, key, enrollment, enabled, expires, capabilities) = row.map_err(storage)?;
        count += 1;
        let member = view.members.get(&id).ok_or(E::Trust)?;
        if key != member.key.sec1()
            || enrollment != member.enrollment
            || enabled != i64::from(member.enabled)
            || expires != member.expires
            || capabilities != i64::from(member.capabilities)
        {
            return Err(E::Trust);
        }
    }
    if count != view.members.len() {
        return Err(E::Trust);
    }
    let mut statement = c
        .prepare("SELECT origin,device FROM e_origins LIMIT 449")
        .map_err(storage)?;
    let rows = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(storage)?;
    let mut count = 0;
    for row in rows {
        let (origin, device) = row.map_err(storage)?;
        count += 1;
        if view.origins.get(&origin) != Some(&device) {
            return Err(E::Trust);
        }
    }
    if count != view.origins.len() {
        return Err(E::Trust);
    }
    Ok(view)
}
