# JEV Phase 1B — Automatic Connections comparative benchmark

Corpus `graph-p1b-1` sha256 `7b86c37f3ed44169…`: 150 events (75 dev / 75 holdout), 19 disputed, 22 categories, all seven kinds + NONE. Frozen 2026-10-08T17:23:21.495Z before any holdout request. JEV `jev-1.13.0`; baseline = production M04.7A prompts/gates ported verbatim (prompt hashes {"prompt.rs":"6a05d8c6a63dc2b8","verify_prompt.rs":"14138ab501485620","semantics.rs":"7257e12aef87dffc"}), Stage A `gpt-4.1-mini` (temperature 0), Stage B `gpt-5-mini` (reasoning effort low), 1 proposal + 2 votes.

Rates are over unique events (one primary run per event); Wilson 95% CI. Edge precision uses predicted edges as denominator. 'Dangerous' = false edges + wrongful removals + user-edge violations.

## Holdout (blind) — undisputed

| Config | Events | Strict precision | Semantic precision | Strict recall | Direction accuracy | False edges | Correct NONE | Stale kept (unsafe) | Wrongful removals | User-edge violations | Failed runs | Dangerous |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A  baseline (M04.7A, gpt-4.1-mini + gpt-5-mini) | 66 | 23/23 = 100.0% [85.7–100.0] | 23/23 = 100.0% [85.7–100.0] | 23/34 = 67.6% [50.8–80.9] | 11/11 = 100.0% [74.1–100.0] | 0 (0 reversed) | 32/32 = 100.0% [89.3–100.0] | 5/8 = 62.5% [30.6–86.3] | 0/7 = 0.0% [0.0–35.4] | 0 | 0 | **0** |
| B  JEV Choice | 66 | 26/29 = 89.7% [73.6–96.4] | 26/29 = 89.7% [73.6–96.4] | 26/34 = 76.5% [60.0–87.6] | 15/15 = 100.0% [79.6–100.0] | 3 (0 reversed) | 31/32 = 96.9% [84.3–99.4] | 0/8 = 0.0% [0.0–32.4] | 5/7 = 71.4% [35.9–91.8] | 0 | 0 | **8** |
| C  JEV Noul statements | 66 | 12/12 = 100.0% [75.7–100.0] | 12/12 = 100.0% [75.7–100.0] | 12/34 = 35.3% [21.5–52.1] | 9/9 = 100.0% [70.1–100.0] | 0 (0 reversed) | 32/32 = 100.0% [89.3–100.0] | 1/8 = 12.5% [2.2–47.1] | 2/7 = 28.6% [8.2–64.1] | 0 | 0 | **2** |
| D  JEV hybrid (guards) | 66 | 23/25 = 92.0% [75.0–97.8] | 23/25 = 92.0% [75.0–97.8] | 23/34 = 67.6% [50.8–80.9] | 14/14 = 100.0% [78.5–100.0] | 2 (0 reversed) | 31/32 = 96.9% [84.3–99.4] | 0/8 = 0.0% [0.0–32.4] | 1/7 = 14.3% [2.6–51.3] | 0 | 0 | **3** |
| B′ Choice, untuned defaults | 66 | 30/39 = 76.9% [61.7–87.4] | 30/39 = 76.9% [61.7–87.4] | 30/34 = 88.2% [73.4–95.3] | 17/17 = 100.0% [81.6–100.0] | 9 (0 reversed) | 27/32 = 84.4% [68.2–93.1] | 0/8 = 0.0% [0.0–32.4] | 5/7 = 71.4% [35.9–91.8] | 0 | 0 | **14** |
| C′ Noul, untuned defaults | 66 | 16/19 = 84.2% [62.4–94.5] | 16/19 = 84.2% [62.4–94.5] | 16/34 = 47.1% [31.5–63.3] | 11/11 = 100.0% [74.1–100.0] | 3 (0 reversed) | 30/32 = 93.8% [79.9–98.3] | 0/8 = 0.0% [0.0–32.4] | 6/7 = 85.7% [48.7–97.4] | 0 | 0 | **9** |
| D′ hybrid, untuned defaults | 66 | 15/16 = 93.8% [71.7–98.9] | 15/16 = 93.8% [71.7–98.9] | 15/34 = 44.1% [28.9–60.5] | 10/10 = 100.0% [72.2–100.0] | 1 (0 reversed) | 31/32 = 96.9% [84.3–99.4] | 1/8 = 12.5% [2.2–47.1] | 1/7 = 14.3% [2.6–51.3] | 0 | 0 | **2** |

