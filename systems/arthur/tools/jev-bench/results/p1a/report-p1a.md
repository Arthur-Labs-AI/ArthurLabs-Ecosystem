# JEV Phase 1A — Blind Identity Resolution Benchmark

Corpus `identity-p1a-1` sha256 `77be61b02888ee81…` (170 cases, 85 dev / 85 holdout, 19 disputed). Thresholds frozen 2026-10-08T16:24:27.994Z before any holdout request. Models: `jev-1.13.0`, `gpt-4.1-mini-2025-04-14`.

Intervals are Wilson 95% over unique cases (one primary request per case; repeats are excluded from these rates).

## holdout/all (blind)

| Strategy | n | Accuracy | False merge on NEW | False merge on UNCERTAIN | Wrong target | Dangerous total | REVISE prec. | REVISE recall | NEW prec. | UNCERTAIN recall |
|---|---|---|---|---|---|---|---|---|---|---|
| A. Noul (frozen) | 85 | 65/85 = 76.5% [66.4%–84.2%] | 0/29 = 0.0% [0.0%–11.7%] | 0/26 = 0.0% [0.0%–12.9%] | 0/30 = 0.0% [-0.0%–11.4%] | **0** | 19/19 = 100.0% [83.2%–100.0%] | 19/30 = 63.3% [45.5%–78.1%] | 23/26 = 88.5% [71.0%–96.0%] | 23/26 = 88.5% [71.0%–96.0%] |
| B. Choice, random order (frozen) | 85 | 76/85 = 89.4% [81.1%–94.3%] | 0/29 = 0.0% [0.0%–11.7%] | 3/26 = 11.5% [4.0%–29.0%] | 0/30 = 0.0% [-0.0%–11.4%] | **3** | 28/31 = 90.3% [75.1%–96.7%] | 28/30 = 93.3% [78.7%–98.2%] | 27/29 = 93.1% [78.0%–98.1%] | 21/26 = 80.8% [62.1%–91.5%] |
| C. Hybrid (frozen) | 85 | 66/85 = 77.6% [67.7%–85.2%] | 0/29 = 0.0% [0.0%–11.7%] | 0/26 = 0.0% [0.0%–12.9%] | 0/30 = 0.0% [-0.0%–11.4%] | **0** | 19/19 = 100.0% [83.2%–100.0%] | 19/30 = 63.3% [45.5%–78.1%] | 23/25 = 92.0% [75.0%–97.8%] | 24/26 = 92.3% [75.9%–97.9%] |
| A'. Noul (Phase 0 default) | 85 | 73/85 = 85.9% [76.9%–91.7%] | 0/29 = 0.0% [0.0%–11.7%] | 4/26 = 15.4% [6.1%–33.5%] | 0/30 = 0.0% [-0.0%–11.4%] | **4** | 28/32 = 87.5% [71.9%–95.0%] | 28/30 = 93.3% [78.7%–98.2%] | 27/31 = 87.1% [71.1%–94.9%] | 18/26 = 69.2% [50.0%–83.5%] |
| B'. Choice (default) | 85 | 74/85 = 87.1% [78.3%–92.6%] | 0/29 = 0.0% [0.0%–11.7%] | 7/26 = 26.9% [13.7%–46.1%] | 0/30 = 0.0% [-0.0%–11.4%] | **7** | 30/37 = 81.1% [65.8%–90.5%] | 30/30 = 100.0% [88.6%–100.0%] | 27/29 = 93.1% [78.0%–98.1%] | 17/26 = 65.4% [46.2%–80.6%] |
| C'. Hybrid (default) | 85 | 75/85 = 88.2% [79.7%–93.5%] | 0/29 = 0.0% [0.0%–11.7%] | 3/26 = 11.5% [4.0%–29.0%] | 0/30 = 0.0% [-0.0%–11.4%] | **3** | 28/31 = 90.3% [75.1%–96.7%] | 28/30 = 93.3% [78.7%–98.2%] | 26/28 = 92.9% [77.4%–98.0%] | 21/26 = 80.8% [62.1%–91.5%] |
| D. gpt-4.1-mini (temp 0) | 85 | 65/85 = 76.5% [66.4%–84.2%] | 0/29 = 0.0% [0.0%–11.7%] | 6/26 = 23.1% [11.0%–42.1%] | 0/30 = 0.0% [-0.0%–11.4%] | **6** | 29/35 = 82.9% [67.3%–91.9%] | 29/30 = 96.7% [83.3%–99.4%] | 29/43 = 67.4% [52.5%–79.5%] | 7/26 = 26.9% [13.7%–46.1%] |

## holdout/undisputed (blind)

