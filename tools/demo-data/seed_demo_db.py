#!/usr/bin/env python3
"""
Seed a DEMO Arthur database for visual evaluation. Not a product feature.

It never touches the real app database. The demo lives in its own XDG data home, and the script refuses to write to the
real location. The schema is NOT copied: it is extracted from apps/arthur/src-tauri/src/storage/migrations.rs, so it
cannot drift from what the app creates. Rows are written under the app's own rules (immutability triggers, projection
guard, canonical relation order, code-point provenance spans, RFC 3339 times), then verified.

  python3 tools/demo-data/seed_demo_db.py --reset            # (re)create and verify
  python3 tools/demo-data/seed_demo_db.py --verify-only      # check an existing demo DB
  XDG_DATA_HOME=~/.local/share/arthur-demo  <launch the app> # run the app against it

Ids are deterministic (uuid5 of a stable name), so re-seeding gives the same ids. Times are relative to "now" at seed
time (--now to pin), so Home shows Today / Yesterday / older groups whenever you seed.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
MIGRATIONS = REPO / "apps/arthur/src-tauri/src/storage/migrations.rs"
IDENTIFIER = "dev.kaloyan.arthur"  # tauri.conf.json "identifier": the folder name under the data home
REAL_DB = Path.home() / ".local/share" / IDENTIFIER / "arthur.db"
DEFAULT_HOME = Path.home() / ".local/share/arthur-demo"
NS = uuid.UUID("6f1c0a52-8b0e-4d52-9a57-5a5d1d7e0001")
SYMMETRIC = {"related_to", "contradicts", "duplicates"}


def uid(*parts: str) -> str:
    return str(uuid.uuid5(NS, "/".join(parts)))


# --------------------------------------------------------------------------------------------------- the story
# A capture: (key, source, age, content, objects). age = (days, hours, minutes) before "now".
# An object: (key, kind, title, body, evidence). `evidence` must appear verbatim in the capture: it is the provenance span.
# objects=None means: never distilled ("Not organized yet"). objects=[] means: distilled, nothing to structure.
CAPTURES = [
    ("c01", "text", (34, 0, 0), "Arthur should be a thinking partner, not another notes app. Raw captures are never edited. Everything Arthur derives must point back at the exact words. What does 'organized' even mean for a half-formed thought?", [
        ("partner", "idea", "Arthur is a thinking partner", "Arthur should be a thinking partner, not another notes app.", "Arthur should be a thinking partner, not another notes app."),
        ("raw_immutable", "decision", "Raw captures are never edited", "Raw captures are never edited.", "Raw captures are never edited."),
        ("points_back", "decision", "Everything derived points back at the exact words", "Everything Arthur derives must point back at the exact words.", "Everything Arthur derives must point back at the exact words."),
        ("organized_q", "question", "What does 'organized' mean for a half-formed thought?", "What does 'organized' even mean for a half-formed thought?", "What does 'organized' even mean for a half-formed thought?"),
    ]),
    ("c02", "voice", (29, 0, 0), "Okay so the phone is where most of my thoughts happen. I want to capture with one gesture, ideally voice, and have it just work on the train with no signal. Maybe the first screen is only a microphone. Then later Arthur organizes it. Email Ignatov to ask whether the demo can run on Android.", [
        ("voice_mobile", "idea", "Voice-first mobile capture", "Capture with one gesture, ideally voice, on the phone.", "I want to capture with one gesture, ideally voice"),
        ("offline", "idea", "Capture must work offline", "Capture has to work on the train with no signal.", "have it just work on the train with no signal"),
        ("mic_first", "idea", "The first screen is only a microphone", "Maybe the first screen is only a microphone.", "Maybe the first screen is only a microphone."),
        ("ask_android", "task", "Ask Ignatov whether the demo can run on Android", "Email Ignatov to ask whether the demo can run on Android.", "Email Ignatov to ask whether the demo can run on Android."),
    ]),
    ("c03", "text", (26, 0, 0), "The graph should explain itself. Typed relations: extends, depends on, contradicts, derived from, duplicates, supersedes. Colour alone is not enough, someone with colour blindness must read it too. A hairball with 400 nodes is useless, so filtering by relation type matters. Edge labels only when selected.", [
        ("graph_explains", "idea", "The graph should explain itself", "The graph should explain itself.", "The graph should explain itself."),
        ("typed_rel", "decision", "Relations are typed, not just links", "Typed relations: extends, depends on, contradicts, derived from, duplicates, supersedes.", "Typed relations: extends, depends on, contradicts, derived from, duplicates, supersedes."),
        ("no_colour_alone", "decision", "Never rely on colour alone", "Colour alone is not enough: someone with colour blindness must read it too.", "Colour alone is not enough, someone with colour blindness must read it too."),
        ("filter_rel", "idea", "Filter by relation type so large graphs stay readable", "A hairball with 400 nodes is useless, so filtering by relation type matters.", "A hairball with 400 nodes is useless, so filtering by relation type matters."),
        ("edge_labels", "idea", "Edge labels only when selected", "Show edge labels only when an edge or its node is selected.", "Edge labels only when selected."),
    ]),
    ("c04", "voice", (21, 0, 0), "Искам Arthur да разбира български. Когато говоря на телефона, понякога смесвам английски и български 😀. Трябва ли да превеждаме заглавията или да ги оставим както са казани? Да не забравя да питам Игнатов за конкурса.", [
        ("bg_understand", "idea", "Arthur трябва да разбира български", "Искам Arthur да разбира български.", "Искам Arthur да разбира български."),
        ("bg_translate", "question", "Да превеждаме ли заглавията?", "Трябва ли да превеждаме заглавията или да ги оставим както са казани?", "Трябва ли да превеждаме заглавията или да ги оставим както са казани?"),
        ("bg_ignatov", "task", "Да питам Игнатов за конкурса", "Да не забравя да питам Игнатов за конкурса.", "Да не забравя да питам Игнатов за конкурса."),
        ("bg_mixed", "note", "Смесен английски и български при говор 😀", "Когато говоря на телефона, понякога смесвам английски и български 😀.", "Когато говоря на телефона, понякога смесвам английски и български 😀."),
    ]),
    ("c05", "text", (18, 0, 0), "EMG wristband as a capture trigger: a double clench starts recording, another stops it. Latency matters more than accuracy here. False triggers while typing would be maddening. Need to measure latency on the real device before promising anything.", [
        ("emg_trigger", "decision", "Use EMG wristband to start and stop capture", "A double clench starts recording, another stops it.", "EMG wristband as a capture trigger: a double clench starts recording, another stops it."),
        ("double_clench", "idea", "A double clench starts recording", "A double clench starts recording.", "a double clench starts recording, another stops it."),
        ("false_triggers", "question", "How many false triggers while typing are tolerable?", "False triggers while typing would be maddening.", "False triggers while typing would be maddening."),
        ("measure_latency", "task", "Measure wristband latency on the real device", "Measure latency on the real device before promising anything.", "Need to measure latency on the real device before promising anything."),
        ("latency_note", "note", "Latency matters more than accuracy for capture triggers", "Latency matters more than accuracy here.", "Latency matters more than accuracy here."),
    ]),
    ("c06", "text", (14, 0, 0), "Demo plan for the competition: show capture, then Arthur organizing, then the graph, then how one idea changed over time. Keep it under five minutes. Prepare a laptop with the app preloaded with real thoughts, not lorem ipsum. Charge the wristband. Print the architecture overview.", [
        ("demo_order", "decision", "Demo order: capture, organize, graph, evolution", "Show capture, then Arthur organizing, then the graph, then how one idea changed over time.", "show capture, then Arthur organizing, then the graph, then how one idea changed over time."),
        ("five_min", "note", "The demo must fit in five minutes", "Keep it under five minutes.", "Keep it under five minutes."),
        ("preload_laptop", "task", "Preload the demo laptop with real thoughts", "Prepare a laptop with the app preloaded with real thoughts, not lorem ipsum.", "Prepare a laptop with the app preloaded with real thoughts, not lorem ipsum."),
        ("charge_wrist", "task", "Charge the wristband", "Charge the wristband.", "Charge the wristband."),
        ("print_arch", "task", "Print the architecture overview", "Print the architecture overview.", "Print the architecture overview."),
    ]),
    ("c07", "voice", (11, 0, 0), "What happens when two ideas contradict each other? Maybe Arthur should flag it but never decide. Maybe the newer idea supersedes the older one, but only if I say so. I keep going back and forth on single page dashboard versus separate screens.", [
        ("contradict_q", "question", "What happens when two ideas contradict?", "What happens when two ideas contradict each other?", "What happens when two ideas contradict each other?"),
        ("flag_not_decide", "decision", "Arthur flags contradictions but never decides", "Arthur should flag a contradiction but never decide.", "Maybe Arthur should flag it but never decide."),
        ("supersede_idea", "idea", "A newer idea can supersede an older one if I say so", "Maybe the newer idea supersedes the older one, but only if I say so.", "Maybe the newer idea supersedes the older one, but only if I say so."),
        ("dashboard", "idea", "Single-page dashboard layout", "Keep everything on one page.", "single page dashboard versus separate screens."),
    ]),
    ("c08", "text", (9, 0, 0), "Architecture notes. Capture is raw and immutable. Distillation turns a capture into objects, each with a span of the original text. The cognitive graph relates objects to objects. Thought lineage records how a single object changed: initial, edit, branch, merge. These are four separate systems and must never be mixed: provenance is not a relation, and a relation is not a revision. Recall comes later and will read from all of them but write to none.", [
        ("arch_overview", "note", "Arthur architecture overview", "Capture is raw and immutable. Distillation turns a capture into objects, each with a span of the original text.", "Capture is raw and immutable. Distillation turns a capture into objects, each with a span of the original text."),
        ("four_systems", "note", "Provenance, relations and revisions are four separate systems alongside recall, and must never be mixed or confused with each other", "These are four separate systems and must never be mixed: provenance is not a relation, and a relation is not a revision.", "These are four separate systems and must never be mixed: provenance is not a relation, and a relation is not a revision."),
        ("recall_reads", "idea", "Recall reads from everything and writes to nothing", "Recall comes later and will read from all of them but write to none.", "Recall comes later and will read from all of them but write to none."),
    ]),
    ("c09", "text", (6, 0, 0), "Redesign the home screen so it feels less like a database. A big calm composer, today's thoughts grouped by capture, a small map of connected thinking, and what changed recently. No stat tiles. Serif for thoughts, sans for the interface.", [
        ("ui_redesign", "idea", "Arthur UI redesign", "Redesign the home screen so it feels less like a database.", "Redesign the home screen so it feels less like a database."),
        ("home_by_capture", "idea", "Home groups thoughts by capture", "Today's thoughts grouped by capture.", "today's thoughts grouped by capture"),
        ("no_stats", "decision", "No stat tiles", "No stat tiles.", "No stat tiles."),
        ("serif_sans", "decision", "Serif for thoughts, sans for the interface", "Serif for thoughts, sans for the interface.", "Serif for thoughts, sans for the interface."),
    ]),
    ("c10", "voice", (5, 0, 0), "Um, hold on, I lost my train of thought.", []),
    ("c11", "text", (3, 0, 0), "Improve graph visualization: relation types need clearer shapes, a legend that doubles as a filter, and a focused view around the selected node. Also look at how other tools do keyboard shortcuts but do not copy them. Email Ignatov the latest concepts.", [
        ("improve_graph", "idea", "Improve graph visualization", "Relation types need clearer shapes, a legend that doubles as a filter, and a focused view around the selected node.", "Improve graph visualization: relation types need clearer shapes, a legend that doubles as a filter, and a focused view around the selected node."),
        ("legend_filter", "idea", "The legend doubles as a filter", "A legend that doubles as a filter.", "a legend that doubles as a filter"),
        ("shortcuts_note", "note", "Look at keyboard shortcut conventions, do not copy them", "Look at how other tools do keyboard shortcuts but do not copy them.", "Also look at how other tools do keyboard shortcuts but do not copy them."),
        ("email_ignatov", "task", "Email Ignatov the latest concepts", "Email Ignatov the latest concepts.", "Email Ignatov the latest concepts."),
    ]),
    ("c12", "voice", (1, 2, 0), "The mobile app should be voice-first and require almost no navigation from the user. Focus on quick capture, clean UI and seamless organization. It should feel like a natural extension of my thinking, not a traditional notes app.", [
        ("mobile", "idea", "Mobile app experience", "The mobile app should be voice-first and require almost no navigation from the user. Focus on quick capture, clean UI and seamless organization.", "The mobile app should be voice-first and require almost no navigation from the user. Focus on quick capture, clean UI and seamless organization."),
        ("seamless", "idea", "Seamless organization after capture", "Seamless organization: capture, then let Arthur do the filing.", "seamless organization"),
    ]),
    ("c13", "text", (0, 3, 0), "Auto-organize after capture: persist first, never let the model block saving, show a small organizing state, and offer a retry if it fails. Check with Ignatov tomorrow about the cloud key for the demo.", [
        ("persist_first", "decision", "Persist first, organize second", "Persist first, and never let the model block saving.", "persist first, never let the model block saving"),
        ("retryable", "idea", "A failed organize must be retryable", "Show a small organizing state, and offer a retry if it fails.", "show a small organizing state, and offer a retry if it fails."),
        ("ask_key", "task", "Ask Ignatov about the cloud key for the demo", "Check with Ignatov tomorrow about the cloud key for the demo.", "Check with Ignatov tomorrow about the cloud key for the demo."),
    ]),
    ("c14", "voice", (0, 0, 40), "Just a thought: what if Arthur could say what changed in my thinking this week? Not a summary, a diff of ideas.", None),
    ("c15", "text", (0, 0, 10), "Remember to buy a charger for the wristband.", [
        ("buy_charger", "task", "Buy a charger for the wristband", "Remember to buy a charger for the wristband.", "Remember to buy a charger for the wristband."),
    ]),
    ("c16", "voice", (0, 2, 30), "More on mobile: capture must work without a connection and sync later when the phone is back online.", [
        ("sync_later", "idea", "Sync after the phone is back online", "Capture must work without a connection and sync later.", "capture must work without a connection and sync later when the phone is back online"),
    ]),
]


@dataclass
class Rev:
    key: str
    origin: str
    parents: list[str]
    age: tuple[int, int, int]  # before now
    title: str | None = None   # None = unchanged from the parent
    body: str | None = None
    kind: str | None = None
    span: tuple[str, str] | None = None  # (capture key, evidence) for a revision interpreted from a NEW capture
    current: bool = False


# Revision histories AFTER the initial revision (which every object gets). Order = creation order.
HISTORY: dict[str, list[Rev]] = {
    "mobile": [
        Rev("r2", "user_edit", ["r1"], (1, 0, 0), body="The mobile app should be voice-first and require almost no navigation from the user. Focus on quick capture, clean UI and seamless organization. It should feel like a natural extension of my thinking, not a traditional notes app."),
        Rev("r3", "distillation", ["r1"], (0, 2, 20), body="The mobile app should be voice-first and require almost no navigation from the user. Focus on quick capture, clean UI and seamless organization. Capture must work without a connection and sync later.", span=("c16", "capture must work without a connection and sync later when the phone is back online")),
        Rev("r4", "merge", ["r2", "r3"], (0, 1, 30), body="The mobile app should be voice-first and require almost no navigation from the user. Focus on quick capture, clean UI and seamless organization. Capture must work without a connection and sync later. It should feel like a natural extension of my thinking, not a traditional notes app."),
        Rev("r5", "user_edit", ["r4"], (0, 0, 20), title="Arthur mobile app experience", current=True),
    ],
    "ui_redesign": [
        Rev("r2", "user_edit", ["r1"], (5, 0, 0), body="Redesign the home screen so it feels less like a database. A big calm composer, today's thoughts grouped by capture, a small map of connected thinking, and what changed recently."),
        Rev("r3", "user_edit", ["r2"], (3, 0, 0), body="Redesign the home screen so it feels less like a database. A big calm composer, today's thoughts grouped by capture, a small map of connected thinking, and what changed recently. No stat tiles."),
        Rev("r4", "user_edit", ["r3"], (1, 0, 0), title="Arthur UI redesign: Marginalia", current=True),
    ],
    "emg_trigger": [
        Rev("r2", "user_edit", ["r1"], (16, 0, 0), body="A double clench starts recording, another stops it. Latency matters more than accuracy here."),
        Rev("r3", "user_edit", ["r1"], (15, 0, 0), body="A single long clench toggles recording. No double gesture."),
        Rev("r4", "user_edit", ["r1"], (14, 20, 0), body="Use the wristband only to start recording; stop by voice command."),
        Rev("r5", "merge", ["r2", "r3", "r4"], (12, 0, 0), body="A double clench starts and stops recording. Latency matters more than accuracy. Gesture alternatives stay documented but are not shipped.", current=True),
    ],
    "dashboard": [Rev("r2", "user_edit", ["r1"], (6, 0, 0), body="Keep everything on one page. Revisit when the number of ideas grows.", current=True)],
    "graph_explains": [
        Rev("r2", "user_edit", ["r1"], (24, 0, 0), body="The graph should explain itself: relation types are visible and nothing needs a manual."),
        Rev("r3", "user_edit", ["r2"], (20, 0, 0), title="The graph should explain itself, not decorate"),
        Rev("r4", "system", ["r3"], (19, 0, 0), body="The graph should explain itself: relation types are visible and nothing needs a manual to be understood.", current=True),
    ],
    "improve_graph": [Rev("r2", "user_edit", ["r1"], (2, 0, 0), body="Offer a list view as the accessible alternative, and keep the map for exploring.")],  # a branch: NOT current
    "partner": [
        Rev("r2", "user_edit", ["r1"], (33, 0, 0), body="Arthur should be a thinking partner, not another notes app. It should feel like an extension of my thinking."),
        Rev("r3", "user_edit", ["r2"], (30, 0, 0), title="Arthur is a thinking partner, not a notes app"),
        Rev("r4", "user_edit", ["r3"], (20, 0, 0), body="Arthur should be a thinking partner, not another notes app. It should feel like an extension of my thinking. Capture quickly. Arthur organizes. Explore when needed."),
        Rev("r5", "user_edit", ["r4"], (8, 0, 0), body="Arthur should be a thinking partner, not another notes app. It should feel like an extension of my thinking. Capture quickly. Arthur organizes. Explore when needed. It is not a chat app either."),
        Rev("r6", "user_edit", ["r5"], (2, 0, 0), body="A thinking partner: capture quickly, Arthur organizes, explore when needed. Not a notes app and not a chat app.", current=True),
    ],
    "bg_understand": [Rev("r2", "user_edit", ["r1"], (19, 0, 0), body="Искам Arthur да разбира български, включително когато смесвам английски и български 😀.", current=True)],
}

# (kind, source, target, origin, age) — age is "days before now"; symmetric kinds are put in canonical order by the writer.
RELATIONS = [
    ("related_to", "raw_immutable", "points_back", "model", 33), ("depends_on", "points_back", "raw_immutable", "user", 33),
    ("related_to", "organized_q", "partner", "model", 33), ("extends", "voice_mobile", "partner", "model", 28),
    ("depends_on", "offline", "voice_mobile", "user", 28), ("extends", "mic_first", "voice_mobile", "user", 28),
    ("derived_from", "mobile", "voice_mobile", "model", 1), ("depends_on", "mobile", "offline", "user", 1),
    ("extends", "mobile", "mic_first", "model", 1), ("related_to", "mobile", "seamless", "system", 1),
    ("contradicts", "mobile", "emg_trigger", "user", 1), ("related_to", "mobile", "ui_redesign", "model", 1),
    ("related_to", "mobile", "sync_later", "model", 0), ("extends", "sync_later", "offline", "model", 0),
    ("extends", "persist_first", "seamless", "model", 0), ("extends", "graph_explains", "partner", "model", 25),
    ("extends", "typed_rel", "graph_explains", "user", 25), ("extends", "no_colour_alone", "graph_explains", "model", 25),
    ("extends", "filter_rel", "graph_explains", "model", 25), ("extends", "edge_labels", "graph_explains", "user", 25),
    ("derived_from", "improve_graph", "graph_explains", "model", 3), ("extends", "legend_filter", "filter_rel", "model", 3),
    ("related_to", "improve_graph", "legend_filter", "model", 3), ("supersedes", "ui_redesign", "dashboard", "user", 5),
    ("related_to", "ui_redesign", "improve_graph", "model", 3), ("extends", "no_stats", "ui_redesign", "model", 5),
    ("extends", "serif_sans", "ui_redesign", "model", 5), ("extends", "home_by_capture", "ui_redesign", "user", 5),
    ("depends_on", "ui_redesign", "graph_explains", "model", 5), ("extends", "bg_understand", "partner", "model", 20),
    ("related_to", "bg_translate", "bg_understand", "model", 20), ("related_to", "bg_mixed", "bg_understand", "system", 20),
    ("duplicates", "bg_ignatov", "email_ignatov", "model", 3), ("depends_on", "emg_trigger", "measure_latency", "user", 17),
    ("extends", "double_clench", "emg_trigger", "model", 17), ("related_to", "false_triggers", "emg_trigger", "model", 17),
    ("related_to", "latency_note", "measure_latency", "system", 17), ("related_to", "charge_wrist", "emg_trigger", "model", 13),
    ("depends_on", "charge_wrist", "buy_charger", "user", 0), ("depends_on", "demo_order", "preload_laptop", "user", 13),
    ("related_to", "preload_laptop", "print_arch", "model", 13), ("related_to", "five_min", "demo_order", "model", 13),
    ("related_to", "contradict_q", "flag_not_decide", "model", 10), ("derived_from", "flag_not_decide", "contradict_q", "user", 10),
    ("extends", "supersede_idea", "flag_not_decide", "model", 10), ("related_to", "supersede_idea", "dashboard", "model", 10),
    ("extends", "four_systems", "arch_overview", "model", 8), ("depends_on", "recall_reads", "four_systems", "model", 8),
    ("related_to", "arch_overview", "points_back", "system", 8), ("related_to", "persist_first", "retryable", "model", 0),
    ("depends_on", "retryable", "persist_first", "user", 0), ("related_to", "ask_key", "ask_android", "model", 0),
    ("related_to", "shortcuts_note", "improve_graph", "model", 3), ("contradicts", "dashboard", "home_by_capture", "model", 5),
]


# ---------------------------------------------------------------------------------------------------- building
def schema_steps() -> list[tuple[int, str]]:
    source = MIGRATIONS.read_text(encoding="utf8")
    steps = []
    for version in (1, 2, 3, 4):
        match = re.search(rf'pub const SCHEMA_V{version}: &str = "(.*?)";\n', source, re.S)
        if not match:
            raise SystemExit(f"cannot find SCHEMA_V{version} in {MIGRATIONS}")
        steps.append((version, match.group(1)))
    return steps


def rfc3339(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ").replace(".000000Z", "Z")


def cp_span(content: str, evidence: str) -> tuple[int, int]:
    """Half-open range of Unicode code points (Python str indexes code points)."""
    start = content.find(evidence)
    if start < 0:
        raise SystemExit(f"evidence not found verbatim in its capture: {evidence!r}")
    return start, start + len(evidence)


def build(db: Path, now: datetime) -> None:
    db.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db)
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA synchronous = FULL")
    for version, sql in schema_steps():
        connection.executescript(f"BEGIN;\n{sql}\nPRAGMA user_version = {version};\nCOMMIT;")

    ago = lambda d, h, m: now - timedelta(days=d, hours=h, minutes=m)
    content_of = {key: content for key, _, _, content, _ in CAPTURES}
    object_info: dict[str, dict] = {}
    events: list[tuple[datetime, int, callable]] = []  # (time, tie-breaker, action)
    order = 0

    def at(time: datetime, action):
        nonlocal order
        order += 1
        events.append((time, order, action))

    for ckey, source, age, content, objects in CAPTURES:
        cid = uid("capture", ckey)
        when = ago(*age)
        at(when, lambda c=cid, s=source, t=content, w=when: connection.execute("INSERT INTO captures (id, source, content, created_at) VALUES (?,?,?,?)", (c, s, t, rfc3339(w))))
        if objects is None:
            continue
        run_at = when + timedelta(seconds=4)
        at(run_at, lambda c=cid, w=run_at: connection.execute("INSERT INTO distillation_runs (capture_id, created_at) VALUES (?,?)", (c, rfc3339(w))))
        # reading order within a distillation = source order, as the store writes it
        for okey, kind, title, body, evidence in sorted(objects, key=lambda o: cp_span(content, o[4])):
            start, end = cp_span(content, evidence)
            oid, rid = uid("object", okey), uid("revision", okey, "r1")
            created = run_at + timedelta(seconds=1 + len(object_info))
            object_info[okey] = {"id": oid, "r1": rid, "revs": {"r1": rid}, "created": created, "capture": cid, "span": (start, end)}

            def make(oid=oid, rid=rid, kind=kind, title=title, body=body, cid=cid, start=start, end=end, created=created):
                stamp = rfc3339(created)
                connection.execute("INSERT INTO knowledge_objects (id, kind, title, body, created_at) VALUES (?,?,?,?,?)", (oid, kind, title, body, stamp))
                connection.execute("INSERT INTO object_sources (object_id, capture_id, source_start, source_end) VALUES (?,?,?,?)", (oid, cid, start, end))
                connection.execute("INSERT INTO thought_revisions (id, object_id, kind, title, body, origin, created_at, capture_id, source_start, source_end) VALUES (?,?,?,?,?,'initial',?,?,?,?)", (rid, oid, kind, title, body, stamp, cid, start, end))
                connection.execute("UPDATE knowledge_objects SET kind=?, title=?, body=?, current_revision_id=? WHERE id=?", (kind, title, body, rid, oid))
            at(created, make)

    state: dict[str, dict] = {}  # latest content per revision, to inherit unchanged fields
    for okey, revs in HISTORY.items():
        for rev in revs:
            def revise(okey=okey, rev=rev):
                info = object_info[okey]
                rid = uid("revision", okey, rev.key)
                info["revs"][rev.key] = rid
                parent_rows = [connection.execute("SELECT kind, title, body FROM thought_revisions WHERE id=?", (info["revs"][p],)).fetchone() for p in rev.parents]
                kind, title, body = parent_rows[-1]  # a merge starts from its last parent, like the app's merge form
                kind, title, body = rev.kind or kind, rev.title or title, rev.body or body
                span = (None, None, None)
                if rev.span:
                    ckey, evidence = rev.span
                    s, e = cp_span(content_of[ckey], evidence)
                    span = (uid("capture", ckey), s, e)
                connection.execute("INSERT INTO thought_revisions (id, object_id, kind, title, body, origin, created_at, capture_id, source_start, source_end) VALUES (?,?,?,?,?,?,?,?,?,?)",
                                   (rid, info["id"], kind, title, body, rev.origin, rfc3339(ago(*rev.age)), *span))
                for parent in rev.parents:
                    connection.execute("INSERT INTO revision_parents (child_revision_id, parent_revision_id) VALUES (?,?)", (rid, info["revs"][parent]))
                if rev.current:
                    connection.execute("UPDATE knowledge_objects SET kind=?, title=?, body=?, current_revision_id=? WHERE id=?", (kind, title, body, rid, info["id"]))
            at(ago(*rev.age), revise)

    for index, (kind, source, target, origin, days) in enumerate(RELATIONS):
        def relate(kind=kind, source=source, target=target, origin=origin, days=days, index=index):
            a, b = object_info[source]["id"], object_info[target]["id"]
            if kind in SYMMETRIC and b < a:
                a, b = b, a  # canonical: the smaller id is the source
            created = max(object_info[source]["created"], object_info[target]["created"]) + timedelta(hours=1, minutes=index)
            connection.execute("INSERT INTO relations (id, kind, source_object_id, target_object_id, origin, created_at) VALUES (?,?,?,?,?,?)",
                               (uid("relation", kind, source, target), kind, a, b, origin, rfc3339(min(created, now - timedelta(minutes=1)))))
        # a relation can only exist once both its objects do
        at(max(ago(days, 0, 0), max(info["created"] for info in (object_info[source], object_info[target])) + timedelta(minutes=30)), relate)

    # Apply in time order. Object creation (+4 s after its capture) always precedes later edits, relations and runs.
    for _, _, action in sorted(events, key=lambda e: (e[0], e[1])):
        action()
    connection.commit()
    connection.close()


# ----------------------------------------------------------------------------------------------------- verifying
def verify(db: Path) -> dict:
    if not db.exists():
        raise SystemExit(f"no database at {db}")
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    c.execute("PRAGMA foreign_keys = ON")
    one = lambda sql: c.execute(sql).fetchone()[0]
    report: dict = {"db": str(db)}
    report["user_version"] = one("PRAGMA user_version")
    report["integrity_check"] = c.execute("PRAGMA integrity_check").fetchall()
    report["foreign_key_check_violations"] = c.execute("PRAGMA foreign_key_check").fetchall()
    tables = ["captures", "distillation_runs", "knowledge_objects", "object_sources", "relations", "thought_revisions", "revision_parents"]
    report["counts"] = {t: one(f"SELECT count(*) FROM {t}") for t in tables}
    problems: list[str] = []

    def expect_zero(label: str, sql: str):
        n = one(sql)
        report.setdefault("invariants", {})[label] = n
        if n:
            problems.append(f"{label}: {n}")

    expect_zero("objects not equal to their current revision", "SELECT count(*) FROM knowledge_objects o LEFT JOIN thought_revisions r ON r.id=o.current_revision_id AND r.object_id=o.id WHERE r.id IS NULL OR r.kind<>o.kind OR r.title<>o.title OR r.body<>o.body")
    expect_zero("objects without exactly one initial revision", "SELECT count(*) FROM (SELECT o.id FROM knowledge_objects o LEFT JOIN thought_revisions r ON r.object_id=o.id AND r.origin='initial' GROUP BY o.id HAVING count(r.id)<>1)")
    expect_zero("initial revisions that have a parent", "SELECT count(*) FROM thought_revisions r JOIN revision_parents p ON p.child_revision_id=r.id WHERE r.origin='initial'")
    expect_zero("merges with fewer than two parents", "SELECT count(*) FROM thought_revisions r WHERE r.origin='merge' AND (SELECT count(*) FROM revision_parents p WHERE p.child_revision_id=r.id)<2")
    expect_zero("non-initial, non-merge revisions without exactly one parent", "SELECT count(*) FROM thought_revisions r WHERE r.origin NOT IN ('initial','merge') AND (SELECT count(*) FROM revision_parents p WHERE p.child_revision_id=r.id)<>1")
    expect_zero("parents that are not older than their child", "SELECT count(*) FROM revision_parents p JOIN thought_revisions c ON c.id=p.child_revision_id JOIN thought_revisions r ON r.id=p.parent_revision_id WHERE r.seq>=c.seq")
    expect_zero("parents from a different object", "SELECT count(*) FROM revision_parents p JOIN thought_revisions c ON c.id=p.child_revision_id JOIN thought_revisions r ON r.id=p.parent_revision_id WHERE r.object_id<>c.object_id")
    expect_zero("symmetric relations not in canonical order", "SELECT count(*) FROM relations WHERE kind IN ('related_to','contradicts','duplicates') AND source_object_id>=target_object_id")
    expect_zero("self relations", "SELECT count(*) FROM relations WHERE source_object_id=target_object_id")
    expect_zero("objects without a provenance row", "SELECT count(*) FROM knowledge_objects o LEFT JOIN object_sources s ON s.object_id=o.id WHERE s.object_id IS NULL")
    expect_zero("objects whose capture has no distillation run", "SELECT count(*) FROM object_sources s LEFT JOIN distillation_runs d ON d.capture_id=s.capture_id WHERE d.capture_id IS NULL")
    expect_zero("timestamps that are not RFC 3339", "SELECT count(*) FROM (SELECT created_at t FROM captures UNION ALL SELECT created_at FROM knowledge_objects UNION ALL SELECT created_at FROM relations UNION ALL SELECT created_at FROM thought_revisions UNION ALL SELECT created_at FROM distillation_runs) WHERE t NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'")

    # Provenance spans must resolve inside the raw capture, counted in code points (Python str indexes code points).
    contents = dict(c.execute("SELECT id, content FROM captures"))
    bad = 0
    for cap, s, e in c.execute("SELECT capture_id, source_start, source_end FROM object_sources UNION ALL SELECT capture_id, source_start, source_end FROM thought_revisions WHERE capture_id IS NOT NULL"):
        text = contents.get(cap)
        if text is None or not (0 <= s < e <= len(text)) or not text[s:e].strip():
            bad += 1
    report.setdefault("invariants", {})["provenance spans that do not resolve"] = bad
    if bad:
        problems.append(f"provenance spans: {bad}")
    report["captures_never_distilled"] = one("SELECT count(*) FROM captures c LEFT JOIN distillation_runs d ON d.capture_id=c.id WHERE d.capture_id IS NULL")
    report["distillation_runs_with_zero_objects"] = one("SELECT count(*) FROM distillation_runs d LEFT JOIN object_sources s ON s.capture_id=d.capture_id WHERE s.capture_id IS NULL")
    report["objects_by_kind"] = dict(c.execute("SELECT kind, count(*) FROM knowledge_objects GROUP BY kind"))
    report["relations_by_kind"] = dict(c.execute("SELECT kind, count(*) FROM relations GROUP BY kind"))
    report["relations_by_origin"] = dict(c.execute("SELECT origin, count(*) FROM relations GROUP BY origin"))
    report["captures_by_source"] = dict(c.execute("SELECT source, count(*) FROM captures GROUP BY source"))
    report["revisions_by_origin"] = dict(c.execute("SELECT origin, count(*) FROM thought_revisions GROUP BY origin"))
    report["objects_with_more_than_one_revision"] = one("SELECT count(*) FROM (SELECT object_id FROM thought_revisions GROUP BY object_id HAVING count(*)>1)")
    report["objects_whose_current_revision_is_not_the_newest"] = one("SELECT count(*) FROM knowledge_objects o WHERE o.current_revision_id <> (SELECT id FROM thought_revisions WHERE object_id=o.id ORDER BY seq DESC LIMIT 1)")
    report["max_relations_on_one_object"] = one("SELECT max(n) FROM (SELECT count(*) n FROM (SELECT source_object_id o FROM relations UNION ALL SELECT target_object_id FROM relations) GROUP BY o)")
    report["problems"] = problems
    if report["integrity_check"] != [("ok",)]:
        report["problems"].append("integrity_check is not ok")
    if report["foreign_key_check_violations"]:
        report["problems"].append("foreign_key_check reported violations")
    report["ok"] = not report["problems"]
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data-home", type=Path, default=DEFAULT_HOME, help="XDG data home for the demo (default: %(default)s)")
    parser.add_argument("--reset", action="store_true", help="delete the demo database first (the seed refuses to run on an existing one otherwise)")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--now", help="pin 'now' (RFC 3339) for reproducible dates")
    args = parser.parse_args()

    db = args.data_home.expanduser().resolve() / IDENTIFIER / "arthur.db"
    if db == REAL_DB.resolve() or REAL_DB.resolve().parent == db.parent:
        raise SystemExit(f"refusing to touch the real app database at {REAL_DB}. Use a different --data-home.")

    if not args.verify_only:
        if db.exists():
            if not args.reset:
                raise SystemExit(f"{db} already exists. Pass --reset to delete and recreate it.")
            for suffix in ("", "-wal", "-shm", "-journal"):
                Path(str(db) + suffix).unlink(missing_ok=True)
        now = datetime.fromisoformat(args.now.replace("Z", "+00:00")) if args.now else datetime.now(timezone.utc)
        build(db, now)

    report = verify(db)
    print(json.dumps(report, indent=2, ensure_ascii=False, default=str))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
