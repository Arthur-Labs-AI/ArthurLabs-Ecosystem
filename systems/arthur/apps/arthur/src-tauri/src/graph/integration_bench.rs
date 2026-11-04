//! M04.7A Automatic Graph Integration benchmark: EVENTS, not isolated pair classification.
//!
//! A scenario is a project, an initial set of objects and a sequence of events (a Capture distilled into a new object, an edit that
//! changes meaning). Every event goes through the real `IntegrationService` (policy, discovery, decision, guarded write, ledger) and the
//! persisted graph is scored against labelled facts.
//!
//! Two tiers share one corpus and one scorer:
//!
//! * `integration_benchmark` (always runs) drives the pipeline with the scripted double. It measures everything that does NOT depend on
//!   a model's judgement: whether discovery nominates the right partner, project leakage, duplicates, user-relation mutation,
//!   direction handling of admitted edges, retraction of relations that stopped holding, idempotence, and the provider budget. The
//!   double answers from the corpus's own labels, so its precision/recall say NOTHING about a real model and are not reported as such.
//! * `live_integration_benchmark` (ignored) drives the same corpus through the real OpenAI proposer and verifier and reports relation
//!   precision, recall, type and direction accuracy, false positives per object and every questionable edge. This is the number the
//!   production quality gate (precision >= 0.90) is about.
//!
//! `cargo test --lib integration_benchmark -- --nocapture`
//! `ARTHUR_LIVE_KEY_FILE=/path/to/key cargo test --lib live_integration_benchmark -- --ignored --nocapture`

use std::collections::{BTreeSet, HashSet};
use std::sync::Arc;

use super::integration::*;
use super::integration_tests::{Double, Fact};
use super::verify::RelationVerifier;
use super::{GraphService, RelationProposer};
use crate::recall::settings::SemanticSettings;
use crate::recall::testing::{run, ConceptEmbedder, Lab};
use crate::recall::RecallService;
use crate::storage::relation_store::{is_symmetric, NewRelation, Relation};

