//! Native capacity authority: only a CaptureStore-owned database location.
use super::admission::{AdmissionError as E, Capacity};
use crate::storage::capture_store::CaptureStore;
use rusqlite::Connection;
use std::path::PathBuf;

#[derive(Clone)]
pub(super) struct OwnedLocation {
    root: PathBuf,
    database: PathBuf,
}
impl OwnedLocation {
    pub fn database(&self) -> &std::path::Path {
        &self.database
    }
    pub fn bind(store: &CaptureStore, c: &Connection) -> Result<Self, E> {
        let root = store
            .owned_data_root()
            .ok_or(E::SpaceUnknown)?
            .canonicalize()
            .map_err(|_| E::SpaceUnknown)?;
        let database = root.join("arthur.db");
        let actual: String = c
            .query_row(
                "SELECT file FROM pragma_database_list WHERE name='main'",
                [],
                |r| r.get(0),
            )
            .map_err(|_| E::SpaceUnknown)?;
        if std::fs::canonicalize(actual).map_err(|_| E::SpaceUnknown)? != database {
            return Err(E::VolumeMismatch);
        }
        let location = Self { root, database };
        location.validate()?;
        Ok(location)
    }
    pub fn validate(&self) -> Result<(), E> {
        if !self.root.is_absolute()
            || !self.root.is_dir()
            || self.root.canonicalize().map_err(|_| E::SpaceUnknown)? != self.root
        {
            return Err(E::SpaceUnknown);
        }
        let m = std::fs::symlink_metadata(&self.database).map_err(|_| E::SpaceUnknown)?;
        if !m.file_type().is_file()
            || self.database.canonicalize().map_err(|_| E::SpaceUnknown)? != self.database
        {
            return Err(E::VolumeMismatch);
        }
        Ok(())
    }
}
pub(super) trait CapacityProvider: Send + Sync {
    fn query(&self, location: &OwnedLocation) -> Result<Capacity, E>;
}
pub(super) struct NativeCapacity;
impl CapacityProvider for NativeCapacity {
    fn query(&self, location: &OwnedLocation) -> Result<Capacity, E> {
        location.validate()?;
        platform::query(location)
    }
}

/// Allocation, not file length: claims must stop charging growth already
/// reflected in the capacity provider's available-byte observation.
pub(super) fn allocated_bytes(path: &std::path::Path, missing_allowed: bool) -> Result<u64, E> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_file() => platform::allocated(path),
        Err(e) if missing_allowed && e.kind() == std::io::ErrorKind::NotFound => Ok(0),
        _ => Err(E::SpaceUnknown),
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ffi::c_void;
    use std::os::windows::{ffi::OsStrExt, io::AsRawHandle};
    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    struct FileInfo {
        attributes: u32,
        created: FileTime,
        accessed: FileTime,
        written: FileTime,
        serial: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            path: *const u16,
            available: *mut u64,
            total: *mut u64,
            free: *mut u64,
        ) -> i32;
        fn GetVolumePathNameW(path: *const u16, volume: *mut u16, len: u32) -> i32;
        fn GetVolumeNameForVolumeMountPointW(path: *const u16, volume: *mut u16, len: u32) -> i32;
        fn GetDiskFreeSpaceW(
            path: *const u16,
            sectors: *mut u32,
            bytes: *mut u32,
            free: *mut u32,
            total: *mut u32,
        ) -> i32;
        fn GetFileInformationByHandle(handle: *mut c_void, info: *mut FileInfo) -> i32;
        fn GetFileInformationByHandleEx(
            handle: *mut c_void,
            class: i32,
            info: *mut c_void,
            size: u32,
        ) -> i32;
    }
    #[repr(C)]
    struct StandardInfo {
        allocation: i64,
        end: i64,
        links: u32,
        delete_pending: u8,
        directory: u8,
    }
    pub fn allocated(path: &std::path::Path) -> Result<u64, E> {
        let file = std::fs::File::open(path).map_err(|_| E::SpaceUnknown)?;
        let mut info = std::mem::MaybeUninit::<StandardInfo>::uninit();
        // FILE_STANDARD_INFO (FileStandardInfo=1); caller-owned synchronous buffer.
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                1,
                info.as_mut_ptr().cast(),
                std::mem::size_of::<StandardInfo>() as u32,
            )
        } == 0
        {
            return Err(E::SpaceUnknown);
        }
        u64::try_from(unsafe { info.assume_init() }.allocation).map_err(|_| E::SpaceUnknown)
    }
    fn wide(p: &std::path::Path) -> Result<Vec<u16>, E> {
        let mut v: Vec<u16> = p.as_os_str().encode_wide().collect();
        if v.contains(&0) {
            return Err(E::SpaceUnknown);
        }
        v.push(0);
        Ok(v)
    }
    fn volume(path: &std::path::Path) -> Result<(Vec<u16>, String), E> {
        let path = wide(path)?;
        let mut mount = vec![0u16; 32768];
        let mut guid = vec![0u16; 32768];
        // API docs: volume mount lookup follows the final mounted volume;
        // canonical owner paths reject symlink substitution. UNC/unsupported
        // filesystems without a volume GUID fail closed rather than guessing.
        unsafe {
            if GetVolumePathNameW(path.as_ptr(), mount.as_mut_ptr(), 32768) == 0
                || GetVolumeNameForVolumeMountPointW(mount.as_ptr(), guid.as_mut_ptr(), 32768) == 0
            {
                return Err(E::SpaceUnknown);
            }
        }
        let len = guid.iter().position(|n| *n == 0).ok_or(E::SpaceUnknown)?;
        let id = String::from_utf16(&guid[..len]).map_err(|_| E::SpaceUnknown)?;
        if id.is_empty() {
            return Err(E::SpaceUnknown);
        }
        Ok((mount, id))
    }
    pub fn query(location: &OwnedLocation) -> Result<Capacity, E> {
        let (mount, id) = volume(&location.database)?;
        if volume(&location.root)?.1 != id {
            return Err(E::VolumeMismatch);
        }
        let dir = wide(&location.root)?;
        let (mut available, mut total, mut free) = (0u64, 0u64, 0u64);
        let (mut sectors, mut bytes, mut clusters, mut all) = (0u32, 0u32, 0u32, 0u32);
        let file = std::fs::File::open(&location.database).map_err(|_| E::SpaceUnknown)?;
        let mut info = std::mem::MaybeUninit::<FileInfo>::uninit();
        // Buffer layouts are Win32 FILETIME/BY_HANDLE_FILE_INFORMATION; handles
        // and all output pointers remain live for these synchronous calls.
        unsafe {
            if GetDiskFreeSpaceExW(dir.as_ptr(), &mut available, &mut total, &mut free) == 0
                || GetDiskFreeSpaceW(
                    mount.as_ptr(),
                    &mut sectors,
                    &mut bytes,
                    &mut clusters,
                    &mut all,
                ) == 0
                || GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) == 0
            {
                return Err(E::SpaceUnknown);
            }
            let info = info.assume_init();
            let allocation_unit = (sectors as u64)
                .checked_mul(bytes as u64)
                .filter(|n| *n > 0)
                .ok_or(E::SpaceUnknown)?;
            if available > total {
                return Err(E::SpaceUnknown);
            }
            location.validate()?;
            if volume(&location.database)?.1 != id {
                return Err(E::VolumeMismatch);
            }
            Ok(Capacity {
                available,
                allocation_unit,
                volume: id,
                file_identity: ((info.serial as u128) << 64)
                    | ((info.index_high as u128) << 32)
                    | info.index_low as u128,
            })
        }
    }
}