| Strategy | n | Accuracy | False merge on NEW | False merge on UNCERTAIN | Wrong target | Dangerous total | REVISE prec. | REVISE recall | NEW prec. | UNCERTAIN recall |
|---|---|---|---|---|---|---|---|---|---|---|
| A. Noul (frozen) | 74 | 55/74 = 74.3% [63.3%–82.9%] | 0/28 = 0.0% [0.0%–12.1%] | 0/16 = 0.0% [0.0%–19.4%] | 0/30 = 0.0% [-0.0%–11.4%] | **0** | 19/19 = 100.0% [83.2%–100.0%] | 19/30 = 63.3% [45.5%–78.1%] | 23/26 = 88.5% [71.0%–96.0%] | 13/16 = 81.3% [57.0%–93.4%] |
| B. Choice, random order (frozen) | 74 | 69/74 = 93.2% [85.1%–97.1%] | 0/28 = 0.0% [0.0%–12.1%] | 0/16 = 0.0% [0.0%–19.4%] | 0/30 = 0.0% [-0.0%–11.4%] | **0** | 28/28 = 100.0% [87.9%–100.0%] | 28/30 = 93.3% [78.7%–98.2%] | 27/29 = 93.1% [78.0%–98.1%] | 14/16 = 87.5% [64.0%–96.5%] |
| C. Hybrid (frozen) | 74 | 56/74 = 75.7% [64.8%–84.0%] | 0/28 = 0.0% [0.0%–12.1%] | 0/16 = 0.0% [0.0%–19.4%] | 0/30 = 0.0% [-0.0%–11.4%] | **0** | 19/19 = 100.0% [83.2%–100.0%] | 19/30 = 63.3% [45.5%–78.1%] | 23/25 = 92.0% [75.0%–97.8%] | 14/16 = 87.5% [64.0%–96.5%] |
| A'. Noul (Phase 0 default) | 74 | 65/74 = 87.8% [78.5%–93.5%] | 0/28 = 0.0% [0.0%–12.1%] | 1/16 = 6.3% [1.1%–28.3%] | 0/30 = 0.0% [-0.0%–11.4%] | **1** | 28/29 = 96.6% [82.8%–99.4%] | 28/30 = 93.3% [78.7%–98.2%] | 26/30 = 86.7% [70.3%–94.7%] | 11/16 = 68.8% [44.4%–85.8%] |
| B'. Choice (default) | 74 | 71/74 = 95.9% [88.7%–98.6%] | 0/28 = 0.0% [0.0%–12.1%] | 0/16 = 0.0% [0.0%–19.4%] | 0/30 = 0.0% [-0.0%–11.4%] | **0** | 30/30 = 100.0% [88.6%–100.0%] | 30/30 = 100.0% [88.6%–100.0%] | 27/29 = 93.1% [78.0%–98.1%] | 14/16 = 87.5% [64.0%–96.5%] |
| C'. Hybrid (default) | 74 | 68/74 = 91.9% [83.4%–96.2%] | 0/28 = 0.0% [0.0%–12.1%] | 0/16 = 0.0% [0.0%–19.4%] | 0/30 = 0.0% [-0.0%–11.4%] | **0** | 28/28 = 100.0% [87.9%–100.0%] | 28/30 = 93.3% [78.7%–98.2%] | 26/28 = 92.9% [77.4%–98.0%] | 14/16 = 87.5% [64.0%–96.5%] |
| D. gpt-4.1-mini (temp 0) | 74 | 64/74 = 86.5% [76.9%–92.5%] | 0/28 = 0.0% [0.0%–12.1%] | 0/16 = 0.0% [0.0%–19.4%] | 0/30 = 0.0% [-0.0%–11.4%] | **0** | 29/29 = 100.0% [88.3%–100.0%] | 29/30 = 96.7% [83.3%–99.4%] | 28/38 = 73.7% [58.0%–85.0%] | 7/16 = 43.8% [23.1%–66.8%] |

## dev/all (thresholds were fitted here — optimistic, for reference only)

