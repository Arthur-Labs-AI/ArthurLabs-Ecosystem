# Demo data for visual evaluation

A populated Arthur database so the UI can be judged with realistic volume. **Not a product feature, not committed.**

## Where it lives
`~/.local/share/arthur-demo/dev.kaloyan.arthur/arthur.db`

It is a separate XDG data home. The seed script refuses to write to the real database
(`~/.local/share/dev.kaloyan.arthur/arthur.db`) and never opens it.

## Seed / reset
```bash
python3 tools/demo-data/seed_demo_db.py --reset         # delete, recreate, verify (prints a JSON report)
python3 tools/demo-data/seed_demo_db.py --verify-only   # re-check an existing demo DB
python3 tools/demo-data/seed_demo_db.py --reset --now 2026-10-04T22:00:00Z   # pin dates for a reproducible picture
```
Without `--reset` the script refuses to touch an existing demo DB. Dates are relative to the moment you seed, so Home
always has a "Today" and "Yesterday". Ids are deterministic (uuid5), so re-seeding gives the same ids.

The schema is read from `apps/arthur/src-tauri/src/storage/migrations.rs`, not copied, so it cannot drift.

## Run the real app against it
```bash
cd apps/arthur
PATH=$HOME/.cargo/bin:$PATH XDG_DATA_HOME=$HOME/.local/share/arthur-demo npm run tauri dev
```
Cloud credentials are not read from the demo home, so voice transcription and distillation will fail there. That is
deliberate (no accidental API spend) and also lets you see the retry states.

## What is in it
16 captures (9 typed, 7 voice; one never organized, one organized into nothing), 49 knowledge objects, 54 relations (all
7 kinds, all 3 origins), 71 revisions including a 3-lane branch with a 3-parent merge. Includes Bulgarian text, an emoji,
a 130-character title, and a hub idea with 7 connections.
