//! Production import policy, including explicit checks on every qualification exception.
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

// Each exception names its actual declaration, not a filename pattern. Inherited
// fixtures must follow a previously verified test/qualification parent. Platform
// selectors alone are never accepted as test guards.
struct QualifiedSource {
    file: &'static str,
    parent: &'static str,
    declaration: &'static str,
    inherited: bool,
}

const QUALIFIED: &[QualifiedSource] = &[
    // These three native labs compose owner-backed stores. They are the only
    // sync/security sources allowed to reference storage directly.
    QualifiedSource { file: "sync/security/tests.rs", parent: "native_security/mod.rs", declaration: "#[cfg(test)] #[path = \"../sync/security/tests.rs\"] mod tests;", inherited: false },
    QualifiedSource { file: "sync/security/tls_lab.rs", parent: "native_security/mod.rs", declaration: "#[cfg(any(test, all(target_os = \"android\", feature = \"android-identity-tests\")))] #[path = \"../sync/security/tls_lab.rs\"] pub(crate) mod tls_lab;", inherited: false },
    QualifiedSource { file: "sync/security/tls_socket_lab.rs", parent: "native_security/mod.rs", declaration: "#[cfg(any(test, all(target_os = \"android\", feature = \"android-identity-tests\")))] #[path = \"../sync/security/tls_socket_lab.rs\"] pub(crate) mod tls_socket_lab;", inherited: false },
    // SQL fixtures retain their original storage paths and original gates.
    // R8 composes the existing engine/TLS with owner-backed SQL fixtures.
    // Check the exact test-only declaration; never exempt a production module.
    QualifiedSource { file: "storage/signed_sync_tests.rs", parent: "storage/mod.rs", declaration: "#[cfg(test)] #[cfg(windows)] mod signed_sync_tests;", inherited: false },
    QualifiedSource { file: "storage/signed_profile_fault_tests.rs", parent: "storage/signed_sync_tests.rs", declaration: "#[path = \"signed_profile_fault_tests.rs\"] mod faults;", inherited: true },
    QualifiedSource { file: "storage/security_e2_tests.rs", parent: "native_security/mod.rs", declaration: "#[cfg(test)] #[path = \"../storage/security_e2_tests.rs\"] mod e2_tests;", inherited: false },
    QualifiedSource { file: "storage/security_android_instrumentation.rs", parent: "storage/mod.rs", declaration: "#[cfg(all(target_os = \"android\", feature = \"android-identity-tests\"))] mod security_android_instrumentation;", inherited: false },
    QualifiedSource { file: "storage/security_pake_tests.rs", parent: "storage/mod.rs", declaration: "#[cfg(any(test, all(target_os = \"android\", feature = \"android-identity-tests\")))] pub(crate) mod security_pake_tests;", inherited: false },
    QualifiedSource { file: "storage/security_tls_tests.rs", parent: "storage/mod.rs", declaration: "#[cfg(any(test, all(target_os = \"android\", feature = \"android-identity-tests\")))] pub(crate) mod security_tls_tests;", inherited: false },
    QualifiedSource { file: "storage/journal/sync_fixtures.rs", parent: "storage/journal/mod.rs", declaration: "#[cfg(test)] pub(crate) mod sync_fixtures;", inherited: false },
    QualifiedSource { file: "storage/journal/physical_tests.rs", parent: "storage/journal/mod.rs", declaration: "#[cfg(test)] mod physical_tests;", inherited: false },
    QualifiedSource { file: "storage/journal/import_physical_tests.rs", parent: "storage/journal/physical_tests.rs", declaration: "#[path = \"import_physical_tests.rs\"] mod import;", inherited: true },
    QualifiedSource { file: "storage/journal/tls_qualification.rs", parent: "storage/journal/mod.rs", declaration: "#[cfg(all(any(windows, target_os = \"android\"), any(test, all(target_os = \"android\", feature = \"android-identity-tests\"))))] pub(crate) mod tls_qualification;", inherited: false },
    QualifiedSource { file: "storage/journal/cross_device_qualification.rs", parent: "storage/journal/mod.rs", declaration: "#[cfg(all(any(windows, target_os = \"android\"), any(test, all(target_os = \"android\", feature = \"android-identity-tests\"))))] pub(crate) mod cross_device_qualification;", inherited: false },
    QualifiedSource { file: "storage/sync_tests.rs", parent: "sync/mod.rs", declaration: "#[cfg(test)] #[path = \"../storage/sync_tests.rs\"] mod tests;", inherited: false },
    QualifiedSource { file: "storage/sync_d3_tests.rs", parent: "storage/sync_tests.rs", declaration: "#[path = \"sync_d3_tests.rs\"] mod d3;", inherited: true },
    QualifiedSource { file: "storage/sync_d4_tests.rs", parent: "storage/sync_d3_tests.rs", declaration: "#[path = \"sync_d4_tests.rs\"] mod d4;", inherited: true },
    QualifiedSource { file: "storage/sync_mvp_tests.rs", parent: "storage/sync_tests.rs", declaration: "#[path = \"sync_mvp_tests.rs\"] mod mvp1;", inherited: true },
    QualifiedSource { file: "storage/sync_tls_tests.rs", parent: "storage/sync_tests.rs", declaration: "#[cfg(windows)] #[path = \"sync_tls_tests.rs\"] mod r1;", inherited: true },
    QualifiedSource { file: "storage/sync_history_tls_tests.rs", parent: "storage/sync_tls_tests.rs", declaration: "#[path = \"sync_history_tls_tests.rs\"] mod history;", inherited: true },
    QualifiedSource { file: "storage/sync_r6_tests.rs", parent: "storage/sync_history_tls_tests.rs", declaration: "#[path = \"sync_r6_tests.rs\"] mod r6;", inherited: true },
];