struct Obj(&'static str, &'static str, &'static str);

enum Action {
    /// A capture is distilled into one new object.
    Capture(Obj),
    /// Several captures arrive together and are integrated concurrently.
    Burst(Vec<Obj>),
    /// An existing object (matched by title) is edited and becomes current with the new body.
    Edit(&'static str, &'static str),
}

struct Step {
    action: Action,
    /// The world after this step (what a perfect judge would accept). `None` keeps the previous world.
    world: Option<&'static [Fact]>,
    /// Edges that SHOULD exist after this step.
    expect: &'static [Fact],
    /// Plausible edges: acceptable if present, not required.
    maybe: &'static [Fact],
    /// Edges that must NOT exist after this step (hard negatives, retractions).
    forbid: &'static [Fact],
}

#[derive(Default)]
struct Scenario {
    name: &'static str,
    seed: Vec<Obj>,
    /// Objects of ANOTHER open project. No edge may ever reach them.
    elsewhere: Vec<Obj>,
    /// Objects of an ARCHIVED project. No edge may ever reach them.
    archived: Vec<Obj>,
    /// User-authored relations, present before the events. They must be exactly the same afterwards.
    user: &'static [Fact],
    /// Unrelated filler objects added to the project first (to make candidate discovery matter).
    fillers: usize,
    bulgarian_fillers: bool,
    world: &'static [Fact],
    /// Semantic-admissibility only (M04.7A.1): edges that are genuinely defensible alternatives or valid consequences of an edit, fixed by
    /// the corpus review in docs/architecture/m047a1-benchmark-review.md. They never change the strict (pre-registered) scoring.
    acceptable: &'static [Fact],
    /// Unseen cases written before the M04.7A.1 prompts were finalised; run once, never tuned against.
    holdout: bool,
    /// The M04.7A.2 expanded corpus (`corpus_v2`).
    v2: bool,
    steps: Vec<Step>,
}

macro_rules! step {
    ($action:expr, expect: $e:expr, maybe: $m:expr, forbid: $f:expr) => {
        Step {
            action: $action,
            world: None,
            expect: $e,
            maybe: $m,
            forbid: $f,
        }
    };
    ($action:expr, world: $w:expr, expect: $e:expr, maybe: $m:expr, forbid: $f:expr) => {
        Step {
            action: $action,
            world: Some($w),
            expect: $e,
            maybe: $m,
            forbid: $f,
        }
    };
}

fn corpus() -> Vec<Scenario> {
    use Action::*;
    vec![
        Scenario {
            name: "mobile-offline (en): extends, depends_on, duplicates, retraction",
            seed: vec![
                Obj(
                    "idea",
                    "Arthur on mobile and desktop",
                    "Arthur should work on mobile and desktop.",
                ),
                Obj(
                    "decision",
                    "Use Tauri v2",
                    "Use Tauri v2 for the unified client.",
                ),
                Obj(
                    "task",
                    "Android voice capture",
                    "Implement Android voice capture.",
                ),
            ],
            elsewhere: vec![Obj(
                "idea",
                "Mobile garden planner",
                "A mobile app for planning the garden on a phone and a desktop.",
            )],
            archived: vec![Obj(
                "idea",
                "Old mobile thought",
                "Arthur on mobile was once a desktop-only idea.",
            )],
            user: &[],
            fillers: 0,
            bulgarian_fillers: false,
            acceptable: &[
                (
                    "derived_from",
                    "Local SQLite storage",
                    "Phone works offline",
                ),
                ("extends", "Local SQLite storage", "Phone works offline"),
                ("contradicts", "Local SQLite storage", "Phone works offline"),
                ("contradicts", "Phone offline mode", "Phone works offline"),
            ],
            holdout: false,
            v2: false,
            world: &[
                (
                    "extends",
                    "Phone works offline",
                    "Arthur on mobile and desktop",
                ),
                ("depends_on", "Phone works offline", "Local SQLite storage"),
                ("duplicates", "Phone offline mode", "Phone works offline"),
                (
                    "contradicts",
                    "Arthur on desktop only",
                    "Arthur on mobile and desktop",
                ),
            ],
            steps: vec![
                step!(Capture(Obj("idea", "Phone works offline", "The phone should still work when the PC is offline.")), expect: &[("extends", "Phone works offline", "Arthur on mobile and desktop")], maybe: &[], forbid: &[("related_to", "Phone works offline", "Use Tauri"), ("depends_on", "Arthur on mobile and desktop", "Phone works offline")]),
                step!(Capture(Obj("decision", "Local SQLite storage", "Keep captures in local SQLite storage on the phone so nothing needs the PC.")), expect: &[("depends_on", "Phone works offline", "Local SQLite storage")], maybe: &[], forbid: &[("depends_on", "Local SQLite storage", "Phone works offline")]),
                step!(Capture(Obj("task", "Buy groceries", "Buy milk and bread tomorrow.")), expect: &[], maybe: &[], forbid: &[("related_to", "Buy groceries", "Phone works offline"), ("related_to", "Buy groceries", "Use Tauri")]),
                step!(Capture(Obj("idea", "Arthur on desktop only", "Arthur should only run on the desktop.")), expect: &[("contradicts", "Arthur on desktop only", "Arthur on mobile and desktop")], maybe: &[], forbid: &[]),
                step!(Capture(Obj("idea", "Phone offline mode", "Offline mode for the phone: the phone works even when the PC is switched off.")), expect: &[("duplicates", "Phone offline mode", "Phone works offline")], maybe: &[("extends", "Phone offline mode", "Arthur on mobile and desktop")], forbid: &[]),
                step!(
                    Edit("Phone works offline", "Revised: the phone is only a thin client and needs the PC for everything."),
                    world: &[("contradicts", "Arthur on desktop only", "Arthur on mobile and desktop")],
                    expect: &[],
                    maybe: &[],
                    forbid: &[("depends_on", "Phone works offline", "Local SQLite storage"), ("duplicates", "Phone offline mode", "Phone works offline"), ("extends", "Phone works offline", "Arthur on mobile and desktop")]
                ),
            ],
        },
        Scenario {
            name: "offline (bg): depends_on / related_to / extends in Bulgarian",
            seed: vec![Obj(
                "idea",
                "Arthur работи без компютъра",
                "Arthur трябва да работи без компютъра.",
            )],
            elsewhere: vec![Obj(
                "idea",
                "Телефонът за градината",
                "Телефонът показва кога да се полива градината.",
            )],
            archived: vec![],
            user: &[],
            fillers: 0,
            bulgarian_fillers: true,
            acceptable: &[(
                "related_to",
                "Arthur работи без компютъра",
                "Телефонът пази знанията",
            )],
            holdout: false,
            v2: false,
            world: &[
                (
                    "depends_on",
                    "Arthur работи без компютъра",
                    "Телефонът пази знанията",
                ),
                (
                    "extends",
                    "Синхронизация с Home Node",
                    "Arthur работи без компютъра",
                ),
                (
                    "related_to",
                    "Синхронизация с Home Node",
                    "Телефонът пази знанията",
                ),
            ],
            steps: vec![
                step!(Capture(Obj("decision", "Телефонът пази знанията", "Телефонът пази знанията локално в SQLite.")), expect: &[("depends_on", "Arthur работи без компютъра", "Телефонът пази знанията")], maybe: &[], forbid: &[("depends_on", "Телефонът пази знанията", "Arthur работи без компютъра")]),
                step!(Capture(Obj("note", "Синхронизация с Home Node", "Синхронизацията с Home Node трябва да работи по-късно.")), expect: &[], maybe: &[("extends", "Синхронизация с Home Node", "Arthur работи без компютъра"), ("related_to", "Синхронизация с Home Node", "Телефонът пази знанията")], forbid: &[("depends_on", "Телефонът пази знанията", "Синхронизация с Home Node")]),
                step!(Capture(Obj("task", "Купи хляб", "Утре да купя хляб и мляко.")), expect: &[], maybe: &[], forbid: &[("related_to", "Купи хляб", "Arthur работи без компютъра"), ("related_to", "Купи хляб", "Телефонът пази знанията")]),
            ],
        },
        Scenario {
            name: "bg in a large project: relevance by Bulgarian stems",
            seed: vec![Obj(
                "idea",
                "Знанията на телефона",
                "Знанията се пазят локално на телефона, без компютър.",
            )],
            elsewhere: vec![],
            archived: vec![],
            user: &[],
            fillers: 30,
            bulgarian_fillers: true,
            acceptable: &[],
            holdout: false,
            v2: false,
            world: &[(
                "extends",
                "Телефонът пази знанията локално",
                "Знанията на телефона",
            )],
            steps: vec![
                step!(Capture(Obj("decision", "Телефонът пази знанията локално", "Телефонът пази знанията локално в SQLite, за да не зависи от компютъра.")), expect: &[("extends", "Телефонът пази знанията локално", "Знанията на телефона")], maybe: &[], forbid: &[("extends", "Знанията на телефона", "Телефонът пази знанията локално")]),
            ],
        },
        Scenario {
            name: "mixed bg/en: extends and a dependency across languages",
            seed: vec![Obj(
                "idea",
                "Voice capture",
                "Voice capture turns speech into a Capture on the phone.",
            )],
            elsewhere: vec![],
            archived: vec![],
            user: &[],
            fillers: 6,
            bulgarian_fillers: false,
            acceptable: &[("depends_on", "Wake word за wristband", "Voice capture")],
            holdout: false,
            v2: false,
            world: &[
                ("extends", "Wake word за wristband", "Voice capture"),
                ("depends_on", "Wake word за wristband", "Wristband hardware"),
            ],
            steps: vec![
                step!(Capture(Obj("note", "Wristband hardware", "The wristband hardware has a microphone and a vibration motor.")), expect: &[], maybe: &[], forbid: &[("related_to", "Wristband hardware", "Voice capture")]),
                step!(Capture(Obj("task", "Wake word за wristband", "Да добавя wake word за wristband, за да започва voice capture без докосване.")), expect: &[("extends", "Wake word за wristband", "Voice capture")], maybe: &[("depends_on", "Wake word за wristband", "Wristband hardware")], forbid: &[("depends_on", "Voice capture", "Wake word за wristband")]),
            ],
        },
        Scenario {
            name: "supersedes: an explicit replacement",
            seed: vec![
                Obj(
                    "decision",
                    "Use Tailscale for sync",
                    "We decided to use Tailscale for the Home Node sync.",
                ),
                Obj(
                    "task",
                    "Email Ignatov",
                    "Tomorrow I need to email Ignatov about the competition.",
                ),
            ],
            elsewhere: vec![],
            archived: vec![],
            user: &[],
            fillers: 0,
            bulgarian_fillers: false,
            acceptable: &[(
                "contradicts",
                "Replace Tailscale with LAN link",
                "Use Tailscale for sync",
            )],
            holdout: false,
            v2: false,
            world: &[(
                "supersedes",
                "Replace Tailscale with LAN link",
                "Use Tailscale for sync",
            )],
            steps: vec![
                step!(Capture(Obj("decision", "Replace Tailscale with LAN link", "Update: we are dropping Tailscale; Home Node sync will use a LAN-only WebSocket connection instead.")), expect: &[("supersedes", "Replace Tailscale with LAN link", "Use Tailscale for sync")], maybe: &[], forbid: &[("supersedes", "Use Tailscale for sync", "Replace Tailscale with LAN link"), ("related_to", "Replace Tailscale with LAN link", "Email Ignatov")]),
            ],
        },
        Scenario {
            name: "prerequisite direction",
            seed: vec![Obj(
                "idea",
                "Cognitive Graph connects ideas",
                "The Cognitive Graph should connect related ideas instead of showing flat notes.",
            )],
            elsewhere: vec![],
            archived: vec![],
            user: &[],
            fillers: 0,
            bulgarian_fillers: false,
            acceptable: &[],
            holdout: false,
            v2: false,
            world: &[(
                "depends_on",
                "Cognitive Graph connects ideas",
                "Distillation creates KnowledgeObjects",
            )],
            steps: vec![
                step!(Capture(Obj("note", "Distillation creates KnowledgeObjects", "Before graph inference works, Thought Distillation has to create KnowledgeObjects.")), expect: &[("depends_on", "Cognitive Graph connects ideas", "Distillation creates KnowledgeObjects")], maybe: &[], forbid: &[("depends_on", "Distillation creates KnowledgeObjects", "Cognitive Graph connects ideas")]),
            ],
        },
        Scenario {
            name: "hard negatives: same vocabulary, no relation",
            seed: vec![
                Obj("note", "Arthur colours", "Arthur uses warm paper colours."),
                Obj(
                    "note",
                    "Arthur naming",
                    "Arthur is named after the assistant in the books.",
                ),
            ],
            elsewhere: vec![],
            archived: vec![],
            user: &[],
            fillers: 0,
            bulgarian_fillers: false,
            acceptable: &[],
            holdout: false,
            v2: false,
            world: &[],
            steps: vec![
                step!(Capture(Obj("idea", "Arthur battery", "The Arthur wristband battery should last a week.")), expect: &[], maybe: &[], forbid: &[("related_to", "Arthur battery", "Arthur colours"), ("related_to", "Arthur battery", "Arthur naming")]),
                step!(Capture(Obj("idea", "Arthur weekend", "Arthur should remind me about the weekend.")), expect: &[], maybe: &[], forbid: &[("related_to", "Arthur weekend", "Arthur colours"), ("related_to", "Arthur weekend", "Arthur battery")]),
            ],
        },
        Scenario {
            name: "user relations are protected through a retracting edit",
            seed: vec![
                Obj("idea", "Plan the report", "Plan the quarterly report."),
                Obj(
                    "task",
                    "Collect the data",
                    "Collect the data for the quarterly report.",
                ),
            ],
            elsewhere: vec![],
            archived: vec![],
            user: &[("related_to", "Plan the report", "Collect the data")],
            fillers: 0,
            bulgarian_fillers: false,
            acceptable: &[("contradicts", "Write the report", "Collect the data")],
            holdout: false,
            v2: false,
            world: &[("depends_on", "Write the report", "Collect the data")],
            steps: vec![
                step!(Capture(Obj("task", "Write the report", "Write the quarterly report once the data has been collected.")), expect: &[("depends_on", "Write the report", "Collect the data")], maybe: &[], forbid: &[]),
                step!(Edit("Write the report", "Write the quarterly report from memory; no data is needed any more."), world: &[], expect: &[], maybe: &[], forbid: &[("depends_on", "Write the report", "Collect the data")]),
            ],
        },
        Scenario {
            name: "burst: five related captures integrated together",
            seed: vec![],
            elsewhere: vec![],
            archived: vec![],
            user: &[],
            fillers: 0,
            bulgarian_fillers: false,
            acceptable: &[("depends_on", "Sync status screen", "Sync service")],
            holdout: false,
            v2: false,
            world: &[
                ("depends_on", "Sync service", "Pairing"),
                ("depends_on", "Pairing", "Local identity"),
                ("extends", "Sync conflict rules", "Sync service"),
                ("related_to", "Sync service", "Sync status screen"),
            ],
            steps: vec![step!(
                Burst(vec![
                    Obj("task", "Sync service", "Build the sync service between the phone and the Home Node."),
                    Obj("task", "Pairing", "Pairing must exist before the sync service can talk to a device."),
                    Obj("decision", "Local identity", "Each device keeps a local identity key used when pairing."),
                    Obj("idea", "Sync conflict rules", "Detailed conflict rules for the sync service when both sides changed."),
                    Obj("idea", "Sync status screen", "A screen that shows the state of the sync service.")
                ]),
                expect: &[("depends_on", "Sync service", "Pairing"), ("depends_on", "Pairing", "Local identity"), ("extends", "Sync conflict rules", "Sync service")],
                maybe: &[("related_to", "Sync service", "Sync status screen")],
                forbid: &[("depends_on", "Pairing", "Sync service")]
            )],
        },
        Scenario {
            name: "old partner in a large project (candidate discovery beyond recency)",
            seed: vec![Obj(
                "decision",
                "Capture-first home screen",
                "The home screen opens straight into capture, not a feed.",
            )],
            elsewhere: vec![],
            archived: vec![],
            user: &[],
            fillers: 60,
            bulgarian_fillers: false,
            acceptable: &[(
                "depends_on",
                "Capture shortcut on lock screen",
                "Capture-first home screen",
            )],
            holdout: false,
            v2: false,
            world: &[(
                "extends",
                "Capture shortcut on lock screen",
                "Capture-first home screen",
            )],
            steps: vec![
                step!(Capture(Obj("idea", "Capture shortcut on lock screen", "A lock-screen shortcut that opens the capture-first home screen in one tap.")), expect: &[("extends", "Capture shortcut on lock screen", "Capture-first home screen")], maybe: &[], forbid: &[]),
            ],
        },
        // ----- Bulgarian holdout (M04.7A.1): unseen, written before the prompts were finalised, run once, never tuned against. -----
        Scenario {
            name: "holdout bg: depends_on",
            seed: vec![Obj(
                "note",
                "Датчик за влага",
                "Датчикът измерва влагата в почвата и дава число.",
            )],
            world: &[("depends_on", "Автоматично поливане", "Датчик за влага")],
            holdout: true,
            v2: false,
            steps: vec![
                step!(Capture(Obj("task", "Автоматично поливане", "Помпата да се включва само когато датчикът за влага покаже суха почва.")), expect: &[("depends_on", "Автоматично поливане", "Датчик за влага")], maybe: &[], forbid: &[("depends_on", "Датчик за влага", "Автоматично поливане")]),
            ],
            ..Default::default()
        },
        Scenario {
            name: "holdout bg: contradicts",
            seed: vec![Obj(
                "decision",
                "Данни в облака",
                "Решихме всички данни да се пазят в облака.",
            )],
            world: &[("contradicts", "Само локални данни", "Данни в облака")],
            holdout: true,
            v2: false,
            steps: vec![
                step!(Capture(Obj("decision", "Само локални данни", "Данните да не напускат устройството – нищо не се качва в облака.")), expect: &[("contradicts", "Само локални данни", "Данни в облака")], maybe: &[], forbid: &[("depends_on", "Само локални данни", "Данни в облака"), ("duplicates", "Само локални данни", "Данни в облака")]),
            ],
            ..Default::default()
        },
        Scenario {
            name: "holdout bg: supersedes",
            seed: vec![Obj(
                "decision",
                "Среща в понеделник",
                "Срещата с екипа е в понеделник в 10 часа.",
            )],
            world: &[(
                "supersedes",
                "Срещата се мести в сряда",
                "Среща в понеделник",
            )],
            acceptable: &[(
                "contradicts",
                "Срещата се мести в сряда",
                "Среща в понеделник",
            )],
            holdout: true,
            v2: false,
            steps: vec![
                step!(Capture(Obj("decision", "Срещата се мести в сряда", "Промяна: срещата с екипа се мести в сряда, понеделник отпада.")), expect: &[("supersedes", "Срещата се мести в сряда", "Среща в понеделник")], maybe: &[], forbid: &[("supersedes", "Среща в понеделник", "Срещата се мести в сряда")]),
            ],
            ..Default::default()
        },
        Scenario {
            name: "holdout bg/en: duplicates across languages",
            seed: vec![Obj(
                "idea",
                "Ранно ставане",
                "Искам да ставам в шест сутринта всеки ден.",
            )],
            world: &[("duplicates", "Wake up at six", "Ранно ставане")],
            holdout: true,
            v2: false,
            steps: vec![
                step!(Capture(Obj("idea", "Wake up at six", "Every day I should wake up at six in the morning.")), expect: &[("duplicates", "Wake up at six", "Ранно ставане")], maybe: &[], forbid: &[("contradicts", "Wake up at six", "Ранно ставане")]),
            ],
            ..Default::default()
        },
        Scenario {
            name: "holdout bg: extends",
            seed: vec![Obj(
                "idea",
                "Седмичен план",
                "Всяка неделя си правя план за седмицата.",
            )],
            world: &[("extends", "Седмичен план с цели", "Седмичен план")],
            holdout: true,
            v2: false,
            steps: vec![
                step!(Capture(Obj("idea", "Седмичен план с цели", "Към седмичния план добавям три цели за всяка седмица и проверка в петък.")), expect: &[("extends", "Седмичен план с цели", "Седмичен план")], maybe: &[], forbid: &[("extends", "Седмичен план", "Седмичен план с цели")]),
            ],
            ..Default::default()
        },
        Scenario {
            name: "holdout bg: hard negatives",
            seed: vec![
                Obj("note", "Рецепта за хляб", "Брашно, вода, мая и сол."),
                Obj(
                    "note",
                    "Кола на сервиз",
                    "Колата е при сервиза до четвъртък.",
                ),
            ],
            world: &[],
            holdout: true,
            v2: false,
            steps: vec![
                step!(Capture(Obj("task", "Купи мляко", "Утре да купя мляко и яйца.")), expect: &[], maybe: &[], forbid: &[("related_to", "Купи мляко", "Рецепта за хляб"), ("related_to", "Купи мляко", "Кола на сервиз")]),
            ],
            ..Default::default()
        },
    ]
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The expanded corpus (M04.7A.2): single-relation cases generated from a table, plus multi-event scenarios.

/// `(holdout, relation kind or "none", language, seed object, new object, who is the source: "new" | "seed", acceptable alternatives)`.
/// For symmetric kinds the source does not matter. "none" = a hard negative (no relation of any kind).
type PairCase = (
    bool,
    &'static str,
    &'static str,
    Obj,
    Obj,
    &'static str,
    &'static [&'static str],
);

fn pair_cases() -> Vec<PairCase> {
    use std::vec;
    vec![
        // depends_on (the seed needs the new object)
        (
            false,
            "depends_on",
            "en",
            Obj(
                "task",
                "Publish the podcast",
                "Publish the first podcast episode on Friday.",
            ),
            Obj(
                "task",
                "Record the episode",
                "Record the first podcast episode before publishing.",
            ),
            "seed",
            &[],
        ),
        (
            false,
            "depends_on",
            "en",
            Obj(
                "task",
                "Send the invoice",
                "Send the March invoice to the client.",
            ),
            Obj(
                "note",
                "Client billing address",
                "The client's billing address is needed on every invoice.",
            ),
            "seed",
            &[],
        ),
        (
            true,
            "depends_on",
            "en",
            Obj("task", "Run the tests", "Run the full test suite."),
            Obj(
                "task",
                "Build the project",
                "Build the project so the tests have something to run.",
            ),
            "seed",
            &[],
        ),
        (
            true,
            "depends_on",
            "en",
            Obj(
                "decision",
                "Launch the shop",
                "Launch the online shop in May.",
            ),
            Obj(
                "task",
                "Payment provider contract",
                "The shop cannot take orders until the payment provider contract is signed.",
            ),
            "seed",
            &[],
        ),
        (
            false,
            "depends_on",
            "bg",
            Obj("task", "Печене на торта", "Печем тортата за рождения ден."),
            Obj(
                "task",
                "Купуване на брашно",
                "За тортата първо трябва да купим брашно.",
            ),
            "seed",
            &[],
        ),
        (
            true,
            "depends_on",
            "bg",
            Obj(
                "task",
                "Подаване на декларация",
                "Подаваме данъчната декларация.",
            ),
            Obj(
                "note",
                "Удостоверение от работодател",
                "Декларацията не може да се подаде без удостоверение от работодателя.",
            ),
            "seed",
            &[],
        ),
        (
            false,
            "depends_on",
            "mixed",
            Obj(
                "task",
                "Release на приложението",
                "Release the mobile app to the store.",
            ),
            Obj(
                "task",
                "Тест на Android",
                "Преди release трябва да минат тестовете на Android.",
            ),
            "seed",
            &[],
        ),
        (
            true,
            "depends_on",
            "mixed",
            Obj(
                "task",
                "Deploy на сървъра",
                "Deploy the new server version.",
            ),
            Obj(
                "note",
                "SSL certificate",
                "Без валиден SSL certificate сървърът не може да се пусне.",
            ),
            "seed",
            &[],
        ),
        (
            false,
            "depends_on",
            "en",
            Obj(
                "task",
                "Teach the class",
                "Teach the Thursday evening class.",
            ),
            Obj(
                "task",
                "Prepare the slides",
                "Slides must be ready before the Thursday class.",
            ),
            "seed",
            &[],
        ),
        (
            true,
            "depends_on",
            "en",
            Obj(
                "idea",
                "Loyalty program",
                "Start a customer loyalty program.",
            ),
            Obj(
                "decision",
                "Collect customer emails",
                "We need customer email addresses to run any loyalty program.",
            ),
            "seed",
            &[],
        ),
        // extends (the new object adds to the seed)
        (
            false,
            "extends",
            "en",
            Obj("idea", "Email newsletter", "Send customers a newsletter."),
            Obj(
                "idea",
                "Newsletter with referrals",
                "The newsletter, plus a referral link in every issue.",
            ),
            "new",
            &[],
        ),
        (
            true,
            "extends",
            "en",
            Obj("note", "Meeting notes", "Keep notes from each meeting."),
            Obj(
                "note",
                "Meeting notes with action items",
                "Meeting notes, extended with an action-item list at the end.",
            ),
            "new",
            &[],
        ),
        (
            false,
            "extends",
            "bg",
            Obj("idea", "Ежедневна разходка", "Ходя на разходка всеки ден."),
            Obj(
                "idea",
                "Разходка с подкаст",
                "Към ежедневната разходка добавям слушане на подкаст.",
            ),
            "new",
            &[],
        ),
        (
            true,
            "extends",
            "bg",
            Obj(
                "task",
                "Седмично пазаруване",
                "Пазарувам продукти за седмицата.",
            ),
            Obj(
                "task",
                "Пазаруване със списък по магазини",
                "Към седмичното пазаруване добавям списък, подреден по магазини.",
            ),
            "new",
            &[],
        ),
        (
            false,
            "extends",
            "en",
            Obj("idea", "Photo gallery", "A page showing our photos."),
            Obj(
                "idea",
                "Gallery with albums",
                "The photo gallery, grouped into albums with captions.",
            ),
            "new",
            &[],
        ),
        (
            true,
            "extends",
            "mixed",
            Obj("idea", "Reminder system", "Remind users about their tasks."),
            Obj(
                "idea",
                "Напомняния по локация",
                "Към reminder системата добавяме напомняния според местоположението.",
            ),
            "new",
            &[],
        ),
        // contradicts (symmetric)
        (
            false,
            "contradicts",
            "en",
            Obj(
                "decision",
                "Open source the code",
                "We will publish the code as open source.",
            ),
            Obj(
                "decision",
                "Keep the code private",
                "The code stays private and will not be published.",
            ),
            "new",
            &[],
        ),
        (
            true,
            "contradicts",
            "en",
            Obj(
                "decision",
                "Work remotely",
                "The whole team works remotely.",
            ),
            Obj(
                "decision",
                "Everyone in the building",
                "Everybody must work from the building every day.",
            ),
            "new",
            &[],
        ),
        (
            false,
            "contradicts",
            "bg",
            Obj(
                "decision",
                "Безплатно приложение",
                "Приложението ще е безплатно за всички.",
            ),
            Obj(
                "decision",
                "Само с абонамент",
                "Приложението ще се продава само срещу абонамент, без безплатна версия.",
            ),
            "new",
            &[],
        ),
        (
            true,
            "contradicts",
            "mixed",
            Obj(
                "decision",
                "Use dark theme only",
                "The app has only a dark theme.",
            ),
            Obj(
                "decision",
                "Светла тема за всички",
                "Приложението да има само светла тема.",
            ),
            "new",
            &[],
        ),
        // duplicates (symmetric)
        (
            false,
            "duplicates",
            "en",
            Obj(
                "idea",
                "Drink more water",
                "I should drink more water during the day.",
            ),
            Obj(
                "idea",
                "Hydration habit",
                "Build the habit of drinking water regularly through the day.",
            ),
            "new",
            &[],
        ),
        (
            true,
            "duplicates",
            "en",
            Obj(
                "task",
                "Call the dentist",
                "Call the dentist to book a check-up.",
            ),
            Obj(
                "task",
                "Book dental check-up",
                "Phone the dentist and arrange a check-up.",
            ),
            "new",
            &[],
        ),
        (
            false,
            "duplicates",
            "bg",
            Obj(
                "idea",
                "Ранни разходки",
                "Искам да се разхождам рано сутрин.",
            ),
            Obj(
                "idea",
                "Сутрешна разходка",
                "Всяка сутрин рано да излизам на разходка.",
            ),
            "new",
            &[],
        ),
        (
            true,
            "duplicates",
            "mixed",
            Obj("note", "Backup the photos", "Make a backup of all photos."),
            Obj(
                "note",
                "Резервно копие на снимките",
                "Да направя резервно копие на всички снимки.",
            ),
            "new",
            &[],
        ),
        // supersedes (the new object replaces the seed)
        (
            false,
            "supersedes",
            "en",
            Obj("decision", "Budget of 5000", "The project budget is 5000."),
            Obj(
                "decision",
                "Budget raised to 8000",
                "Update: the project budget is now 8000, replacing the earlier 5000.",
            ),
            "new",
            &["contradicts"],
        ),
        (
            true,
            "supersedes",
            "en",
            Obj("decision", "Launch in June", "We launch in June."),
            Obj(
                "decision",
                "Launch moved to September",
                "The launch moves to September; June is no longer the plan.",
            ),
            "new",
            &["contradicts"],
        ),
        (
            false,
            "supersedes",
            "bg",
            Obj(
                "decision",
                "Хостинг при доставчик А",
                "Хостваме при доставчик А.",
            ),
            Obj(
                "decision",
                "Преминаваме към доставчик Б",
                "Сменяме хостинга: вече ще е при доставчик Б, а не при А.",
            ),
            "new",
            &["contradicts"],
        ),
        (
            true,
            "supersedes",
            "bg",
            Obj("decision", "Срок до петък", "Срокът за задачата е петък."),
            Obj(
                "decision",
                "Новият срок е понеделник",
                "Срокът се измества за понеделник, петъчният отпада.",
            ),
            "new",
            &["contradicts"],
        ),
        // derived_from (the new object follows from the seed)
        (
            false,
            "derived_from",
            "en",
            Obj(
                "note",
                "Churn is rising",
                "Customer churn rose for three months in a row.",
            ),
            Obj(
                "decision",
                "Start a retention program",
                "Start a customer retention program.",
            ),
            "new",
            &["depends_on"],
        ),
        (
            true,
            "derived_from",
            "en",
            Obj(
                "note",
                "Interviews: setup is slow",
                "Five customers said setup takes too long.",
            ),
            Obj("idea", "Shorten the setup", "Cut the setup to three steps."),
            "new",
            &["depends_on"],
        ),
        (
            false,
            "derived_from",
            "bg",
            Obj("note", "Жалби за шум", "Съседите се оплакват от шум вечер."),
            Obj(
                "decision",
                "Тихи часове след 22",
                "Въвеждаме тихи часове след 22 часа.",
            ),
            "new",
            &["depends_on"],
        ),
        (
            true,
            "derived_from",
            "mixed",
            Obj(
                "note",
                "Анкета: малко време",
                "В анкетата хората казаха, че нямат време за дълги формуляри.",
            ),
            Obj(
                "idea",
                "Short forms only",
                "Make every form at most five fields.",
            ),
            "new",
            &["depends_on"],
        ),
        // related_to (a concrete link, no stronger kind)
        (
            false,
            "related_to",
            "en",
            Obj(
                "idea",
                "Garden herbs",
                "Grow basil and mint on the balcony.",
            ),
            Obj(
                "note",
                "Pasta recipes",
                "Simple pasta recipes with fresh basil.",
            ),
            "new",
            &[],
        ),
        (
            true,
            "related_to",
            "bg",
            Obj(
                "idea",
                "Билки на балкона",
                "Отглеждам босилек и мента на балкона.",
            ),
            Obj(
                "note",
                "Рецепти с босилек",
                "Рецепти за паста с пресен босилек.",
            ),
            "new",
            &[],
        ),
        (
            false,
            "related_to",
            "mixed",
            Obj("note", "Spanish lessons", "Weekly Spanish lessons on Zoom."),
            Obj(
                "note",
                "Книги на испански",
                "Списък с книги на испански за четене.",
            ),
            "new",
            &[],
        ),
        // hard negatives: shared words, no relation
        (
            false,
            "none",
            "en",
            Obj(
                "task",
                "Pay the electricity bill",
                "Pay the electricity bill by the 15th.",
            ),
            Obj(
                "note",
                "Pay attention in class",
                "Remember to pay attention during the lecture.",
            ),
            "new",
            &[],
        ),
        (
            true,
            "none",
            "en",
            Obj("note", "Apple pie recipe", "Apples, flour and butter."),
            Obj(
                "idea",
                "Apple stock price",
                "Check the Apple stock price on Monday.",
            ),
            "new",
            &[],
        ),
        (
            false,
            "none",
            "bg",
            Obj("task", "Ключ за колата", "Търся ключа за колата."),
            Obj("note", "Ключ за API", "Ключът за API е в настройките."),
            "new",
            &[],
        ),
        (
            true,
            "none",
            "bg",
            Obj("note", "Банка с мед", "Бурканът с мед е празен."),
            Obj("task", "Банка за кредит", "Да отида в банката за кредита."),
            "new",
            &[],
        ),
        (
            false,
            "none",
            "mixed",
            Obj("note", "Python script", "A Python script to rename files."),
            Obj("note", "Змията в градината", "Видях змия в градината."),
            "new",
            &[],
        ),
        (
            true,
            "none",
            "mixed",
            Obj("idea", "Cloud storage", "Move files to cloud storage."),
            Obj("note", "Облаци днес", "Днес небето е облачно."),
            "new",
            &[],
        ),
    ]
}

fn leak<T>(value: Vec<T>) -> &'static [T] {
    Box::leak(value.into_boxed_slice())
}

