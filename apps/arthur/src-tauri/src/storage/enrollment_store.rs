//! Nonsecret dormant registry, borrowing the ONE existing native store owner.
//! No Connection::open, filesystem path, provider work or network I/O here.
use super::capture_store::CaptureStore;
pub(crate) use crate::sync_api::security::enrollment::{MembershipBinding, Root};
use crate::sync_api::security::{
    canonical, enrollment::*, identity::*, Result, SecurityError as E,
};
use rusqlite::{params, Connection, TransactionBehavior};
use uuid::Uuid;
fn sql(_: rusqlite::Error) -> E {
    E::Storage
}
fn local_admin(c: &Connection, root: &Root) -> Result<()> {
    #[cfg(any(windows, target_os = "android"))]
    {
        let (_, key) = super::device_identity_store::bound_key(c, root.admin.peer_id())?;
        if key != root.admin {
            return Err(E::Trust);
        }
        Ok(())
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        let _ = (c, root);
        Err(E::PlatformUnverified)
    }
}
fn verify_grant(
    c: &Connection,
    root: &Root,
    id: Uuid,
    key: &PublicIdentity,
    bytes: &[u8],
) -> Result<()> {
    let grant = SignedUpdate::decode(bytes)?;
    grant.verify(&root.admin)?;
    if grant.body.network != root.network {
        return Err(E::Trust);
    }
    match &grant.body.action {
        Action::Grant {
            device,
            enrollment,
            role: Role::Member,
            ..
        } if device == key && *enrollment == id => (),
        _ => return Err(E::Trust),
    }
    let original: Vec<u8> = c
        .query_row(
            "SELECT bytes FROM e_updates WHERE epoch=?1",
            [grant.body.epoch],
            |r| r.get(0),
        )
        .map_err(|_| E::Trust)?;
    if original != bytes {
        return Err(E::Trust);
    }
    Ok(())
}
// Same-boot monotone observation, in the reservation/proof/approval transaction.
// Live issuance has no release producer; a future producer must use a monotonic
// boot clock, never SystemTime. Any observed regression durably expires the code.
fn observe(c: &Connection, id: Uuid, now: u64) -> Result<bool> {
    let (started, seen): (i64, i64) = c.query_row(
        "SELECT e.started,t.seen FROM e_enrollments e JOIN e2_enrollment_clock t ON t.enrollment=e.id WHERE e.id=?1",
        [id.to_string()], |r| Ok((r.get(0)?,r.get(1)?)),
    ).map_err(|_| E::State)?;
    if now < started as u64 || now < seen as u64 || now - started as u64 >= 120 {
        c.execute("UPDATE e_enrollments SET state='expired',ticket=NULL WHERE id=?1 AND state IN('issued','reserved','approval')",[id.to_string()]).map_err(sql)?;
        return Ok(false);
    }
    c.execute(
        "UPDATE e2_enrollment_clock SET seen=?2 WHERE enrollment=?1",
        params![id.to_string(), i64::try_from(now).map_err(|_| E::Invalid)?],
    )
    .map_err(sql)?;
    Ok(true)
}
/// Both outcomes confirm SQLite COMMIT. Never blindly retry the signed update.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApplyOutcome {
    Committed,
    CommittedTransportUnavailable,
}
pub(crate) struct NetworkRegistry<'a> {
    owner: &'a CaptureStore,
}
impl<'a> NetworkRegistry<'a> {
    pub fn candidate(owner: &'a CaptureStore) -> Result<Self> {
        let c = owner.connection.lock().map_err(|_| E::Storage)?;
        let exists: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='e_registry')",
                [],
                |r| r.get(0),
            )
            .map_err(sql)?;
        if !exists {
            return Err(E::ActivationPending);
        }
        Ok(Self { owner })
    }
    fn write<T>(&self, work: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let mut c = self.owner.connection.lock().map_err(|_| E::Storage)?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        match work(&tx) {
            Ok(out) => match tx.commit() {
                Ok(()) => Ok(out),
                Err(_) => {
                    let _ = c.pragma_update(None, "query_only", true);
                    Err(E::Storage)
                }
            },
            Err(e) => {
                if tx.rollback().is_err() {
                    let _ = c.pragma_update(None, "query_only", true);
                    return Err(E::Storage);
                }
                Err(e)
            }
        }
    }
    pub fn root(&self) -> Result<Root> {
        let c = self.owner.connection.lock().map_err(|_| E::Storage)?;
        verified_root(&c)
    }
    pub fn create_network(&self, admin: &dyn DeviceIdentityStore) -> Result<Root> {
        let p = admin.public_identity()?;
        let update = SignedUpdate::sign(
            Update {
                network: Uuid::new_v4(),
                epoch: 1,
                previous: [0; 32],
                action: Action::Genesis { admin: p.clone() },
            },
            admin,
        )?;
        let genesis = update.bytes()?;
        let pin_signature = admin.sign_domain_separated(
            Domain::Registry,
            &super::registry_verification::pin_bytes(&genesis)?,
        )?;
        self.write(|c| {
            c.execute(
                "INSERT INTO e2_network_pin VALUES(1,?1,?2,?3)",
                params![genesis, p.sec1(), pin_signature],
            )
            .map_err(sql)?;
            apply(c, &update)
        })?;
        self.root()
    }
    pub fn apply(&self, update: &SignedUpdate) -> Result<ApplyOutcome> {
        if matches!(update.body.action, Action::Genesis { .. }) {
            return Err(E::Trust);
        }
        self.write(|c| apply(c, update))?;
        if let Action::Revoke { device } = &update.body.action {
            if self
                .owner
                .revoked(crate::sync_api::revocation::Expected {
                    network: update.body.network,
                    peer: device.peer_id(),
                })
                .is_err()
            {
                // Pool revocation failure already shuts down the poisoned Pool.
                // Durable success is distinct from degraded runtime notification.
                return Ok(ApplyOutcome::CommittedTransportUnavailable);
            }
        }
        Ok(ApplyOutcome::Committed)
    }
    pub fn next(&self, action: Action, admin: &dyn DeviceIdentityStore) -> Result<SignedUpdate> {
        let root = self.root()?;
        if admin.public_identity()? != root.admin {
            return Err(E::Trust);
        }
        SignedUpdate::sign(
            Update {
                network: root.network,
                epoch: root.epoch.checked_add(1).ok_or(E::Limit)?,
                previous: root.digest,
                action,
            },
            admin,
        )
    }
    pub fn binding(
        &self,
        local: Uuid,
        peer: &PublicIdentity,
        now: u64,
    ) -> Result<MembershipBinding> {
        let root = self.root()?;
        let binding = MembershipBinding {
            root,
            local,
            peer: peer.clone(),
        };
        let c = self.owner.connection.lock().map_err(|_| E::Storage)?;
        authorize_binding(&c, &binding, now)?;
        Ok(binding)
    }
    pub fn original_author(&self, origin: Uuid) -> Result<PublicIdentity> {
        let c = self.owner.connection.lock().map_err(|_| E::Storage)?;
        let registry = super::registry_verification::verified(&c)?;
        let author = registry.origins.get(&origin.to_string()).ok_or(E::Trust)?;
        // Historical provenance survives revocation. This lookup grants no new
        // event authority; the signed-import seam separately checks that policy.
        Ok(registry.members.get(author).ok_or(E::Trust)?.key.clone())
    }
    // Startup is explicit and must precede any candidate traffic. Unresolved codes
    // cannot resume after restart; device-wide limits are deliberately NOT reset.
    pub fn startup(&self) -> Result<Uuid> {
        let boot = Uuid::new_v4();
        self.write(|c|{c.execute("UPDATE e_enrollments SET state='cancelled',ticket=NULL WHERE state IN('issued','reserved','approval')",[]).map_err(sql)?;c.execute("INSERT INTO e_abuse VALUES(1,?1,0,0) ON CONFLICT(singleton) DO UPDATE SET boot=excluded.boot",[boot.to_string()]).map_err(sql)?;Ok(boot)})
    }
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    pub fn issue_fixture(&self, boot: Uuid, now: u64) -> Result<Challenge> {
        let code = SecretCode::generate()?;
        let id = Uuid::new_v4();
        let n = i64::try_from(now).map_err(|_| E::Invalid)?;
        self.write(|c| {
            let (b,attempts,issued):(String,i64,i64)=c.query_row("SELECT boot,attempts,issued FROM e_abuse WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(sql)?;
            if b!=boot.to_string() {return Err(E::State);}
            if attempts>=5||issued>=8 {return Err(E::Locked);}
            c.execute("INSERT INTO e_enrollments(id,boot,started,state,attempts) VALUES(?1,?2,?3,'issued',0)",params![id.to_string(),b,n]).map_err(|_|E::State)?;
            c.execute("INSERT INTO e2_enrollment_clock VALUES(?1,?2)",params![id.to_string(),n]).map_err(sql)?;
            c.execute("UPDATE e_abuse SET issued=issued+1 WHERE singleton=1",[]).map_err(sql)?;
            Ok(())
        })?;
        Ok(Challenge {
            id,
            started: now,
            boot,
            code: Some(code),
        })
    }
    pub fn reserve(&self, ch: &mut Challenge, now: u64) -> Result<Attempt> {
        let ticket = Uuid::new_v4();
        let result=self.write(|c|{
        let (boot,attempts):(String,i64)=c.query_row("SELECT boot,attempts FROM e_abuse WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?))).map_err(sql)?;
        if boot!=ch.boot.to_string(){return Err(E::State);}
        let started:i64=c.query_row("SELECT started FROM e_enrollments WHERE id=?1 AND boot=?2",params![ch.id.to_string(),boot],|r|r.get(0)).map_err(|_|E::State)?;
        if started as u64!=ch.started{return Err(E::State);}
        if !observe(c,ch.id,now)? { return Ok(false); }
        if attempts>=5{return Err(E::Locked);}
        let changed=c.execute("UPDATE e_enrollments SET state='reserved',attempts=attempts+1,ticket=?2 WHERE id=?1 AND boot=?3 AND state='issued' AND attempts<5",params![ch.id.to_string(),ticket.to_string(),boot]).map_err(sql)?;
        if changed!=1{return Err(E::State);}
        c.execute("UPDATE e_abuse SET attempts=attempts+1 WHERE singleton=1",[]).map_err(sql)?;Ok(true)
    });
        match result {
            Ok(true) => Ok(Attempt {
                enrollment: ch.id,
                nonce: ticket,
                boot: ch.boot,
            }),
            Ok(false) => {
                ch.erase();
                Err(E::Expired)
            }
            Err(e) => {
                if matches!(e, E::Locked) {
                    ch.erase();
                }
                Err(e)
            }
        }
    }
    pub fn failed(&self, ticket: &Attempt) -> Result<()> {
        self.write(|c|{let changed=c.execute("UPDATE e_enrollments SET state=CASE WHEN attempts>=5 OR (SELECT attempts FROM e_abuse WHERE singleton=1)>=5 THEN 'locked' ELSE 'issued' END,ticket=NULL WHERE id=?1 AND boot=?2 AND ticket=?3 AND state='reserved'",params![ticket.enrollment.to_string(),ticket.boot.to_string(),ticket.nonce.to_string()]).map_err(sql)?;if changed!=1{return Err(E::State);}Ok(())})
    }
    pub fn cancel(&self, ch: &mut Challenge) -> Result<()> {
        ch.erase();
        self.write(|c|{c.execute("UPDATE e_enrollments SET state='cancelled',ticket=NULL WHERE id=?1 AND state IN('issued','reserved','approval')",[ch.id.to_string()]).map_err(sql)?;Ok(())})
    }
    pub fn record_proof(
        &self,
        ch: &mut Challenge,
        proof: CandidateProof,
        now: u64,
    ) -> Result<[u8; 32]> {
        let (ticket, transcript) = proof.parts();
        let hash = transcript.hash()?;
        let root = self.root()?;
        if transcript.enrollment != ch.id
            || transcript.network != root.network
            || transcript.admin != root.admin.device_id()
            || transcript.issuer != root.admin
            || ticket.enrollment != ch.id
            || ticket.boot != ch.boot
        {
            return Err(E::Trust);
        }
        let fresh = self.write(|c| {
            let started: i64 = c.query_row(
                "SELECT started FROM e_enrollments WHERE id=?1 AND boot=?2 AND ticket=?3 AND state='reserved' AND boot=(SELECT boot FROM e_abuse WHERE singleton=1)",
                params![ch.id.to_string(), ch.boot.to_string(), ticket.nonce.to_string()],
                |r| r.get(0),
            ).map_err(|_| E::State)?;
            if started as u64 != ch.started {
                return Err(E::State);
            }
            if !observe(c,ch.id,now)? {
                // Commit expiry rather than rolling it back as an error.
                return Ok(false);
            }
            let changed=c.execute("UPDATE e_enrollments SET state='approval',candidate=?4,transcript=?5,ticket=NULL WHERE id=?1 AND boot=?2 AND ticket=?3 AND state='reserved' AND boot=(SELECT boot FROM e_abuse WHERE singleton=1) AND started=?6",params![ch.id.to_string(),ch.boot.to_string(),ticket.nonce.to_string(),transcript.joiner.sec1(),hash.as_slice(),i64::try_from(ch.started).map_err(|_|E::Invalid)?]).map_err(sql)?;
            if changed!=1 { return Err(E::State); }
            Ok(true)
        })?;
        ch.erase();
        if fresh {
            Ok(hash)
        } else {
            Err(E::Expired)
        }
    }
    // Test/debug qualification seam ONLY. It consumes actual opaque-ke evidence,
    // uses the SAME reservation/approval ledger and never creates a live producer.
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    pub fn record_qualification(
        &self,
        ch: &mut Challenge,
        ticket: Attempt,
        pending: crate::sync_api::security::composition::lab::QualifiedPending,
        now: u64,
    ) -> Result<[u8; 32]> {
        let result = (|| {
            let (context, hash) = pending.into_lab_parts();
            if context.enrollment != ch.id
                || context.reservation != ticket.nonce
                || ticket.enrollment != ch.id
                || ticket.boot != ch.boot
            {
                return Err(E::Trust);
            }
            let fresh=self.write(|c| {
            let root=verified_root(c)?;
            local_admin(c,&root)?;
            if context.network!=root.network || context.admin_key!=root.admin {return Err(E::Trust);}
            let started:i64=c.query_row("SELECT started FROM e_enrollments WHERE id=?1 AND boot=?2 AND ticket=?3 AND state='reserved' AND boot=(SELECT boot FROM e_abuse WHERE singleton=1)",params![ch.id.to_string(),ch.boot.to_string(),ticket.nonce.to_string()],|r|r.get(0)).map_err(|_|E::State)?;
            if started as u64 != ch.started {return Err(E::State);}
            if !observe(c,ch.id,now)? {return Ok(false);}
            let n=c.execute("UPDATE e_enrollments SET state='approval',candidate=?2,transcript=?3,ticket=NULL WHERE id=?1 AND state='reserved' AND ticket=?4",params![ch.id.to_string(),context.joiner.sec1(),hash.as_slice(),ticket.nonce.to_string()]).map_err(sql)?;
            if n!=1{return Err(E::State);} Ok(true)
        })?;
            if fresh {
                Ok(hash)
            } else {
                Err(E::Expired)
            }
        })();
        if result.is_ok() {
            ch.erase();
        } else if ticket.enrollment == ch.id && ticket.boot == ch.boot {
            // Memory erasure and durable cancellation belong to the SAME exact
            // reservation. A stale ticket must not strand its newer successor.
            let cleanup = self.write(|c| {
                let changed = c.execute("UPDATE e_enrollments SET state='cancelled',ticket=NULL WHERE id=?1 AND boot=?2 AND ticket=?3 AND state='reserved'", params![ticket.enrollment.to_string(),ticket.boot.to_string(),ticket.nonce.to_string()]).map_err(sql)?;
                // Preserve only a still-usable challenge (including its newer
                // reservation). Startup/expiry/terminal rows erase stale memory.
                let reusable: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM e_enrollments WHERE id=?1 AND boot=?2 AND started=?3 AND boot=(SELECT boot FROM e_abuse WHERE singleton=1) AND state IN('issued','reserved'))", params![ch.id.to_string(),ch.boot.to_string(),i64::try_from(ch.started).map_err(|_|E::Invalid)?], |r|r.get(0)).map_err(sql)?;
                Ok(changed == 1 || !reusable)
            });
            match cleanup {
                Ok(true) => ch.erase(),
                Ok(false) => (),
                Err(e) => {
                    ch.erase();
                    return Err(e);
                } // fail closed; startup recovery
            }
        }
        result
    }
    // Local approval command, not a peer message. Exact key + transcript + epoch
    // are rechecked after the admin signing operation and inside the transaction.
    pub fn approve(
        &self,
        id: Uuid,
        expected: &PublicIdentity,
        transcript: [u8; 32],
        now: u64,
        admin: &dyn DeviceIdentityStore,
    ) -> Result<Vec<u8>> {
        let update = self.next(
            Action::Grant {
                device: expected.clone(),
                role: Role::Member,
                capabilities: 3,
                enrollment: id,
                expires: now.checked_add(3600).ok_or(E::Limit)?,
                origins: vec![],
            },
            admin,
        )?;
        self.write(|c| {
            let (key, hash, state): (Vec<u8>, Vec<u8>, String) = c.query_row(
                "SELECT candidate,transcript,state FROM e_enrollments WHERE id=?1 AND boot=(SELECT boot FROM e_abuse WHERE singleton=1)",
                [id.to_string()], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            ).map_err(|_| E::State)?;
            if state != "approval" || key != expected.sec1() || hash != transcript {
                return Err(E::Trust);
            }
            if !observe(c,id,now)? {
                return Ok(None);
            }
            local_admin(c,&verified_root(c)?)?;
            apply(c, &update)?;
            let bytes = update.bytes()?;
            c.execute("UPDATE e_enrollments SET state='consumed',grant_bytes=?2 WHERE id=?1", params![id.to_string(), bytes]).map_err(sql)?;
            Ok(Some(bytes))
        })?.ok_or(E::Expired)
    }
    pub fn resume(
        &self,
        id: Uuid,
        key: &PublicIdentity,
        now: u64,
        channel: [u8; 32],
        signature: &[u8],
    ) -> Result<Vec<u8>> {
        if channel == [0; 32] {
            return Err(E::Trust);
        }
        let root = self.root()?;
        let request = canonical(&(root.network, id, key, channel))?;
        verify(key, Domain::EnrollmentReceipt, &request, signature)?;
        self.write(|c| {
            let root = verified_root(c)?;
            local_admin(c,&root)?;
            let (stored, grant, state): (Vec<u8>, Vec<u8>, String) = c
                .query_row(
                    "SELECT candidate,grant_bytes,state FROM e_enrollments WHERE id=?1",
                    [id.to_string()],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .map_err(|_| E::Trust)?;
            if stored != key.sec1() || !matches!(state.as_str(), "consumed" | "received") {
                return Err(E::Trust);
            }
            verify_grant(c,&root,id,key,&grant)?;
            let enabled: bool = c
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM e_members WHERE device=?1 AND enabled=1 AND expires>?2)",
                    params![key.peer_id().to_string(),i64::try_from(now).map_err(|_|E::Expired)?],
                    |r| r.get(0),
                )
                .map_err(sql)?;
            if !enabled {
                return Err(E::Trust);
            }
            Ok(grant)
        })
    }
    pub fn receipt(
        &self,
        id: Uuid,
        key: &PublicIdentity,
        grant: &[u8],
        now: u64,
        channel: [u8; 32],
        signature: &[u8],
    ) -> Result<()> {
        if channel == [0; 32] {
            return Err(E::Trust);
        }
        let root = self.root()?;
        let payload = canonical(&(
            root.network,
            id,
            key,
            sha2::Sha256::digest(grant).to_vec(),
            channel,
        ))?;
        verify(key, Domain::EnrollmentReceipt, &payload, signature)?;
        self.write(|c| {
            let root = verified_root(c)?;
            local_admin(c,&root)?;
            verify_grant(c,&root,id,key,grant)?;
            let n=c.execute("UPDATE e_enrollments SET state='received' WHERE id=?1 AND candidate=?2 AND grant_bytes=?3 AND state IN('consumed','received') AND EXISTS(SELECT 1 FROM e_members WHERE device=?4 AND enabled=1 AND expires>?5)",params![id.to_string(),key.sec1(),grant,key.peer_id().to_string(),i64::try_from(now).map_err(|_|E::Expired)?]).map_err(sql)?;
            if n!=1 { return Err(E::Trust); }
            Ok(())
        })
    }
}
use sha2::Digest;
pub(super) fn unverified_root(c: &Connection) -> Result<Root> {
    let (network, admin, epoch, digest): (String, Vec<u8>, i64, Vec<u8>) = c
        .query_row(
            "SELECT network,admin,epoch,digest FROM e_registry WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|_| E::State)?;
    Ok(Root {
        network: Uuid::parse_str(&network).map_err(|_| E::Storage)?,
        admin: PublicIdentity::from_sec1(admin)?,
        epoch,
        digest: digest.try_into().map_err(|_| E::Storage)?,
    })
}
fn verified_root(c: &Connection) -> Result<Root> {
    Ok(super::registry_verification::verified(c)?.root)
}
fn apply(c: &Connection, u: &SignedUpdate) -> Result<()> {
    u.body.validate()?;
    let exists: bool = c
        .query_row("SELECT EXISTS(SELECT 1 FROM e_registry)", [], |r| r.get(0))
        .map_err(sql)?;
    let admin = if exists {
        let r = verified_root(c)?;
        if u.body.network != r.network {
            return Err(E::Trust);
        }
        if u.body.epoch <= r.epoch {
            return Err(E::Replay);
        }
        if u.body.epoch != r.epoch + 1 || u.body.previous != r.digest {
            return Err(E::Fork);
        }
        if matches!(u.body.action, Action::Genesis { .. }) {
            return Err(E::Trust);
        }
        r.admin
    } else {
        match &u.body.action {
            Action::Genesis { admin } => admin.clone(),
            _ => return Err(E::Trust),
        }
    };
    u.verify(&admin)?;
    match &u.body.action {
        Action::Genesis { admin } => {
            c.execute(
                "INSERT INTO e_members VALUES(?1,?2,NULL,1,?3,3)",
                params![admin.peer_id().to_string(), admin.sec1(), i64::MAX],
            )
            .map_err(sql)?;
        }
        Action::Grant {
            device,
            enrollment,
            expires,
            capabilities,
            origins,
            ..
        } => {
            let count: i64 = c
                .query_row("SELECT count(*) FROM e_members", [], |r| r.get(0))
                .map_err(sql)?;
            if count >= 8 {
                return Err(E::Limit);
            }
            c.execute(
                "INSERT INTO e_members VALUES(?1,?2,?3,1,?4,?5)",
                params![
                    device.peer_id().to_string(),
                    device.sec1(),
                    enrollment.to_string(),
                    *expires as i64,
                    capabilities
                ],
            )
            .map_err(|_| E::Trust)?;
            for origin in origins {
                c.execute(
                    "INSERT INTO e_origins VALUES(?1,?2)",
                    params![origin.to_string(), device.peer_id().to_string()],
                )
                .map_err(|_| E::Trust)?;
            }
        }
        Action::Revoke { device } => {
            if device == &admin {
                return Err(E::Trust);
            }
            if c.execute(
                "UPDATE e_members SET enabled=0 WHERE device=?1 AND key=?2 AND enabled=1",
                params![device.peer_id().to_string(), device.sec1()],
            )
            .map_err(sql)?
                != 1
            {
                return Err(E::Trust);
            }
        }
    }
    c.execute(
        "INSERT INTO e_updates VALUES(?1,?2)",
        params![u.body.epoch, u.bytes()?],
    )
    .map_err(sql)?;
    c.execute("INSERT INTO e_registry VALUES(1,?1,?2,?3,?4) ON CONFLICT(singleton) DO UPDATE SET epoch=excluded.epoch,digest=excluded.digest",params![u.body.network.to_string(),admin.sec1(),u.body.epoch,u.body.hash()?.as_slice()]).map_err(sql)?;
    super::registry_verification::verified(c)?;
    Ok(())
}
pub(crate) fn authorize_binding(c: &Connection, b: &MembershipBinding, now: u64) -> Result<()> {
    let registry = super::registry_verification::verified(c)?;
    let r = &registry.root;
    if r.network != b.root.network
        || r.epoch != b.root.epoch
        || r.digest != b.root.digest
        || r.admin != b.root.admin
    {
        return Err(E::Trust);
    }
    let now = i64::try_from(now).map_err(|_| E::Expired)?;
    for id in [b.local, b.peer.peer_id()] {
        let member = registry.members.get(&id.to_string()).ok_or(E::Trust)?;
        if !member.enabled || member.expires <= now || member.capabilities != 3 {
            return Err(E::Trust);
        }
    }
    if registry
        .members
        .get(&b.peer.peer_id().to_string())
        .ok_or(E::Trust)?
        .key
        != b.peer
    {
        return Err(E::Trust);
    }
    #[cfg(any(windows, target_os = "android"))]
    {
        let (_, local) = super::device_identity_store::bound_key(c, b.local)?;
        if local != registry.local_key
            || registry
                .members
                .get(&b.local.to_string())
                .ok_or(E::Trust)?
                .key
                != local
        {
            return Err(E::Trust);
        }
    }
    #[cfg(not(any(windows, target_os = "android")))]
    return Err(E::PlatformUnverified);
    Ok(())
}
#[cfg(test)]
pub(crate) fn with_test_connection<T>(
    owner: &CaptureStore,
    work: impl FnOnce(&Connection) -> T,
) -> T {
    work(&owner.connection.lock().unwrap())
}
#[cfg(test)]
pub(crate) fn schema_version(owner: &CaptureStore) -> i64 {
    owner.query_i64_for_test("PRAGMA user_version")
}
#[cfg(test)]
pub(crate) fn install(owner: &CaptureStore) {
    owner
        .connection
        .lock()
        .unwrap()
        .execute_batch(include_str!("enrollment_candidate.sql"))
        .unwrap();
    owner
        .connection
        .lock()
        .unwrap()
        .execute_batch(include_str!("enrollment_e2.sql"))
        .unwrap();
}
#[cfg(test)]
pub(crate) fn import_with_barrier(
    owner: &CaptureStore,
    session: &crate::sync_api::VerifiedSession,
    event: crate::sync_api::ValidatedEvent,
    clock: &dyn crate::sync_api::SyncClock,
    cancel: &crate::sync_api::Cancellation,
    barrier: impl FnOnce(),
) -> crate::sync_api::Result<crate::sync_api::Receipt> {
    let db = super::sync_store::CandidateSyncStore::synthetic(owner);
    db.write(session, clock, cancel, |c| {
        let receipt = super::sync_store::retain_in(c, session, &event, clock, cancel)?;
        barrier();
        Ok(receipt)
    })
}