## Holdout (blind) — disputed

| Config | Events | Strict precision | Semantic precision | Strict recall | Direction accuracy | False edges | Correct NONE | Stale kept (unsafe) | Wrongful removals | User-edge violations | Failed runs | Dangerous |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A  baseline (M04.7A, gpt-4.1-mini + gpt-5-mini) | 9 | 0/1 = 0.0% [0.0–79.3] | 1/1 = 100.0% [20.7–100.0] | 0/8 = 0.0% [0.0–32.4] | n/a | 0 (0 reversed) | 1/1 = 100.0% [20.7–100.0] | n/a | n/a | 0 | 0 | **0** |
| B  JEV Choice | 9 | n/a | n/a | 0/8 = 0.0% [0.0–32.4] | n/a | 0 (0 reversed) | 1/1 = 100.0% [20.7–100.0] | n/a | n/a | 0 | 0 | **0** |
| C  JEV Noul statements | 9 | n/a | n/a | 0/8 = 0.0% [0.0–32.4] | n/a | 0 (0 reversed) | 1/1 = 100.0% [20.7–100.0] | n/a | n/a | 0 | 0 | **0** |
| D  JEV hybrid (guards) | 9 | n/a | n/a | 0/8 = 0.0% [0.0–32.4] | n/a | 0 (0 reversed) | 1/1 = 100.0% [20.7–100.0] | n/a | n/a | 0 | 0 | **0** |
| B′ Choice, untuned defaults | 9 | 1/1 = 100.0% [20.7–100.0] | 1/1 = 100.0% [20.7–100.0] | 1/8 = 12.5% [2.2–47.1] | 1/1 = 100.0% [20.7–100.0] | 0 (0 reversed) | 1/1 = 100.0% [20.7–100.0] | n/a | n/a | 0 | 0 | **0** |
| C′ Noul, untuned defaults | 9 | n/a | n/a | 0/8 = 0.0% [0.0–32.4] | n/a | 0 (0 reversed) | 1/1 = 100.0% [20.7–100.0] | n/a | n/a | 0 | 0 | **0** |
| D′ hybrid, untuned defaults | 9 | n/a | n/a | 0/8 = 0.0% [0.0–32.4] | n/a | 0 (0 reversed) | 1/1 = 100.0% [20.7–100.0] | n/a | n/a | 0 | 0 | **0** |

## Holdout (blind) — all