fn corpus_v2() -> Vec<Scenario> {
    use Action::*;
    let mut scenarios: Vec<Scenario> = Vec::new();
    for (holdout, kind, language, seed, new, source, alternatives) in pair_cases() {
        let (seed_title, new_title) = (seed.1, new.1);
        let fact: Option<Fact> = (kind != "none").then(|| {
            if source == "seed" {
                (kind, seed_title, new_title)
            } else {
                (kind, new_title, seed_title)
            }
        });
        let world: &'static [Fact] = leak(fact.into_iter().collect());
        let acceptable: &'static [Fact] = leak(
            alternatives
                .iter()
                .map(|alt| {
                    if source == "seed" {
                        (*alt, seed_title, new_title)
                    } else {
                        (*alt, new_title, seed_title)
                    }
                })
                .collect(),
        );
        let forbid: &'static [Fact] = if kind == "none" {
            leak(vec![
                ("related_to", new_title, seed_title),
                ("depends_on", new_title, seed_title),
                ("extends", new_title, seed_title),
            ])
        } else {
            &[]
        };
        let name: &'static str =
            Box::leak(format!("v2 {kind} ({language}): {new_title}").into_boxed_str());
        scenarios.push(Scenario {
            name,
            seed: vec![seed],
            world,
            acceptable,
            holdout,
            v2: true,
            steps: vec![Step {
                action: Capture(new),
                world: None,
                expect: world,
                maybe: &[],
                forbid,
            }],
            ..Default::default()
        });
    }
    // Multi-event scenarios: edits that retract, replace or add, protection of user relations, discovery in a larger project.
    scenarios.push(Scenario {
        name: "v2 team calls: supersedes and two contradictions",
        seed: vec![Obj("decision", "Weekly team call on Tuesday", "The team call happens every Tuesday at 9.")],
        world: &[("supersedes", "Team call moved to Thursday", "Weekly team call on Tuesday"), ("contradicts", "Skip team calls entirely", "Weekly team call on Tuesday"), ("contradicts", "Skip team calls entirely", "Team call moved to Thursday")],
        acceptable: &[("contradicts", "Team call moved to Thursday", "Weekly team call on Tuesday")],
        v2: true,
        steps: vec![
            step!(Capture(Obj("decision", "Team call moved to Thursday", "Update: the team call is now on Thursday; Tuesday is cancelled.")), expect: &[("supersedes", "Team call moved to Thursday", "Weekly team call on Tuesday")], maybe: &[], forbid: &[("supersedes", "Weekly team call on Tuesday", "Team call moved to Thursday")]),
            step!(Capture(Obj("idea", "Skip team calls entirely", "We should have no team calls at all; use written updates instead.")), expect: &[("contradicts", "Skip team calls entirely", "Team call moved to Thursday")], maybe: &[("contradicts", "Skip team calls entirely", "Weekly team call on Tuesday")], forbid: &[]),
        ],
        ..Default::default()
    });
    scenarios.push(Scenario {
        name: "v2 post-edit retraction: a dependency that no longer holds",
        seed: vec![Obj("task", "Ship version two", "Ship version two to customers next month.")],
        world: &[("depends_on", "Ship version two", "Fix the login bug")],
        v2: true,
        steps: vec![
            step!(Capture(Obj("task", "Fix the login bug", "Fix the login bug before shipping version two.")), expect: &[("depends_on", "Ship version two", "Fix the login bug")], maybe: &[], forbid: &[]),
            step!(Edit("Ship version two", "Version two is cancelled; we only maintain version one from now on."), world: &[], expect: &[], maybe: &[], forbid: &[("depends_on", "Ship version two", "Fix the login bug")]),
        ],
        ..Default::default()
    });
    scenarios.push(Scenario {
        name: "v2 post-edit retraction: an extension that no longer holds",
        seed: vec![Obj("idea", "Monthly newsletter", "Send a monthly newsletter.")],
        world: &[("extends", "Newsletter design", "Monthly newsletter")],
        v2: true,
        steps: vec![
            step!(Capture(Obj("idea", "Newsletter design", "Design a template for the monthly newsletter.")), expect: &[("extends", "Newsletter design", "Monthly newsletter")], maybe: &[], forbid: &[]),
            step!(Edit("Newsletter design", "Design a template for the show notes of the new podcast."), world: &[], expect: &[], maybe: &[], forbid: &[("extends", "Newsletter design", "Monthly newsletter")]),
        ],
        ..Default::default()
    });
    scenarios.push(Scenario {
        name: "v2 bg post-edit retraction",
        seed: vec![Obj("task", "Пътуване до морето", "Пътуваме до морето през август.")],
        world: &[("depends_on", "Пътуване до морето", "Резервация на хотел")],
        v2: true,
        steps: vec![
            step!(Capture(Obj("task", "Резервация на хотел", "Пътуването до морето не може да стане без резервация на хотел.")), expect: &[("depends_on", "Пътуване до морето", "Резервация на хотел")], maybe: &[], forbid: &[]),
            step!(Edit("Пътуване до морето", "Отказваме се от пътуването; оставаме си вкъщи през август."), world: &[], expect: &[], maybe: &[], forbid: &[("depends_on", "Пътуване до морето", "Резервация на хотел")]),
        ],
        ..Default::default()
    });
    scenarios.push(Scenario {
        name: "v2 user relation is protected through a retracting edit",
        seed: vec![Obj("idea", "Alpha plan", "Plan the Alpha launch."), Obj("task", "Alpha budget", "Prepare the Alpha budget.")],
        user: &[("related_to", "Alpha plan", "Alpha budget")],
        world: &[("depends_on", "Alpha launch event", "Alpha budget")],
        v2: true,
        steps: vec![
            step!(Capture(Obj("task", "Alpha launch event", "Hold the Alpha launch event once the Alpha budget is approved.")), expect: &[("depends_on", "Alpha launch event", "Alpha budget")], maybe: &[], forbid: &[]),
            step!(Edit("Alpha launch event", "The Alpha launch event is held online and costs nothing."), world: &[], expect: &[], maybe: &[], forbid: &[("depends_on", "Alpha launch event", "Alpha budget")]),
        ],
        ..Default::default()
    });
    scenarios.push(Scenario {
        name: "v2 discovery in a large project (en)",
        seed: vec![Obj("idea", "Offline cache", "Cache responses so the app works on a slow network.")],
        fillers: 30,
        world: &[("extends", "Cache invalidation", "Offline cache")],
        acceptable: &[("depends_on", "Cache invalidation", "Offline cache")],
        v2: true,
        steps: vec![step!(Capture(Obj("idea", "Cache invalidation", "Rules for invalidating the offline cache when data changes.")), expect: &[("extends", "Cache invalidation", "Offline cache")], maybe: &[], forbid: &[])],
        ..Default::default()
    });
    scenarios.push(Scenario {
        name: "v2 discovery in a large project (bg)",
        seed: vec![Obj("note", "Резервно копие", "Резервното копие се прави всяка нощ.")],
        fillers: 30,
        bulgarian_fillers: true,
        world: &[("depends_on", "Проверка на копието", "Резервно копие")],
        acceptable: &[("extends", "Проверка на копието", "Резервно копие")],
        v2: true,
        steps: vec![step!(Capture(Obj("idea", "Проверка на копието", "Всяка седмица проверявам дали резервното копие се възстановява.")), expect: &[("depends_on", "Проверка на копието", "Резервно копие")], maybe: &[], forbid: &[])],
        ..Default::default()
    });
    scenarios.push(Scenario {
        name: "v2 holdout burst: a delivery chain",
        holdout: true,
        world: &[("depends_on", "Pack the order", "Print the label"), ("depends_on", "Print the label", "Confirm the address"), ("extends", "Gift wrapping", "Pack the order")],
        v2: true,
        steps: vec![step!(
            Burst(vec![
                Obj("task", "Pack the order", "Pack the customer's order into a box once the label is ready."),
                Obj("task", "Print the label", "Print the shipping label after the address is confirmed."),
                Obj("task", "Confirm the address", "Confirm the delivery address with the customer."),
                Obj("idea", "Gift wrapping", "Packing the order, plus optional gift wrapping."),
                Obj("note", "Tape colours", "The tape comes in brown and white.")
            ]),
            expect: &[("depends_on", "Pack the order", "Print the label"), ("depends_on", "Print the label", "Confirm the address"), ("extends", "Gift wrapping", "Pack the order")],
            maybe: &[],
            forbid: &[("depends_on", "Print the label", "Pack the order"), ("related_to", "Tape colours", "Confirm the address")]
        )],
        ..Default::default()
    });
    scenarios.push(Scenario {
        name: "v2 holdout post-edit replacement (en)",
        holdout: true,
        seed: vec![Obj("decision", "Use email for support", "Customer support happens by email.")],
        world: &[("extends", "Support by email with templates", "Use email for support")],
        v2: true,
        steps: vec![
            step!(Capture(Obj("idea", "Support by email with templates", "Customer support by email, using reply templates for common questions.")), expect: &[("extends", "Support by email with templates", "Use email for support")], maybe: &[], forbid: &[]),
            step!(Edit("Support by email with templates", "We replace email support with a live chat widget; email is no longer used."), world: &[("contradicts", "Support by email with templates", "Use email for support")], expect: &[], maybe: &[], forbid: &[("extends", "Support by email with templates", "Use email for support")]),
        ],
        ..Default::default()
    });
    scenarios.push(Scenario {
        name: "v2 holdout bg chain",
        holdout: true,
        seed: vec![Obj("task", "Ремонт на банята", "Правим ремонт на банята през лятото.")],
        world: &[("depends_on", "Ремонт на банята", "Избор на плочки"), ("extends", "Плочки с геометричен мотив", "Избор на плочки")],
        v2: true,
        steps: vec![
            step!(Capture(Obj("task", "Избор на плочки", "Ремонтът на банята не може да започне, докато не изберем плочки.")), expect: &[("depends_on", "Ремонт на банята", "Избор на плочки")], maybe: &[], forbid: &[("depends_on", "Избор на плочки", "Ремонт на банята")]),
            step!(Capture(Obj("idea", "Плочки с геометричен мотив", "При избора на плочки да търсим такива с геометричен мотив.")), expect: &[("extends", "Плочки с геометричен мотив", "Избор на плочки")], maybe: &[], forbid: &[]),
        ],
        ..Default::default()
    });
    // ----- M04.7A.3 diagnostic: temporal / moot semantics, domain-independent (cancelled, obsolete, unnecessary, reprioritised). -----
    scenarios.push(Scenario {
        name: "diag moot: cancelled plan vs old prerequisite",
        seed: vec![Obj("task", "Order packaging", "Order packaging for the spring product line.")],
        world: &[],
        v2: true,
        steps: vec![step!(Capture(Obj("decision", "Discontinue the spring line", "The spring product line is cancelled and will not be produced.")), expect: &[], maybe: &[("related_to", "Discontinue the spring line", "Order packaging")], forbid: &[("contradicts", "Discontinue the spring line", "Order packaging"), ("supersedes", "Discontinue the spring line", "Order packaging"), ("depends_on", "Order packaging", "Discontinue the spring line"), ("duplicates", "Discontinue the spring line", "Order packaging")])],
        ..Default::default()
    });
    scenarios.push(Scenario {
        name: "diag moot: edit cancels the parent, dependency retracted",
        seed: vec![Obj("task", "Open the pop-up store", "Open the pop-up store in June.")],
        world: &[("depends_on", "Open the pop-up store", "Sign the lease")],
        v2: true,
        steps: vec![
            step!(Capture(Obj("task", "Sign the lease", "The pop-up store cannot open until the lease is signed.")), expect: &[("depends_on", "Open the pop-up store", "Sign the lease")], maybe: &[], forbid: &[]),
            step!(Edit("Open the pop-up store", "The pop-up store is cancelled; we will not open it."), world: &[], expect: &[], maybe: &[], forbid: &[("depends_on", "Open the pop-up store", "Sign the lease"), ("contradicts", "Open the pop-up store", "Sign the lease")]),
        ],
        ..Default::default()
    });
    scenarios.push(Scenario {
        name: "diag moot: obsolete requirement replaced",
        seed: vec![Obj("note", "Support legacy browsers", "The site must support legacy browsers."), Obj("task", "Test pages in legacy browsers", "Test every page in legacy browsers.")],
        world: &[("supersedes", "Drop legacy browser support", "Support legacy browsers")],
        acceptable: &[("contradicts", "Drop legacy browser support", "Support legacy browsers")],
        v2: true,
        steps: vec![step!(Capture(Obj("decision", "Drop legacy browser support", "Legacy browser support is no longer required.")), expect: &[("supersedes", "Drop legacy browser support", "Support legacy browsers")], maybe: &[], forbid: &[("contradicts", "Drop legacy browser support", "Test pages in legacy browsers"), ("supersedes", "Drop legacy browser support", "Test pages in legacy browsers")])],
        ..Default::default()
    });
    scenarios.push(Scenario {
        name: "diag moot: changed priority replaces the old one",
        seed: vec![Obj("task", "Write the onboarding guide", "Write the onboarding guide; it is high priority this week."), Obj("note", "Release checklist", "The release checklist has twelve items.")],
        world: &[("supersedes", "Onboarding guide is low priority", "Write the onboarding guide")],
        acceptable: &[("contradicts", "Onboarding guide is low priority", "Write the onboarding guide")],
        v2: true,
        steps: vec![step!(Capture(Obj("note", "Onboarding guide is low priority", "The onboarding guide is now low priority; do it after the release.")), expect: &[("supersedes", "Onboarding guide is low priority", "Write the onboarding guide")], maybe: &[], forbid: &[("contradicts", "Onboarding guide is low priority", "Release checklist"), ("supersedes", "Onboarding guide is low priority", "Release checklist")])],
        ..Default::default()
    });
    scenarios.push(Scenario {
        name: "diag moot (bg): cancelled event vs old task",
        seed: vec![Obj("task", "Поръчка на торта", "Поръчваме торта за рождения ден.")],
        world: &[],
        v2: true,
        steps: vec![step!(Capture(Obj("decision", "Рожденият ден е отменен", "Рожденият ден е отменен, няма да има празненство.")), expect: &[], maybe: &[("related_to", "Рожденият ден е отменен", "Поръчка на торта")], forbid: &[("contradicts", "Рожденият ден е отменен", "Поръчка на торта"), ("supersedes", "Рожденият ден е отменен", "Поръчка на торта")])],
        ..Default::default()
    });
    scenarios.push(Scenario {
        name: "diag moot (bg): changed priority",
        seed: vec![Obj("task", "Подготовка на фактури", "Да подготвя фактурите, спешно е.")],
        world: &[("supersedes", "Фактурите вече не са спешни", "Подготовка на фактури")],
        acceptable: &[("contradicts", "Фактурите вече не са спешни", "Подготовка на фактури")],
        v2: true,
        steps: vec![step!(Capture(Obj("note", "Фактурите вече не са спешни", "Фактурите вече не са спешни, могат да изчакат до понеделник.")), expect: &[("supersedes", "Фактурите вече не са спешни", "Подготовка на фактури")], maybe: &[], forbid: &[])],
        ..Default::default()
    });
    scenarios.push(Scenario {
        name: "diag control: a genuine contradiction is still found",
        seed: vec![Obj("decision", "Pay in advance", "Customers pay in advance.")],
        world: &[("contradicts", "Pay on delivery", "Pay in advance")],
        v2: true,
        steps: vec![step!(Capture(Obj("decision", "Pay on delivery", "Customers pay on delivery only; nothing is paid in advance.")), expect: &[("contradicts", "Pay on delivery", "Pay in advance")], maybe: &[], forbid: &[])],
        ..Default::default()
    });
    scenarios.push(Scenario {
        name: "diag control (bg): a genuine contradiction is still found",
        seed: vec![Obj("decision", "Среща присъствено", "Срещата е присъствена в офиса.")],
        world: &[("contradicts", "Среща онлайн", "Среща присъствено")],
        v2: true,
        steps: vec![step!(Capture(Obj("decision", "Среща онлайн", "Срещата е само онлайн, никой не идва в офиса.")), expect: &[("contradicts", "Среща онлайн", "Среща присъствено")], maybe: &[], forbid: &[])],
        ..Default::default()
    });
    // ----- M04.7A.3: direction-aware dependency retraction. Retract only when the DEPENDENT's own current text cancels its plan. -----
    let dep = |name: &'static str,
               seed: Obj,
               prerequisite: Obj,
               fact: Fact,
               edit: (&'static str, &'static str),
               expect_after: &'static [Fact],
               forbid_after: &'static [Fact]| Scenario {
        name,
        seed: vec![seed],
        world: leak(vec![fact]),
        v2: true,
        steps: vec![
            Step {
                action: Capture(prerequisite),
                world: None,
                expect: leak(vec![fact]),
                maybe: &[],
                forbid: &[],
            },
            Step {
                action: Edit(edit.0, edit.1),
                world: if forbid_after.is_empty() {
                    None
                } else {
                    Some(&[])
                },
                expect: expect_after,
                maybe: &[],
                forbid: forbid_after,
            },
        ],
        ..Default::default()
    };
    let shop: Fact = ("depends_on", "Open the second shop", "Hire the manager");
    scenarios.push(dep(
        "diag dep paused: a postponed dependent keeps its dependency",
        Obj(
            "task",
            "Open the second shop",
            "Open the second shop in June.",
        ),
        Obj(
            "task",
            "Hire the manager",
            "The second shop cannot open until the manager is hired.",
        ),
        shop,
        (
            "Open the second shop",
            "Opening the second shop is postponed until next year.",
        ),
        leak(vec![shop]),
        &[],
    ));
    let news: Fact = ("depends_on", "Launch the newsletter", "Pick a mail tool");
    scenarios.push(dep(
        "diag dep unavailable prerequisite: dependent stays",
        Obj(
            "task",
            "Launch the newsletter",
            "Launch the newsletter in autumn.",
        ),
        Obj(
            "task",
            "Pick a mail tool",
            "The newsletter cannot launch until a mail tool is chosen.",
        ),
        news,
        (
            "Pick a mail tool",
            "The mail tool decision is cancelled and no tool is available.",
        ),
        leak(vec![news]),
        &[],
    ));
    let dash: Fact = (
        "depends_on",
        "Redesign the dashboard",
        "Approve the mockups",
    );
    scenarios.push(dep(
        "diag dep reprioritised: a lower priority keeps the dependency",
        Obj(
            "task",
            "Redesign the dashboard",
            "Redesign the dashboard this quarter.",
        ),
        Obj(
            "task",
            "Approve the mockups",
            "The dashboard redesign cannot start until the mockups are approved.",
        ),
        dash,
        (
            "Redesign the dashboard",
            "The dashboard redesign is now low priority; do it later.",
        ),
        leak(vec![dash]),
        &[],
    ));
    let migrate: Fact = ("depends_on", "Migrate the database", "Back up the database");
    scenarios.push(dep(
        "diag dep active: a detailed edit keeps the dependency",
        Obj(
            "task",
            "Migrate the database",
            "Migrate the database next week.",
        ),
        Obj(
            "task",
            "Back up the database",
            "The migration must not start before a backup of the database exists.",
        ),
        migrate,
        (
            "Migrate the database",
            "Migrate the database next week, after the freeze, with a rollback plan.",
        ),
        leak(vec![migrate]),
        &[],
    ));
    let cafe: Fact = ("depends_on", "Откриване на кафене", "Наем на помещение");
    scenarios.push(dep(
        "diag dep cancelled (bg): a cancelled dependent loses it",
        Obj("task", "Откриване на кафене", "Откриваме кафене през юни."),
        Obj(
            "task",
            "Наем на помещение",
            "Кафенето не може да се отвори без наето помещение.",
        ),
        cafe,
        (
            "Откриване на кафене",
            "Отказваме се от кафенето; няма да го откриваме.",
        ),
        &[],
        leak(vec![cafe]),
    ));
    let guard: Fact = ("depends_on", "Print the tickets", "Book the venue");
    scenarios.push(Scenario {
        name: "diag dep user relation is protected from a cancelling edit",
        seed: vec![Obj("task", "Print the tickets", "Print the tickets for the concert."), Obj("task", "Book the venue", "Book the venue for the concert.")],
        user: leak(vec![guard]),
        world: &[],
        v2: true,
        steps: vec![step!(Edit("Print the tickets", "The concert is cancelled; we will not print any tickets."), world: &[], expect: &[], maybe: &[], forbid: &[])],
        ..Default::default()
    });
    let swim: Fact = ("depends_on", "Open the pool", "Certify the lifeguards");
    scenarios.push(Scenario {
        name: "diag dep reactivation is inferred afresh",
        seed: vec![Obj("task", "Open the pool", "Open the pool in July.")],
        world: leak(vec![swim]),
        v2: true,
        steps: vec![
            step!(Capture(Obj("task", "Certify the lifeguards", "The pool cannot open until the lifeguards are certified.")), expect: leak(vec![swim]), maybe: &[], forbid: &[]),
            step!(Edit("Open the pool", "The pool project is cancelled; we will not open the pool."), world: &[], expect: &[], maybe: &[], forbid: leak(vec![swim])),
            step!(Edit("Open the pool", "We changed our minds: the pool will open in July, once the lifeguards are certified."), world: leak(vec![swim]), expect: leak(vec![swim]), maybe: &[], forbid: &[]),
        ],
        ..Default::default()
    });
    scenarios
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Scoring.

