fn main() {
    // Android 15+ devices may use 16 KB memory pages and Google Play requires 16 KB
    // aligned native libraries; NDK r27 links with 4 KB alignment by default.
    // Emitted here (not via rustflags) so it holds however the Tauri CLI sets RUSTFLAGS.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg-cdylib=-Wl,-z,max-page-size=16384");
    }
    tauri_build::build()
}
