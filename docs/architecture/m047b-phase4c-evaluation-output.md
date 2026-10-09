## Evaluation output

### Dev split (31 revision cases: 10 safe / 21 unsafe; 10 identity cases)

#### Identity gate with SCRIPTED classifier signals (policy check, not classifier accuracy)

| metric | result |
|---|---|
| identity false-revision rate (should not revise, did) | 0/6 = 0.0% (95% CI 0.0–39.0%) |
| identity recall (should revise that target, did) | 3/4 = 75.0% (95% CI 30.1–95.4%) |
| incorrect-target rate (revised, wrong object) | 0/3 = 0.0% (95% CI 0.0–56.1%) |
| UNCERTAIN rate (all cases) | 6/10 = 60.0% (95% CI 31.3–83.2%) |
| outcome differs from implementer's expectation | 1/10 = 10.0% (95% CI 1.8–40.4%) |
| [bg] outcome differs from expectation | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| [en] outcome differs from expectation | 1/8 = 12.5% (95% CI 2.2–47.1%) |
| [mixed] outcome differs from expectation | 0/1 = 0.0% (95% CI 0.0–79.3%) |

#### Layer A — deterministic validator only (no model)

| metric | result |
|---|---|
| unsafe drafts accepted (all classes) | 10/21 = 47.6% (95% CI 28.3–67.6%) |
| unsupported-assertion acceptance (new fact / date / number / entity) | 2/7 = 28.6% (95% CI 8.2–64.1%) |
| omission acceptance (dropped existing fact) | 0/3 = 0.0% (95% CI 0.0–56.1%) |
| incorrect-correction acceptance | 3/3 = 100.0% (95% CI 43.9–100.0%) |
| negation/qualifier change acceptance | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| scope expansion acceptance | 2/2 = 100.0% (95% CI 34.2–100.0%) |
| certainty increase acceptance | 1/1 = 100.0% (95% CI 20.7–100.0%) |
| contradiction acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| ambiguous-reference acceptance | 1/1 = 100.0% (95% CI 20.7–100.0%) |
| evidence-misattribution acceptance | 1/1 = 100.0% (95% CI 20.7–100.0%) |
| safe drafts rejected (false veto, end to end) | 0/10 = 0.0% (95% CI 0.0–27.8%) |
| safe drafts stopped by the deterministic validator | 0/10 = 0.0% (95% CI 0.0–27.8%) |
| [bg] unsafe accepted | 2/5 = 40.0% (95% CI 11.8–76.9%) |
| [bg] safe rejected | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| [en] unsafe accepted | 7/12 = 58.3% (95% CI 32.0–80.7%) |
| [en] safe rejected | 0/6 = 0.0% (95% CI 0.0–39.0%) |
| [mixed] unsafe accepted | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| [mixed] safe rejected | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| [unicode] unsafe accepted | 1/2 = 50.0% (95% CI 9.5–90.5%) |
| [unicode] safe rejected | 0/1 = 0.0% (95% CI 0.0–79.3%) |

#### Layer B — validator + real adapter over mock transport: oracle (plumbing, NOT model quality)

| metric | result |
|---|---|
| unsafe drafts accepted (all classes) | 0/21 = 0.0% (95% CI 0.0–15.5%) |
| unsupported-assertion acceptance (new fact / date / number / entity) | 0/7 = 0.0% (95% CI 0.0–35.4%) |
| omission acceptance (dropped existing fact) | 0/3 = 0.0% (95% CI 0.0–56.1%) |
| incorrect-correction acceptance | 0/3 = 0.0% (95% CI 0.0–56.1%) |
| negation/qualifier change acceptance | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| scope expansion acceptance | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| certainty increase acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| contradiction acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| ambiguous-reference acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| evidence-misattribution acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| safe drafts rejected (false veto, end to end) | 0/10 = 0.0% (95% CI 0.0–27.8%) |
| verifier false-PASS (unsafe drafts that reached it and passed) | 0/10 = 0.0% (95% CI 0.0–27.8%) |
| verifier false-VETO (safe drafts that reached it and were vetoed) | 0/10 = 0.0% (95% CI 0.0–27.8%) |
| verifier unavailable/unreadable (of drafts that reached it) | 0/20 = 0.0% (95% CI 0.0–16.1%) |
| safe drafts stopped by the deterministic validator | 0/10 = 0.0% (95% CI 0.0–27.8%) |
| [bg] unsafe accepted | 0/5 = 0.0% (95% CI 0.0–43.4%) |
| [bg] safe rejected | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| [en] unsafe accepted | 0/12 = 0.0% (95% CI 0.0–24.2%) |
| [en] safe rejected | 0/6 = 0.0% (95% CI 0.0–39.0%) |
| [mixed] unsafe accepted | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| [mixed] safe rejected | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| [unicode] unsafe accepted | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| [unicode] safe rejected | 0/1 = 0.0% (95% CI 0.0–79.3%) |