#[derive(Debug, Default, Clone)]
struct Metrics {
    objects: usize,
    admitted: usize,
    correct: usize,
    wrong_kind: usize,
    wrong_direction: usize,
    false_positive: usize,
    hard_negative_hits: usize,
    expected: usize,
    found: usize,
    maybe_found: usize,
    directional_admitted_labelled: usize,
    directional_correct: usize,
    leaked: usize,
    duplicates: usize,
    user_mutations: usize,
    users_seeded: usize,
    retraction_failures: usize,
    pool_expected: usize,
    pool_hit: usize,
    max_requests_per_event: usize,
    events: usize,
    idempotence_violations: usize,
    questionable: Vec<String>,
    /// (expected kind on the pair, predicted kind) -> count. `none` on either side means no label / no edge.
    confusion: std::collections::BTreeMap<(String, String), usize>,
    /// Canonical identity of every admitted edge, for agreement between runs.
    edges: BTreeSet<String>,
    requests_total: usize,
    elapsed_total_ms: u128,
    provider_events: usize,
    /// Edges that are strictly correct OR a documented acceptable alternative (semantic admissibility), and not a hard negative.
    admissible: usize,
    /// Persisted edges that are NOT admissible and so need a human decision (wrong kind, wrong direction, unlabelled).
    review: Vec<String>,
    /// Provider failures by cause (`HTTP 402`, `HTTP 429`, `other`). A run with any is contaminated, never an idempotence violation.
    provider_failures: std::collections::BTreeMap<String, usize>,
    funnel: Vec<FunnelRow>,
    /// Stage A answers that did not parse (model reliability, not a provider outage). The event is retried; the call still costs.
    contract_failures: usize,
    a_calls: usize,
    b_calls: usize,
    b_invalid: usize,
    a_invalid: usize,
    deferred_events: usize,
    events_reaching_stage_b: usize,
    /// Binary-test quality by relation kind (M04.7A.2): Stage A claims and the claims that survive both verification passes.
    binary: std::collections::BTreeMap<String, BinaryStat>,
    surviving_pairs: usize,
    ambiguous_pairs: usize,
    ambiguous_dropped: usize,
}

#[derive(Debug, Default, Clone)]
struct BinaryStat {
    claims: usize,
    claims_strict: usize,
    claims_admissible: usize,
    expected: usize,
    claimed_expected: usize,
    verified: usize,
    verified_strict: usize,
    verified_admissible: usize,
    verified_expected: usize,
}

/// Where each REQUIRED relation was lost, if it was: discovery -> Stage A -> Stage B -> persisted.
#[derive(Debug, Clone)]
struct FunnelRow {
    fact: String,
    discovered: bool,
    proposed_pair: bool,
    proposed_exact: bool,
    votes: Vec<String>,
    persisted: bool,
}

fn holds(relation: &Relation, fact: &Fact, title_of: &dyn Fn(&str) -> String) -> bool {
    let (source, target) = (
        title_of(&relation.source_object_id),
        title_of(&relation.target_object_id),
    );
    let direct = relation.kind == fact.0 && source.contains(fact.1) && target.contains(fact.2);
    let swapped = is_symmetric(fact.0)
        && relation.kind == fact.0
        && source.contains(fact.2)
        && target.contains(fact.1);
    direct || swapped
}

fn pair_matches(relation: &Relation, fact: &Fact, title_of: &dyn Fn(&str) -> String) -> bool {
    let (source, target) = (
        title_of(&relation.source_object_id),
        title_of(&relation.target_object_id),
    );
    (source.contains(fact.1) && target.contains(fact.2))
        || (source.contains(fact.2) && target.contains(fact.1))
}

/// Wraps the real proposer and verifier and records what each stage SAID, so a miss or a questionable edge can be explained.
struct Spy {
    proposer: Arc<dyn RelationProposer>,
    verifier: Arc<dyn RelationVerifier>,
    log: std::sync::Mutex<Vec<String>>,
    trace: std::sync::Mutex<Trace>,
}

/// What each stage said during one step, by title, for the funnel.
#[derive(Default)]
struct Trace {
    pools: Vec<Vec<String>>,
    /// (kind, source title, target title)
    proposals: Vec<(String, String, String)>,
    votes: Vec<VoteRecord>,
    failures: Vec<String>,
    /// Raw provider attempts, including retries and the ones that failed.
    a_calls: usize,
    b_calls: usize,
    /// Stage B responses that broke the output contract (each counted, even if its retry succeeded).
    b_invalid: usize,
    a_invalid: usize,
}

struct VoteRecord {
    vote: usize,
    proposed_kind: String,
    first: String,
    second: String,
    /// This pass supported the claim (accept, high confidence, explicit link, strong forward support).
    accepted: bool,
    /// The direction this pass named.
    source: String,
    target: String,
    summary: String,
}

/// The claims that BOTH verification passes supported with the same identity (symmetric kinds: the same unordered pair; directional
/// kinds: the same direction). Pure, so the accounting is testable without a model.
fn survivors_of(votes: &[VoteRecord]) -> Vec<(String, String, String)> {
    let mut out: Vec<(String, String, String)> = Vec::new();
    for first in votes.iter().filter(|v| v.vote == 1 && v.accepted) {
        let confirmed = votes.iter().any(|v| {
            v.vote == 2
                && v.accepted
                && v.proposed_kind == first.proposed_kind
                && v.first == first.first
                && v.second == first.second
                && ((v.source == first.source && v.target == first.target)
                    || (is_symmetric(&first.proposed_kind)
                        && v.source == first.target
                        && v.target == first.source))
        });
        let claim = (
            first.proposed_kind.clone(),
            first.source.clone(),
            first.target.clone(),
        );
        if confirmed && !out.contains(&claim) {
            out.push(claim);
        }
    }
    out
}

/// Where a provider failure came from. Only `Http` and `Network` contaminate a run; a `Contract` failure (the model's answer did not parse)
/// is a model reliability metric: the event is deferred and retried, and the failed call still counts toward cost.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum FailureKind {
    Http(String),
    Network,
    Contract,
    Other,
}

fn classify_failure(message: &str) -> FailureKind {
    if let Some(code) = message
        .split("HTTP ")
        .nth(1)
        .and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next())
        .filter(|c| !c.is_empty())
    {
        return FailureKind::Http(code.to_string());
    }
    if message.contains("Could not reach") {
        FailureKind::Network
    } else if message.contains("could not be trusted") || message.contains("llm_invalid_output") {
        FailureKind::Contract
    } else {
        FailureKind::Other
    }
}

impl Spy {
    fn new(proposer: Arc<dyn RelationProposer>, verifier: Arc<dyn RelationVerifier>) -> Arc<Self> {
        Arc::new(Self {
            proposer,
            verifier,
            log: std::sync::Mutex::new(vec![]),
            trace: std::sync::Mutex::new(Trace::default()),
        })
    }

    fn take_trace(&self) -> Trace {
        std::mem::take(&mut *self.trace.lock().unwrap())
    }
}

impl Spy {
    fn drain(&self) -> Vec<String> {
        std::mem::take(&mut *self.log.lock().unwrap())
    }
}