fn source_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}
fn read(path: &Path) -> String {
    fs::read_to_string(path).expect("read checked Rust source")
}
fn compact(text: &str) -> String {
    // Commas may be added by rustfmt in multiline attributes.
    text.chars()
        .filter(|c| !c.is_whitespace() && *c != ',')
        .collect()
}
fn verified_qualification_sources(src: &Path) -> BTreeSet<String> {
    let mut checked = BTreeSet::new();
    for entry in QUALIFIED {
        assert!(
            src.join(entry.file).is_file(),
            "missing exception {}",
            entry.file
        );
        if entry.inherited {
            assert!(
                checked.contains(entry.parent),
                "unverified parent {}",
                entry.parent
            );
        } else {
            assert!(
                entry.declaration.contains("#[cfg(test)]")
                    || entry
                        .declaration
                        .contains("feature = \"android-identity-tests\"")
            );
        }
        assert!(
            compact(&read(&src.join(entry.parent))).contains(&compact(entry.declaration)),
            "{} lost its explicit qualification declaration in {}",
            entry.file,
            entry.parent
        );
        assert!(
            checked.insert(entry.file.to_owned()),
            "duplicate exception {}",
            entry.file
        );
    }
    checked
}

fn rust_files(dir: &Path, result: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("checked source directory exists") {
        let file = entry.expect("read source directory entry").path();
        if file.is_dir() {
            rust_files(&file, result);
        } else if file.extension().is_some_and(|ext| ext == "rs") {
            result.push(file);
        }
    }
}