#### Layer B — validator + real adapter over mock transport: always-pass (plumbing, NOT model quality)

| metric | result |
|---|---|
| unsafe drafts accepted (all classes) | 10/21 = 47.6% (95% CI 28.3–67.6%) |
| unsupported-assertion acceptance (new fact / date / number / entity) | 2/7 = 28.6% (95% CI 8.2–64.1%) |
| omission acceptance (dropped existing fact) | 0/3 = 0.0% (95% CI 0.0–56.1%) |
| incorrect-correction acceptance | 3/3 = 100.0% (95% CI 43.9–100.0%) |
| negation/qualifier change acceptance | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| scope expansion acceptance | 2/2 = 100.0% (95% CI 34.2–100.0%) |
| certainty increase acceptance | 1/1 = 100.0% (95% CI 20.7–100.0%) |
| contradiction acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| ambiguous-reference acceptance | 1/1 = 100.0% (95% CI 20.7–100.0%) |
| evidence-misattribution acceptance | 1/1 = 100.0% (95% CI 20.7–100.0%) |
| safe drafts rejected (false veto, end to end) | 0/10 = 0.0% (95% CI 0.0–27.8%) |
| verifier false-PASS (unsafe drafts that reached it and passed) | 10/10 = 100.0% (95% CI 72.2–100.0%) |
| verifier false-VETO (safe drafts that reached it and were vetoed) | 0/10 = 0.0% (95% CI 0.0–27.8%) |
| verifier unavailable/unreadable (of drafts that reached it) | 0/20 = 0.0% (95% CI 0.0–16.1%) |
| safe drafts stopped by the deterministic validator | 0/10 = 0.0% (95% CI 0.0–27.8%) |
| [bg] unsafe accepted | 2/5 = 40.0% (95% CI 11.8–76.9%) |
| [bg] safe rejected | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| [en] unsafe accepted | 7/12 = 58.3% (95% CI 32.0–80.7%) |
| [en] safe rejected | 0/6 = 0.0% (95% CI 0.0–39.0%) |
| [mixed] unsafe accepted | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| [mixed] safe rejected | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| [unicode] unsafe accepted | 1/2 = 50.0% (95% CI 9.5–90.5%) |
| [unicode] safe rejected | 0/1 = 0.0% (95% CI 0.0–79.3%) |

#### Layer B — validator + real adapter over mock transport: garbage answers (plumbing, NOT model quality)

| metric | result |
|---|---|
| unsafe drafts accepted (all classes) | 0/21 = 0.0% (95% CI 0.0–15.5%) |
| unsupported-assertion acceptance (new fact / date / number / entity) | 0/7 = 0.0% (95% CI 0.0–35.4%) |
| omission acceptance (dropped existing fact) | 0/3 = 0.0% (95% CI 0.0–56.1%) |
| incorrect-correction acceptance | 0/3 = 0.0% (95% CI 0.0–56.1%) |
| negation/qualifier change acceptance | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| scope expansion acceptance | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| certainty increase acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| contradiction acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| ambiguous-reference acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| evidence-misattribution acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| safe drafts rejected (false veto, end to end) | 10/10 = 100.0% (95% CI 72.2–100.0%) |
| verifier false-PASS (unsafe drafts that reached it and passed) | 0/10 = 0.0% (95% CI 0.0–27.8%) |
| verifier false-VETO (safe drafts that reached it and were vetoed) | 0/10 = 0.0% (95% CI 0.0–27.8%) |
| verifier unavailable/unreadable (of drafts that reached it) | 20/20 = 100.0% (95% CI 83.9–100.0%) |
| safe drafts stopped by the deterministic validator | 0/10 = 0.0% (95% CI 0.0–27.8%) |
| [bg] unsafe accepted | 0/5 = 0.0% (95% CI 0.0–43.4%) |
| [bg] safe rejected | 2/2 = 100.0% (95% CI 34.2–100.0%) |
| [en] unsafe accepted | 0/12 = 0.0% (95% CI 0.0–24.2%) |
| [en] safe rejected | 6/6 = 100.0% (95% CI 61.0–100.0%) |
| [mixed] unsafe accepted | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| [mixed] safe rejected | 1/1 = 100.0% (95% CI 20.7–100.0%) |
| [unicode] unsafe accepted | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| [unicode] safe rejected | 1/1 = 100.0% (95% CI 20.7–100.0%) |