type Objects<'a> = &'a [crate::storage::knowledge_store::KnowledgeObject];
type Proposed = Result<Vec<super::RelationCandidate>, super::RelationError>;
type Voted = Result<Vec<super::verify::Verdict>, super::RelationError>;

impl Spy {
    fn record_proposals(&self, objects: Objects<'_>, result: &Proposed) {
        let title = |id: &str| {
            objects
                .iter()
                .find(|o| o.id == id)
                .map(|o| o.title.clone())
                .unwrap_or_default()
        };
        {
            let mut trace = self.trace.lock().unwrap();
            trace.a_calls += 1;
            if matches!(result, Err(super::RelationError::InvalidOutput(_))) {
                trace.a_invalid += 1;
            }
            trace
                .pools
                .push(objects.iter().map(|o| o.title.clone()).collect());
            match result {
                Ok(list) => trace.proposals.extend(list.iter().map(|c| {
                    (
                        c.kind.clone(),
                        title(&c.source_object_id),
                        title(&c.target_object_id),
                    )
                })),
                Err(error) => trace.failures.push(error.to_string()),
            }
        }
        let mut log = self.log.lock().unwrap();
        log.push(format!("A pool of {} objects", objects.len()));
        match result {
            Ok(list) => {
                for c in list {
                    log.push(format!(
                        "A claims {} {} -> {}   ({})",
                        c.kind,
                        title(&c.source_object_id),
                        title(&c.target_object_id),
                        c.reason
                    ));
                }
                if list.is_empty() {
                    log.push("A claims nothing".into());
                }
            }
            Err(error) => log.push(format!("A failed: {error}")),
        }
    }

    fn record_votes(
        &self,
        candidates: &[super::verify::VerifyCandidate],
        presentation: super::verify::Presentation,
        result: &Voted,
    ) {
        let mut log = self.log.lock().unwrap();
        {
            let mut trace = self.trace.lock().unwrap();
            trace.b_calls += 1;
            if matches!(result, Err(super::RelationError::InvalidOutput(_))) {
                trace.b_invalid += 1;
            }
        }
        if let Err(error) = result {
            self.trace.lock().unwrap().failures.push(error.to_string());
        }
        if let Ok(verdicts) = result {
            for v in verdicts {
                let candidate = &candidates[v.index];
                let title = |id: &str| {
                    if candidate.source.id == id {
                        candidate.source.title.clone()
                    } else {
                        candidate.target.title.clone()
                    }
                };
                self.trace.lock().unwrap().votes.push(VoteRecord {
                    vote: if presentation == super::verify::Presentation::LowerIdFirst {
                        1
                    } else {
                        2
                    },
                    proposed_kind: candidate.kind.clone(),
                    first: candidate.source.title.clone(),
                    second: candidate.target.title.clone(),
                    accepted: v.decision == super::verify::Decision::Accept
                        && v.confidence == super::verify::Confidence::High
                        && v.explicit_link
                        && v.forward_support == super::verify::Support::Strong,
                    source: title(&v.source_object_id),
                    target: title(&v.target_object_id),
                    summary: format!(
                        "{:?} {} {} -> {} conf={:?}",
                        v.decision,
                        v.kind,
                        title(&v.source_object_id),
                        title(&v.target_object_id),
                        v.confidence
                    ),
                });
                log.push(format!(
                    "B {:?} #{} claimed {} [{} / {}] -> {:?} {} {} -> {}  conf={:?} fwd={:?} rev={:?} explicit={} moot={} plan_cancelled={} req_gone={}{}",
                    presentation, v.index, candidate.kind, candidate.source.title, candidate.target.title, v.decision, v.kind, title(&v.source_object_id), title(&v.target_object_id), v.confidence, v.forward_support, v.reverse_support, v.explicit_link, v.cancels_or_obsoletes, v.cancelled_plan_object_id.as_ref().map(|id| title(id)).unwrap_or_else(|| "-".into()), v.dependency_no_longer_required,
                    v.temporal_evidence.as_ref().map(|e| format!(" evidence=\"{e}\"")).unwrap_or_default()
                ));
            }
        }
    }
}

impl RelationProposer for Spy {
    fn propose<'a>(
        &'a self,
        objects: Objects<'a>,
        existing: &'a [Relation],
    ) -> crate::async_util::BoxFuture<'a, Proposed> {
        self.proposer.propose(objects, existing)
    }

    fn propose_for<'a>(
        &'a self,
        focus_id: &'a str,
        objects: Objects<'a>,
        existing: &'a [Relation],
    ) -> crate::async_util::BoxFuture<'a, Proposed> {
        Box::pin(async move {
            let result = self.proposer.propose_for(focus_id, objects, existing).await;
            self.record_proposals(objects, &result);
            result
        })
    }
}

impl RelationVerifier for Spy {
    fn verify<'a>(
        &'a self,
        candidates: &'a [super::verify::VerifyCandidate],
        presentation: super::verify::Presentation,
    ) -> crate::async_util::BoxFuture<'a, Voted> {
        Box::pin(async move {
            let result = self.verifier.verify(candidates, presentation).await;
            self.record_votes(candidates, presentation, &result);
            result
        })
    }
}

struct Bench {
    lab: Arc<Lab>,
    service: Arc<IntegrationService>,
    recall: Arc<RecallService>,
    double: Option<Arc<Double>>,
    spy: Option<Arc<Spy>>,
    _dir: tempfile::TempDir,
}

impl Bench {
    fn new(
        proposer: Arc<dyn RelationProposer>,
        verifier: Arc<dyn RelationVerifier>,
        double: Option<Arc<Double>>,
        semantic: bool,
    ) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let embedder = Arc::new(ConceptEmbedder::new(
            64,
            &[
                ("phone", "device"),
                ("mobile", "device"),
                ("handset", "device"),
            ],
        ));
        let recall = Arc::new(RecallService::new(
            embedder,
            Arc::new(SemanticSettings::new(dir.path().join("semantic.json"))),
        ));
        if semantic {
            recall.settings().set(recall.model_key(), true).unwrap();
        }
        if let Some(double) = &double {
            // The scripted world is explicit: a `depends_on` that the world no longer holds means the requirement changed.
            *double.requirement_gone.lock().unwrap() = true;
        }
        let service = Arc::new(IntegrationService::new(
            GraphService::new(proposer, verifier),
            IntegrationSettings::in_memory(true),
            Ledger::in_memory(),
        ));
        Self {
            lab: Arc::new(Lab::new()),
            service,
            recall,
            double,
            spy: None,
            _dir: dir,
        }
    }
}

fn run_scenario(bench: &Bench, scenario: &Scenario, metrics: &mut Metrics, verbose: bool) {
    let lab = &bench.lab;
    let project = lab.project(scenario.name);
    let title_of = |id: &str| {
        lab.store
            .get_knowledge_object(id)
            .unwrap()
            .map(|o| o.title)
            .unwrap_or_default()
    };
    let find = |needle: &str| -> String {
        lab.store
            .list_knowledge_objects_in(Some(&project))
            .unwrap()
            .into_iter()
            .find(|o| o.title.contains(needle))
            .unwrap_or_else(|| panic!("no object titled {needle}"))
            .id
    };

    for o in &scenario.seed {
        lab.object(&project, o.0, o.1, o.2);
    }
    for index in 0..scenario.fillers {
        if scenario.bulgarian_fillers {
            lab.object(
                &project,
                "note",
                &format!("Бележка {index}"),
                &format!("Домати и поливане, бележка номер {index}."),
            );
        } else {
            lab.object(
                &project,
                "note",
                &format!("Filler {index}"),
                &format!("Tomatoes and watering, filler note number {index}."),
            );
        }
    }
    let other = lab.project(&format!("{} / other", scenario.name));
    let elsewhere: Vec<String> = scenario
        .elsewhere
        .iter()
        .map(|o| lab.object(&other, o.0, o.1, o.2))
        .collect();
    let old = lab.project(&format!("{} / archived", scenario.name));
    let archived: Vec<String> = scenario
        .archived
        .iter()
        .map(|o| lab.object(&old, o.0, o.1, o.2))
        .collect();
    if !archived.is_empty() {
        lab.store.archive_project(&old).unwrap();
    }
    let user_before: Vec<Relation> = scenario
        .user
        .iter()
        .map(|(kind, source, target)| {
            lab.store
                .create_relation(
                    NewRelation {
                        kind: (*kind).into(),
                        source_object_id: find(source),
                        target_object_id: find(target),
                    },
                    "user",
                )
                .unwrap()
        })
        .collect();

    let mut world: &'static [Fact] = scenario.world;
    let mut seen: HashSet<String> = lab
        .store
        .list_relations()
        .unwrap()
        .into_iter()
        .map(|r| r.id)
        .collect();
    let foreign: HashSet<String> = elsewhere.into_iter().chain(archived).collect();

    for step in &scenario.steps {
        if let Some(next) = step.world {
            world = next;
        }
        if let Some(double) = &bench.double {
            double.set_facts(world);
            *double.noise.lock().unwrap() = step.forbid.to_vec();
        }
        let pools_before = bench
            .double
            .as_ref()
            .map(|d| d.pools.lock().unwrap().len())
            .unwrap_or(0);
        let (before_proposals, before_votes) = bench
            .double
            .as_ref()
            .map(|d| {
                (
                    d.proposer_calls.load(std::sync::atomic::Ordering::SeqCst),
                    d.verifier_calls.load(std::sync::atomic::Ordering::SeqCst),
                )
            })
            .unwrap_or((0, 0));

        let changes: Vec<ChangedKnowledge> = match &step.action {
            Action::Capture(o) => {
                metrics.objects += 1;
                vec![ChangedKnowledge::created(
                    &lab.object(&project, o.0, o.1, o.2),
                    "",
                )]
            }
            Action::Burst(list) => {
                metrics.objects += list.len();
                list.iter()
                    .map(|o| ChangedKnowledge::created(&lab.object(&project, o.0, o.1, o.2), ""))
                    .collect()
            }
            Action::Edit(title, body) => {
                let id = find(title);
                let before = lab.current_revision(&id);
                if verbose {
                    let previous = lab.store.get_revision(&before).unwrap();
                    println!("      EDIT previous revision {} ({}, written {}): \"{}\" -> new body: \"{}\"", &before[..8], previous.origin, previous.created_at, previous.body, body);
                }
                let after = lab.edit(&id, None, Some(body));
                vec![ChangedKnowledge::revised(&id, &before, &after)]
            }
        };
        let changes: Vec<ChangedKnowledge> = changes
            .into_iter()
            .map(|c| ChangedKnowledge {
                current_revision_id: lab.current_revision(&c.object_id),
                ..c
            })
            .collect();
        metrics.events += changes.len();

        let reports: Vec<IntegrationReport> = if changes.len() > 1 {
            let handles: Vec<_> = changes
                .iter()
                .cloned()
                .map(|change| {
                    let (service, lab, recall) = (
                        bench.service.clone(),
                        bench.lab.clone(),
                        bench.recall.clone(),
                    );
                    tauri::async_runtime::spawn(async move {
                        service.integrate(&lab.store, &recall, change).await
                    })
                })
                .collect();
            run(async move {
                let mut out = Vec::new();
                for handle in handles {
                    out.push(handle.await.unwrap());
                }
                out
            })
        } else {
            changes
                .iter()
                .map(|change| {
                    run(bench
                        .service
                        .integrate(&lab.store, &bench.recall, change.clone()))
                })
                .collect()
        };
        for report in &reports {
            let requests = report.decision.provider_requests;
            metrics.requests_total += requests;
            metrics.surviving_pairs += report.decision.surviving_pairs;
            metrics.ambiguous_pairs += report.decision.ambiguous_pairs;
            metrics.ambiguous_dropped += report.decision.ambiguous_dropped;
            if requests > 0 {
                metrics.elapsed_total_ms += report.elapsed_ms;
                metrics.provider_events += 1;
            }
            metrics.max_requests_per_event = metrics.max_requests_per_event.max(requests);
        }

        // What each stage said for THIS step (before any retry below adds to it).
        let mut trace = bench.spy.as_ref().map(|spy| spy.take_trace());

        // Retry/idempotence: every event again. An event whose first run FAILED at the provider is a retry, not a violation. A completed
        // event run again must change nothing and send nothing.
        let completed = |report: &IntegrationReport| {
            matches!(report.status, Status::Integrated | Status::Skipped(_))
        };
        let graph_now = lab.store.list_relations().unwrap();
        let calls_now = bench.double.as_ref().map(|d| d.calls());
        for (change, first) in changes.iter().zip(&reports) {
            let again = run(bench
                .service
                .integrate(&lab.store, &bench.recall, change.clone()));
            if completed(first) && !matches!(again.status, Status::Skipped(Skip::AlreadyIntegrated))
            {
                metrics.idempotence_violations += 1;
            }
        }
        if reports.iter().all(completed)
            && (lab.store.list_relations().unwrap() != graph_now
                || bench.double.as_ref().map(|d| d.calls()) != calls_now)
        {
            metrics.idempotence_violations += 1;
        }
        if let (Some(spy), Some(trace)) = (&bench.spy, trace.as_mut()) {
            // Failures during the retries are provider failures too; their other output is not part of this step's funnel.
            trace.failures.extend(spy.take_trace().failures);
        }
        if let Some(trace) = &trace {
            // Binary-test quality: a claim is judged against the labels of THIS step's world (strict) and the documented alternatives.
            let strict: Vec<&Fact> = step
                .expect
                .iter()
                .chain(step.maybe)
                .chain(world.iter())
                .collect();
            let matches = |fact: &Fact, kind: &str, a: &str, b: &str| {
                fact.0 == kind
                    && ((a.contains(fact.1) && b.contains(fact.2))
                        || (is_symmetric(kind) && a.contains(fact.2) && b.contains(fact.1)))
            };
            let classify = |kind: &str, a: &str, b: &str| {
                let forbidden = step.forbid.iter().any(|f| matches(f, kind, a, b));
                let strict_hit = strict.iter().any(|f| matches(f, kind, a, b)) && !forbidden;
                let adm_hit = strict_hit
                    || (scenario.acceptable.iter().any(|f| matches(f, kind, a, b)) && !forbidden);
                (strict_hit, adm_hit)
            };
            for (kind, a, b) in &trace.proposals {
                let stat = metrics.binary.entry(kind.clone()).or_default();
                let (st, ad) = classify(kind, a, b);
                stat.claims += 1;
                stat.claims_strict += st as usize;
                stat.claims_admissible += ad as usize;
            }
            // Survivors: both passes supported the claim and named the same direction.
            let survivors = survivors_of(&trace.votes);
            for (kind, a, b) in &survivors {
                let stat = metrics.binary.entry(kind.clone()).or_default();
                let (st, ad) = classify(kind, a, b);
                stat.verified += 1;
                stat.verified_strict += st as usize;
                stat.verified_admissible += ad as usize;
            }
            for fact in step.expect {
                let stat = metrics.binary.entry(fact.0.to_string()).or_default();
                stat.expected += 1;
                stat.claimed_expected += trace
                    .proposals
                    .iter()
                    .any(|(k, a, b)| matches(fact, k, a, b))
                    as usize;
                stat.verified_expected +=
                    survivors.iter().any(|(k, a, b)| matches(fact, k, a, b)) as usize;
            }
        }
        if let Some(trace) = &trace {
            metrics.a_calls += trace.a_calls;
            metrics.b_calls += trace.b_calls;
            metrics.b_invalid += trace.b_invalid;
            metrics.a_invalid += trace.a_invalid;
            metrics.deferred_events += reports
                .iter()
                .filter(|r| matches!(r.status, Status::Deferred(_) | Status::Failed(_)))
                .count();
            for failure in &trace.failures {
                match classify_failure(failure) {
                    FailureKind::Contract => metrics.contract_failures += 1,
                    FailureKind::Http(code) => {
                        *metrics
                            .provider_failures
                            .entry(format!("HTTP {code}"))
                            .or_default() += 1
                    }
                    FailureKind::Network => {
                        *metrics
                            .provider_failures
                            .entry("network".into())
                            .or_default() += 1
                    }
                    FailureKind::Other => {
                        *metrics.provider_failures.entry("other".into()).or_default() += 1
                    }
                }
            }
        }

        if verbose {
            if let Some(spy) = &bench.spy {
                for line in spy.drain() {
                    println!("      | {line}");
                }
                for report in &reports {
                    println!(
                        "      | integration: {:?} candidates={} {:?}",
                        report.status, report.candidates, report.decision
                    );
                }
            }
        }

        // Score what this step added.
        let relations = lab.store.list_relations().unwrap();
        let added: Vec<&Relation> = relations.iter().filter(|r| !seen.contains(&r.id)).collect();
        for relation in &added {
            metrics.admitted += 1;
            let describe = format!(
                "{} {} -> {} [{}]",
                relation.kind,
                title_of(&relation.source_object_id),
                title_of(&relation.target_object_id),
                relation.origin
            );
            let labelled: Vec<&Fact> = step
                .expect
                .iter()
                .chain(step.maybe)
                .chain(world.iter())
                .collect();
            let hit = labelled.iter().any(|fact| holds(relation, fact, &title_of));
            let is_expected = step
                .expect
                .iter()
                .any(|fact| holds(relation, fact, &title_of));
            let is_maybe = step
                .maybe
                .iter()
                .any(|fact| holds(relation, fact, &title_of));
            let directional_pair = labelled.iter().find(|fact| {
                !is_symmetric(fact.0)
                    && relation.kind == fact.0
                    && pair_matches(relation, fact, &title_of)
            });
            if directional_pair.is_some() {
                metrics.directional_admitted_labelled += 1;
            }
            let pair_fact = labelled
                .iter()
                .find(|fact| fact.0 == relation.kind && pair_matches(relation, fact, &title_of))
                .or_else(|| {
                    labelled
                        .iter()
                        .find(|fact| pair_matches(relation, fact, &title_of))
                });
            *metrics
                .confusion
                .entry((
                    pair_fact
                        .map(|f| f.0.to_string())
                        .unwrap_or_else(|| "none".into()),
                    relation.kind.clone(),
                ))
                .or_default() += 1;
            {
                let (a, b) = (
                    title_of(&relation.source_object_id),
                    title_of(&relation.target_object_id),
                );
                let (a, b) = if is_symmetric(&relation.kind) && b < a {
                    (b, a)
                } else {
                    (a, b)
                };
                metrics
                    .edges
                    .insert(format!("{}|{}|{}", relation.kind, a, b));
            }
            let forbidden = step
                .forbid
                .iter()
                .any(|fact| holds(relation, fact, &title_of));
            if (hit
                || scenario
                    .acceptable
                    .iter()
                    .any(|fact| holds(relation, fact, &title_of)))
                && !forbidden
            {
                metrics.admissible += 1;
            } else {
                metrics.review.push(describe.clone());
            }
            if hit {
                metrics.correct += 1;
                if directional_pair.is_some() {
                    metrics.directional_correct += 1;
                }
                if is_maybe && !is_expected {
                    metrics.maybe_found += 1;
                }
            } else if directional_pair.is_some() {
                metrics.wrong_direction += 1;
                metrics
                    .questionable
                    .push(format!("WRONG DIRECTION: {describe}"));
            } else if labelled
                .iter()
                .any(|fact| pair_matches(relation, fact, &title_of))
            {
                metrics.wrong_kind += 1;
                metrics.questionable.push(format!("WRONG KIND: {describe}"));
            } else {
                metrics.false_positive += 1;
                metrics.questionable.push(format!("UNLABELLED: {describe}"));
            }
            if step
                .forbid
                .iter()
                .any(|fact| holds(relation, fact, &title_of))
            {
                metrics.hard_negative_hits += 1;
            }
            if foreign.contains(&relation.source_object_id)
                || foreign.contains(&relation.target_object_id)
            {
                metrics.leaked += 1;
            }
            if verbose {
                println!("      + {describe}");
            }
        }
        seen.extend(relations.iter().map(|r| r.id.clone()));

        // Recall of what was required, and retraction of what must be gone.
        for fact in step.expect {
            metrics.expected += 1;
            if let Some(trace) = &trace {
                let pair = |a: &str, b: &str| {
                    (a.contains(fact.1) && b.contains(fact.2))
                        || (a.contains(fact.2) && b.contains(fact.1))
                };
                let directed = |a: &str, b: &str| {
                    (a.contains(fact.1) && b.contains(fact.2))
                        || (is_symmetric(fact.0) && a.contains(fact.2) && b.contains(fact.1))
                };
                metrics.funnel.push(FunnelRow {
                    fact: format!("{} {} -> {}", fact.0, fact.1, fact.2),
                    discovered: trace.pools.iter().any(|pool| {
                        pool.iter().any(|t| t.contains(fact.1))
                            && pool.iter().any(|t| t.contains(fact.2))
                    }),
                    proposed_pair: trace.proposals.iter().any(|(_, a, b)| pair(a, b)),
                    proposed_exact: trace
                        .proposals
                        .iter()
                        .any(|(kind, a, b)| kind == fact.0 && directed(a, b)),
                    votes: trace
                        .votes
                        .iter()
                        .filter(|v| pair(&v.first, &v.second))
                        .map(|v| {
                            format!("v{} (proposed {}) {}", v.vote, v.proposed_kind, v.summary)
                        })
                        .collect(),
                    persisted: relations.iter().any(|r| holds(r, fact, &title_of)),
                });
            }
            if relations.iter().any(|r| holds(r, fact, &title_of)) {
                metrics.found += 1;
            } else {
                if !relations.iter().any(|r| pair_matches(r, fact, &title_of)) {
                    *metrics
                        .confusion
                        .entry((fact.0.to_string(), "none".into()))
                        .or_default() += 1;
                }
                if verbose {
                    println!("      - MISSED {} {} -> {}", fact.0, fact.1, fact.2);
                }
            }
        }
        for fact in step.forbid {
            if relations.iter().any(|r| holds(r, fact, &title_of)) {
                metrics.retraction_failures += 1;
                if verbose {
                    println!("      ! STILL PRESENT {} {} -> {}", fact.0, fact.1, fact.2);
                }
            }
        }
        // Candidate discovery: was the partner of every expected edge among the nominees? (the double records the pools)
        if let Some(double) = &bench.double {
            let pools = double.pools.lock().unwrap();
            let new_pools: Vec<&Vec<String>> = pools.iter().skip(pools_before).collect();
            for fact in step.expect {
                if let Some(relation) = relations.iter().find(|r| holds(r, fact, &title_of)) {
                    metrics.pool_expected += 1;
                    if new_pools.iter().any(|pool| {
                        pool.contains(&relation.source_object_id)
                            && pool.contains(&relation.target_object_id)
                    }) {
                        metrics.pool_hit += 1;
                    }
                }
            }
            let requests = double
                .proposer_calls
                .load(std::sync::atomic::Ordering::SeqCst)
                + double
                    .verifier_calls
                    .load(std::sync::atomic::Ordering::SeqCst)
                - before_proposals
                - before_votes;
            metrics.max_requests_per_event = metrics
                .max_requests_per_event
                .max(requests / changes.len().max(1));
        }
    }

    // Whole-graph invariants.
    let relations = lab.store.list_relations().unwrap();
    let keys: BTreeSet<(String, String, String)> = relations
        .iter()
        .map(|r| {
            (
                r.kind.clone(),
                r.source_object_id.clone(),
                r.target_object_id.clone(),
            )
        })
        .collect();
    metrics.duplicates += relations.len() - keys.len();
    for user in &user_before {
        if !relations.contains(user) {
            metrics.user_mutations += 1;
        }
    }
    // All scenarios share one store, so the count of user relations is cumulative.
    metrics.users_seeded += user_before.len();
    let user_after = relations.iter().filter(|r| r.origin == "user").count();
    metrics.user_mutations += user_after.abs_diff(metrics.users_seeded);
    if relations.iter().any(|r| {
        r.origin == "model"
            && (foreign.contains(&r.source_object_id) || foreign.contains(&r.target_object_id))
    }) {
        metrics.leaked += 1;
    }
}