| Config | Events | Strict precision | Semantic precision | Strict recall | Direction accuracy | False edges | Correct NONE | Stale kept (unsafe) | Wrongful removals | User-edge violations | Failed runs | Dangerous |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A  baseline (M04.7A, gpt-4.1-mini + gpt-5-mini) | 75 | 23/24 = 95.8% [79.8–99.3] | 24/24 = 100.0% [86.2–100.0] | 23/42 = 54.8% [39.9–68.8] | 11/11 = 100.0% [74.1–100.0] | 0 (0 reversed) | 33/33 = 100.0% [89.6–100.0] | 5/8 = 62.5% [30.6–86.3] | 0/7 = 0.0% [0.0–35.4] | 0 | 0 | **0** |
| B  JEV Choice | 75 | 26/29 = 89.7% [73.6–96.4] | 26/29 = 89.7% [73.6–96.4] | 26/42 = 61.9% [46.8–75.0] | 15/15 = 100.0% [79.6–100.0] | 3 (0 reversed) | 32/33 = 97.0% [84.7–99.5] | 0/8 = 0.0% [0.0–32.4] | 5/7 = 71.4% [35.9–91.8] | 0 | 0 | **8** |
| C  JEV Noul statements | 75 | 12/12 = 100.0% [75.7–100.0] | 12/12 = 100.0% [75.7–100.0] | 12/42 = 28.6% [17.2–43.6] | 9/9 = 100.0% [70.1–100.0] | 0 (0 reversed) | 33/33 = 100.0% [89.6–100.0] | 1/8 = 12.5% [2.2–47.1] | 2/7 = 28.6% [8.2–64.1] | 0 | 0 | **2** |
| D  JEV hybrid (guards) | 75 | 23/25 = 92.0% [75.0–97.8] | 23/25 = 92.0% [75.0–97.8] | 23/42 = 54.8% [39.9–68.8] | 14/14 = 100.0% [78.5–100.0] | 2 (0 reversed) | 32/33 = 97.0% [84.7–99.5] | 0/8 = 0.0% [0.0–32.4] | 1/7 = 14.3% [2.6–51.3] | 0 | 0 | **3** |
| B′ Choice, untuned defaults | 75 | 31/40 = 77.5% [62.5–87.7] | 31/40 = 77.5% [62.5–87.7] | 31/42 = 73.8% [58.9–84.7] | 18/18 = 100.0% [82.4–100.0] | 9 (0 reversed) | 28/33 = 84.8% [69.1–93.3] | 0/8 = 0.0% [0.0–32.4] | 5/7 = 71.4% [35.9–91.8] | 0 | 0 | **14** |
| C′ Noul, untuned defaults | 75 | 16/19 = 84.2% [62.4–94.5] | 16/19 = 84.2% [62.4–94.5] | 16/42 = 38.1% [25.0–53.2] | 11/11 = 100.0% [74.1–100.0] | 3 (0 reversed) | 31/33 = 93.9% [80.4–98.3] | 0/8 = 0.0% [0.0–32.4] | 6/7 = 85.7% [48.7–97.4] | 0 | 0 | **9** |
| D′ hybrid, untuned defaults | 75 | 15/16 = 93.8% [71.7–98.9] | 15/16 = 93.8% [71.7–98.9] | 15/42 = 35.7% [23.0–50.8] | 10/10 = 100.0% [72.2–100.0] | 1 (0 reversed) | 32/33 = 97.0% [84.7–99.5] | 1/8 = 12.5% [2.2–47.1] | 1/7 = 14.3% [2.6–51.3] | 0 | 0 | **2** |

## Dev (thresholds fitted here — optimistic) — undisputed