| Strategy | n | Accuracy | False merge on NEW | False merge on UNCERTAIN | Wrong target | Dangerous total | REVISE prec. | REVISE recall | NEW prec. | UNCERTAIN recall |
|---|---|---|---|---|---|---|---|---|---|---|
| A. Noul (frozen) | 85 | 69/85 = 81.2% [71.6%–88.1%] | 0/29 = 0.0% [0.0%–11.7%] | 0/24 = 0.0% [0.0%–13.8%] | 0/32 = 0.0% [0.0%–10.7%] | **0** | 22/22 = 100.0% [85.1%–100.0%] | 22/32 = 68.8% [51.4%–82.0%] | 23/23 = 100.0% [85.7%–100.0%] | 24/24 = 100.0% [86.2%–100.0%] |
| B. Choice, random order (frozen) | 85 | 78/85 = 91.8% [84.0%–96.0%] | 0/29 = 0.0% [0.0%–11.7%] | 3/24 = 12.5% [4.3%–31.0%] | 0/32 = 0.0% [0.0%–10.7%] | **3** | 31/34 = 91.2% [77.0%–97.0%] | 31/32 = 96.9% [84.3%–99.4%] | 27/28 = 96.4% [82.3%–99.4%] | 20/24 = 83.3% [64.1%–93.3%] |
| C. Hybrid (frozen) | 85 | 69/85 = 81.2% [71.6%–88.1%] | 0/29 = 0.0% [0.0%–11.7%] | 0/24 = 0.0% [0.0%–13.8%] | 0/32 = 0.0% [0.0%–10.7%] | **0** | 22/22 = 100.0% [85.1%–100.0%] | 22/32 = 68.8% [51.4%–82.0%] | 23/23 = 100.0% [85.7%–100.0%] | 24/24 = 100.0% [86.2%–100.0%] |
| A'. Noul (Phase 0 default) | 85 | 73/85 = 85.9% [76.9%–91.7%] | 1/29 = 3.4% [0.6%–17.2%] | 6/24 = 25.0% [12.0%–44.9%] | 0/32 = 0.0% [0.0%–10.7%] | **7** | 32/39 = 82.1% [67.3%–91.0%] | 32/32 = 100.0% [89.3%–100.0%] | 26/29 = 89.7% [73.6%–96.4%] | 15/24 = 62.5% [42.7%–78.8%] |
| B'. Choice (default) | 85 | 75/85 = 88.2% [79.7%–93.5%] | 1/29 = 3.4% [0.6%–17.2%] | 7/24 = 29.2% [14.9%–49.2%] | 0/32 = 0.0% [0.0%–10.7%] | **8** | 32/40 = 80.0% [65.2%–89.5%] | 32/32 = 100.0% [89.3%–100.0%] | 27/28 = 96.4% [82.3%–99.4%] | 16/24 = 66.7% [46.7%–82.0%] |
| C'. Hybrid (default) | 85 | 76/85 = 89.4% [81.1%–94.3%] | 1/29 = 3.4% [0.6%–17.2%] | 4/24 = 16.7% [6.7%–35.9%] | 0/32 = 0.0% [0.0%–10.7%] | **5** | 32/37 = 86.5% [72.0%–94.1%] | 32/32 = 100.0% [89.3%–100.0%] | 25/26 = 96.2% [81.1%–99.3%] | 19/24 = 79.2% [59.5%–90.8%] |
| D. gpt-4.1-mini (temp 0) | 85 | 66/85 = 77.6% [67.7%–85.2%] | 0/29 = 0.0% [0.0%–11.7%] | 5/24 = 20.8% [9.2%–40.5%] | 0/32 = 0.0% [0.0%–10.7%] | **5** | 32/37 = 86.5% [72.0%–94.1%] | 32/32 = 100.0% [89.3%–100.0%] | 29/43 = 67.4% [52.5%–79.5%] | 5/24 = 20.8% [9.2%–40.5%] |

## dev/undisputed (thresholds were fitted here — optimistic, for reference only)