#### Layer B — validator + real adapter over mock transport: endpoint outage (plumbing, NOT model quality)

| metric | result |
|---|---|
| unsafe drafts accepted (all classes) | 0/21 = 0.0% (95% CI 0.0–15.5%) |
| unsupported-assertion acceptance (new fact / date / number / entity) | 0/7 = 0.0% (95% CI 0.0–35.4%) |
| omission acceptance (dropped existing fact) | 0/3 = 0.0% (95% CI 0.0–56.1%) |
| incorrect-correction acceptance | 0/3 = 0.0% (95% CI 0.0–56.1%) |
| negation/qualifier change acceptance | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| scope expansion acceptance | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| certainty increase acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| contradiction acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| ambiguous-reference acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| evidence-misattribution acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| safe drafts rejected (false veto, end to end) | 10/10 = 100.0% (95% CI 72.2–100.0%) |
| verifier false-PASS (unsafe drafts that reached it and passed) | 0/10 = 0.0% (95% CI 0.0–27.8%) |
| verifier false-VETO (safe drafts that reached it and were vetoed) | 0/10 = 0.0% (95% CI 0.0–27.8%) |
| verifier unavailable/unreadable (of drafts that reached it) | 20/20 = 100.0% (95% CI 83.9–100.0%) |
| safe drafts stopped by the deterministic validator | 0/10 = 0.0% (95% CI 0.0–27.8%) |
| [bg] unsafe accepted | 0/5 = 0.0% (95% CI 0.0–43.4%) |
| [bg] safe rejected | 2/2 = 100.0% (95% CI 34.2–100.0%) |
| [en] unsafe accepted | 0/12 = 0.0% (95% CI 0.0–24.2%) |
| [en] safe rejected | 6/6 = 100.0% (95% CI 61.0–100.0%) |
| [mixed] unsafe accepted | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| [mixed] safe rejected | 1/1 = 100.0% (95% CI 20.7–100.0%) |
| [unicode] unsafe accepted | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| [unicode] safe rejected | 1/1 = 100.0% (95% CI 20.7–100.0%) |

#### Layer C — real model (GPT-6 Luna, same-family review, effort none)

NOT RUN. No verification authorization was granted, no OpenAI credential was used and no paid request was made. No real-model metric is reported.

### Frozen holdout (evaluated once, nothing tuned to it) (25 revision cases: 8 safe / 17 unsafe; 10 identity cases)

#### Identity gate with SCRIPTED classifier signals (policy check, not classifier accuracy)

| metric | result |
|---|---|
| identity false-revision rate (should not revise, did) | 0/6 = 0.0% (95% CI 0.0–39.0%) |
| identity recall (should revise that target, did) | 3/4 = 75.0% (95% CI 30.1–95.4%) |
| incorrect-target rate (revised, wrong object) | 0/3 = 0.0% (95% CI 0.0–56.1%) |
| UNCERTAIN rate (all cases) | 6/10 = 60.0% (95% CI 31.3–83.2%) |
| outcome differs from implementer's expectation | 1/10 = 10.0% (95% CI 1.8–40.4%) |
| [bg] outcome differs from expectation | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| [en] outcome differs from expectation | 1/8 = 12.5% (95% CI 2.2–47.1%) |
| [unicode] outcome differs from expectation | 0/1 = 0.0% (95% CI 0.0–79.3%) |

#### Layer A — deterministic validator only (no model)

| metric | result |
|---|---|
| unsafe drafts accepted (all classes) | 7/17 = 41.2% (95% CI 21.6–64.0%) |
| unsupported-assertion acceptance (new fact / date / number / entity) | 3/6 = 50.0% (95% CI 18.8–81.2%) |
| omission acceptance (dropped existing fact) | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| incorrect-correction acceptance | 2/2 = 100.0% (95% CI 34.2–100.0%) |
| negation/qualifier change acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| scope expansion acceptance | 1/3 = 33.3% (95% CI 6.1–79.2%) |
| certainty increase acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| contradiction acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| ambiguous-reference acceptance | 1/1 = 100.0% (95% CI 20.7–100.0%) |
| evidence-misattribution acceptance | 0/0 (n/a: no cases) |
| safe drafts rejected (false veto, end to end) | 1/8 = 12.5% (95% CI 2.2–47.1%) |
| safe drafts stopped by the deterministic validator | 1/8 = 12.5% (95% CI 2.2–47.1%) |
| [bg] unsafe accepted | 0/3 = 0.0% (95% CI 0.0–56.1%) |
| [bg] safe rejected | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| [en] unsafe accepted | 7/11 = 63.6% (95% CI 35.4–84.8%) |
| [en] safe rejected | 0/5 = 0.0% (95% CI 0.0–43.4%) |
| [mixed] unsafe accepted | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| [mixed] safe rejected | 1/1 = 100.0% (95% CI 20.7–100.0%) |
| [unicode] unsafe accepted | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| [unicode] safe rejected | 0/1 = 0.0% (95% CI 0.0–79.3%) |