| Config | Events | Strict precision | Semantic precision | Strict recall | Direction accuracy | False edges | Correct NONE | Stale kept (unsafe) | Wrongful removals | User-edge violations | Failed runs | Dangerous |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A  baseline (M04.7A, gpt-4.1-mini + gpt-5-mini) | 65 | 18/20 = 90.0% [69.9–97.2] | 18/20 = 90.0% [69.9–97.2] | 18/32 = 56.3% [39.3–71.8] | 12/12 = 100.0% [75.7–100.0] | 2 (0 reversed) | 31/33 = 93.9% [80.4–98.3] | 3/5 = 60.0% [23.1–88.2] | 2/6 = 33.3% [9.7–70.0] | 0 | 1 | **4** |
| B  JEV Choice | 65 | 29/29 = 100.0% [88.3–100.0] | 29/29 = 100.0% [88.3–100.0] | 29/32 = 90.6% [75.8–96.8] | 21/21 = 100.0% [84.5–100.0] | 0 (0 reversed) | 33/33 = 100.0% [89.6–100.0] | 1/5 = 20.0% [3.6–62.4] | 4/6 = 66.7% [30.0–90.3] | 0 | 0 | **4** |
| C  JEV Noul statements | 65 | 8/8 = 100.0% [67.6–100.0] | 8/8 = 100.0% [67.6–100.0] | 8/32 = 25.0% [13.3–42.1] | 6/6 = 100.0% [61.0–100.0] | 0 (0 reversed) | 33/33 = 100.0% [89.6–100.0] | 4/5 = 80.0% [37.6–96.4] | 1/6 = 16.7% [3.0–56.4] | 0 | 0 | **1** |
| D  JEV hybrid (guards) | 65 | 26/26 = 100.0% [87.1–100.0] | 26/26 = 100.0% [87.1–100.0] | 26/32 = 81.3% [64.7–91.1] | 19/19 = 100.0% [83.2–100.0] | 0 (0 reversed) | 33/33 = 100.0% [89.6–100.0] | 0/5 = 0.0% [0.0–43.4] | 2/6 = 33.3% [9.7–70.0] | 0 | 0 | **2** |
| B′ Choice, untuned defaults | 65 | 31/40 = 77.5% [62.5–87.7] | 31/40 = 77.5% [62.5–87.7] | 31/32 = 96.9% [84.3–99.4] | 22/22 = 100.0% [85.1–100.0] | 9 (0 reversed) | 28/33 = 84.8% [69.1–93.3] | 1/5 = 20.0% [3.6–62.4] | 4/6 = 66.7% [30.0–90.3] | 0 | 0 | **13** |
| C′ Noul, untuned defaults | 65 | 14/16 = 87.5% [64.0–96.5] | 14/16 = 87.5% [64.0–96.5] | 14/32 = 43.8% [28.2–60.7] | 12/12 = 100.0% [75.7–100.0] | 2 (0 reversed) | 31/33 = 93.9% [80.4–98.3] | 0/5 = 0.0% [0.0–43.4] | 3/6 = 50.0% [18.8–81.2] | 0 | 0 | **5** |
| D′ hybrid, untuned defaults | 65 | 11/11 = 100.0% [74.1–100.0] | 11/11 = 100.0% [74.1–100.0] | 11/32 = 34.4% [20.4–51.7] | 9/9 = 100.0% [70.1–100.0] | 0 (0 reversed) | 33/33 = 100.0% [89.6–100.0] | 0/5 = 0.0% [0.0–43.4] | 2/6 = 33.3% [9.7–70.0] | 0 | 0 | **2** |

## Creation, rejection and revalidation, separately (holdout, undisputed)

| Config | Creation: correct edges / gold edges | Creation: false edges | Rejection: NONE events kept clean | Rejection: false admissions | Revalidation: stale removed | Revalidation: stale kept (unsafe) | Revalidation: valid kept / wrongly removed |
|---|---|---|---|---|---|---|---|
| A  baseline (M04.7A, gpt-4.1-mini + gpt-5-mini) | 23/34 | 0 | 32/32 = 100.0% [89.3–100.0] | 0/32 = 0.0% [0.0–10.7] | 3/8 | 5/8 | 7/7 kept, 0 wrongly removed |
| B  JEV Choice | 26/34 | 3 | 31/32 = 96.9% [84.3–99.4] | 1/32 = 3.1% [0.6–15.7] | 8/8 | 0/8 | 2/7 kept, 5 wrongly removed |
| C  JEV Noul statements | 12/34 | 0 | 32/32 = 100.0% [89.3–100.0] | 0/32 = 0.0% [0.0–10.7] | 7/8 | 1/8 | 5/7 kept, 2 wrongly removed |
| D  JEV hybrid (guards) | 23/34 | 2 | 31/32 = 96.9% [84.3–99.4] | 1/32 = 3.1% [0.6–15.7] | 8/8 | 0/8 | 6/7 kept, 1 wrongly removed |

## By relation kind (holdout, undisputed): gold edges recovered exactly (kind + direction) / predicted edges of that kind that were correct

