/// Operating system this build runs on, as one of the `ArthurPlatform` values in
/// `packages/contracts/api.ts`. Android reports `android`, not `linux`.
pub fn current() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "unknown"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_a_known_contract_platform() {
        let known = ["linux", "windows", "android", "macos", "ios", "unknown"];
        assert!(known.contains(&current()));
    }
}