#### Layer B — validator + real adapter over mock transport: oracle (plumbing, NOT model quality)

| metric | result |
|---|---|
| unsafe drafts accepted (all classes) | 0/17 = 0.0% (95% CI 0.0–18.4%) |
| unsupported-assertion acceptance (new fact / date / number / entity) | 0/6 = 0.0% (95% CI 0.0–39.0%) |
| omission acceptance (dropped existing fact) | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| incorrect-correction acceptance | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| negation/qualifier change acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| scope expansion acceptance | 0/3 = 0.0% (95% CI 0.0–56.1%) |
| certainty increase acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| contradiction acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| ambiguous-reference acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| evidence-misattribution acceptance | 0/0 (n/a: no cases) |
| safe drafts rejected (false veto, end to end) | 1/8 = 12.5% (95% CI 2.2–47.1%) |
| verifier false-PASS (unsafe drafts that reached it and passed) | 0/7 = 0.0% (95% CI 0.0–35.4%) |
| verifier false-VETO (safe drafts that reached it and were vetoed) | 0/7 = 0.0% (95% CI 0.0–35.4%) |
| verifier unavailable/unreadable (of drafts that reached it) | 0/14 = 0.0% (95% CI 0.0–21.5%) |
| safe drafts stopped by the deterministic validator | 1/8 = 12.5% (95% CI 2.2–47.1%) |
| [bg] unsafe accepted | 0/3 = 0.0% (95% CI 0.0–56.1%) |
| [bg] safe rejected | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| [en] unsafe accepted | 0/11 = 0.0% (95% CI 0.0–25.9%) |
| [en] safe rejected | 0/5 = 0.0% (95% CI 0.0–43.4%) |
| [mixed] unsafe accepted | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| [mixed] safe rejected | 1/1 = 100.0% (95% CI 20.7–100.0%) |
| [unicode] unsafe accepted | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| [unicode] safe rejected | 0/1 = 0.0% (95% CI 0.0–79.3%) |

#### Layer B — validator + real adapter over mock transport: always-pass (plumbing, NOT model quality)

| metric | result |
|---|---|
| unsafe drafts accepted (all classes) | 7/17 = 41.2% (95% CI 21.6–64.0%) |
| unsupported-assertion acceptance (new fact / date / number / entity) | 3/6 = 50.0% (95% CI 18.8–81.2%) |
| omission acceptance (dropped existing fact) | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| incorrect-correction acceptance | 2/2 = 100.0% (95% CI 34.2–100.0%) |
| negation/qualifier change acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| scope expansion acceptance | 1/3 = 33.3% (95% CI 6.1–79.2%) |
| certainty increase acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| contradiction acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| ambiguous-reference acceptance | 1/1 = 100.0% (95% CI 20.7–100.0%) |
| evidence-misattribution acceptance | 0/0 (n/a: no cases) |
| safe drafts rejected (false veto, end to end) | 1/8 = 12.5% (95% CI 2.2–47.1%) |
| verifier false-PASS (unsafe drafts that reached it and passed) | 7/7 = 100.0% (95% CI 64.6–100.0%) |
| verifier false-VETO (safe drafts that reached it and were vetoed) | 0/7 = 0.0% (95% CI 0.0–35.4%) |
| verifier unavailable/unreadable (of drafts that reached it) | 0/14 = 0.0% (95% CI 0.0–21.5%) |
| safe drafts stopped by the deterministic validator | 1/8 = 12.5% (95% CI 2.2–47.1%) |
| [bg] unsafe accepted | 0/3 = 0.0% (95% CI 0.0–56.1%) |
| [bg] safe rejected | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| [en] unsafe accepted | 7/11 = 63.6% (95% CI 35.4–84.8%) |
| [en] safe rejected | 0/5 = 0.0% (95% CI 0.0–43.4%) |
| [mixed] unsafe accepted | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| [mixed] safe rejected | 1/1 = 100.0% (95% CI 20.7–100.0%) |
| [unicode] unsafe accepted | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| [unicode] safe rejected | 0/1 = 0.0% (95% CI 0.0–79.3%) |