| Strategy | n | Accuracy | False merge on NEW | False merge on UNCERTAIN | Wrong target | Dangerous total | REVISE prec. | REVISE recall | NEW prec. | UNCERTAIN recall |
|---|---|---|---|---|---|---|---|---|---|---|
| A. Noul (frozen) | 77 | 62/77 = 80.5% [70.3%–87.8%] | 0/28 = 0.0% [0.0%–12.1%] | 0/17 = 0.0% [0.0%–18.4%] | 0/32 = 0.0% [0.0%–10.7%] | **0** | 22/22 = 100.0% [85.1%–100.0%] | 22/32 = 68.8% [51.4%–82.0%] | 23/23 = 100.0% [85.7%–100.0%] | 17/17 = 100.0% [81.6%–100.0%] |
| B. Choice, random order (frozen) | 77 | 73/77 = 94.8% [87.4%–98.0%] | 0/28 = 0.0% [0.0%–12.1%] | 1/17 = 5.9% [1.0%–27.0%] | 0/32 = 0.0% [0.0%–10.7%] | **1** | 31/32 = 96.9% [84.3%–99.4%] | 31/32 = 96.9% [84.3%–99.4%] | 27/28 = 96.4% [82.3%–99.4%] | 15/17 = 88.2% [65.7%–96.7%] |
| C. Hybrid (frozen) | 77 | 62/77 = 80.5% [70.3%–87.8%] | 0/28 = 0.0% [0.0%–12.1%] | 0/17 = 0.0% [0.0%–18.4%] | 0/32 = 0.0% [0.0%–10.7%] | **0** | 22/22 = 100.0% [85.1%–100.0%] | 22/32 = 68.8% [51.4%–82.0%] | 23/23 = 100.0% [85.7%–100.0%] | 17/17 = 100.0% [81.6%–100.0%] |
| A'. Noul (Phase 0 default) | 77 | 67/77 = 87.0% [77.7%–92.8%] | 1/28 = 3.6% [0.6%–17.7%] | 4/17 = 23.5% [9.6%–47.3%] | 0/32 = 0.0% [0.0%–10.7%] | **5** | 32/37 = 86.5% [72.0%–94.1%] | 32/32 = 100.0% [89.3%–100.0%] | 25/28 = 89.3% [72.8%–96.3%] | 10/17 = 58.8% [36.0%–78.4%] |
| B'. Choice (default) | 77 | 72/77 = 93.5% [85.7%–97.2%] | 1/28 = 3.6% [0.6%–17.7%] | 3/17 = 17.6% [6.2%–41.0%] | 0/32 = 0.0% [0.0%–10.7%] | **4** | 32/36 = 88.9% [74.7%–95.6%] | 32/32 = 100.0% [89.3%–100.0%] | 27/28 = 96.4% [82.3%–99.4%] | 13/17 = 76.5% [52.7%–90.4%] |
| C'. Hybrid (default) | 77 | 71/77 = 92.2% [84.0%–96.4%] | 1/28 = 3.6% [0.6%–17.7%] | 2/17 = 11.8% [3.3%–34.3%] | 0/32 = 0.0% [0.0%–10.7%] | **3** | 32/35 = 91.4% [77.6%–97.0%] | 32/32 = 100.0% [89.3%–100.0%] | 25/26 = 96.2% [81.1%–99.3%] | 14/17 = 82.4% [59.0%–93.8%] |
| D. gpt-4.1-mini (temp 0) | 77 | 65/77 = 84.4% [74.7%–90.9%] | 0/28 = 0.0% [0.0%–12.1%] | 3/17 = 17.6% [6.2%–41.0%] | 0/32 = 0.0% [0.0%–10.7%] | **3** | 32/35 = 91.4% [77.6%–97.0%] | 32/32 = 100.0% [89.3%–100.0%] | 28/37 = 75.7% [59.9%–86.6%] | 5/17 = 29.4% [13.3%–53.1%] |

## Holdout confusion matrices (all cases; rows expected, cols predicted)

**A. Noul (frozen)**

| exp \ pred | REVISE | NEW | UNCERTAIN | ERROR |
|---|---|---|---|---|
| REVISE | 19 | 0 | 11 | 0 |
| NEW | 0 | 23 | 6 | 0 |
| UNCERTAIN | 0 | 3 | 23 | 0 |

**B. Choice, random order (frozen)**

| exp \ pred | REVISE | NEW | UNCERTAIN | ERROR |
|---|---|---|---|---|
| REVISE | 28 | 0 | 2 | 0 |
| NEW | 0 | 27 | 2 | 0 |
| UNCERTAIN | 3 | 2 | 21 | 0 |

**C. Hybrid (frozen)**

| exp \ pred | REVISE | NEW | UNCERTAIN | ERROR |
|---|---|---|---|---|
| REVISE | 19 | 0 | 11 | 0 |
| NEW | 0 | 23 | 6 | 0 |
| UNCERTAIN | 0 | 2 | 24 | 0 |

**A'. Noul (Phase 0 default)**

| exp \ pred | REVISE | NEW | UNCERTAIN | ERROR |
|---|---|---|---|---|
| REVISE | 28 | 0 | 2 | 0 |
| NEW | 0 | 27 | 2 | 0 |
| UNCERTAIN | 4 | 4 | 18 | 0 |

**B'. Choice (default)**

| exp \ pred | REVISE | NEW | UNCERTAIN | ERROR |
|---|---|---|---|---|
| REVISE | 30 | 0 | 0 | 0 |
| NEW | 0 | 27 | 2 | 0 |
| UNCERTAIN | 7 | 2 | 17 | 0 |

**C'. Hybrid (default)**

| exp \ pred | REVISE | NEW | UNCERTAIN | ERROR |
|---|---|---|---|---|
| REVISE | 28 | 0 | 2 | 0 |
| NEW | 0 | 26 | 3 | 0 |
| UNCERTAIN | 3 | 2 | 21 | 0 |

**D. gpt-4.1-mini (temp 0)**

| exp \ pred | REVISE | NEW | UNCERTAIN | ERROR |
|---|---|---|---|---|
| REVISE | 29 | 1 | 0 | 0 |
| NEW | 0 | 29 | 0 | 0 |
| UNCERTAIN | 6 | 13 | 7 | 0 |

