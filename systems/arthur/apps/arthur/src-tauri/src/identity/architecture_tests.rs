//! The pure core must stay pure: no network, no SQLite, no Graph, no storage, no providers. Checked on the source text.

const FILES: [(&str, &str); 6] = [
    ("mod.rs", include_str!("mod.rs")),
    ("types.rs", include_str!("types.rs")),
    ("classifier.rs", include_str!("classifier.rs")),
    ("policy.rs", include_str!("policy.rs")),
    ("resolver.rs", include_str!("resolver.rs")),
    ("fake.rs", include_str!("fake.rs")),
];

fn forbidden() -> Vec<String> {
    [
        "rus",
        "qlite",
        "|req",
        "west",
        "|tau",
        "ri",
        "|tok",
        "io",
        "|std::",
        "net",
        "|std::",
        "fs",
        "|crate::",
        "storage",
        "|crate::",
        "graph",
        "|crate::",
        "providers",
        "|crate::",
        "recall",
        "|crate::",
        "distillation",
    ]
    .concat()
    .split('|')
    .map(str::to_string)
    .collect()
}

#[test]
fn the_identity_core_imports_nothing_that_can_reach_a_network_a_database_or_the_graph() {
    let banned = forbidden();
    assert!(banned.len() >= 9);
    for (name, source) in FILES {
        // Only code lines count; the module docs may name what is excluded.
        for line in source
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
        {
            for word in &banned {
                assert!(
                    !line.contains(word.as_str()),
                    "{name}: `{line}` mentions `{word}`"
                );
            }
        }
    }
}

#[test]
fn the_kind_list_equals_the_stores() {
    assert_eq!(super::types::KINDS, crate::storage::knowledge_store::KINDS);
}

#[test]
fn the_setting_is_off_by_default_and_no_policy_accepts_a_model_until_one_is_named() {
    let policy = super::ResolverPolicy::default();
    assert!(!super::policy::DEFAULT_ENABLED && !policy.enabled);
    assert!(policy.accepted_models.is_empty());
    assert!(
        !crate::graph::integration::DEFAULT_ENABLED,
        "Automatic Connections stays default OFF"
    );
}