fn ratio(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        1.0
    } else {
        numerator as f64 / denominator as f64
    }
}

fn report(label: &str, metrics: &Metrics) {
    let correct = metrics.correct;
    let precision = ratio(correct, metrics.admitted);
    println!("\n=== {label} ===");
    println!(
        "events {}  new objects {}  admitted relations {}",
        metrics.events, metrics.objects, metrics.admitted
    );
    println!(
        "relation precision            {precision:.3}   (correct {correct} / admitted {})",
        metrics.admitted
    );
    println!(
        "relation recall               {:.3}   (found {} / expected {})",
        ratio(metrics.found, metrics.expected),
        metrics.found,
        metrics.expected
    );
    println!("relation-type accuracy        {:.3}   (right kind on {} of {} admitted edges on labelled pairs)", ratio(correct + metrics.wrong_direction, correct + metrics.wrong_kind + metrics.wrong_direction), correct + metrics.wrong_direction, correct + metrics.wrong_kind + metrics.wrong_direction);
    println!("direction accuracy            {:.3}   (directional admitted on labelled pairs: {}, wrong: {})", ratio(metrics.directional_correct, metrics.directional_admitted_labelled), metrics.directional_admitted_labelled, metrics.wrong_direction);
    println!(
        "false positives / object      {:.3}   ({} unlabelled + {} hard-negative hits)",
        metrics.false_positive as f64 / metrics.objects.max(1) as f64,
        metrics.false_positive,
        metrics.hard_negative_hits
    );
    println!("plausible extras accepted     {}", metrics.maybe_found);
    println!("project leakage               {}", metrics.leaked);
    println!("duplicate persisted relations {}", metrics.duplicates);
    println!("user-relation mutations       {}", metrics.user_mutations);
    println!(
        "retraction failures           {}",
        metrics.retraction_failures
    );
    println!(
        "idempotence violations        {}",
        metrics.idempotence_violations
    );
    println!(
        "max provider requests / event {}",
        metrics.max_requests_per_event
    );
    if metrics.pool_expected > 0 {
        println!("candidate discovery recall    {:.3}   ({} / {} expected edges had both ends in the pool)", ratio(metrics.pool_hit, metrics.pool_expected), metrics.pool_hit, metrics.pool_expected);
    }
    for line in &metrics.questionable {
        println!("  questionable: {line}");
    }
}

fn run_corpus(bench: &Bench, verbose: bool) -> Metrics {
    run_corpus_set(bench, verbose, "all")
}

/// `set`: `all`; `main` (the original 24 events); `holdout` (the unseen Bulgarian cases); `v2dev` / `v2holdout` (the expanded corpus; the
/// holdout half is never looked at while prompts are being tuned).
fn run_corpus_set(bench: &Bench, verbose: bool, set: &str) -> Metrics {
    let mut metrics = Metrics::default();
    let only = std::env::var("ARTHUR_AB_ONLY").ok();
    let wanted = |scenario: &Scenario| {
        only.as_deref()
            .is_none_or(|needle| scenario.name.contains(needle))
            && match set {
                "main" => !scenario.v2 && !scenario.holdout,
                "holdout" => !scenario.v2 && scenario.holdout,
                "v2dev" => scenario.v2 && !scenario.holdout && !scenario.name.starts_with("diag "),
                // M04.7A.3 focused diagnostic: the new temporal/moot cases plus the dev directional cases (where the verifier flipped with order).
                // The 12 dev directional cases only (M04.7A.3 phase 1: the supported-flag fix, isolated from the moot gate).
                "dir" => {
                    scenario.v2
                        && !scenario.holdout
                        && [
                            "v2 depends_on",
                            "v2 extends",
                            "v2 supersedes",
                            "v2 derived_from",
                        ]
                        .iter()
                        .any(|p| scenario.name.starts_with(p))
                }
                "moot" => {
                    scenario.name.starts_with("diag moot")
                        || scenario.name.starts_with("diag control")
                }
                // M04.7A.3 direction-aware dependency retraction: the cancelled-parent case plus paused / unavailable / reprioritised / active controls.
                "dep" => {
                    scenario.name.starts_with("diag dep")
                        || scenario
                            .name
                            .starts_with("diag moot: edit cancels the parent")
                }
                "diag" => {
                    scenario.name.starts_with("diag moot")
                        || scenario.name.starts_with("diag control")
                        || (scenario.v2
                            && !scenario.holdout
                            && [
                                "v2 depends_on",
                                "v2 extends",
                                "v2 supersedes",
                                "v2 derived_from",
                            ]
                            .iter()
                            .any(|p| scenario.name.starts_with(p)))
                }
                "v2holdout" => scenario.v2 && scenario.holdout,
                _ => true,
            }
    };
    for scenario in corpus().into_iter().chain(corpus_v2()).filter(wanted) {
        if verbose {
            println!("\n--- {}", scenario.name);
        }
        run_scenario(bench, &scenario, &mut metrics, verbose);
    }
    metrics
}

#[test]
fn integration_benchmark() {
    let double = Double::new(&[]);
    let bench = Bench::new(double.clone(), double.clone(), Some(double), false);
    let metrics = run_corpus(&bench, std::env::var("ARTHUR_BENCH_VERBOSE").is_ok());
    report("scripted double, semantic Recall OFF (pipeline policy, discovery, safety; NOT model quality)", &metrics);

    // Hard gates.
    assert_eq!(metrics.leaked, 0, "project leakage");
    assert_eq!(
        metrics.user_mutations, 0,
        "user-created relations modified or deleted"
    );
    assert_eq!(metrics.duplicates, 0, "duplicate persisted relations");
    assert_eq!(
        metrics.wrong_direction, 0,
        "an admitted directional relation has the wrong direction"
    );
    assert_eq!(
        metrics.hard_negative_hits, 0,
        "a hard negative or retracted relation was persisted"
    );
    assert_eq!(
        metrics.retraction_failures, 0,
        "a relation that stopped holding is still in the graph"
    );
    assert_eq!(
        metrics.idempotence_violations, 0,
        "integrating an event twice changed something"
    );
    assert!(
        metrics.max_requests_per_event <= super::MAX_PROVIDER_REQUESTS_PER_RUN,
        "provider budget"
    );
    assert_eq!(
        metrics.directional_correct, metrics.directional_admitted_labelled,
        "direction correctness on admitted directional relations"
    );
    // The double judges from the labels, so nothing is admitted that the labels do not hold.
    assert_eq!(metrics.false_positive + metrics.wrong_kind, 0);
    // What discovery is responsible for: the partner of every required edge must have been nominated.
    assert_eq!(
        metrics.pool_hit, metrics.pool_expected,
        "candidate discovery missed a required partner"
    );
    assert_eq!(
        metrics.found, metrics.expected,
        "a required relation was not produced"
    );
}

/// The same corpus with semantic Recall ON must not change what is safe; it can only add nominees.
#[test]
fn integration_benchmark_with_semantic_recall_on_keeps_every_gate() {
    let double = Double::new(&[]);
    let bench = Bench::new(double.clone(), double.clone(), Some(double), true);
    let metrics = run_corpus(&bench, false);
    report("scripted double, semantic Recall ON", &metrics);
    assert_eq!(
        (
            metrics.leaked,
            metrics.user_mutations,
            metrics.duplicates,
            metrics.wrong_direction,
            metrics.hard_negative_hits,
            metrics.idempotence_violations
        ),
        (0, 0, 0, 0, 0, 0)
    );
    assert_eq!(metrics.pool_hit, metrics.pool_expected);
}