## Dangerous merges (predicted REVISE where expected NEW/UNCERTAIN, or REVISE with wrong target)

| split | strategy | case | cat | lang | disputed | expected | predicted | Noul scores | Choice probs | candidates → capture |
|---|---|---|---|---|---|---|---|---|---|---|
| holdout | B. Choice, random order (frozen) | P131 | SCOPE | en | yes | UNCERTAIN | REVISE→0 | 0.86 | revise_idea_0:0.99 | Kestrel is a consumer product. → Kestrel is really an enterprise tool in disguise. |
| holdout | B. Choice, random order (frozen) | P136 | SCOPE | bg | yes | UNCERTAIN | REVISE→0 | 0.87 | revise_idea_0:0.99 | Орбит е мобилно приложение. → Орбит е инструмент за мислене, а не просто приложение. |
| holdout | B. Choice, random order (frozen) | P140 | SCOPE | mixed | yes | UNCERTAIN | REVISE→0 | 0.92 | revise_idea_0:1 | Orbit е SaaS продукт. → Orbit е по-скоро platform за разработчици, не продукт. |
| holdout | D. gpt-4.1-mini (temp 0) | P122 | SUBTASK | bg | yes | UNCERTAIN | REVISE→0 | n/a | n/a | Да организирам сватбата. → Да избера ресторант за сватбата. |
| holdout | D. gpt-4.1-mini (temp 0) | P126 | SUBTASK | mixed | yes | UNCERTAIN | REVISE→0 | n/a | n/a | Да направим redesign на onboarding-а. → Да сменим илюстрациите в onboarding-а. |
| holdout | D. gpt-4.1-mini (temp 0) | P131 | SCOPE | en | yes | UNCERTAIN | REVISE→0 | n/a | n/a | Kestrel is a consumer product. → Kestrel is really an enterprise tool in disguise. |
| holdout | D. gpt-4.1-mini (temp 0) | P136 | SCOPE | bg | yes | UNCERTAIN | REVISE→0 | n/a | n/a | Орбит е мобилно приложение. → Орбит е инструмент за мислене, а не просто приложение. |
| holdout | D. gpt-4.1-mini (temp 0) | P138 | SCOPE | bg | yes | UNCERTAIN | REVISE→0 | n/a | n/a | Искам да живея по-здравословно. → Искам да спра захарта. |
| holdout | D. gpt-4.1-mini (temp 0) | P140 | SCOPE | mixed | yes | UNCERTAIN | REVISE→0 | n/a | n/a | Orbit е SaaS продукт. → Orbit е по-скоро platform за разработчици, не продукт. |
| dev | B. Choice, random order (frozen) | P129 | SCOPE | en | yes | UNCERTAIN | REVISE→0 | 0.92 | revise_idea_0:1 | Orbit is a web dashboard. → Orbit is an operations platform, not just a dashboard. |
| dev | B. Choice, random order (frozen) | P130 | SCOPE | en | yes | UNCERTAIN | REVISE→0 | 0.89 | revise_idea_0:1 | Lumen is a note-taking app. → Lumen is a knowledge workspace, not a notes app. |
| dev | B. Choice, random order (frozen) | P144 | AMBREF | en |  | UNCERTAIN | REVISE→0 | 0.91 | revise_idea_0:1 | Move the launch to May. → Let's push it back a bit more. |
| dev | D. gpt-4.1-mini (temp 0) | P125 | SUBTASK | bg |  | UNCERTAIN | REVISE→0 | n/a | n/a | Ремонт на банята. → Да избера плочки за банята. |
| dev | D. gpt-4.1-mini (temp 0) | P129 | SCOPE | en | yes | UNCERTAIN | REVISE→0 | n/a | n/a | Orbit is a web dashboard. → Orbit is an operations platform, not just a dashboard. |
| dev | D. gpt-4.1-mini (temp 0) | P130 | SCOPE | en | yes | UNCERTAIN | REVISE→0 | n/a | n/a | Lumen is a note-taking app. → Lumen is a knowledge workspace, not a notes app. |
| dev | D. gpt-4.1-mini (temp 0) | P149 | AMBREF | en |  | UNCERTAIN | REVISE→0 | n/a | n/a | The CEO wants the new report. → He needs it by Friday. |
| dev | D. gpt-4.1-mini (temp 0) | P170 | TWOFIT | mixed |  | UNCERTAIN | REVISE→0 | n/a | n/a | Landing page за продукта. ‖ Landing page за webinar-а. → Landing page-ът да има по-голям CTA бутон. |

## Holdout breakdowns

### By language

