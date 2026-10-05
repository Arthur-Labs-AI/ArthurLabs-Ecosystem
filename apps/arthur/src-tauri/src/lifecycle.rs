//! How the process ends.
//!
//! On Android the Activity being destroyed ends the event loop, and `tao` then calls `std::process::exit`. That is libc
//! `exit()`: it runs every `atexit` handler and C++ static destructor in the process, here including those of the
//! in-process Chromium WebView, while ~65 other threads (WebView, tokio, binder) are still alive. Chromium's statics are
//! not written to be destroyed that way, and the process intermittently aborts with
//! `FORTIFY: pthread_mutex_lock called on a destroyed mutex`. Measured: `RunEvent::Exit` fires, 78 ms later the atexit
//! handlers start, 250 ms after that the abort, all on the Rust event-loop thread.
//!
//! Nothing Arthur owns needs those destructors: SQLite commits are durable when they return, and recordings that were
//! not deleted are purged at the next launch. So when the app is exiting we leave with `_exit`, which ends the process
//! immediately without running them. This is not a way to hide the abort: the destructors that caused it never run.

/// Ends the process now, without running atexit handlers or static destructors. Used from `RunEvent::Exit`.
#[cfg(target_os = "android")]
pub fn leave_process() {
    // SAFETY: `_exit` has no preconditions. It never returns.
    unsafe { libc::_exit(0) }
}

/// Other platforms keep the default, orderly exit.
#[cfg(not(target_os = "android"))]
pub fn leave_process() {}
