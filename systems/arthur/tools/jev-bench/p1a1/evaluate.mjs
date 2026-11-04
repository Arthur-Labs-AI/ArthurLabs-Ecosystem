#!/usr/bin/env node
// Offline evaluation with the FROZEN Phase 1A.1 policy. Writes results/p1a1/report-p1a1.{md,json}
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCorpus1, policy, guardScores, relevantIdx, llmDecide, ci, pct, wilson, RES1, ledger1, noulDecide, choiceDecide, hybridDecide } from "./lib.mjs";
const rd = (n) => JSON.parse(readFileSync(join(RES1, n), "utf8"));
const corpus = loadCorpus1(), by = Object.fromEntries(corpus.cases.map((c) => [c.id, c]));
const F = rd("policy-frozen.json"), TH = F.gate_thresholds_inherited_unchanged_from_p1a, GN = F.guard.noul_redef_block_at_or_above, GC = F.guard.choice_kind_reframing_block_at_or_above;
const raw = { dev: rd("raw-jev-dev.json"), holdout: rd("raw-jev-holdout.json") }, llmC = { dev: rd("raw-openai-class-dev.json"), holdout: rd("raw-openai-class-holdout.json") }, llmG = { dev: rd("raw-openai-guard-dev.json"), holdout: rd("raw-openai-guard-holdout.json") };
const consF = rd("raw-jev-cons-fixed.json"), consR = rd("raw-jev-cons-random.json");
const V = {
  "H0 hybrid (P1A gate)": { base: "hybrid", boundary: false, gn: null, gc: null }, "H1 +project boundary": { base: "hybrid", boundary: true, gn: null, gc: null },
  "H2 +Noul guard": { base: "hybrid", boundary: true, gn: GN, gc: null }, "H3 +Choice guard": { base: "hybrid", boundary: true, gn: null, gc: GC }, "H4 +both guards": { base: "hybrid", boundary: true, gn: GN, gc: GC },
  "C0 Choice only (P1A gate)": { base: "choice", boundary: false, gn: null, gc: null }, "C1 +project boundary": { base: "choice", boundary: true, gn: null, gc: null },
  "C2 +Noul guard": { base: "choice", boundary: true, gn: GN, gc: null }, "C3 +Choice guard": { base: "choice", boundary: true, gn: null, gc: GC }, "C4 +both guards": { base: "choice", boundary: true, gn: GN, gc: GC },
};
const rows = (split, P) => raw[split].records.filter((r) => r.rep === 1).map((r) => ({ id: r.id, ...(r.response ? policy(by[r.id], r.response.answers, P, TH) : { decision: null, target: null }) }));
const llmRows = (split, boundary) => llmC[split].records.map((r) => { const d = r.response ? llmDecide(r.response, by[r.id].candidates.length) : { decision: null }; let o = { id: r.id, decision: d.decision, target: d.target ?? null }; if (boundary && o.decision === "REVISE" && by[r.id].candidates[o.target].project !== by[r.id].new_capture.project) o = { ...o, decision: "NEW", target: null }; return o; });
function metrics(rs, filter = () => true) {
  rs = rs.filter((r) => filter(by[r.id])); const c = (r) => by[r.id];
  const und = rs.filter((r) => !c(r).disputed), dis = rs.filter((r) => c(r).disputed);
  const revCases = und.filter((r) => c(r).expected === "REVISE"), safeCases = und.filter((r) => c(r).expected !== "REVISE");
  const accepted = revCases.filter((r) => r.decision === "REVISE" && r.target === c(r).target), wrongT = revCases.filter((r) => r.decision === "REVISE" && r.target !== c(r).target);
  const clearFM = safeCases.filter((r) => r.decision === "REVISE"), dispMerge = dis.filter((r) => r.decision === "REVISE" && c(r).expected !== "REVISE");
  const rf = und.filter((r) => c(r).reframing), rfD = dis.filter((r) => c(r).reframing);
  return { n: rs.length, clear_false_merges: ci(clearFM.length, safeCases.length), clear_false_merge_ids: clearFM.map((r) => r.id), wrong_target: ci(wrongT.length, revCases.length), accepted_revisions: ci(accepted.length, revCases.length), missed_revisions: ci(revCases.length - accepted.length, revCases.length),
    disputed_merges: ci(dispMerge.length, dis.length), disputed_merge_ids: dispMerge.map((r) => r.id), reframing_merged_undisputed: ci(rf.filter((r) => r.decision === "REVISE").length, rf.length), reframing_merged_disputed: ci(rfD.filter((r) => r.decision === "REVISE").length, rfD.length),
    errors: rs.filter((r) => r.decision == null).length, _k: { clearFM: clearFM.length, wrongT: wrongT.length, accepted: accepted.length, rev: revCases.length, safe: safeCases.length, disp: dis.length, dispMerge: dispMerge.length } };
}
const R = { frozen: F, results: {}, guard: {}, breakdown: {} }, L = []; const out = (...s) => L.push(...s);
out("# JEV Phase 1A.1 — Reframing Guard Evaluation", "", `Corpus \`identity-p1a1-1\` sha256 \`${corpus.sha256.slice(0, 16)}…\`: ${corpus.cases.length} fresh cases (${corpus.cases.filter((c) => c.split === "dev").length} dev / ${corpus.cases.filter((c) => c.split === "holdout").length} holdout), ${corpus.cases.filter((c) => c.disputed).length} disputed, ${corpus.cases.filter((c) => c.reframing).length} reframing. Policy frozen ${F.frozen_at} before any holdout request. Gate thresholds are Phase 1A's, unchanged. Guard thresholds: Noul redefine ≥ ${GN}, Choice reframing ≥ ${GC}.`, "", "All rates are over unique scenarios (first request per case), Wilson 95% CI. Undisputed and disputed cases are reported separately.", "");
for (const split of ["holdout", "dev"]) {
  R.results[split] = {};
  out(`## ${split === "holdout" ? "Holdout (blind)" : "Dev (guard thresholds fitted here)"}`, "", "| Policy | Clear false merges (undisputed NEW/UNCERTAIN) | Wrong target | Accepted revisions | Missed revisions | Disputed merged | Reframing merged (undisputed) | Reframing merged (disputed) |", "|---|---|---|---|---|---|---|---|");
  for (const [name, P] of Object.entries(V)) { const m = metrics(rows(split, P)); R.results[split][name] = m; out(`| ${name} | ${m.clear_false_merges} | ${m.wrong_target} | ${m.accepted_revisions} | ${m.missed_revisions} | ${m.disputed_merges} | ${m.reframing_merged_undisputed} | ${m.reframing_merged_disputed} |`); }
  for (const [name, b] of [["D gpt-4.1-mini", false], ["D+boundary", true]]) { const m = metrics(llmRows(split, b)); R.results[split][name] = m; out(`| ${name} | ${m.clear_false_merges} | ${m.wrong_target} | ${m.accepted_revisions} | ${m.missed_revisions} | ${m.disputed_merges} | ${m.reframing_merged_undisputed} | ${m.reframing_merged_disputed} |`); }
  out("");
}
out("### Cases merged by a policy where the label says otherwise (holdout)", "", "| Policy | Clear false merges | Disputed merges |", "|---|---|---|");
for (const [name, m] of Object.entries(R.results.holdout)) out(`| ${name} | ${m.clear_false_merge_ids.join(", ") || "–"} | ${m.disputed_merge_ids.join(", ") || "–"} |`);
out("");
// ---- guard as a classifier
function guardEval(split) {
  const recs = raw[split].records.filter((r) => r.rep === 1 && r.response && relevantIdx(by[r.id]) != null);
  const g = (r) => guardScores(r.response.answers, relevantIdx(by[r.id]));
  const llm = Object.fromEntries(llmG[split].records.filter((r) => r.response).map((r) => { try { return [r.id, !!JSON.parse(r.response.choices[0].message.content).redefines]; } catch { return [r.id, null]; } }));
  const res = {};
  for (const [label, filt] of [["undisputed", (c) => !c.disputed], ["disputed", (c) => c.disputed], ["all", () => true]]) {
    const pos = recs.filter((r) => by[r.id].reframing && filt(by[r.id])), neg = recs.filter((r) => by[r.id].expected === "REVISE" && filt(by[r.id]));
    const auc = (k) => { if (!pos.length || !neg.length) return null; let w = 0, t = 0; for (const p of pos) for (const n of neg) { t++; const a = g(p)[k], b = g(n)[k]; w += a > b ? 1 : a === b ? 0.5 : 0; } return w / t; };
    const rate = (set, f) => ci(set.filter(f).length, set.length);
    res[label] = { n_reframing: pos.length, n_detail_revisions: neg.length, noul_sensitivity: rate(pos, (r) => g(r).redef >= GN), noul_false_alarm: rate(neg, (r) => g(r).redef >= GN), noul_auc: auc("redef"),
      choice_sensitivity: rate(pos, (r) => g(r).kindReframing >= GC), choice_false_alarm: rate(neg, (r) => g(r).kindReframing >= GC), choice_auc: auc("kindReframing"),
      either_sensitivity: rate(pos, (r) => g(r).redef >= GN || g(r).kindReframing >= GC), either_false_alarm: rate(neg, (r) => g(r).redef >= GN || g(r).kindReframing >= GC),
      llm_sensitivity: rate(pos, (r) => llm[r.id] === true), llm_false_alarm: rate(neg, (r) => llm[r.id] === true) };
  }
  return res;
}
R.guard = { holdout: guardEval("holdout"), dev: guardEval("dev") };
out("## Reframing guard as a classifier (candidate = the target idea; reframing=true vs correct-target REVISE cases)", "");
for (const split of ["holdout", "dev"]) for (const lab of ["undisputed", "disputed"]) { const g = R.guard[split][lab]; out(`**${split} / ${lab}** (reframing n=${g.n_reframing}, detail-revisions n=${g.n_detail_revisions})`, "", "| Guard | Sensitivity (reframing caught) | False alarm (valid revision blocked) | AUC |", "|---|---|---|---|", `| Noul redefine ≥ ${GN} | ${g.noul_sensitivity} | ${g.noul_false_alarm} | ${g.noul_auc?.toFixed(3) ?? "n/a"} |`, `| Choice reframing ≥ ${GC} | ${g.choice_sensitivity} | ${g.choice_false_alarm} | ${g.choice_auc?.toFixed(3) ?? "n/a"} |`, `| Either | ${g.either_sensitivity} | ${g.either_false_alarm} | – |`, `| gpt-4.1-mini yes/no (exploratory) | ${g.llm_sensitivity} | ${g.llm_false_alarm} | – |`, ""); }
// post-hoc robustness sweep (NOT used for selection)
out("### Post-hoc threshold robustness on holdout (undisputed; not used to select anything)", "", "| threshold | Noul sens | Noul false alarm | Choice sens | Choice false alarm |", "|---|---|---|---|---|");
{ const recs = raw.holdout.records.filter((r) => r.rep === 1 && r.response && relevantIdx(by[r.id]) != null && !by[r.id].disputed); const g = (r) => guardScores(r.response.answers, relevantIdx(by[r.id])); const pos = recs.filter((r) => by[r.id].reframing), neg = recs.filter((r) => by[r.id].expected === "REVISE");
  for (const t of [0.3, 0.5, 0.7, 0.8, 0.9, 0.95]) out(`| ${t} | ${pct(pos.filter((r) => g(r).redef >= t).length / pos.length)} | ${pct(neg.filter((r) => g(r).redef >= t).length / neg.length)} | ${pct(pos.filter((r) => g(r).kindReframing >= t).length / pos.length)} | ${pct(neg.filter((r) => g(r).kindReframing >= t).length / neg.length)} |`); }
