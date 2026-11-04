#!/usr/bin/env node
// Offline, deterministic evaluation of saved Phase 1A responses with the FROZEN thresholds. Writes results/p1a/report-p1a.{md,json}
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCorpus, noulDecide, choiceDecide, hybridDecide, llmDecide, score, ci, pct, RESULTS, DEFAULT_TH, ledger } from "./lib.mjs";
const rd = (n) => JSON.parse(readFileSync(join(RESULTS, n), "utf8"));
const corpus = loadCorpus(), byId = Object.fromEntries(corpus.cases.map((c) => [c.id, c]));
const FROZEN = rd("thresholds-frozen.json"); const TH = FROZEN.thresholds, DEF = DEFAULT_TH;
const jevDev = rd("raw-jev-dev.json"), jevHold = rd("raw-jev-holdout.json"), llmDev = rd("raw-openai-dev.json"), llmHold = rd("raw-openai-holdout.json");
const consF = rd("raw-jev-cons-fixed.json"), consR = rd("raw-jev-cons-random.json"), consL = rd("raw-openai-cons.json");

function decideAll(rec, th) {
  const c = byId[rec.id], n = noulDecide(rec.response.answers, c.candidates.length, th), ch = choiceDecide(rec.response.answers, th);
  return { noul: n, choice: ch, hybrid: hybridDecide(n, ch) };
}
const mkRow = (id, d) => ({ id, expected: byId[id].expected, exp_target: byId[id].target, decision: d.decision, target: d.target ?? null });
function rowsFor(raw, mech, th, { rep1 = true } = {}) {
  return raw.records.filter((r) => (!rep1 || r.rep === 1)).map((r) => r.response ? mkRow(r.id, decideAll(r, th)[mech]) : { ...mkRow(r.id, { decision: null }) });
}
const llmRows = (raw) => raw.records.map((r) => mkRow(r.id, r.response ? llmDecide(r.response, byId[r.id].candidates.length) : { decision: null }));
const STRATS = {
  "A. Noul (frozen)": (s) => rowsFor(s.jev, "noul", TH),
  "B. Choice, random order (frozen)": (s) => rowsFor(s.jev, "choice", TH),
  "C. Hybrid (frozen)": (s) => rowsFor(s.jev, "hybrid", TH),
  "A'. Noul (Phase 0 default)": (s) => rowsFor(s.jev, "noul", DEF),
  "B'. Choice (default)": (s) => rowsFor(s.jev, "choice", DEF),
  "C'. Hybrid (default)": (s) => rowsFor(s.jev, "hybrid", DEF),
  "D. gpt-4.1-mini (temp 0)": (s) => llmRows(s.llm),
};
const sets = { dev: { jev: jevDev, llm: llmDev }, holdout: { jev: jevHold, llm: llmHold } };
const R = { frozen: FROZEN, corpus: { sha256: corpus.sha256, n: corpus.cases.length }, results: {}, breakdown: {}, failures: [], consistency: {}, ops: {} };
const L = [];
const out = (...s) => L.push(...s);
const keep = (rows, f) => rows.filter((r) => f(byId[r.id]));
for (const split of ["holdout", "dev"]) {
  for (const subset of ["all", "undisputed"]) {
    R.results[`${split}/${subset}`] = {};
    for (const [name, f] of Object.entries(STRATS)) {
      let rows = f(sets[split]); if (subset === "undisputed") rows = keep(rows, (c) => !c.disputed);
      R.results[`${split}/${subset}`][name] = score(rows);
    }
  }
}
// ---- headline tables
out("# JEV Phase 1A — Blind Identity Resolution Benchmark", "", `Corpus \`identity-p1a-1\` sha256 \`${corpus.sha256.slice(0, 16)}…\` (${corpus.cases.length} cases, ${corpus.cases.filter((c) => c.split === "dev").length} dev / ${corpus.cases.filter((c) => c.split === "holdout").length} holdout, ${corpus.cases.filter((c) => c.disputed).length} disputed). Thresholds frozen ${FROZEN.frozen_at} before any holdout request. Models: \`jev-1.13.0\`, \`gpt-4.1-mini-2025-04-14\`.`, "", "Intervals are Wilson 95% over unique cases (one primary request per case; repeats are excluded from these rates).", "");
for (const key of ["holdout/all", "holdout/undisputed", "dev/all", "dev/undisputed"]) {
  out(`## ${key}${key.startsWith("dev") ? " (thresholds were fitted here — optimistic, for reference only)" : " (blind)"}`, "", "| Strategy | n | Accuracy | False merge on NEW | False merge on UNCERTAIN | Wrong target | Dangerous total | REVISE prec. | REVISE recall | NEW prec. | UNCERTAIN recall |", "|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [name, s] of Object.entries(R.results[key])) out(`| ${name} | ${s.n} | ${s.accuracy} | ${s.false_merge_on_new} | ${s.false_merge_on_uncertain} | ${s.wrong_target} | **${s.dangerous_merges_total}** | ${s.revise_precision} | ${s.revise_recall} | ${s.new_precision} | ${s.uncertain_recall} |`);
  out("");
}
// ---- confusion (holdout/all)
out("## Holdout confusion matrices (all cases; rows expected, cols predicted)", "");
for (const [name, s] of Object.entries(R.results["holdout/all"])) { out(`**${name}**`, "", "| exp \\ pred | REVISE | NEW | UNCERTAIN | ERROR |", "|---|---|---|---|---|"); for (const e of ["REVISE", "NEW", "UNCERTAIN"]) { const m = s.confusion[e]; out(`| ${e} | ${m.REVISE} | ${m.NEW} | ${m.UNCERTAIN} | ${m.ERROR} |`); } out(""); }
// ---- failures (holdout + dev), every dangerous merge for every strategy
out("## Dangerous merges (predicted REVISE where expected NEW/UNCERTAIN, or REVISE with wrong target)", "");
out("| split | strategy | case | cat | lang | disputed | expected | predicted | Noul scores | Choice probs | candidates → capture |", "|---|---|---|---|---|---|---|---|---|---|---|");
for (const split of ["holdout", "dev"]) {
  const jev = sets[split].jev;
  for (const [name, f] of Object.entries(STRATS)) {
    for (const row of f(sets[split])) {
      const c = byId[row.id];
      const bad = row.decision === "REVISE" && (c.expected !== "REVISE" || row.target !== c.target);
      if (!bad) continue;
      const rec = jev.records.find((r) => r.id === row.id && r.rep === 1); const a = rec?.response?.answers;
      const sc = a ? c.candidates.map((_, i) => a[`same_idea_${i}`]?.noul?.toFixed(2)).join("/") : "";
      const pr = a ? Object.entries(a.relation.probabilities).filter(([, v]) => v >= 0.05).map(([k, v]) => `${k}:${v}`).join(" ") : "";
      R.failures.push({ split, strategy: name, id: row.id, expected: c.expected, exp_target: c.target, predicted_target: row.target });
      if (name.startsWith("A'") || name.startsWith("B'") || name.startsWith("C'")) continue; // default-threshold rows only in JSON
      out(`| ${split} | ${name} | ${row.id} | ${c.category} | ${c.lang} | ${c.disputed ? "yes" : ""} | ${c.expected}${c.target != null ? "→" + c.target : ""} | REVISE→${row.target} | ${name.startsWith("D") ? "n/a" : sc} | ${name.startsWith("D") ? "n/a" : pr} | ${c.candidates.map((x) => x.text).join(" ‖ ")} → ${c.new_capture.text} |`);
    }
  }
}
out("");
// ---- breakdowns on holdout
function bd(label, groupFn) {
  out(`### ${label}`, "", "| group | strategy | n | accuracy | dangerous merges |", "|---|---|---|---|---|");
  const groups = [...new Set(corpus.cases.map(groupFn))].sort();
  for (const g of groups) for (const name of ["A. Noul (frozen)", "B. Choice, random order (frozen)", "C. Hybrid (frozen)", "D. gpt-4.1-mini (temp 0)"]) {
    const rows = keep(STRATS[name](sets.holdout), (c) => groupFn(c) === g); if (!rows.length) continue; const s = score(rows);
    out(`| ${g} | ${name} | ${s.n} | ${s.accuracy} | ${s.dangerous_merges_total} |`);
  }
  out("");
}
out("## Holdout breakdowns", "");
bd("By language", (c) => c.lang); bd("By category", (c) => c.category);
bd("Single vs multi-candidate", (c) => (c.candidates.length > 1 ? "multi-candidate" : "single-candidate"));
// ---- multi-candidate identity: target accuracy on REVMC + ambiguity handling
out("## Multi-candidate identity (holdout)", "");
out("| strategy | REVMC: correct target | REVMC: wrongly UNCERTAIN/NEW | AMBREF+TWOFIT (multi-cand UNCERTAIN): REVISE-merged | resolved UNCERTAIN |", "|---|---|---|---|---|");
for (const name of ["A. Noul (frozen)", "B. Choice, random order (frozen)", "C. Hybrid (frozen)", "D. gpt-4.1-mini (temp 0)", "A'. Noul (Phase 0 default)", "B'. Choice (default)", "C'. Hybrid (default)"]) {
  const rm = keep(STRATS[name](sets.holdout), (c) => c.category === "REVMC");
  const ok = rm.filter((r) => r.decision === "REVISE" && r.target === byId[r.id].target).length, wrongT = rm.filter((r) => r.decision === "REVISE" && r.target !== byId[r.id].target).length, miss = rm.filter((r) => r.decision !== "REVISE").length;
  const am = keep(STRATS[name](sets.holdout), (c) => (c.category === "AMBREF" || c.category === "TWOFIT") && c.candidates.length > 1);
  out(`| ${name} | ${ci(ok, rm.length)} (wrong target ${wrongT}) | ${miss} | ${am.filter((r) => r.decision === "REVISE").length}/${am.length} | ${am.filter((r) => r.decision === "UNCERTAIN").length}/${am.length} |`);
}
out("");
// top-two ambiguity analysis (all cases with >=2 candidates, rep1, dev+holdout) — Noul scores
out("### Noul top-two gap by true label (multi-candidate cases, all splits, first request)", "", "| expected | n | top1 median | top2 median | gap median | cases where top-1 would be the correct target | ≥2 candidates ≥0.8 |", "|---|---|---|---|---|---|---|");
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)].toFixed(2) : "n/a"; };
for (const e of ["REVISE", "NEW", "UNCERTAIN"]) {
  const t = []; for (const raw of [jevDev, jevHold]) for (const r of raw.records.filter((x) => x.rep === 1 && x.response && byId[x.id].candidates.length > 1 && byId[x.id].expected === e)) { const d = noulDecide(r.response.answers, byId[r.id].candidates.length, TH); const idx = d.scores.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]); t.push({ ...d, argTop: idx[0][1], id: r.id }); }
  out(`| ${e} | ${t.length} | ${med(t.map((x) => x.top1))} | ${med(t.map((x) => x.top2))} | ${med(t.map((x) => x.gap))} | ${e === "REVISE" ? t.filter((x) => x.argTop === byId[x.id].target).length + "/" + t.length : "n/a (no target)"} | ${t.filter((x) => x.scores.filter((s) => s >= 0.8).length >= 2).length} |`);
}
out("");
// ---- consistency
function consistency() {
  const groups = {}; // id -> fixed reps, random reps
  for (const r of consF.records.filter((x) => x.response)) (groups[r.id] ??= { f: [], r: [] }).f.push(r);
  for (const r of consR.records.filter((x) => x.response)) (groups[r.id] ??= { f: [], r: [] }).r.push(r);
  const res = {}; const same = (arr) => new Set(arr).size === 1;
  for (const mech of ["noul", "choice", "hybrid"]) {
    let fixedSame = 0, randSame = 0, allSame = 0, tot = 0, dispAmong = 0; const flips = [];
    let maxNoul = 0, maxProb = 0, exact = 0;
    for (const [id, g] of Object.entries(groups)) {
      tot++; const key = (r) => { const d = decideAll(r, TH)[mech]; return `${d.decision}:${d.target ?? ""}`; };
      const fk = g.f.map(key), rk = g.r.map(key);
      if (same(fk)) fixedSame++; if (same(rk)) randSame++; if (same([...fk, ...rk])) allSame++; else flips.push(id);
      if (mech === "noul") for (let i = 0; i < byId[id].candidates.length; i++) { const v = g.f.map((r) => r.response.answers[`same_idea_${i}`].noul); maxNoul = Math.max(maxNoul, Math.max(...v) - Math.min(...v)); }
      if (mech === "choice") { const ks = Object.keys(g.f[0].response.answers.relation.probabilities); for (const k of ks) { const v = g.f.map((r) => r.response.answers.relation.probabilities[k]); maxProb = Math.max(maxProb, Math.max(...v) - Math.min(...v)); } }
      if (mech === "noul" && g.f.every((r) => JSON.stringify(r.response.answers) === JSON.stringify(g.f[0].response.answers))) exact++;
    }
    res[mech] = { cases: tot, identical_across_3_fixed_order: fixedSame, identical_across_3_random_orders: randSame, identical_across_all_6: allSame, unstable_cases: flips, ...(mech === "noul" ? { max_score_drift_fixed_order: maxNoul, bit_identical_cases_fixed: exact } : {}), ...(mech === "choice" ? { max_prob_drift_fixed_order: maxProb } : {}) };
  }
  // persistence of false merges under repeats
  const persist = [];
  for (const [id, g] of Object.entries(groups)) for (const mech of ["noul", "choice", "hybrid"]) {
    const c = byId[id]; const ds = [...g.f, ...g.r].map((r) => decideAll(r, TH)[mech]); const bad = ds.filter((d) => d.decision === "REVISE" && (c.expected !== "REVISE" || d.target !== c.target));
    if (bad.length) persist.push({ id, mech, expected: c.expected, bad_reps: `${bad.length}/${ds.length}`, disputed: c.disputed });
  }
  res.false_merges_in_repeats = persist;
  // noul vs choice disagreement (frozen decisions) and option-order effect
  let dis = 0, totc = 0; const dl = [];
  for (const r of [...consF.records, ...consR.records].filter((x) => x.response)) { totc++; const d = decideAll(r, TH); if (d.noul.decision !== d.choice.decision || d.noul.target !== d.choice.target) { dis++; dl.push(r.id); } }
  res.noul_vs_choice = { requests: totc, disagreements: dis, cases: [...new Set(dl)] };
  // choice argmax fixed vs random
  let flip = 0, pairs = 0; for (const g of Object.values(groups)) { const fa = g.f[0].response.answers.relation, base = (a) => (a.choice.startsWith("revise") ? "revise" : a.choice); const fk = g.f.map((r) => r.response.answers.relation.choice); for (const r of g.r) { pairs++; if (r.response.answers.relation.choice !== fk[0]) flip++; } }
  res.choice_argmax_changed_by_random_order = `${flip}/${pairs} requests differ from the fixed-order answer`;
  // LLM consistency
  const lg = {}; for (const r of consL.records.filter((x) => x.response)) (lg[r.id] ??= []).push(`${JSON.stringify(llmDecide(r.response, byId[r.id].candidates.length))}`);
  res.llm = { cases: Object.keys(lg).length, identical_across_3: Object.values(lg).filter(same).length };
  return res;
}
R.consistency = consistency(); const C = R.consistency;
out("## Consistency (48-case stratified subset: 3 identical fixed-order repeats + 3 random-order repeats; not used in the rates above)", "", "```json", JSON.stringify(C, null, 1), "```", "");
// ---- ops
function ops(label, raws, kind) {
  const recs = raws.flatMap((r) => r.records); const ok = recs.filter((r) => r.response); const lat = ok.map((r) => r.latency_ms).sort((a, b) => a - b);
  const q = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
  const tin = ok.reduce((s, r) => s + (kind === "jev" ? r.response.usage?.input_tokens : r.response.usage?.prompt_tokens) ?? 0, 0), tout = ok.reduce((s, r) => s + ((kind === "jev" ? r.response.usage?.output_tokens : r.response.usage?.completion_tokens) ?? 0), 0);
  const models = [...new Set(ok.map((r) => r.response.model))];
  const llmSchema = kind === "llm" ? recs.filter((r) => r.response && llmDecide(r.response, byId[r.id].candidates.length).decision == null).length : ok.filter((r) => { const d = decideAll(r, TH); return d.noul.decision == null || d.choice.decision == null; }).length;
  return { requests: recs.length, ok: ok.length, api_errors: recs.filter((r) => r.error).map((r) => ({ id: r.id, error: r.error })), schema_errors: llmSchema, retried: recs.filter((r) => (r.attempts ?? 1) > 1).length, models, latency_ms: { p50: q(0.5), p95: q(0.95), max: lat[lat.length - 1] }, input_tokens: tin, output_tokens: tout, cost_usd: kind === "jev" ? tin * 0.042e-6 : tin * 0.4e-6 + tout * 1.6e-6 };
}
R.ops = { jev: ops("jev", [jevDev, jevHold, consF, consR], "jev"), llm: ops("llm", [llmDev, llmHold, consL], "llm"), ledger_spent_usd: ledger().spent_usd, budget_usd: 1.0 };
out("## Provider performance", "", "```json", JSON.stringify(R.ops, null, 1), "```", "");
writeFileSync(join(RESULTS, "report-p1a.md"), L.join("\n")); writeFileSync(join(RESULTS, "report-p1a.json"), JSON.stringify(R, null, 1));
console.log("ok");