| group | strategy | n | accuracy | dangerous merges |
|---|---|---|---|---|
| bg | A. Noul (frozen) | 27 | 19/27 = 70.4% [51.5%–84.1%] | 0 |
| bg | B. Choice, random order (frozen) | 27 | 25/27 = 92.6% [76.6%–97.9%] | 1 |
| bg | C. Hybrid (frozen) | 27 | 19/27 = 70.4% [51.5%–84.1%] | 0 |
| bg | D. gpt-4.1-mini (temp 0) | 27 | 20/27 = 74.1% [55.3%–86.8%] | 3 |
| en | A. Noul (frozen) | 33 | 29/33 = 87.9% [72.7%–95.2%] | 0 |
| en | B. Choice, random order (frozen) | 33 | 30/33 = 90.9% [76.4%–96.9%] | 1 |
| en | C. Hybrid (frozen) | 33 | 29/33 = 87.9% [72.7%–95.2%] | 0 |
| en | D. gpt-4.1-mini (temp 0) | 33 | 26/33 = 78.8% [62.2%–89.3%] | 1 |
| mixed | A. Noul (frozen) | 25 | 17/25 = 68.0% [48.4%–82.8%] | 0 |
| mixed | B. Choice, random order (frozen) | 25 | 21/25 = 84.0% [65.3%–93.6%] | 1 |
| mixed | C. Hybrid (frozen) | 25 | 18/25 = 72.0% [52.4%–85.7%] | 0 |
| mixed | D. gpt-4.1-mini (temp 0) | 25 | 19/25 = 76.0% [56.6%–88.5%] | 2 |

### By category

