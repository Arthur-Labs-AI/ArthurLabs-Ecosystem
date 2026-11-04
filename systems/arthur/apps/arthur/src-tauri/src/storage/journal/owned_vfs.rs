//! Disposable test VFS, explicitly selected by name; NEVER a default replacement.
//! Authority: SQLite files/cores; this bounded numeric ledger is test evidence.
//! Owner: CaptureStore closes its connection before releasing the registration.
//! Direction: admission -> VFS token -> original native methods, no domain calls.
//! Boundary: closed file classes and native-owned root, never peer paths/SQL.
//! Failure: deny before delegated growth; retain sticky refusal through COMMIT.
//! Lifecycle: SQLite malloc/free for native files; Arc for registration; RAII token.
//! Seams: deterministic nth-I/O faults and numeric checkpoints, no polling/sleeps.
//! Compatibility: test-only DELETE extent contract; production remains unverified.
//! Observability/security: no paths, SQL or file contents in records or errors.
use super::admission::{round, AdmissionError as E, StorageDemand};
use rusqlite::{ffi, Connection};
use std::{
    cell::UnsafeCell,
    collections::BTreeMap,
    ffi::{c_char, c_void, CStr, CString},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
};

const CONTROL: i32 = 0x41525448;
const RECORDS: usize = 32768;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Class {
    Main,
    Journal,
    Temp,
    Subjournal,
    Other,
}
impl Class {
    fn slot(self) -> usize {
        match self {
            Self::Main => 0,
            Self::Journal => 1,
            _ => 2,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Boundary {
    Open,
    Write,
    Truncate,
    Sync,
    Close,
    Delete,
}
#[derive(Clone, Debug)]
pub(super) struct Record {
    pub file: u64,
    pub class: Class,
    pub boundary: Boundary,
    pub end: u64,
    pub rc: i32,
    pub allocation: Option<u64>,
    pub session: u64,
}
#[derive(Clone, Copy)]
pub(super) struct Injection {
    pub class: Class,
    pub boundary: Boundary,
    pub nth: usize,
    pub code: i32,
}
struct Live {
    class: Class,
    length: u64,
}
struct Limit {
    id: u64,
    base: BTreeMap<u64, u64>,
    ceilings: [u64; 3],
    unit: u64,
    denied: bool,
    peak: [u64; 3],
}
#[derive(Default)]
struct Ledger {
    files: BTreeMap<u64, Live>,
    records: Vec<Record>,
    next: u64,
    session: u64,
    limit: Option<Limit>,
    injection: Option<Injection>,
    begins: u64,
    ends: u64,
}
pub(in crate::storage) struct OwnedVfs {
    vfs: UnsafeCell<ffi::sqlite3_vfs>,
    inner: *mut ffi::sqlite3_vfs,
    name: CString,
    root: PathBuf,
    ledger: Mutex<Ledger>,
    me: Weak<OwnedVfs>,
}
// Registered vfs is pinned and immutable (SQLite alone changes pNext under its
// registration mutex). All mutable evidence is locked; native files are used
// only through their owning SQLite connection's serialization.
unsafe impl Send for OwnedVfs {}
unsafe impl Sync for OwnedVfs {}
impl OwnedVfs {
    pub(in crate::storage) fn new(root: &Path) -> Arc<Self> {
        let root = root.canonicalize().unwrap();
        let name = CString::new(format!("arthur-test-{}", uuid::Uuid::new_v4())).unwrap();
        let inner = unsafe { ffi::sqlite3_vfs_find(std::ptr::null()) };
        assert!(!inner.is_null());
        let this = Arc::new_cyclic(|me| {
            let mut vfs: ffi::sqlite3_vfs = unsafe { std::mem::zeroed() };
            vfs.iVersion = 2;
            vfs.szOsFile = std::mem::size_of::<File>() as i32;
            vfs.mxPathname = unsafe { (*inner).mxPathname };
            vfs.xOpen = Some(open);
            vfs.xDelete = Some(delete);
            vfs.xAccess = Some(access);
            vfs.xFullPathname = Some(full_path);
            vfs.xDlOpen = Some(dl_open);
            vfs.xDlError = Some(dl_error);
            vfs.xDlSym = Some(dl_sym);
            vfs.xDlClose = Some(dl_close);
            vfs.xRandomness = Some(randomness);
            vfs.xSleep = Some(sleep);
            vfs.xCurrentTime = Some(current_time);
            vfs.xGetLastError = Some(last_error);
            vfs.xCurrentTimeInt64 = Some(current_time64);
            Self {
                vfs: UnsafeCell::new(vfs),
                inner,
                name,
                root,
                ledger: Mutex::new(Ledger::default()),
                me: me.clone(),
            }
        });
        unsafe {
            (*this.vfs.get()).zName = this.name.as_ptr();
            (*this.vfs.get()).pAppData = Arc::as_ptr(&this).cast_mut().cast();
            assert_eq!(ffi::sqlite3_vfs_register(this.vfs.get(), 0), ffi::SQLITE_OK);
        }
        this
    }
    pub(in crate::storage) fn name(&self) -> &str {
        self.name.to_str().unwrap()
    }
    pub(super) fn records(&self) -> Vec<Record> {
        self.ledger.lock().unwrap().records.clone()
    }
    pub(super) fn counts(&self) -> (u64, u64) {
        let l = self.ledger.lock().unwrap();
        (l.begins, l.ends)
    }
    pub(super) fn inject(&self, f: Injection) {
        self.ledger.lock().unwrap().injection = Some(f);
    }
    pub(super) fn clear_records(&self) {
        let mut l = self.ledger.lock().unwrap();
        assert!(l.limit.is_none());
        l.records.clear();
    }
    pub(super) fn peak(&self) -> Option<[u64; 3]> {
        self.ledger.lock().unwrap().limit.as_ref().map(|l| l.peak)
    }
    fn path(&self, name: *const c_char, class: Class) -> Option<PathBuf> {
        if name.is_null() {
            return None;
        }
        let path = PathBuf::from(unsafe { CStr::from_ptr(name) }.to_str().ok()?);
        let allowed = match class {
            Class::Main => "arthur.db",
            Class::Journal => "arthur.db-journal",
            _ => return None,
        };
        if path.file_name()? != allowed || path.parent()?.canonicalize().ok()? != self.root {
            return None;
        }
        let path = self.root.join(allowed);
        if let Ok(m) = std::fs::symlink_metadata(&path) {
            if !m.file_type().is_file() {
                return None;
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if m.file_attributes() & 0x400 != 0 {
                    return None;
                }
            }
        }
        Some(path)
    }
}
impl Drop for OwnedVfs {
    fn drop(&mut self) {
        unsafe {
            ffi::sqlite3_vfs_unregister(self.vfs.get());
        }
    }
}
#[repr(C)]
struct File {
    base: ffi::sqlite3_file,
    context: *mut FileContext,
}
struct FileContext {
    vfs: Arc<OwnedVfs>,
    native: *mut ffi::sqlite3_file,
    id: u64,
    class: Class,
    path: PathBuf,
}
unsafe fn context<'a>(f: *mut ffi::sqlite3_file) -> &'a FileContext {
    &*(*(f.cast::<File>())).context
}
unsafe fn owner<'a>(v: *mut ffi::sqlite3_vfs) -> &'a OwnedVfs {
    &*((*v).pAppData.cast::<OwnedVfs>())
}
fn code(work: impl FnOnce() -> i32) -> i32 {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(work)).unwrap_or(ffi::SQLITE_IOERR)
}
fn class(flags: i32) -> Class {
    if flags & ffi::SQLITE_OPEN_MAIN_DB != 0 {
        Class::Main
    } else if flags & ffi::SQLITE_OPEN_MAIN_JOURNAL != 0 {
        Class::Journal
    } else if flags & ffi::SQLITE_OPEN_SUBJOURNAL != 0 {
        Class::Subjournal
    } else if flags
        & (ffi::SQLITE_OPEN_TEMP_DB | ffi::SQLITE_OPEN_TEMP_JOURNAL | ffi::SQLITE_OPEN_TRANSIENT_DB)
        != 0
    {
        Class::Temp
    } else {
        Class::Other
    }
}
fn refusal(v: &OwnedVfs, id: u64, class: Class, boundary: Boundary, end: u64) -> i32 {
    let mut l = match v.ledger.lock() {
        Ok(l) => l,
        Err(_) => return ffi::SQLITE_IOERR,
    };
    if l.records.len() >= RECORDS {
        if let Some(b) = &mut l.limit {
            b.denied = true;
        }
        return ffi::SQLITE_FULL;
    }
    if let Some(f) = &mut l.injection {
        if f.class == class && f.boundary == boundary {
            f.nth = f.nth.saturating_sub(1);
            if f.nth == 0 {
                let rc = f.code;
                l.injection = None;
                return rc;
            }
        }
    }
    let Some(b) = l.limit.as_ref() else {
        return ffi::SQLITE_OK;
    };
    if boundary != Boundary::Write && boundary != Boundary::Truncate {
        return ffi::SQLITE_OK;
    }
    let mut used = [0u64; 3];
    for (file, live) in &l.files {
        let length = if *file == id {
            end.max(live.length)
        } else {
            live.length
        };
        let old = *b.base.get(file).unwrap_or(&0);
        let Some(growth) = round(length.saturating_sub(old), b.unit).ok() else {
            return ffi::SQLITE_FULL;
        };
        let Some(sum) = used[live.class.slot()].checked_add(growth) else {
            return ffi::SQLITE_FULL;
        };
        used[live.class.slot()] = sum;
    }
    let deny = used.iter().zip(b.ceilings).any(|(used, max)| *used > max);
    let b = l.limit.as_mut().unwrap();
    if deny {
        b.denied = true;
        ffi::SQLITE_FULL
    } else {
        for i in 0..3 {
            b.peak[i] = b.peak[i].max(used[i]);
        }
        ffi::SQLITE_OK
    }
}
fn record(
    v: &OwnedVfs,
    id: u64,
    class: Class,
    boundary: Boundary,
    end: u64,
    rc: i32,
    allocation: Option<u64>,
) {
    if let Ok(mut l) = v.ledger.lock() {
        if rc != ffi::SQLITE_OK {
            if let Some(b) = &mut l.limit {
                b.denied = true;
            }
        }
        let session = l.limit.as_ref().map_or(0, |b| b.id);
        if l.records.len() < RECORDS {
            l.records.push(Record {
                file: id,
                class,
                boundary,
                end,
                rc,
                allocation,
                session,
            });
        }
    }
}
unsafe extern "C" fn open(
    v: *mut ffi::sqlite3_vfs,
    name: *const c_char,
    file: *mut ffi::sqlite3_file,
    flags: i32,
    out: *mut i32,
) -> i32 {
    code(|| {
        (*file).pMethods = std::ptr::null();
        let v = owner(v);
        let class = class(flags);
        let Some(path) = v.path(name, class) else {
            record(v, 0, class, Boundary::Open, 0, ffi::SQLITE_CANTOPEN, None);
            if let Ok(mut l) = v.ledger.lock() {
                if let Some(b) = &mut l.limit {
                    b.denied = true;
                }
            }
            return ffi::SQLITE_CANTOPEN;
        };
        let (id, arc) = {
            let mut l = v.ledger.lock().unwrap();
            if class == Class::Main && l.files.values().any(|f| f.class == Class::Main) {
                return ffi::SQLITE_CANTOPEN;
            }
            let Some(next) = l.next.checked_add(1) else {
                return ffi::SQLITE_FULL;
            };
            l.next = next;
            (l.next, v.me.upgrade().unwrap())
        };
        let fault = refusal(v, id, class, Boundary::Open, 0);
        if fault != ffi::SQLITE_OK {
            record(v, id, class, Boundary::Open, 0, fault, None);
            return fault;
        }
        let native = ffi::sqlite3_malloc64((*v.inner).szOsFile as u64).cast::<ffi::sqlite3_file>();
        if native.is_null() {
            return ffi::SQLITE_NOMEM;
        }
        std::ptr::write_bytes(native.cast::<u8>(), 0, (*v.inner).szOsFile as usize);
        let rc = (*v.inner).xOpen.unwrap()(v.inner, name, native, flags, out);
        if rc != ffi::SQLITE_OK {
            if !(*native).pMethods.is_null() {
                ((*(*native).pMethods).xClose.unwrap())(native);
            }
            ffi::sqlite3_free(native.cast());
            record(v, id, class, Boundary::Open, 0, rc, None);
            return rc;
        }
        let mut length = 0;
        let rc = ((*(*native).pMethods).xFileSize.unwrap())(native, &mut length);
        if rc != ffi::SQLITE_OK || length < 0 {
            ((*(*native).pMethods).xClose.unwrap())(native);
            ffi::sqlite3_free(native.cast());
            return if rc != ffi::SQLITE_OK {
                rc
            } else {
                ffi::SQLITE_IOERR_FSTAT
            };
        }
        v.ledger.lock().unwrap().files.insert(
            id,
            Live {
                class,
                length: length as u64,
            },
        );
        let allocation = super::capacity::allocated_bytes(&path, false).ok();
        let ctx = Box::new(FileContext {
            vfs: arc,
            native,
            id,
            class,
            path,
        });
        (*(file.cast::<File>())).context = Box::into_raw(ctx);
        (*file).pMethods = &METHODS;
        record(
            v,
            id,
            class,
            Boundary::Open,
            length as u64,
            ffi::SQLITE_OK,
            allocation,
        );
        ffi::SQLITE_OK
    })
}
unsafe extern "C" fn close(file: *mut ffi::sqlite3_file) -> i32 {
    code(|| {
        let f = Box::from_raw((*(file.cast::<File>())).context);
        // Always release the native resource, including an injected close error.
        let fault = refusal(&f.vfs, f.id, f.class, Boundary::Close, 0);
        let native_rc = ((*(*f.native).pMethods).xClose.unwrap())(f.native);
        let rc = if native_rc == ffi::SQLITE_OK {
            fault
        } else {
            native_rc
        };
        ffi::sqlite3_free(f.native.cast());
        (*file).pMethods = std::ptr::null();
        record(&f.vfs, f.id, f.class, Boundary::Close, 0, rc, None);
        f.vfs.ledger.lock().unwrap().files.remove(&f.id);
        rc
    })
}
unsafe extern "C" fn write(
    file: *mut ffi::sqlite3_file,
    data: *const c_void,
    amt: i32,
    offset: i64,
) -> i32 {
    code(|| {
        let f = context(file);
        let Some(end) = u64::try_from(offset)
            .ok()
            .and_then(|o| u64::try_from(amt).ok().and_then(|n| o.checked_add(n)))
        else {
            return ffi::SQLITE_FULL;
        };
        let mut rc = refusal(&f.vfs, f.id, f.class, Boundary::Write, end);
        if rc == ffi::SQLITE_OK {
            rc = ((*(*f.native).pMethods).xWrite.unwrap())(f.native, data, amt, offset);
            if rc == ffi::SQLITE_OK {
                let mut l = f.vfs.ledger.lock().unwrap();
                let live = l.files.get_mut(&f.id).unwrap();
                live.length = live.length.max(end);
            }
        }
        let allocation = super::capacity::allocated_bytes(&f.path, false).ok();
        record(&f.vfs, f.id, f.class, Boundary::Write, end, rc, allocation);
        rc
    })
}
unsafe extern "C" fn truncate(file: *mut ffi::sqlite3_file, size: i64) -> i32 {
    code(|| {
        let f = context(file);
        let Ok(end) = u64::try_from(size) else {
            return ffi::SQLITE_FULL;
        };
        let mut rc = refusal(&f.vfs, f.id, f.class, Boundary::Truncate, end);
        if rc == ffi::SQLITE_OK {
            rc = ((*(*f.native).pMethods).xTruncate.unwrap())(f.native, size);
            if rc == ffi::SQLITE_OK {
                f.vfs
                    .ledger
                    .lock()
                    .unwrap()
                    .files
                    .get_mut(&f.id)
                    .unwrap()
                    .length = end;
            }
        }
        record(
            &f.vfs,
            f.id,
            f.class,
            Boundary::Truncate,
            end,
            rc,
            super::capacity::allocated_bytes(&f.path, false).ok(),
        );
        rc
    })
}
unsafe extern "C" fn sync(file: *mut ffi::sqlite3_file, flags: i32) -> i32 {
    code(|| {
        let f = context(file);
        let mut rc = refusal(&f.vfs, f.id, f.class, Boundary::Sync, 0);
        if rc == ffi::SQLITE_OK {
            rc = ((*(*f.native).pMethods).xSync.unwrap())(f.native, flags);
        }
        record(&f.vfs, f.id, f.class, Boundary::Sync, 0, rc, None);
        rc
    })
}
unsafe extern "C" fn control(file: *mut ffi::sqlite3_file, op: i32, arg: *mut c_void) -> i32 {
    code(|| {
        let f = context(file);
        if op == CONTROL {
            *(arg.cast::<Option<Arc<OwnedVfs>>>()) = Some(f.vfs.clone());
            return ffi::SQLITE_OK;
        }
        if op == ffi::SQLITE_FCNTL_FILE_POINTER {
            *(arg.cast::<*mut ffi::sqlite3_file>()) = file;
            return ffi::SQLITE_OK;
        }
        // Native allocation hints and atomic-write batches can allocate without a
        // visible xWrite. Refuse those optimizations rather than undercount them.
        match op {
            ffi::SQLITE_FCNTL_LOCKSTATE
            | ffi::SQLITE_FCNTL_LAST_ERRNO
            | ffi::SQLITE_FCNTL_HAS_MOVED
            | ffi::SQLITE_FCNTL_VFSNAME => {
                ((*(*f.native).pMethods).xFileControl.unwrap())(f.native, op, arg)
            }
            // A closed control catalog also refuses native handle replacement,
            // NULL_IO and future native methods that might allocate behind us.
            _ => ffi::SQLITE_NOTFOUND,
        }
    })
}
macro_rules! file_forward {($name:ident,$field:ident,($($arg:ident:$ty:ty),*)=>$ret:ty)=>{
    unsafe extern "C" fn $name(file:*mut ffi::sqlite3_file,$($arg:$ty),*)->$ret {let f=context(file);((*(*f.native).pMethods).$field.unwrap())(f.native,$($arg),*)}
}}
file_forward!(read,xRead,(data:*mut c_void,amt:i32,offset:i64)=>i32);
file_forward!(size,xFileSize,(size:*mut i64)=>i32);
file_forward!(lock,xLock,(flags:i32)=>i32);
file_forward!(unlock,xUnlock,(flags:i32)=>i32);
file_forward!(reserved,xCheckReservedLock,(out:*mut i32)=>i32);
file_forward!(sector,xSectorSize,()=>i32);
// Disable atomic/batch optimizations: every write must traverse this wrapper.
unsafe extern "C" fn characteristics(_: *mut ffi::sqlite3_file) -> i32 {
    0
}
static METHODS: ffi::sqlite3_io_methods = ffi::sqlite3_io_methods {
    iVersion: 1,
    xClose: Some(close),
    xRead: Some(read),
    xWrite: Some(write),
    xTruncate: Some(truncate),
    xSync: Some(sync),
    xFileSize: Some(size),
    xLock: Some(lock),
    xUnlock: Some(unlock),
    xCheckReservedLock: Some(reserved),
    xFileControl: Some(control),
    xSectorSize: Some(sector),
    xDeviceCharacteristics: Some(characteristics),
    xShmMap: None,
    xShmLock: None,
    xShmBarrier: None,
    xShmUnmap: None,
    xFetch: None,
    xUnfetch: None,
};

unsafe extern "C" fn delete(v: *mut ffi::sqlite3_vfs, name: *const c_char, dir: i32) -> i32 {
    code(|| {
        let v = owner(v);
        if v.path(name, Class::Journal).is_none() {
            return ffi::SQLITE_IOERR_DELETE;
        }
        let mut rc = refusal(v, 0, Class::Journal, Boundary::Delete, 0);
        if rc == ffi::SQLITE_OK {
            rc = (*v.inner).xDelete.unwrap()(v.inner, name, dir);
        }
        record(v, 0, Class::Journal, Boundary::Delete, 0, rc, None);
        rc
    })
}
macro_rules! vfs_forward {($name:ident,$field:ident,($($arg:ident:$ty:ty),*)=>$ret:ty,$fallback:expr)=>{
    unsafe extern "C" fn $name(v:*mut ffi::sqlite3_vfs,$($arg:$ty),*)->$ret {let inner=owner(v).inner;match (*inner).$field {Some(f)=>f(inner,$($arg),*),None=>$fallback}}
}}
vfs_forward!(access,xAccess,(name:*const c_char,flags:i32,out:*mut i32)=>i32,ffi::SQLITE_IOERR_ACCESS);
vfs_forward!(full_path,xFullPathname,(name:*const c_char,n:i32,out:*mut c_char)=>i32,ffi::SQLITE_CANTOPEN);
vfs_forward!(randomness,xRandomness,(n:i32,out:*mut c_char)=>i32,0);
vfs_forward!(sleep,xSleep,(n:i32)=>i32,0);
vfs_forward!(current_time,xCurrentTime,(out:*mut f64)=>i32,ffi::SQLITE_ERROR);
vfs_forward!(current_time64,xCurrentTimeInt64,(out:*mut i64)=>i32,ffi::SQLITE_ERROR);
vfs_forward!(last_error,xGetLastError,(n:i32,out:*mut c_char)=>i32,0);
vfs_forward!(dl_open,xDlOpen,(name:*const c_char)=>*mut c_void,std::ptr::null_mut());
vfs_forward!(dl_error,xDlError,(n:i32,out:*mut c_char)=>(),());
vfs_forward!(dl_close,xDlClose,(handle:*mut c_void)=>(),());
type Symbol = Option<unsafe extern "C" fn(*mut ffi::sqlite3_vfs, *mut c_void, *const c_char)>;
vfs_forward!(dl_sym,xDlSym,(handle:*mut c_void,name:*const c_char)=>Symbol,None);

pub(super) struct IoBudget {
    vfs: Arc<OwnedVfs>,
    id: u64,
}
impl IoBudget {
    pub(super) fn begin(c: &Connection, demand: StorageDemand, unit: u64) -> Result<Self, E> {
        let mut vfs: Option<Arc<OwnedVfs>> = None;
        let rc = unsafe {
            ffi::sqlite3_file_control(
                c.handle(),
                c"main".as_ptr(),
                CONTROL,
                (&mut vfs as *mut Option<Arc<OwnedVfs>>).cast(),
            )
        };
        if rc != ffi::SQLITE_OK {
            return Err(E::UnverifiedBounds);
        }
        let vfs = vfs.ok_or(E::UnverifiedBounds)?;
        let id;
        {
            let mut l = vfs.ledger.lock().map_err(|_| E::RecoveryRequired)?;
            if l.limit.is_some() {
                return Err(E::RecoveryRequired);
            }
            let ceilings = [
                demand.main.ok_or(E::UnknownDemand)?,
                demand.journal.ok_or(E::UnknownDemand)?,
                demand.scratch.ok_or(E::UnknownDemand)?,
            ];
            if unit == 0 {
                return Err(E::SpaceUnknown);
            }
            l.session = l.session.checked_add(1).ok_or(E::Overflow)?;
            id = l.session;
            let begins = l.begins.checked_add(1).ok_or(E::Overflow)?;
            l.limit = Some(Limit {
                id,
                base: l.files.iter().map(|(id, f)| (*id, f.length)).collect(),
                ceilings,
                unit,
                denied: false,
                peak: [0; 3],
            });
            l.begins = begins;
        }
        Ok(Self { vfs, id })
    }
    pub(super) fn check(&self) -> Result<(), E> {
        let l = self.vfs.ledger.lock().map_err(|_| E::RecoveryRequired)?;
        match l.limit.as_ref() {
            Some(b) if b.id == self.id && !b.denied => Ok(()),
            _ => Err(E::GrowthExceeded),
        }
    }
}
impl Drop for IoBudget {
    fn drop(&mut self) {
        if let Ok(mut l) = self.vfs.ledger.lock() {
            if l.limit.as_ref().is_some_and(|b| b.id == self.id) {
                l.limit = None;
                l.ends += 1;
            }
        }
    }
}