#[cfg(target_os = "android")]
mod platform {
    use super::*;
    use std::os::{fd::AsRawFd, unix::fs::MetadataExt};
    pub fn allocated(path: &std::path::Path) -> Result<u64, E> {
        std::fs::metadata(path)
            .map_err(|_| E::SpaceUnknown)?
            .blocks()
            .checked_mul(512)
            .ok_or(E::Overflow)
    }
    pub fn query(location: &OwnedLocation) -> Result<Capacity, E> {
        let file = std::fs::File::open(&location.database).map_err(|_| E::SpaceUnknown)?;
        let meta = file.metadata().map_err(|_| E::SpaceUnknown)?;
        if std::fs::metadata(&location.root)
            .map_err(|_| E::SpaceUnknown)?
            .dev()
            != meta.dev()
        {
            return Err(E::VolumeMismatch);
        }
        let mut info = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        // fstatvfs is available below minSdk24; use the open owned DB fd.
        if unsafe { libc::fstatvfs(file.as_raw_fd(), info.as_mut_ptr()) } != 0 {
            return Err(E::SpaceUnknown);
        }
        let info = unsafe { info.assume_init() };
        if info.f_flag & libc::ST_RDONLY as libc::c_ulong != 0 {
            return Err(E::SpaceUnknown);
        }
        let unit = u64::try_from(info.f_frsize)
            .ok()
            .filter(|n| *n > 0)
            .ok_or(E::SpaceUnknown)?;
        let available = u64::try_from(info.f_bavail)
            .map_err(|_| E::Overflow)?
            .checked_mul(unit)
            .ok_or(E::Overflow)?;
        Ok(Capacity {
            available,
            allocation_unit: unit,
            volume: meta.dev().to_string(),
            file_identity: ((meta.dev() as u128) << 64) | meta.ino() as u128,
        })
    }
}

// No direct Linux libc dependency or installed target in this checkout.
// Keep the unsupported provider explicit; never fabricate cross-platform proof.
#[cfg(not(any(windows, target_os = "android")))]
mod platform {
    use super::*;
    pub fn allocated(_: &std::path::Path) -> Result<u64, E> {
        Err(E::SpaceUnknown)
    }
    pub fn query(_: &OwnedLocation) -> Result<Capacity, E> {
        Err(E::SpaceUnknown)
    }
}