| group | strategy | n | accuracy | dangerous merges |
|---|---|---|---|---|
| AMBREF | A. Noul (frozen) | 7 | 4/7 = 57.1% [25.0%–84.2%] | 0 |
| AMBREF | B. Choice, random order (frozen) | 7 | 5/7 = 71.4% [35.9%–91.8%] | 0 |
| AMBREF | C. Hybrid (frozen) | 7 | 5/7 = 71.4% [35.9%–91.8%] | 0 |
| AMBREF | D. gpt-4.1-mini (temp 0) | 7 | 5/7 = 71.4% [35.9%–91.8%] | 0 |
| CONT | A. Noul (frozen) | 7 | 5/7 = 71.4% [35.9%–91.8%] | 0 |
| CONT | B. Choice, random order (frozen) | 7 | 7/7 = 100.0% [64.6%–100.0%] | 0 |
| CONT | C. Hybrid (frozen) | 7 | 5/7 = 71.4% [35.9%–91.8%] | 0 |
| CONT | D. gpt-4.1-mini (temp 0) | 7 | 7/7 = 100.0% [64.6%–100.0%] | 0 |
| CORR | A. Noul (frozen) | 7 | 7/7 = 100.0% [64.6%–100.0%] | 0 |
| CORR | B. Choice, random order (frozen) | 7 | 7/7 = 100.0% [64.6%–100.0%] | 0 |
| CORR | C. Hybrid (frozen) | 7 | 7/7 = 100.0% [64.6%–100.0%] | 0 |
| CORR | D. gpt-4.1-mini (temp 0) | 7 | 7/7 = 100.0% [64.6%–100.0%] | 0 |
| DIFFPROJ | A. Noul (frozen) | 7 | 4/7 = 57.1% [25.0%–84.2%] | 0 |
| DIFFPROJ | B. Choice, random order (frozen) | 7 | 6/7 = 85.7% [48.7%–97.4%] | 0 |
| DIFFPROJ | C. Hybrid (frozen) | 7 | 4/7 = 57.1% [25.0%–84.2%] | 0 |
| DIFFPROJ | D. gpt-4.1-mini (temp 0) | 7 | 7/7 = 100.0% [64.6%–100.0%] | 0 |
| NEWMC | A. Noul (frozen) | 7 | 7/7 = 100.0% [64.6%–100.0%] | 0 |
| NEWMC | B. Choice, random order (frozen) | 7 | 7/7 = 100.0% [64.6%–100.0%] | 0 |
| NEWMC | C. Hybrid (frozen) | 7 | 7/7 = 100.0% [64.6%–100.0%] | 0 |
| NEWMC | D. gpt-4.1-mini (temp 0) | 7 | 7/7 = 100.0% [64.6%–100.0%] | 0 |
| REPL | A. Noul (frozen) | 7 | 5/7 = 71.4% [35.9%–91.8%] | 0 |
| REPL | B. Choice, random order (frozen) | 7 | 7/7 = 100.0% [64.6%–100.0%] | 0 |
| REPL | C. Hybrid (frozen) | 7 | 5/7 = 71.4% [35.9%–91.8%] | 0 |
| REPL | D. gpt-4.1-mini (temp 0) | 7 | 7/7 = 100.0% [64.6%–100.0%] | 0 |
| REVMC | A. Noul (frozen) | 8 | 2/8 = 25.0% [7.1%–59.1%] | 0 |
| REVMC | B. Choice, random order (frozen) | 8 | 6/8 = 75.0% [40.9%–92.9%] | 0 |
| REVMC | C. Hybrid (frozen) | 8 | 2/8 = 25.0% [7.1%–59.1%] | 0 |
| REVMC | D. gpt-4.1-mini (temp 0) | 8 | 7/8 = 87.5% [52.9%–97.8%] | 0 |
| SAMEPROJ | A. Noul (frozen) | 7 | 7/7 = 100.0% [64.6%–100.0%] | 0 |
| SAMEPROJ | B. Choice, random order (frozen) | 7 | 7/7 = 100.0% [64.6%–100.0%] | 0 |
| SAMEPROJ | C. Hybrid (frozen) | 7 | 7/7 = 100.0% [64.6%–100.0%] | 0 |
| SAMEPROJ | D. gpt-4.1-mini (temp 0) | 7 | 7/7 = 100.0% [64.6%–100.0%] | 0 |
| SCOPE | A. Noul (frozen) | 7 | 5/7 = 71.4% [35.9%–91.8%] | 0 |
| SCOPE | B. Choice, random order (frozen) | 7 | 3/7 = 42.9% [15.8%–75.0%] | 3 |
| SCOPE | C. Hybrid (frozen) | 7 | 5/7 = 71.4% [35.9%–91.8%] | 0 |
| SCOPE | D. gpt-4.1-mini (temp 0) | 7 | 2/7 = 28.6% [8.2%–64.1%] | 4 |
| SUBTASK | A. Noul (frozen) | 7 | 7/7 = 100.0% [64.6%–100.0%] | 0 |
| SUBTASK | B. Choice, random order (frozen) | 7 | 7/7 = 100.0% [64.6%–100.0%] | 0 |
| SUBTASK | C. Hybrid (frozen) | 7 | 7/7 = 100.0% [64.6%–100.0%] | 0 |
| SUBTASK | D. gpt-4.1-mini (temp 0) | 7 | 0/7 = 0.0% [0.0%–35.4%] | 2 |
| TOPIC | A. Noul (frozen) | 7 | 5/7 = 71.4% [35.9%–91.8%] | 0 |
| TOPIC | B. Choice, random order (frozen) | 7 | 7/7 = 100.0% [64.6%–100.0%] | 0 |
| TOPIC | C. Hybrid (frozen) | 7 | 5/7 = 71.4% [35.9%–91.8%] | 0 |
| TOPIC | D. gpt-4.1-mini (temp 0) | 7 | 7/7 = 100.0% [64.6%–100.0%] | 0 |
| TWOFIT | A. Noul (frozen) | 7 | 7/7 = 100.0% [64.6%–100.0%] | 0 |
| TWOFIT | B. Choice, random order (frozen) | 7 | 7/7 = 100.0% [64.6%–100.0%] | 0 |
| TWOFIT | C. Hybrid (frozen) | 7 | 7/7 = 100.0% [64.6%–100.0%] | 0 |
| TWOFIT | D. gpt-4.1-mini (temp 0) | 7 | 2/7 = 28.6% [8.2%–64.1%] | 0 |

### Single vs multi-candidate

| group | strategy | n | accuracy | dangerous merges |
|---|---|---|---|---|
| multi-candidate | A. Noul (frozen) | 29 | 20/29 = 69.0% [50.8%–82.7%] | 0 |
| multi-candidate | B. Choice, random order (frozen) | 29 | 25/29 = 86.2% [69.4%–94.5%] | 0 |
| multi-candidate | C. Hybrid (frozen) | 29 | 21/29 = 72.4% [54.3%–85.3%] | 0 |
| multi-candidate | D. gpt-4.1-mini (temp 0) | 29 | 21/29 = 72.4% [54.3%–85.3%] | 0 |
| single-candidate | A. Noul (frozen) | 56 | 45/56 = 80.4% [68.2%–88.7%] | 0 |
| single-candidate | B. Choice, random order (frozen) | 56 | 51/56 = 91.1% [80.7%–96.1%] | 3 |
| single-candidate | C. Hybrid (frozen) | 56 | 45/56 = 80.4% [68.2%–88.7%] | 0 |
| single-candidate | D. gpt-4.1-mini (temp 0) | 56 | 44/56 = 78.6% [66.2%–87.3%] | 6 |

## Multi-candidate identity (holdout)

