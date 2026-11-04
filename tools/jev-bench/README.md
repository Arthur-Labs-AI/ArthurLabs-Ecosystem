# jev-bench (Phase 0, benchmark-only)

Identity-resolution canary for TypeSafe JEV (Noul + Choice). Not wired into Arthur; zero dependencies (Node ≥ 22).

- `corpus.json` — 30 frozen synthetic cases (labels written before any output was seen; do not edit in Phase 0)
- `run.mjs` — live runner: `node tools/jev-bench/run.mjs --runs 3 [--model jev-1.13.0] [--budget 0.05] [--dry]`
  Needs `TYPESAFE_API_KEY` in the environment, or in the repo-root `.env` (only that one variable is read). Stops if missing.
- `score.mjs` — offline deterministic re-scoring: `node tools/jev-bench/score.mjs tools/jev-bench/results/raw-<id>.json`
- `lib.mjs` — request building, fixed decision policy, metrics, Markdown report
- `results/` — `raw-*.json` (requests + responses, no headers/credentials), `analysis-*.json`, `report-*.md`

Retries cover only transport failures (network, timeout, 429, 529, 5xx; max 3 attempts). Wrong answers are never retried.

## Phase 1A (blind identity benchmark) — `p1a/`
`corpus-p1a.json` (170 cases, dev/holdout split, frozen: `p1a/CORPUS_FREEZE.txt`), built by `p1a/build-corpus.mjs`.
Order: `run.mjs --provider jev|openai --split dev` → `tune.mjs` (dev only, writes `thresholds-frozen.json`) → `run.mjs --split holdout|consistency` (refuses before freeze) → `evaluate.mjs` → `results/p1a/report-p1a.md`.
Needs `TYPESAFE_API_KEY` and `OPENAI_API_KEY` (only those two variables are read). Spend is capped by `results/p1a/ledger.json` (budget $1.00).

## Phase 1B (Automatic Graph relations) — `p1b/`
`corpus-p1b.json` (150 events; `p1b/CORPUS_FREEZE.txt`), `p1b/baseline.mjs` (verbatim-prompt port of the M04.7A multiclass pipeline; prompts are extracted from the Rust sources at runtime), `p1b/jev.mjs` + `decide.mjs` (JEV Choice / Noul / hybrid), `run.mjs` → `tune.mjs` (dev only, writes `frozen.json`) → holdout/consistency → `evaluate.mjs` → `results/p1b/report-p1b.md`. Needs `TYPESAFE_API_KEY` and `OPENAI_API_KEY`; budget capped at $5.00 in `results/p1b/ledger.json`.