#### Layer B — validator + real adapter over mock transport: garbage answers (plumbing, NOT model quality)

| metric | result |
|---|---|
| unsafe drafts accepted (all classes) | 0/17 = 0.0% (95% CI 0.0–18.4%) |
| unsupported-assertion acceptance (new fact / date / number / entity) | 0/6 = 0.0% (95% CI 0.0–39.0%) |
| omission acceptance (dropped existing fact) | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| incorrect-correction acceptance | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| negation/qualifier change acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| scope expansion acceptance | 0/3 = 0.0% (95% CI 0.0–56.1%) |
| certainty increase acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| contradiction acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| ambiguous-reference acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| evidence-misattribution acceptance | 0/0 (n/a: no cases) |
| safe drafts rejected (false veto, end to end) | 8/8 = 100.0% (95% CI 67.6–100.0%) |
| verifier false-PASS (unsafe drafts that reached it and passed) | 0/7 = 0.0% (95% CI 0.0–35.4%) |
| verifier false-VETO (safe drafts that reached it and were vetoed) | 0/7 = 0.0% (95% CI 0.0–35.4%) |
| verifier unavailable/unreadable (of drafts that reached it) | 14/14 = 100.0% (95% CI 78.5–100.0%) |
| safe drafts stopped by the deterministic validator | 1/8 = 12.5% (95% CI 2.2–47.1%) |
| [bg] unsafe accepted | 0/3 = 0.0% (95% CI 0.0–56.1%) |
| [bg] safe rejected | 1/1 = 100.0% (95% CI 20.7–100.0%) |
| [en] unsafe accepted | 0/11 = 0.0% (95% CI 0.0–25.9%) |
| [en] safe rejected | 5/5 = 100.0% (95% CI 56.6–100.0%) |
| [mixed] unsafe accepted | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| [mixed] safe rejected | 1/1 = 100.0% (95% CI 20.7–100.0%) |
| [unicode] unsafe accepted | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| [unicode] safe rejected | 1/1 = 100.0% (95% CI 20.7–100.0%) |

#### Layer B — validator + real adapter over mock transport: endpoint outage (plumbing, NOT model quality)

| metric | result |
|---|---|
| unsafe drafts accepted (all classes) | 0/17 = 0.0% (95% CI 0.0–18.4%) |
| unsupported-assertion acceptance (new fact / date / number / entity) | 0/6 = 0.0% (95% CI 0.0–39.0%) |
| omission acceptance (dropped existing fact) | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| incorrect-correction acceptance | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| negation/qualifier change acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| scope expansion acceptance | 0/3 = 0.0% (95% CI 0.0–56.1%) |
| certainty increase acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| contradiction acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| ambiguous-reference acceptance | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| evidence-misattribution acceptance | 0/0 (n/a: no cases) |
| safe drafts rejected (false veto, end to end) | 8/8 = 100.0% (95% CI 67.6–100.0%) |
| verifier false-PASS (unsafe drafts that reached it and passed) | 0/7 = 0.0% (95% CI 0.0–35.4%) |
| verifier false-VETO (safe drafts that reached it and were vetoed) | 0/7 = 0.0% (95% CI 0.0–35.4%) |
| verifier unavailable/unreadable (of drafts that reached it) | 14/14 = 100.0% (95% CI 78.5–100.0%) |
| safe drafts stopped by the deterministic validator | 1/8 = 12.5% (95% CI 2.2–47.1%) |
| [bg] unsafe accepted | 0/3 = 0.0% (95% CI 0.0–56.1%) |
| [bg] safe rejected | 1/1 = 100.0% (95% CI 20.7–100.0%) |
| [en] unsafe accepted | 0/11 = 0.0% (95% CI 0.0–25.9%) |
| [en] safe rejected | 5/5 = 100.0% (95% CI 56.6–100.0%) |
| [mixed] unsafe accepted | 0/1 = 0.0% (95% CI 0.0–79.3%) |
| [mixed] safe rejected | 1/1 = 100.0% (95% CI 20.7–100.0%) |
| [unicode] unsafe accepted | 0/2 = 0.0% (95% CI 0.0–65.8%) |
| [unicode] safe rejected | 1/1 = 100.0% (95% CI 20.7–100.0%) |

#### Layer C — real model (GPT-6 Luna, same-family review, effort none)

NOT RUN. No verification authorization was granted, no OpenAI credential was used and no paid request was made. No real-model metric is reported.