| Kind | A recall | B recall | C recall | D recall | A precision | B precision | C precision | D precision |
|---|---|---|---|---|---|---|---|---|
| related_to | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 |
| extends | 5/6 | 5/6 | 4/6 | 5/6 | 5/5 | 5/7 | 4/4 | 5/7 |
| depends_on | 3/6 | 4/6 | 0/6 | 3/6 | 3/3 | 4/4 | 0/0 | 3/3 |
| contradicts | 7/7 | 6/7 | 0/7 | 4/7 | 7/7 | 6/6 | 0/0 | 4/4 |
| derived_from | 0/4 | 1/4 | 0/4 | 1/4 | 0/0 | 1/2 | 0/0 | 1/1 |
| duplicates | 5/6 | 5/6 | 3/6 | 5/6 | 5/5 | 5/5 | 3/3 | 5/5 |
| supersedes | 3/5 | 5/5 | 5/5 | 5/5 | 3/3 | 5/5 | 5/5 | 5/5 |

## By language (holdout, undisputed)

| group | A: events / correct-edge recall / false edges / wrongful removals / stale kept | B: events / correct-edge recall / false edges / wrongful removals / stale kept | C: events / correct-edge recall / false edges / wrongful removals / stale kept | D: events / correct-edge recall / false edges / wrongful removals / stale kept |
|---|---|---|---|---|
| en | 33 / 11/16 / 0 / 0 / 2 | 33 / 14/16 / 1 / 3 / 0 | 33 / 8/16 / 0 / 2 / 0 | 33 / 12/16 / 1 / 1 / 0 |
| bg | 17 / 7/10 / 0 / 0 / 2 | 17 / 8/10 / 1 / 1 / 0 | 17 / 2/10 / 0 / 0 / 1 | 17 / 6/10 / 1 / 0 / 0 |
| mixed | 16 / 5/8 / 0 / 0 / 1 | 16 / 4/8 / 1 / 1 / 0 | 16 / 2/8 / 0 / 0 / 0 | 16 / 5/8 / 0 / 0 / 0 |

## By category (holdout, undisputed)