/// Before/after for the realistic sequence of captures: how many useful edges exist after each capture, and how much noise.
#[test]
fn before_and_after_automatic_integration() {
    let sequence: Vec<(Obj, &'static [Fact])> = vec![
        (
            Obj(
                "idea",
                "Arthur on mobile and desktop",
                "Arthur should work on mobile and desktop.",
            ),
            &[],
        ),
        (
            Obj(
                "decision",
                "Use Tauri v2",
                "Use Tauri v2 for the unified client.",
            ),
            &[("depends_on", "Arthur on mobile and desktop", "Use Tauri v2")],
        ),
        (
            Obj(
                "task",
                "Android voice capture",
                "Implement Android voice capture for the mobile client.",
            ),
            &[(
                "extends",
                "Android voice capture",
                "Arthur on mobile and desktop",
            )],
        ),
        (
            Obj(
                "idea",
                "Phone works offline",
                "The phone should still work when the PC is offline.",
            ),
            &[(
                "extends",
                "Phone works offline",
                "Arthur on mobile and desktop",
            )],
        ),
        (
            Obj(
                "decision",
                "Local SQLite storage",
                "Keep captures in local SQLite storage on the phone so nothing needs the PC.",
            ),
            &[("depends_on", "Phone works offline", "Local SQLite storage")],
        ),
        (
            Obj("task", "Buy groceries", "Buy milk and bread tomorrow."),
            &[],
        ),
        (
            Obj(
                "idea",
                "Home Node sync later",
                "Synchronisation with the Home Node can come after the phone works alone.",
            ),
            &[("related_to", "Home Node sync later", "Phone works offline")],
        ),
    ];
    let world: &'static [Fact] = &[
        ("depends_on", "Arthur on mobile and desktop", "Use Tauri v2"),
        (
            "extends",
            "Android voice capture",
            "Arthur on mobile and desktop",
        ),
        (
            "extends",
            "Phone works offline",
            "Arthur on mobile and desktop",
        ),
        ("depends_on", "Phone works offline", "Local SQLite storage"),
        ("related_to", "Home Node sync later", "Phone works offline"),
    ];
    let double = Double::new(world);
    let bench = Bench::new(double.clone(), double.clone(), Some(double.clone()), false);
    let lab = bench.lab.clone();
    let project = lab.project("sequence");
    let title_of = |id: &str| {
        lab.store
            .get_knowledge_object(id)
            .unwrap()
            .map(|o| o.title)
            .unwrap_or_default()
    };
    println!("\n=== before/after: useful edges and noise after each capture ===");
    println!(
        "{:<34} {:>8} {:>8} {:>8}",
        "capture", "manual", "auto", "noise"
    );
    let mut total_noise = 0;
    for (object, expect) in &sequence {
        let id = lab.object(&project, object.0, object.1, object.2);
        let change = ChangedKnowledge::created(&id, &lab.current_revision(&id));
        run(bench.service.integrate(&lab.store, &bench.recall, change));
        let relations = lab.store.list_relations().unwrap();
        let useful = relations
            .iter()
            .filter(|r| world.iter().any(|fact| holds(r, fact, &title_of)))
            .count();
        let noise = relations.len() - useful;
        total_noise += noise;
        println!("{:<34} {:>8} {:>8} {:>8}", object.1, 0, useful, noise);
        let _ = expect;
    }
    assert_eq!(
        total_noise, 0,
        "useful connectivity rose and noise stayed at zero"
    );
    assert_eq!(lab.store.list_relations().unwrap().len(), world.len());
}

/// Manual "Find connections" looks at the 40 most recent objects. In a large project that window misses an old partner;
/// automatic integration nominates by relevance.
#[test]
fn manual_recency_window_versus_relevance_discovery_in_a_large_project() {
    let world: &'static [Fact] = &[("extends", "Capture shortcut", "Capture-first home")];
    let double = Double::new(world);
    let bench = Bench::new(double.clone(), double.clone(), Some(double.clone()), false);
    let lab = bench.lab.clone();
    let project = lab.project("large");
    let old = lab.object(
        &project,
        "decision",
        "Capture-first home",
        "The home screen opens straight into capture.",
    );
    for index in 0..60 {
        lab.object(
            &project,
            "note",
            &format!("Filler {index}"),
            &format!("Tomatoes and watering, filler note number {index}."),
        );
    }
    let new = lab.object(
        &project,
        "idea",
        "Capture shortcut",
        "A lock-screen shortcut that opens the capture-first home screen.",
    );

    // Manual: the existing explicit run, with its recency window of 40.
    let manual = GraphService::new(double.clone(), double.clone());
    let found = run(manual.infer_in(&lab.store, &[new.clone()], Some(&project))).unwrap();
    println!(
        "\nmanual (recency window of 40): {} relation(s); the old partner is {} objects old",
        found.len(),
        61
    );
    assert!(
        found.is_empty(),
        "the manual window cannot see an object that is 61 captures old"
    );
    assert!(lab.store.list_relations().unwrap().is_empty());

    // Automatic: relevance.
    let change = ChangedKnowledge::created(&new, &lab.current_revision(&new));
    run(bench.service.integrate(&lab.store, &bench.recall, change));
    let relations = lab.store.list_relations().unwrap();
    println!(
        "automatic (relevance discovery): {} relation(s)",
        relations.len()
    );
    assert_eq!(relations.len(), 1);
    assert!(relations[0].source_object_id == new && relations[0].target_object_id == old);
}

/// Opt-in: the SAME corpus through the real OpenAI proposer and verifier.
#[test]
#[ignore = "calls the real OpenAI API; set ARTHUR_LIVE_KEY_FILE"]
fn live_integration_benchmark() {
    use crate::graph::openai::{OpenAiRelationProposer, OpenAiRelationVerifier};
    use crate::providers::credentials::FileCredentialSource;
    let key_file = std::env::var("ARTHUR_LIVE_KEY_FILE").expect("ARTHUR_LIVE_KEY_FILE");
    let credentials = Arc::new(FileCredentialSource::new(key_file.into()));
    let proposer = Arc::new(OpenAiRelationProposer::new(credentials.clone()).unwrap());
    let verifier = Arc::new(OpenAiRelationVerifier::new(credentials).unwrap());
    let spy = Spy::new(proposer, verifier);
    let mut bench = Bench::new(spy.clone(), spy.clone(), None, false);
    bench.spy = Some(spy);
    let metrics = run_corpus(&bench, true);
    report("LIVE OpenAI, semantic Recall OFF", &metrics);
    assert_eq!(
        (
            metrics.leaked,
            metrics.user_mutations,
            metrics.duplicates,
            metrics.wrong_direction
        ),
        (0, 0, 0, 0),
        "hard gates"
    );
    println!(
        "\nPRODUCTION GATE precision >= 0.90: {}",
        if ratio(metrics.correct, metrics.admitted) >= 0.90 {
            "PASSED"
        } else {
            "NOT PASSED: keep automatic integration off by default"
        }
    );
}

/// Opt-in: the whole path, Capture -> real Distillation -> Automatic Graph Integration, in a clean project, for a designed sequence of
/// thoughts. Every persisted automatic relation is printed so it can be inspected by hand.
#[test]
#[ignore = "calls the real OpenAI API; set ARTHUR_LIVE_KEY_FILE"]
fn live_acceptance_through_capture_and_distillation() {
    use crate::distillation::openai::OpenAiDistiller;
    use crate::distillation::DistillationService;
    use crate::graph::openai::{OpenAiRelationProposer, OpenAiRelationVerifier};
    use crate::providers::credentials::FileCredentialSource;
    use crate::storage::capture_store::CreateCaptureInput;

    let credentials = Arc::new(FileCredentialSource::new(
        std::env::var("ARTHUR_LIVE_KEY_FILE")
            .expect("ARTHUR_LIVE_KEY_FILE")
            .into(),
    ));
    let spy = Spy::new(
        Arc::new(OpenAiRelationProposer::new(credentials.clone()).unwrap()),
        Arc::new(OpenAiRelationVerifier::new(credentials.clone()).unwrap()),
    );
    let mut bench = Bench::new(spy.clone(), spy.clone(), None, false);
    bench.spy = Some(spy.clone());
    let distillation =
        DistillationService::new(Arc::new(OpenAiDistiller::new(credentials).unwrap()));
    let lab = bench.lab.clone();
    let project = lab.project("Live acceptance");

    let thoughts = [
        "I want Arthur to work on both mobile and desktop, from one codebase.",
        "Decision: we use Tauri v2 for the unified client.",
        "Task: implement Android voice capture so I can speak a thought into the phone.",
        "Arthur must keep working when the PC is switched off, so the phone has to store everything locally in SQLite.",
        "Synchronisation with the Home Node can wait until the phone works completely on its own.",
        "I need to buy milk and bread tomorrow.",
        "Actually, Arthur should only run on the desktop. A phone client is not worth the effort.",
        "The phone must keep working offline, without the PC.",
        "Update: we are dropping Tauri and will build native Android and native desktop clients instead.",
        "Идея: Arthur трябва да пази знанията локално на телефона.",
        "Задача: да направя синхронизация между телефона и Home Node по-късно.",
        "Идея: Home Node трябва да е единственият източник на истина за знанията.",
        "The wristband should vibrate when recording starts.",
        "Remember to renew the domain name next month.",
    ];
    let title_of = |id: &str| {
        lab.store
            .get_knowledge_object(id)
            .unwrap()
            .map(|o| o.title)
            .unwrap_or_default()
    };
    let mut persisted = 0usize;
    let mut requests = 0usize;
    for (index, text) in thoughts.iter().enumerate() {
        let capture = lab
            .store
            .create(CreateCaptureInput {
                source: "text".into(),
                content: (*text).into(),
                project_id: Some(project.clone()),
            })
            .unwrap();
        let objects = match run(distillation.distill(&lab.store, &capture.id)) {
            Ok(objects) => objects,
            Err(error) => {
                println!("\n[{index:>2}] DISTILLATION FAILED: {error}");
                continue;
            }
        };
        println!(
            "\n[{index:>2}] \"{text}\"\n     -> {}",
            objects
                .iter()
                .map(|o| format!("{} \"{}\"", o.kind, o.title))
                .collect::<Vec<_>>()
                .join(" | ")
        );
        for object in &objects {
            let change = ChangedKnowledge::created(&object.id, &lab.current_revision(&object.id));
            let report = run(bench.service.integrate(&lab.store, &bench.recall, change));
            requests += report.decision.provider_requests;
            for line in spy.drain() {
                println!("       | {line}");
            }
            println!(
                "       integration: {:?} candidates={} added={} requests={} {} ms",
                report.status,
                report.candidates,
                report.added,
                report.decision.provider_requests,
                report.elapsed_ms
            );
        }
        let relations = lab.store.list_relations().unwrap();
        for relation in relations.iter().skip(persisted) {
            println!(
                "     + {} {} -> {} [{}]",
                relation.kind,
                title_of(&relation.source_object_id),
                title_of(&relation.target_object_id),
                relation.origin
            );
        }
        persisted = relations.len();
    }
    let relations = lab.store.list_relations().unwrap();
    println!("\n=== every automatic relation in the project ({} over {} objects, {} provider requests) ===", relations.len(), lab.store.list_knowledge_objects_in(Some(&project)).unwrap().len(), requests);
    for relation in &relations {
        println!(
            "  {} \"{}\" -> \"{}\" [{}]",
            relation.kind,
            title_of(&relation.source_object_id),
            title_of(&relation.target_object_id),
            relation.origin
        );
    }
    let keys: BTreeSet<_> = relations
        .iter()
        .map(|r| {
            (
                r.kind.clone(),
                r.source_object_id.clone(),
                r.target_object_id.clone(),
            )
        })
        .collect();
    assert_eq!(keys.len(), relations.len(), "no duplicate relation");
    assert!(relations.iter().all(|r| r.origin == "model"));
}

fn f1(precision: f64, recall: f64) -> f64 {
    if precision + recall == 0.0 {
        0.0
    } else {
        2.0 * precision * recall / (precision + recall)
    }
}

/// One run's numbers. Returns (strict precision, semantic-admissibility precision, contaminated).
fn ab_summary(
    label: &str,
    metrics: &Metrics,
    tokens: Option<(u64, u64, u64, u64)>,
) -> (f64, f64, bool) {
    let precision = ratio(metrics.correct, metrics.admitted);
    let semantic = ratio(metrics.admissible, metrics.admitted);
    let recall = ratio(metrics.found, metrics.expected);
    let labelled = metrics.correct + metrics.wrong_kind + metrics.wrong_direction;
    let contaminated = !metrics.provider_failures.is_empty(); // HTTP/network/other infrastructure failures only; parse failures are reported separately
    println!(
        "\n##### AB {label}{}",
        if contaminated {
            "  [CONTAMINATED: provider failures, excluded from aggregates]"
        } else {
            ""
        }
    );
    println!("AB strict_precision={precision:.3} semantic_admissibility_precision={semantic:.3} recall={recall:.3} f1={:.3}", f1(precision, recall));
    println!("AB type_accuracy={:.3} direction_accuracy={:.3} (directional labelled admitted {}, wrong {})", ratio(metrics.correct + metrics.wrong_direction, labelled), ratio(metrics.directional_correct, metrics.directional_admitted_labelled), metrics.directional_admitted_labelled, metrics.wrong_direction);
    println!(
        "AB accepted={} strict_correct={} admissible={} needing_review={}",
        metrics.admitted,
        metrics.correct,
        metrics.admissible,
        metrics.review.len()
    );
    println!("AB hard_negative_hits={} stale_relation_failures={} leakage={} duplicates={} user_mutations={} idempotence_violations={}", metrics.hard_negative_hits, metrics.retraction_failures, metrics.leaked, metrics.duplicates, metrics.user_mutations, metrics.idempotence_violations);
    println!("AB provider_failures={:?} contract_failures(parse)={} (events deferred and retried; their calls are counted in cost)", metrics.provider_failures, metrics.contract_failures);
    println!("AB raw_attempts stageA={} stageB={} | contract_invalid stageA={} stageB={} | deferred_or_failed_events={} (a stage-B pass is retried at most {} times per pass; exhausted retries leave the event deferred)", metrics.a_calls, metrics.b_calls, metrics.a_invalid, metrics.b_invalid, metrics.deferred_events, super::integrate::MAX_CONTRACT_RETRIES);
    println!(
        "AB provider_requests={} events_with_provider_work={} latency_per_event_ms={}",
        metrics.requests_total,
        metrics.provider_events,
        if metrics.provider_events == 0 {
            0
        } else {
            metrics.elapsed_total_ms / metrics.provider_events as u128
        }
    );
    if let Some((prompt, completion, reasoning, cached)) = tokens {
        println!("AB tokens prompt={prompt} completion={completion} (reasoning {reasoning}) cache_hit_prompt={cached}");
    }
    println!("AB ambiguity: surviving_pairs={} ambiguous_pairs={} ambiguity_rate={:.3} ambiguous_claims_dropped={}", metrics.surviving_pairs, metrics.ambiguous_pairs, ratio(metrics.ambiguous_pairs, metrics.surviving_pairs), metrics.ambiguous_dropped);
    for (kind, stat) in &metrics.binary {
        println!(
            "AB binary kind={kind} stageA_claims={} precision_strict={:.2} precision_admissible={:.2} recall={:.2} ({}/{}) | verified_claims={} precision_strict={:.2} precision_admissible={:.2} recall={:.2}",
            stat.claims, ratio(stat.claims_strict, stat.claims), ratio(stat.claims_admissible, stat.claims), ratio(stat.claimed_expected, stat.expected), stat.claimed_expected, stat.expected, stat.verified, ratio(stat.verified_strict, stat.verified), ratio(stat.verified_admissible, stat.verified), ratio(stat.verified_expected, stat.expected)
        );
    }
    let rows = &metrics.funnel;
    if !rows.is_empty() {
        let (n, d, p, e, k) = (
            rows.len(),
            rows.iter().filter(|r| r.discovered).count(),
            rows.iter().filter(|r| r.proposed_pair).count(),
            rows.iter().filter(|r| r.proposed_exact).count(),
            rows.iter().filter(|r| r.persisted).count(),
        );
        let exact_and_kept = rows
            .iter()
            .filter(|r| r.proposed_exact && r.persisted)
            .count();
        println!("AB funnel required={n} discovered={d} proposed_pair={p} proposed_exact={e} persisted={k}");
        println!("AB candidate_recall={:.3} proposal_recall={:.3} (of discovered) proposal_type_accuracy={:.3} (of proposed pairs) verifier_pass_rate={:.3} (of exact proposals) verifier_acceptance_precision_strict={precision:.3} verifier_acceptance_precision_semantic={semantic:.3} final_recall={recall:.3}", ratio(d, n), ratio(rows.iter().filter(|r| r.discovered && r.proposed_pair).count(), d), ratio(e, p), ratio(exact_and_kept, e));
        for row in rows {
            let stage = if !row.discovered {
                "LOST AT DISCOVERY"
            } else if !row.proposed_pair {
                "LOST AT STAGE A (no proposal for the pair)"
            } else if !row.proposed_exact {
                "STAGE A proposed another kind/direction"
            } else if !row.persisted {
                "LOST AT STAGE B / ADMISSION"
            } else {
                "persisted"
            };
            println!("AB funnel_row [{stage}] {} | discovered={} proposed_pair={} proposed_exact={} persisted={}", row.fact, row.discovered, row.proposed_pair, row.proposed_exact, row.persisted);
            for vote in &row.votes {
                println!("AB funnel_vote   {vote}");
            }
        }
    }
    for ((expected, predicted), count) in &metrics.confusion {
        println!("AB confusion expected={expected} predicted={predicted} n={count}");
    }
    for line in &metrics.review {
        println!("AB review {line}");
    }
    for edge in &metrics.edges {
        println!("AB edge {edge}");
    }
    (precision, semantic, contaminated)
}

