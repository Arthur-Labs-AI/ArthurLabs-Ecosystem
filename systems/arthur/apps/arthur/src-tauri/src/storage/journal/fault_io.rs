//! Test-only, per-open-file VFS callback faults. No global VFS registration,
//! OS device fault, capacity exhaustion or production growth certification.
//! All unmodified methods still receive the original native sqlite3_file.
use crate::storage::capture_store::CaptureStore;
use rusqlite::ffi;
use std::ffi::c_void;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Clone, Copy)]
pub(super) enum Fault {
    WriteFull,
    SyncIo,
}

#[repr(C)]
struct Methods {
    io: ffi::sqlite3_io_methods,
    original: *const ffi::sqlite3_io_methods,
    hits: AtomicUsize,
}

pub(super) struct FileFault<'a> {
    store: &'a CaptureStore,
    file: *mut ffi::sqlite3_file,
    methods: Box<Methods>,
}
impl<'a> FileFault<'a> {
    /// Install only on the owned MAIN file while its connection is locked.
    /// The guard borrows the store so SQLite cannot close the file first.
    ///
    /// # Safety
    /// Until the guard is dropped, the test must not close/replace the store's
    /// connection, change VFS methods, or install another guard on that file.
    /// CaptureStore's private test helpers otherwise permit such replacement.
    pub unsafe fn install(store: &'a CaptureStore, fault: Fault) -> Self {
        let c = store.connection.lock().unwrap();
        let mut file: *mut ffi::sqlite3_file = std::ptr::null_mut();
        // FILE_POINTER writes one sqlite3_file* into caller-owned storage. It
        // does not transfer ownership; the open connection owns its lifetime.
        let rc = unsafe {
            ffi::sqlite3_file_control(
                c.handle(),
                c"main".as_ptr(),
                ffi::SQLITE_FCNTL_FILE_POINTER,
                (&mut file as *mut *mut ffi::sqlite3_file).cast(),
            )
        };
        assert_eq!(rc, ffi::SQLITE_OK);
        assert!(!file.is_null());
        // Native method table is POD; copy it, never mutate SQLite's shared
        // original. Only this open file receives our stable Box address.
        let original = unsafe { (*file).pMethods };
        assert!(!original.is_null());
        let mut methods = Box::new(Methods {
            io: unsafe { std::ptr::read(original) },
            original,
            hits: AtomicUsize::new(0),
        });
        assert!((1..=3).contains(&methods.io.iVersion));
        match fault {
            Fault::WriteFull => methods.io.xWrite = Some(write_full),
            Fault::SyncIo => methods.io.xSync = Some(sync_io),
        }
        unsafe {
            (*file).pMethods = &methods.io;
        }
        Self {
            store,
            file,
            methods,
        }
    }
    pub fn hits(&self) -> usize {
        self.methods.hits.load(Ordering::SeqCst)
    }
}
impl Drop for FileFault<'_> {
    fn drop(&mut self) {
        let _c = self
            .store
            .connection
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // The store borrow keeps this main file live. A consumed one-shot has
        // already restored pMethods. An unused one is restored here before Box
        // reclamation. No callback can be running while this mutex is held.
        unsafe {
            if std::ptr::eq((*self.file).pMethods, &self.methods.io) {
                (*self.file).pMethods = self.methods.original;
            }
        }
    }
}
unsafe fn consume(file: *mut ffi::sqlite3_file) {
    // Only the callbacks below call consume, and only our installed table can
    // point to them. repr(C) puts io first, so its address is Methods' address.
    let methods = &*((*file).pMethods.cast::<Methods>());
    (*file).pMethods = methods.original;
    methods.hits.fetch_add(1, Ordering::SeqCst);
    // Restore BEFORE reporting failure so genuine SQLite rollback/recovery
    // uses native I/O. No panic, allocation or SQL reentry in callbacks.
}
unsafe extern "C" fn write_full(
    file: *mut ffi::sqlite3_file,
    _: *const c_void,
    _: i32,
    _: i64,
) -> i32 {
    consume(file);
    ffi::SQLITE_FULL
}
unsafe extern "C" fn sync_io(file: *mut ffi::sqlite3_file, _: i32) -> i32 {
    consume(file);
    ffi::SQLITE_IOERR_FSYNC
}