// Lex enough Rust to distinguish paths from comments and normal/raw strings.
// This checks fully-qualified expressions as well as grouped/multiline imports.
fn tokens(source: &str) -> Vec<String> {
    let bytes = source.as_bytes();
    let mut at = 0;
    let mut out = Vec::new();
    while at < bytes.len() {
        if bytes[at..].starts_with(b"//") {
            while at < bytes.len() && bytes[at] != b'\n' {
                at += 1;
            }
        } else if bytes[at..].starts_with(b"/*") {
            let mut depth = 1;
            at += 2;
            while at < bytes.len() && depth > 0 {
                if bytes[at..].starts_with(b"/*") {
                    depth += 1;
                    at += 2;
                } else if bytes[at..].starts_with(b"*/") {
                    depth -= 1;
                    at += 2;
                } else {
                    at += 1;
                }
            }
        } else {
            let raw_start = if bytes[at] == b'r' {
                Some(at + 1)
            } else if bytes[at..].starts_with(b"br") {
                Some(at + 2)
            } else {
                None
            };
            if let Some(start) = raw_start {
                let mut quote = start;
                while quote < bytes.len() && bytes[quote] == b'#' {
                    quote += 1;
                }
                if quote < bytes.len() && bytes[quote] == b'"' {
                    let hashes = quote - start;
                    at = quote + 1;
                    while at < bytes.len() {
                        if bytes[at] == b'"'
                            && bytes
                                .get(at + 1..at + 1 + hashes)
                                .is_some_and(|suffix| suffix.iter().all(|b| *b == b'#'))
                        {
                            at += 1 + hashes;
                            break;
                        }
                        at += 1;
                    }
                    continue;
                }
            }
            if bytes[at] == b'"' {
                at += 1;
                while at < bytes.len() {
                    if bytes[at] == b'\\' {
                        at = (at + 2).min(bytes.len());
                    } else if bytes[at] == b'"' {
                        at += 1;
                        break;
                    } else {
                        at += 1;
                    }
                }
            } else if bytes[at].is_ascii_alphabetic() || bytes[at] == b'_' {
                let start = at;
                at += 1;
                while at < bytes.len() && (bytes[at].is_ascii_alphanumeric() || bytes[at] == b'_') {
                    at += 1;
                }
                out.push(source[start..at].to_owned());
            } else if bytes[at..].starts_with(b"::") {
                out.push("::".to_owned());
                at += 2;
            } else {
                if !bytes[at].is_ascii_whitespace() {
                    out.push(char::from(bytes[at]).to_string());
                }
                at += 1;
            }
        }
    }
    out
}

fn crate_roots(source: &str) -> Vec<String> {
    let tokens = tokens(source);
    let mut roots = Vec::new();
    for at in 0..tokens.len().saturating_sub(2) {
        if tokens[at] != "crate" || tokens[at + 1] != "::" {
            continue;
        }
        if tokens[at + 2] != "{" {
            roots.push(tokens[at + 2].clone());
            continue;
        }
        let mut depth = 0;
        let mut branch = true;
        for token in &tokens[at + 3..] {
            match token.as_str() {
                "{" => depth += 1,
                "}" if depth == 0 => break,
                "}" => depth -= 1,
                "," if depth == 0 => branch = true,
                _ if branch && depth == 0 => {
                    roots.push(token.clone());
                    branch = false;
                }
                _ => {}
            }
        }
    }
    roots
}

#[test]
fn import_scan_detects_grouped_paths_and_ignores_comments_and_strings() {
    assert_eq!(
        crate_roots("use crate::{sync::{A, B}, storage as db, sync_api::X};"),
        ["sync", "storage", "sync_api"]
    );
    assert_eq!(crate_roots("let x: crate :: sync :: X;"), ["sync"]);
    assert!(crate_roots(
        "// crate::storage\n /* outer /* crate::sync */ end */ let s = \"crate::sync\";"
    )
    .is_empty());
    assert!(crate_roots(r###"let s = r##"a "quoted" crate::storage"##;"###).is_empty());
}

#[test]
fn production_storage_and_sync_have_no_cross_imports() {
    let src = source_root();
    let qualified = verified_qualification_sources(&src);
    let mut failures = Vec::new();
    for (layer, forbidden) in [("storage", "sync"), ("sync", "storage")] {
        let mut files = Vec::new();
        rust_files(&src.join(layer), &mut files);
        for file in files {
            let relative = file
                .strip_prefix(&src)
                .expect("under source root")
                .to_string_lossy()
                .replace('\\', "/");
            let roots = crate_roots(&read(&file));
            if !qualified.contains(&relative) && roots.iter().any(|root| root == forbidden) {
                failures.push(format!("{relative} refers to crate::{forbidden}"));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "Production layer violations:\n{}",
        failures.join("\n")
    );
}

#[test]
fn neutral_contract_sources_have_no_sqlite_or_implementation_imports() {
    let src = source_root();
    let mut files = Vec::new();
    rust_files(&src.join("sync_api"), &mut files);
    // These unchanged source paths are owned by sync_api via #[path], so they
    // receive the exact same purity check as files physically in sync_api.
    files.extend([
        src.join("sync/trust.rs"),
        src.join("sync/security/signed.rs"),
    ]);
    for file in files {
        let source = read(&file);
        assert!(
            !source.contains("rusqlite"),
            "{} mentions SQLite's driver",
            file.display()
        );
        let roots = crate_roots(&source);
        assert!(
            !roots.iter().any(|root| root == "storage" || root == "sync"),
            "{} imports an implementation",
            file.display()
        );
    }
}