| group | A: events / correct-edge recall / false edges / wrongful removals / stale kept | B: events / correct-edge recall / false edges / wrongful removals / stale kept | C: events / correct-edge recall / false edges / wrongful removals / stale kept | D: events / correct-edge recall / false edges / wrongful removals / stale kept |
|---|---|---|---|---|
| CR_depends_on | 5 / 3/5 / 0 / 0 / 0 | 5 / 4/5 / 0 / 0 / 0 | 5 / 0/5 / 0 / 0 / 0 | 5 / 3/5 / 0 / 0 / 0 |
| CR_extends | 4 / 4/4 / 0 / 0 / 0 | 4 / 4/4 / 1 / 0 / 0 | 4 / 3/4 / 0 / 0 / 0 | 4 / 4/4 / 1 / 0 / 0 |
| CR_derived_from | 4 / 0/4 / 0 / 0 / 0 | 4 / 1/4 / 1 / 0 / 0 | 4 / 0/4 / 0 / 0 / 0 | 4 / 1/4 / 0 / 0 / 0 |
| CR_supersedes | 3 / 1/3 / 0 / 0 / 0 | 3 / 3/3 / 0 / 0 / 0 | 3 / 3/3 / 0 / 0 / 0 | 3 / 3/3 / 0 / 0 / 0 |
| CR_contradicts | 4 / 4/4 / 0 / 0 / 0 | 4 / 4/4 / 0 / 0 / 0 | 4 / 0/4 / 0 / 0 / 0 | 4 / 2/4 / 0 / 0 / 0 |
| CR_duplicates | 4 / 3/4 / 0 / 0 / 0 | 4 / 3/4 / 0 / 0 / 0 | 4 / 2/4 / 0 / 0 / 0 | 4 / 3/4 / 0 / 0 / 0 |
| CR_related_to | 0 / 0/0 / 0 / 0 / 0 | 0 / 0/0 / 0 / 0 / 0 | 0 / 0/0 / 0 / 0 / 0 | 0 / 0/0 / 0 / 0 / 0 |
| HN | 10 / 0/0 / 0 / 0 / 0 | 10 / 0/0 / 0 / 0 / 0 | 10 / 0/0 / 0 / 0 / 0 | 10 / 0/0 / 0 / 0 / 0 |
| UN | 4 / 0/0 / 0 / 0 / 0 | 4 / 0/0 / 0 / 0 / 0 | 4 / 0/0 / 0 / 0 / 0 | 4 / 0/0 / 0 / 0 / 0 |
| CF_sc | 5 / 5/5 / 0 / 0 / 0 | 5 / 4/5 / 0 / 0 / 0 | 5 / 2/5 / 0 / 0 / 0 | 5 / 4/5 / 0 / 0 / 0 |
| CF_ed | 4 / 3/4 / 0 / 0 / 0 | 4 / 3/4 / 0 / 0 / 0 | 4 / 2/4 / 0 / 0 / 0 | 4 / 3/4 / 0 / 0 / 0 |
| CF_dd | 1 / 0/1 / 0 / 0 / 0 | 1 / 0/1 / 0 / 0 / 0 | 1 / 0/1 / 0 / 0 / 0 | 1 / 0/1 / 0 / 0 / 0 |
| CF_rn | 1 / 0/0 / 0 / 0 / 0 | 1 / 0/0 / 0 / 0 / 0 | 1 / 0/0 / 0 / 0 / 0 | 1 / 0/0 / 0 / 0 / 0 |
| RV_cancel | 2 / 0/0 / 0 / 0 / 1 | 2 / 0/0 / 0 / 0 / 0 | 2 / 0/0 / 0 / 0 / 1 | 2 / 0/0 / 0 / 0 / 0 |
| RV_req | 4 / 0/0 / 0 / 0 / 4 | 4 / 0/0 / 0 / 0 / 0 | 4 / 0/0 / 0 / 0 / 0 | 4 / 0/0 / 0 / 0 / 0 |
| RV_prereq | 3 / 0/0 / 0 / 0 / 0 | 3 / 0/0 / 0 / 3 / 0 | 3 / 0/0 / 0 / 1 / 0 | 3 / 0/0 / 0 / 0 / 0 |
| RV_pause | 2 / 0/0 / 0 / 0 / 0 | 2 / 0/0 / 0 / 2 / 0 | 2 / 0/0 / 0 / 0 / 0 | 2 / 0/0 / 0 / 0 / 0 |
| RV_extgone | 2 / 0/0 / 0 / 0 / 0 | 2 / 0/0 / 1 / 0 / 0 | 2 / 0/0 / 0 / 0 / 0 | 2 / 0/0 / 1 / 0 / 0 |
| RV_still | 2 / 0/0 / 0 / 0 / 0 | 2 / 0/0 / 0 / 0 / 0 | 2 / 0/0 / 0 / 1 / 0 | 2 / 0/0 / 0 / 1 / 0 |
| RV_user | 0 / 0/0 / 0 / 0 / 0 | 0 / 0/0 / 0 / 0 / 0 | 0 / 0/0 / 0 / 0 / 0 | 0 / 0/0 / 0 / 0 / 0 |
| CD | 2 / 0/0 / 0 / 0 / 0 | 2 / 0/0 / 0 / 0 / 0 | 2 / 0/0 / 0 / 0 / 0 | 2 / 0/0 / 0 / 0 / 0 |
| AMBG | 0 / 0/0 / 0 / 0 / 0 | 0 / 0/0 / 0 / 0 / 0 | 0 / 0/0 / 0 / 0 / 0 | 0 / 0/0 / 0 / 0 / 0 |

## Dangerous failures on the holdout (every false edge, reversed edge, wrongful removal, user-edge violation; frozen configs only)

