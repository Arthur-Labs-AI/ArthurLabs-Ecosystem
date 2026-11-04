//! The adapter stays a provider boundary: it must not reach the database, the graph, Recall, the revision/distillation storage or
//! any UI-facing command, and nothing that ships may construct it yet.

const FILES: [(&str, &str); 6] = [
    ("mod.rs", include_str!("mod.rs")),
    ("client.rs", include_str!("client.rs")),
    ("consent.rs", include_str!("consent.rs")),
    ("protocol.rs", include_str!("protocol.rs")),
    ("provider.rs", include_str!("provider.rs")),
    ("transport.rs", include_str!("transport.rs")),
];

#[test]
fn the_adapter_imports_no_storage_graph_recall_or_command_code() {
    let banned = [
        ["rus", "qlite"].concat(),
        ["crate::", "storage"].concat(),
        ["crate::", "graph"].concat(),
        ["crate::", "recall"].concat(),
        ["crate::", "commands"].concat(),
        ["tau", "ri::"].concat(),
    ];
    for (name, source) in FILES {
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
fn no_shipped_code_constructs_or_enables_the_adapter() {
    for (name, source) in [
        ("lib.rs", include_str!("../lib.rs")),
        (
            "commands/distill.rs",
            include_str!("../commands/distill.rs"),
        ),
        ("commands/ai.rs", include_str!("../commands/ai.rs")),
        (
            "commands/integration.rs",
            include_str!("../commands/integration.rs"),
        ),
        (
            "distillation/mod.rs",
            include_str!("../distillation/mod.rs"),
        ),
    ] {
        for word in [
            "JevIdentityProvider",
            "JevConsent",
            "ReqwestTransport",
            "jev::",
        ] {
            assert!(!source.contains(word), "{name} mentions {word}");
        }
    }
}

#[test]
fn the_endpoint_and_model_are_constants_and_the_model_is_pinned() {
    assert_eq!(super::JEV_ENDPOINT, "https://api.typesafe.ai/v1/systemone");
    assert_eq!(super::JEV_MODEL, "jev-1.13.0");
    for (name, source) in FILES {
        assert!(
            !source.contains("jev-latest") || name == "mod.rs",
            "{name} must not name an alias"
        );
    }
    let protocol = include_str!("protocol.rs");
    assert!(
        protocol.contains("JEV_MODEL") && !protocol.contains("\"jev-"),
        "the request model comes from the pinned constant"
    );
}
