use serde::Serialize;

use crate::platform;

/// Mirrors `RuntimeInfo` in `packages/contracts/api.ts`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub app_version: &'static str,
    pub platform: &'static str,
}

pub fn runtime_info() -> RuntimeInfo {
    RuntimeInfo {
        app_version: env!("CARGO_PKG_VERSION"),
        platform: platform::current(),
    }
}

#[tauri::command]
pub fn get_runtime_info() -> RuntimeInfo {
    runtime_info()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_the_contract_shape() {
        let value = serde_json::to_value(runtime_info()).expect("serializes");
        let object = value.as_object().expect("is an object");

        assert_eq!(object.len(), 2);
        assert_eq!(object["appVersion"], env!("CARGO_PKG_VERSION"));
        assert_eq!(object["platform"], platform::current());
    }
}