| Config | Event | Category | Disputed | Failure | Detail |
|---|---|---|---|---|---|
| B | G012 | CR_extends |  | false edge | extends Workshop with a printed handout → Run a workshop on saving |
| B | G026 | CR_derived_from |  | false edge | derived_from Спираме Android версията → Data: 60% от потребителите са на iOS |
| B | G120 | RV_prereq |  | wrongful removal | valid depends_on removed |
| B | G121 | RV_prereq |  | wrongful removal | valid depends_on removed |
| B | G122 | RV_prereq |  | wrongful removal | valid depends_on removed |
| B | G123 | RV_pause |  | wrongful removal | valid depends_on removed |
| B | G125 | RV_pause |  | wrongful removal | valid depends_on removed |
| B | G127 | RV_extgone |  | false edge | extends Подробен план за маркетинг на конференцията → Конференция |
| C | G121 | RV_prereq |  | wrongful removal | valid depends_on removed |
| C | G129 | RV_still |  | wrongful removal | valid extends removed |
| D | G012 | CR_extends |  | false edge | extends Workshop with a printed handout → Run a workshop on saving |
| D | G127 | RV_extgone |  | false edge | extends Подробен план за маркетинг на конференцията → Конференция |
| D | G129 | RV_still |  | wrongful removal | valid extends removed |

## Repeatability (44-event stratified subset × 3 runs; JEV with 3 different random option orders; events counted once)

```json
{
 "A": {
  "events": 44,
  "identical": 34,
  "unstable": [
   "G018",
   "G032",
   "G033",
   "G099",
   "G103",
   "G110",
   "G128",
   "G130",
   "G139",
   "G142"
  ]
 },
 "B": {
  "events": 44,
  "identical": 34,
  "unstable": [
   "G009",
   "G033",
   "G037",
   "G038",
   "G090",
   "G099",
   "G108",
   "G110",
   "G137",
   "G142"
  ]
 },
 "C": {
  "events": 44,
  "identical": 44,
  "unstable": []
 },
 "D": {
  "events": 44,
  "identical": 41,
  "unstable": [
   "G037",
   "G090",
   "G130"
  ]
 },
 "persisting_dangerous": {
  "A": {
   "G103": 1,
   "G128": 1,
   "G130": 1
  },
  "B": {
   "G115": 3,
   "G120": 3,
   "G123": 3,
   "G125": 3,
   "G127": 3,
   "G137": 1,
   "G108": 1
  },
  "C": {
   "G129": 3
  },
  "D": {
   "G127": 3,
   "G129": 3,
   "G130": 1
  }
 },
 "choice_argmax_flips_across_orders": "6/86 pairs",
 "baseline_failed_runs": 2
}
```

## Provider performance

```json
{
 "baseline": {
  "events_run": 282,
  "failed_runs": [
   {
    "id": "G109",
    "error": "stage B contract failures exhausted"
   },
   {
    "id": "G110",
    "error": "stage B contract failures exhausted"
   },
   {
    "id": "G139",
    "error": "stage B contract failures exhausted"
   }
  ],
  "provider_requests": 716,
  "requests_per_event_mean": 2.5390070921985815,
  "retried_transport": 0,
  "per_model": {
   "gpt-4.1-mini": {
    "requests": 282,
    "prompt": 737386,
    "completion": 15600,
    "reasoning": 0
   },
   "gpt-5-mini": {
    "requests": 434,
    "prompt": 1240156,
    "completion": 183009,
    "reasoning": 134400
   }
  },
  "per_call_latency_ms": {
   "p50": 2789,
   "p95": 6966,
   "max": 12846
  },
  "per_event_wall_ms_sequential": {
   "p50": 8160,
   "p95": 16583,
   "max": 24975
  },
  "cost_usd": 0.9959714,
  "cost_per_event_usd": 0.0035318134751773046
 },
 "jev": {
  "requests": 1090,
  "ok": 1090,
  "api_errors": 0,
  "retried": 0,
  "models": [
   "jev-1.13.0"
  ],
  "per_request_latency_ms": {
   "p50": 299,
   "p95": 545,
   "max": 1006
  },
  "input_tokens": 6631196,
  "output_tokens": 487384,
  "cost_usd": 0.278510232,
  "requests_per_event_mean": 3.8652482269503547
 },
 "ledger_spent_usd": 1.275512432,
 "budget_usd": 5
}
```