out("");
// ---- breakdowns for H4 and C4 and gpt
const bdPolicies = { "H4 +both guards": (s) => rows(s, V["H4 +both guards"]), "C4 +both guards": (s) => rows(s, V["C4 +both guards"]), "H0 hybrid (P1A gate)": (s) => rows(s, V["H0 hybrid (P1A gate)"]), "D gpt-4.1-mini": (s) => llmRows(s, false) };
out("## Holdout breakdowns", "");
for (const [label, g] of [["Language", (c) => c.lang], ["Category", (c) => c.category], ["Candidates", (c) => (c.candidates.length > 1 ? "multi-candidate" : "single-candidate")]]) {
  out(`### By ${label}`, "", "| group | policy | n | clear false merges | wrong target | accepted / revisions | disputed merged |", "|---|---|---|---|---|---|---|");
  for (const grp of [...new Set(corpus.cases.map(g))].sort()) for (const [name, f] of Object.entries(bdPolicies)) { const m = metrics(f("holdout"), (c) => g(c) === grp); if (!m.n) continue; out(`| ${grp} | ${name} | ${m.n} | ${m.clear_false_merges} | ${m.wrong_target} | ${m._k.accepted}/${m._k.rev} | ${m.disputed_merges} |`); }
  out("");
}
// ---- consistency
const same = (a) => new Set(a).size === 1; const groups = {};
for (const r of consF.records.filter((x) => x.response)) (groups[r.id] ??= { f: [], r: [] }).f.push(r);
for (const r of consR.records.filter((x) => x.response)) (groups[r.id] ??= { f: [], r: [] }).r.push(r);
const cons = { cases: Object.keys(groups).length, per_policy: {}, guard_drift: {}, persisted_bad: [] };
for (const [name, P] of Object.entries({ "H0": V["H0 hybrid (P1A gate)"], "H4": V["H4 +both guards"], "C4": V["C4 +both guards"] })) {
  let f = 0, a = 0; const unstable = [];
  for (const [id, g] of Object.entries(groups)) { const k = (r) => { const d = policy(by[id], r.response.answers, P, TH); return `${d.decision}:${d.target ?? ""}`; }; const fk = g.f.map(k), all = [...fk, ...g.r.map(k)]; if (same(fk)) f++; if (same(all)) a++; else unstable.push(id);
    const bad = all.filter((s) => s.startsWith("REVISE") && (by[id].expected !== "REVISE" || s !== `REVISE:${by[id].target}`)).length; if (bad) cons.persisted_bad.push({ policy: name, id, expected: by[id].expected, disputed: by[id].disputed, bad_reps: `${bad}/6` }); }
  cons.per_policy[name] = { identical_3_fixed: f, identical_all_6: a, unstable };
}
let dr = 0, dk = 0; for (const [id, g] of Object.entries(groups)) { const i = relevantIdx(by[id]); if (i == null) continue; const v = g.f.map((r) => guardScores(r.response.answers, i)); dr = Math.max(dr, Math.max(...v.map((x) => x.redef)) - Math.min(...v.map((x) => x.redef))); dk = Math.max(dk, Math.max(...v.map((x) => x.kindReframing)) - Math.min(...v.map((x) => x.kindReframing))); }
cons.guard_drift = { max_redef_range_fixed_order: dr, max_kind_reframing_range_fixed_order: dk };
R.consistency = cons; out("## Stability (36-case stratified subset; 3 fixed-order + 3 random-order repeats; not used for rates above)", "", "```json", JSON.stringify(cons, null, 1), "```", "");
// ---- ops
function ops(raws, kind) { const recs = raws.flatMap((r) => r.records), ok = recs.filter((r) => r.response), lat = ok.map((r) => r.latency_ms).sort((a, b) => a - b), q = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
  const tin = ok.reduce((s, r) => s + ((kind === "jev" ? r.response.usage?.input_tokens : r.response.usage?.prompt_tokens) ?? 0), 0), tout = ok.reduce((s, r) => s + ((kind === "jev" ? r.response.usage?.output_tokens : r.response.usage?.completion_tokens) ?? 0), 0);
  return { requests: recs.length, ok: ok.length, api_errors: recs.filter((r) => r.error).length, retried: recs.filter((r) => (r.attempts ?? 1) > 1).length, models: [...new Set(ok.map((r) => r.response.model))], latency_ms: { p50: q(0.5), p95: q(0.95), max: lat[lat.length - 1] }, input_tokens: tin, output_tokens: tout, cost_usd: kind === "jev" ? tin * 0.042e-6 : tin * 0.4e-6 + tout * 1.6e-6 }; }
const schemaErr = [...raw.dev.records, ...raw.holdout.records].filter((r) => r.response && (noulDecide(r.response.answers, by[r.id].candidates.length, TH).decision == null || choiceDecide(r.response.answers, TH).decision == null || by[r.id].candidates.some((_, i) => guardScores(r.response.answers, i).redef == null || guardScores(r.response.answers, i).kindReframing == null))).length;
R.ops = { jev: { ...ops([raw.dev, raw.holdout, consF, consR], "jev"), schema_errors: schemaErr }, openai: ops([llmC.dev, llmC.holdout, llmG.dev, llmG.holdout], "llm"), ledger_spent_usd: ledger1().spent_usd, budget_usd: 0.25 };
out("## Provider performance", "", "```json", JSON.stringify(R.ops, null, 1), "```");
writeFileSync(join(RES1, "report-p1a1.md"), L.join("\n")); writeFileSync(join(RES1, "report-p1a1.json"), JSON.stringify(R, null, 1)); console.log("ok");