| strategy | REVMC: correct target | REVMC: wrongly UNCERTAIN/NEW | AMBREF+TWOFIT (multi-cand UNCERTAIN): REVISE-merged | resolved UNCERTAIN |
|---|---|---|---|---|
| A. Noul (frozen) | 2/8 = 25.0% [7.1%–59.1%] (wrong target 0) | 6 | 0/14 | 11/14 |
| B. Choice, random order (frozen) | 6/8 = 75.0% [40.9%–92.9%] (wrong target 0) | 2 | 0/14 | 12/14 |
| C. Hybrid (frozen) | 2/8 = 25.0% [7.1%–59.1%] (wrong target 0) | 6 | 0/14 | 12/14 |
| D. gpt-4.1-mini (temp 0) | 7/8 = 87.5% [52.9%–97.8%] (wrong target 0) | 1 | 0/14 | 7/14 |
| A'. Noul (Phase 0 default) | 6/8 = 75.0% [40.9%–92.9%] (wrong target 0) | 2 | 1/14 | 10/14 |
| B'. Choice (default) | 8/8 = 100.0% [67.6%–100.0%] (wrong target 0) | 0 | 0/14 | 12/14 |
| C'. Hybrid (default) | 6/8 = 75.0% [40.9%–92.9%] (wrong target 0) | 2 | 0/14 | 12/14 |

### Noul top-two gap by true label (multi-candidate cases, all splits, first request)

| expected | n | top1 median | top2 median | gap median | cases where top-1 would be the correct target | ≥2 candidates ≥0.8 |
|---|---|---|---|---|---|---|
| REVISE | 16 | 0.95 | 0.02 | 0.92 | 16/16 | 0 |
| NEW | 14 | 0.06 | 0.03 | 0.02 | n/a (no target) | 0 |
| UNCERTAIN | 24 | 0.48 | 0.35 | 0.09 | n/a (no target) | 0 |

## Consistency (48-case stratified subset: 3 identical fixed-order repeats + 3 random-order repeats; not used in the rates above)

```json
{
 "noul": {
  "cases": 48,
  "identical_across_3_fixed_order": 46,
  "identical_across_3_random_orders": 44,
  "identical_across_all_6": 44,
  "unstable_cases": [
   "P001",
   "P018",
   "P031",
   "P041"
  ],
  "max_score_drift_fixed_order": 0.06,
  "bit_identical_cases_fixed": 3
 },
 "choice": {
  "cases": 48,
  "identical_across_3_fixed_order": 48,
  "identical_across_3_random_orders": 47,
  "identical_across_all_6": 47,
  "unstable_cases": [
   "P123"
  ],
  "max_prob_drift_fixed_order": 0.07000000000000006
 },
 "hybrid": {
  "cases": 48,
  "identical_across_3_fixed_order": 46,
  "identical_across_3_random_orders": 44,
  "identical_across_all_6": 44,
  "unstable_cases": [
   "P001",
   "P018",
   "P031",
   "P041"
  ]
 },
 "false_merges_in_repeats": [
  {
   "id": "P130",
   "mech": "choice",
   "expected": "UNCERTAIN",
   "bad_reps": "6/6",
   "disputed": true
  },
  {
   "id": "P140",
   "mech": "choice",
   "expected": "UNCERTAIN",
   "bad_reps": "6/6",
   "disputed": true
  }
 ],
 "noul_vs_choice": {
  "requests": 288,
  "disagreements": 62,
  "cases": [
   "P001",
   "P030",
   "P036",
   "P055",
   "P087",
   "P092",
   "P096",
   "P130",
   "P132",
   "P140",
   "P031",
   "P041",
   "P018",
   "P123"
  ]
 },
 "choice_argmax_changed_by_random_order": "1/144 requests differ from the fixed-order answer",
 "llm": {
  "cases": 48,
  "identical_across_3": 48
 }
}
```

## Provider performance

```json
{
 "jev": {
  "requests": 543,
  "ok": 543,
  "api_errors": [],
  "schema_errors": 0,
  "retried": 0,
  "models": [
   "jev-1.13.0"
  ],
  "latency_ms": {
   "p50": 277,
   "p95": 395,
   "max": 877
  },
  "input_tokens": 382417,
  "output_tokens": 45700,
  "cost_usd": 0.016061514
 },
 "llm": {
  "requests": 314,
  "ok": 314,
  "api_errors": [],
  "schema_errors": 0,
  "retried": 0,
  "models": [
   "gpt-4.1-mini-2025-04-14"
  ],
  "latency_ms": {
   "p50": 720,
   "p95": 1187,
   "max": 2723
  },
  "input_tokens": 73175,
  "output_tokens": 3716,
  "cost_usd": 0.0352156
 },
 "ledger_spent_usd": 0.05127711400000001,
 "budget_usd": 1
}
```