fn gate(label: &str, metrics: &Metrics) {
    let strict = ratio(metrics.correct, metrics.admitted);
    let semantic = ratio(metrics.admissible, metrics.admitted);
    println!("\n##### PRODUCTION GATE {label}");
    println!(
        "GATE precision: strict {strict:.3} >= 0.90 OR semantic {semantic:.3} >= 0.95 -> {}",
        if strict >= 0.90 || semantic >= 0.95 {
            "PASS"
        } else {
            "FAIL"
        }
    );
    println!("GATE hard-negative hits = {} (clearly-wrong edges also need manual review of {} listed) -> {}", metrics.hard_negative_hits, metrics.review.len(), if metrics.hard_negative_hits == 0 && metrics.review.is_empty() { "PASS" } else { "FAIL / REVIEW" });
    println!(
        "GATE stale relation failures = {} -> {}",
        metrics.retraction_failures,
        if metrics.retraction_failures == 0 {
            "PASS"
        } else {
            "FAIL"
        }
    );
    println!(
        "GATE direction accuracy = {:.3} -> {}",
        ratio(
            metrics.directional_correct,
            metrics.directional_admitted_labelled
        ),
        if metrics.wrong_direction == 0 {
            "PASS"
        } else {
            "FAIL"
        }
    );
    println!(
        "GATE leakage={} user mutations={} duplicates={} -> {}",
        metrics.leaked,
        metrics.user_mutations,
        metrics.duplicates,
        if metrics.leaked + metrics.user_mutations + metrics.duplicates == 0 {
            "PASS"
        } else {
            "FAIL"
        }
    );
}

/// The controlled model A/B. Same corpus, labels, discovery, contracts and admission rules; only the model differs.
/// `ARTHUR_AB_PROVIDER=openai|deepseek` (default deepseek), `ARTHUR_AB_RUNS=3`, `ARTHUR_AB_SET=main|holdout` (default main).
/// DeepSeek reads `DEEPSEEK_API_KEY`; OpenAI uses `ARTHUR_LIVE_KEY_FILE`.
#[test]
#[ignore = "calls a real provider"]
fn live_ab_benchmark() {
    use crate::graph::deepseek_bench::{DeepSeek, DeepSeekProposer, DeepSeekVerifier};
    use crate::graph::openai::{OpenAiRelationProposer, OpenAiRelationVerifier};
    use crate::providers::credentials::FileCredentialSource;

    let provider = std::env::var("ARTHUR_AB_PROVIDER").unwrap_or_else(|_| "deepseek".into());
    let runs: usize = std::env::var("ARTHUR_AB_RUNS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3);
    let set = std::env::var("ARTHUR_AB_SET").unwrap_or_else(|_| "main".into());
    let mut precisions: Vec<(f64, f64)> = Vec::new();
    let mut edge_sets: Vec<BTreeSet<String>> = Vec::new();
    for run_index in 1..=runs {
        let meter = (provider == "deepseek").then(DeepSeek::new);
        let (proposer, verifier): (Arc<dyn RelationProposer>, Arc<dyn RelationVerifier>) =
            match &meter {
                Some(client) => (
                    Arc::new(DeepSeekProposer(client.clone())),
                    Arc::new(DeepSeekVerifier(client.clone())),
                ),
                None => {
                    let credentials = Arc::new(FileCredentialSource::new(
                        std::env::var("ARTHUR_LIVE_KEY_FILE")
                            .expect("ARTHUR_LIVE_KEY_FILE")
                            .into(),
                    ));
                    let verifier = OpenAiRelationVerifier::new(credentials.clone()).unwrap();
                    (
                        Arc::new(OpenAiRelationProposer::new(credentials).unwrap()),
                        Arc::new(verifier),
                    )
                }
            };
        let spy = Spy::new(proposer, verifier);
        let mut bench = Bench::new(spy.clone(), spy.clone(), None, false);
        bench.spy = Some(spy);
        println!(
            "\n########## RUN {run_index} ({provider}, {}) ##########",
            set
        );
        let metrics = run_corpus_set(&bench, true, &set);
        let tokens = meter.as_ref().map(|c| {
            use std::sync::atomic::Ordering::SeqCst;
            {
                println!(
                    "AB transport_retries_absorbed={} http_calls_total_incl_failed={}",
                    c.meter.retries.load(SeqCst),
                    c.meter.requests.load(SeqCst)
                );
                (
                    c.meter.prompt_tokens.load(SeqCst),
                    c.meter.completion_tokens.load(SeqCst),
                    c.meter.reasoning_tokens.load(SeqCst),
                    c.meter.cache_hit_tokens.load(SeqCst),
                )
            }
        });
        let (strict, semantic, contaminated) =
            ab_summary(&format!("{provider} run {run_index}"), &metrics, tokens);
        gate(&format!("{provider} run {run_index}"), &metrics);
        if !contaminated {
            precisions.push((strict, semantic));
            edge_sets.push(metrics.edges.clone());
        }
        assert_eq!(
            (
                metrics.leaked,
                metrics.user_mutations,
                metrics.duplicates,
                metrics.wrong_direction
            ),
            (0, 0, 0, 0),
            "hard invariants"
        );
    }
    let spread = |values: Vec<f64>| {
        let mut v = values;
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        if v.is_empty() {
            (0.0, 0.0, 0.0)
        } else {
            (v[0], v[v.len() / 2], v[v.len() - 1])
        }
    };
    let (s, q) = (
        spread(precisions.iter().map(|p| p.0).collect()),
        spread(precisions.iter().map(|p| p.1).collect()),
    );
    println!(
        "\n##### AB AGGREGATE {provider} over {} uncontaminated run(s)",
        precisions.len()
    );
    println!("AB strict precision min={:.3} median={:.3} max={:.3}; semantic precision min={:.3} median={:.3} max={:.3}", s.0, s.1, s.2, q.0, q.1, q.2);
    for i in 0..edge_sets.len() {
        for j in i + 1..edge_sets.len() {
            let both = edge_sets[i].intersection(&edge_sets[j]).count();
            let either = edge_sets[i].union(&edge_sets[j]).count();
            println!(
                "AB agreement run{} vs run{}: jaccard={:.3} ({both} shared of {either})",
                i + 1,
                j + 1,
                ratio(both, either)
            );
        }
    }
    // Per-edge admission frequency and relation-type stability (diagnostics only; nothing like this runs in production).
    let all: BTreeSet<&String> = edge_sets.iter().flatten().collect();
    let n = edge_sets.len();
    let mut by_frequency = [0usize; 8];
    for edge in &all {
        let seen = edge_sets.iter().filter(|set| set.contains(*edge)).count();
        by_frequency[seen.min(7)] += 1;
        println!("AB frequency {seen}/{n} {edge}");
    }
    println!(
        "AB edges by admission frequency: {:?} (index = runs in which the edge appeared)",
        &by_frequency[..=n.min(7)]
    );
    let mut kinds_by_pair: std::collections::BTreeMap<String, BTreeSet<String>> =
        std::collections::BTreeMap::new();
    for edge in &all {
        let parts: Vec<&str> = edge.split('|').collect();
        let mut pair = [parts[1], parts[2]];
        pair.sort();
        kinds_by_pair
            .entry(pair.join(" <-> "))
            .or_default()
            .insert(parts[0].to_string());
    }
    let unstable = kinds_by_pair
        .values()
        .filter(|kinds| kinds.len() > 1)
        .count();
    println!("AB relation-type stability: {} of {} related pairs received more than one kind across runs", unstable, kinds_by_pair.len());
    for (pair, kinds) in kinds_by_pair.iter().filter(|(_, k)| k.len() > 1) {
        println!("AB unstable_kind {pair}: {kinds:?}");
    }
}

/// Bulgarian diagnosis (M04.7A.1): does the same pair get a proposal in English, in Bulgarian, and in Bulgarian with explicit wording?
/// If English also yields nothing, the miss is the weakness of the (implicit) relation, not the language. Diagnostic only.
#[test]
#[ignore = "calls the real OpenAI API; set ARTHUR_LIVE_KEY_FILE"]
fn live_bulgarian_proposal_diagnosis() {
    use crate::graph::openai::OpenAiRelationProposer;
    use crate::providers::credentials::FileCredentialSource;
    let credentials = Arc::new(FileCredentialSource::new(
        std::env::var("ARTHUR_LIVE_KEY_FILE")
            .expect("ARTHUR_LIVE_KEY_FILE")
            .into(),
    ));
    let proposer = OpenAiRelationProposer::new(credentials).unwrap();
    let variants: [(&str, (&str, &str), (&str, &str)); 4] = [
        ("BG original", ("Arthur работи без компютъра", "Arthur трябва да работи без компютъра."), ("Телефонът пази знанията", "Телефонът пази знанията локално в SQLite.")),
        ("EN translation", ("Arthur works without the computer", "Arthur must work without the computer."), ("The phone keeps the knowledge", "The phone keeps the knowledge locally in SQLite.")),
        ("BG explicit wording", ("Arthur работи без компютъра", "Arthur трябва да работи без компютъра."), ("Телефонът пази знанията", "За да работи Arthur без компютъра, телефонът трябва да пази знанията локално в SQLite.")),
        ("EN explicit wording", ("Arthur works without the computer", "Arthur must work without the computer."), ("The phone keeps the knowledge", "For Arthur to work without the computer, the phone has to keep the knowledge locally in SQLite.")),
    ];
    for (label, (t1, b1), (t2, b2)) in variants {
        for attempt in 1..=3 {
            let lab = Lab::new();
            let project = lab.project("diagnosis");
            let first = lab.object(&project, "idea", t1, b1);
            let second = lab.object(&project, "decision", t2, b2);
            let objects = lab.store.list_knowledge_objects_in(Some(&project)).unwrap();
            let title = |id: &str| {
                objects
                    .iter()
                    .find(|o| o.id == id)
                    .map(|o| o.title.clone())
                    .unwrap_or_default()
            };
            let result = run(proposer.propose_for(&second, &objects, &[]));
            let _ = first;
            match result {
                Ok(list) if list.is_empty() => {
                    println!("DIAG {label} #{attempt}: proposes nothing")
                }
                Ok(list) => {
                    for c in list {
                        println!(
                            "DIAG {label} #{attempt}: {} {} -> {}  ({})",
                            c.kind,
                            title(&c.source_object_id),
                            title(&c.target_object_id),
                            c.reason
                        );
                    }
                }
                Err(error) => println!("DIAG {label} #{attempt}: failed {error}"),
            }
        }
    }
}

/// Prints the corpus labels as JSON lines (free, deterministic) so audits of saved live logs can join claims to labels.
/// `cargo test --lib dump_corpus_labels -- --nocapture --ignored`
#[test]
#[ignore = "diagnostic output only"]
fn dump_corpus_labels() {
    let facts = |list: &[Fact]| {
        list.iter()
            .map(|f| serde_json::json!([f.0, f.1, f.2]))
            .collect::<Vec<_>>()
    };
    for scenario in corpus().into_iter().chain(corpus_v2()) {
        let mut world: &[Fact] = scenario.world;
        for (index, step) in scenario.steps.iter().enumerate() {
            if let Some(next) = step.world {
                world = next;
            }
            let action = match &step.action {
                Action::Capture(o) => serde_json::json!({ "capture": o.1 }),
                Action::Burst(list) => {
                    serde_json::json!({ "burst": list.iter().map(|o| o.1).collect::<Vec<_>>() })
                }
                Action::Edit(title, _) => serde_json::json!({ "edit": title }),
            };
            println!(
                "LABEL {}",
                serde_json::json!({
                    "scenario": scenario.name, "step": index, "v2": scenario.v2, "holdout": scenario.holdout, "action": action,
                    "expect": facts(step.expect), "maybe": facts(step.maybe), "forbid": facts(step.forbid), "world": facts(world), "acceptable": facts(scenario.acceptable),
                    "seed": scenario.seed.iter().map(|o| o.1).collect::<Vec<_>>(),
                })
            );
        }
    }
}

#[cfg(test)]
mod accounting_tests {
    use super::*;

    fn vote(
        vote: usize,
        kind: &str,
        first: &str,
        second: &str,
        source: &str,
        target: &str,
        accepted: bool,
    ) -> VoteRecord {
        VoteRecord {
            vote,
            proposed_kind: kind.into(),
            first: first.into(),
            second: second.into(),
            accepted,
            source: source.into(),
            target: target.into(),
            summary: String::new(),
        }
    }

    #[test]
    fn a_symmetric_claim_survives_whichever_order_the_two_passes_name_its_ends() {
        // The recorded-run bug: a symmetric kind has no direction, and the two passes list the pair in opposite orders.
        for kind in ["contradicts", "duplicates", "related_to"] {
            let votes = vec![
                vote(1, kind, "A", "B", "A", "B", true),
                vote(2, kind, "A", "B", "B", "A", true),
            ];
            assert_eq!(survivors_of(&votes).len(), 1, "{kind}");
        }
    }

    #[test]
    fn a_directional_claim_needs_both_passes_to_name_the_same_direction() {
        for kind in ["depends_on", "extends", "derived_from", "supersedes"] {
            assert_eq!(
                survivors_of(&[
                    vote(1, kind, "A", "B", "A", "B", true),
                    vote(2, kind, "A", "B", "A", "B", true)
                ])
                .len(),
                1,
                "{kind} same direction"
            );
            assert!(
                survivors_of(&[
                    vote(1, kind, "A", "B", "A", "B", true),
                    vote(2, kind, "A", "B", "B", "A", true)
                ])
                .is_empty(),
                "{kind} opposite directions"
            );
        }
    }

    #[test]
    fn vote_accounting_requires_both_passes_the_same_claim_and_counts_it_once() {
        assert!(
            survivors_of(&[
                vote(1, "extends", "A", "B", "A", "B", true),
                vote(2, "extends", "A", "B", "A", "B", false)
            ])
            .is_empty(),
            "one pass only"
        );
        assert!(
            survivors_of(&[
                vote(1, "extends", "A", "B", "A", "B", true),
                vote(2, "depends_on", "A", "B", "A", "B", true)
            ])
            .is_empty(),
            "different claims"
        );
        let twice = vec![
            vote(1, "extends", "A", "B", "A", "B", true),
            vote(2, "extends", "A", "B", "A", "B", true),
            vote(1, "extends", "A", "B", "A", "B", true),
            vote(2, "extends", "A", "B", "A", "B", true),
        ];
        assert_eq!(
            survivors_of(&twice).len(),
            1,
            "a retried event does not double count"
        );
    }

    #[test]
    fn failures_are_classified_so_a_parse_failure_is_never_an_outage_or_a_semantic_rejection() {
        assert_eq!(
            classify_failure("llm_failed: The language model failed (HTTP 402). Try again."),
            FailureKind::Http("402".into())
        );
        assert_eq!(
            classify_failure("llm_failed: The language model failed (HTTP 429). Try again."),
            FailureKind::Http("429".into())
        );
        assert_eq!(classify_failure("llm_failed: Could not reach the language model. Check the connection and try again."), FailureKind::Network);
        assert_eq!(classify_failure("llm_invalid_output: The language model returned something that could not be trusted (not the requested structure). Nothing was saved. Try again."), FailureKind::Contract);
        assert_eq!(classify_failure("storage_failed: x"), FailureKind::Other);
    }
}
