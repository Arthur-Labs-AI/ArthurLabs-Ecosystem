//! Nonsecret dormant registry, borrowing the ONE existing native store owner.
//! No Connection::open, filesystem path, provider work or network I/O here.
use super::capture_store::CaptureStore;
pub(crate) use crate::sync::security::enrollment::{MembershipBinding, Root};
use crate::sync::security::{canonical, enrollment::*, identity::*, Result, SecurityError as E};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use uuid::Uuid;
fn sql(_: rusqlite::Error) -> E {
    E::Storage
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
                action: Action::Genesis { admin: p },
            },
            admin,
        )?;
        self.write(|c| apply(c, &update))?;
        self.root()
    }
    pub fn apply(&self, update: &SignedUpdate) -> Result<()> {
        if matches!(update.body.action, Action::Genesis { .. }) {
            return Err(E::Trust);
        }
        self.write(|c| apply(c, update))
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
        let _root = self.root()?;
        let c = self.owner.connection.lock().map_err(|_| E::Storage)?;
        let bytes:Vec<u8>=c.query_row("SELECT m.key FROM e_origins o JOIN e_members m ON m.device=o.device WHERE o.origin=?1 AND m.enabled=1",[origin.to_string()],|r|r.get(0)).map_err(|_|E::Trust)?;
        PublicIdentity::from_sec1(bytes)
    }
    // Startup is explicit and must precede any candidate traffic. Unresolved codes
    // cannot resume after restart; device-wide limits are deliberately NOT reset.
    pub fn startup(&self) -> Result<Uuid> {
        let boot = Uuid::new_v4();
        self.write(|c|{c.execute("UPDATE e_enrollments SET state='cancelled',ticket=NULL WHERE state IN('issued','reserved','approval')",[]).map_err(sql)?;c.execute("INSERT INTO e_abuse VALUES(1,?1,0,0) ON CONFLICT(singleton) DO UPDATE SET boot=excluded.boot",[boot.to_string()]).map_err(sql)?;Ok(boot)})
    }
    #[cfg(test)]
    pub fn issue_fixture(&self, boot: Uuid, now: u64) -> Result<Challenge> {
        let code = SecretCode::generate()?;
        let id = Uuid::new_v4();
        let n = i64::try_from(now).map_err(|_| E::Invalid)?;
        self.write(|c|{let (b,attempts,issued):(String,i64,i64)=c.query_row("SELECT boot,attempts,issued FROM e_abuse WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(sql)?;if b!=boot.to_string(){return Err(E::State);}if attempts>=5||issued>=8{return Err(E::Locked);}c.execute("INSERT INTO e_enrollments(id,boot,started,state,attempts) VALUES(?1,?2,?3,'issued',0)",params![id.to_string(),b,n]).map_err(|_|E::State)?;c.execute("UPDATE e_abuse SET issued=issued+1 WHERE singleton=1",[]).map_err(sql)?;Ok(())})?;
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
        if now<started as u64||now-started as u64>=120{
            c.execute("UPDATE e_enrollments SET state='expired' WHERE id=?1 AND state IN('issued','reserved','approval')",[ch.id.to_string()]).map_err(sql)?;return Ok(false);
        }
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
            if now < started as u64 || now - started as u64 >= 120 {
                c.execute("UPDATE e_enrollments SET state='expired',ticket=NULL WHERE id=?1", [ch.id.to_string()]).map_err(sql)?;
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
            let (key, hash, start, state): (Vec<u8>, Vec<u8>, i64, String) = c.query_row(
                "SELECT candidate,transcript,started,state FROM e_enrollments WHERE id=?1 AND boot=(SELECT boot FROM e_abuse WHERE singleton=1)",
                [id.to_string()], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            ).map_err(|_| E::State)?;
            if state != "approval" || key != expected.sec1() || hash != transcript {
                return Err(E::Trust);
            }
            if now < start as u64 || now - start as u64 >= 120 {
                c.execute("UPDATE e_enrollments SET state='expired',ticket=NULL WHERE id=?1", [id.to_string()]).map_err(sql)?;
                return Ok(None);
            }
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
            let n=c.execute("UPDATE e_enrollments SET state='received' WHERE id=?1 AND candidate=?2 AND grant_bytes=?3 AND state IN('consumed','received') AND EXISTS(SELECT 1 FROM e_members WHERE device=?4 AND enabled=1 AND expires>?5)",params![id.to_string(),key.sec1(),grant,key.peer_id().to_string(),i64::try_from(now).map_err(|_|E::Expired)?]).map_err(sql)?;
            if n!=1 { return Err(E::Trust); }
            Ok(())
        })
    }
}
use sha2::Digest;
fn root(c: &Connection) -> Result<Root> {
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
    let r = root(c)?;
    let mut previous = [0; 32];
    let mut count = 0;
    let mut q = c
        .prepare("SELECT epoch,bytes FROM e_updates ORDER BY epoch")
        .map_err(sql)?;
    let rows = q
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
        })
        .map_err(sql)?;
    for row in rows {
        let (epoch, bytes) = row.map_err(sql)?;
        count += 1;
        if count > 4096 {
            return Err(E::Limit);
        }
        let update = SignedUpdate::decode(&bytes)?;
        if epoch != count
            || update.body.epoch != epoch
            || update.body.previous != previous
            || update.body.network != r.network
        {
            return Err(E::Fork);
        }
        if epoch == 1 {
            if !matches!(&update.body.action,Action::Genesis{admin}if admin==&r.admin) {
                return Err(E::Trust);
            }
        }
        update.verify(&r.admin)?;
        previous = update.body.hash()?;
    }
    if count != r.epoch || previous != r.digest {
        return Err(E::Fork);
    }
    Ok(r)
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
    Ok(())
}
pub(crate) fn authorize_binding(c: &Connection, b: &MembershipBinding, now: u64) -> Result<()> {
    let r = root(c)?;
    if r.network != b.root.network
        || r.epoch != b.root.epoch
        || r.digest != b.root.digest
        || r.admin != b.root.admin
    {
        return Err(E::Trust);
    }
    let valid:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM e_members WHERE device=?1 AND key=?2 AND enabled=1 AND expires>?3 AND capabilities=3) AND EXISTS(SELECT 1 FROM e_members WHERE device=?4 AND enabled=1 AND expires>?3)",params![b.peer.peer_id().to_string(),b.peer.sec1(),i64::try_from(now).map_err(|_|E::Expired)?,b.local.to_string()],|r|r.get(0)).map_err(sql)?;
    if !valid {
        return Err(E::Trust);
    }
    let local: Option<(String, Option<Vec<u8>>, String)> = c
        .query_row(
            "SELECT slot,key,state FROM e_identity WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(sql)?;
    if let Some((slot, key, state)) = local {
        if state != "active" {
            return Err(E::Trust);
        }
        let expected = PublicIdentity::from_sec1(key.ok_or(E::Trust)?)?;
        if expected.peer_id() != b.local {
            return Err(E::Trust);
        }
        #[cfg(windows)]
        {
            let native = crate::sync::security::windows::WindowsIdentity::slot(
                Uuid::parse_str(&slot).map_err(|_| E::Trust)?,
            );
            if native.public_identity()? != expected {
                return Err(E::Trust);
            }
        }
        #[cfg(not(windows))]
        {
            let _ = slot;
            return Err(E::PlatformUnverified);
        }
    }
    Ok(())
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
}
#[cfg(test)]
pub(crate) fn import_with_barrier(
    owner: &CaptureStore,
    session: &crate::sync::VerifiedSession,
    event: crate::sync::ValidatedEvent,
    clock: &dyn crate::sync::SyncClock,
    cancel: &crate::sync::Cancellation,
    barrier: impl FnOnce(),
) -> crate::sync::Result<crate::sync::Receipt> {
    let db = super::sync_store::CandidateSyncStore::synthetic(owner);
    db.write(session, clock, cancel, |c| {
        let receipt = super::sync_store::retain_in(c, session, &event, clock, cancel)?;
        barrier();
        Ok(receipt)
    })
}
