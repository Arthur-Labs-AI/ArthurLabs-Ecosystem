#!/usr/bin/env node
// Offline evaluation with FROZEN thresholds. Writes results/p1b/report-p1b.{md,json}
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { rd, corpus, byId, jevDecisions, baselineDecisions, scoreAll, readings } from "./common.mjs";
import { aggregate, fmtRate, scoreEvent, canon, ledger, RES, PRICES, JEV_PRICE_IN } from "./lib.mjs";
import { DEFAULT_TH } from "./decide.mjs";
const F = rd("frozen.json"), TH = F.thresholds;
const raw = { dev: { jev: rd("raw-jev-dev.json"), bl: rd("raw-baseline-dev.json") }, holdout: { jev: rd("raw-jev-holdout.json"), bl: rd("raw-baseline-holdout.json") } };
const cons = { jev: rd("raw-jev-cons.json"), bl: rd("raw-baseline-cons.json") };
const CFG = [["A  baseline (M04.7A, gpt-4.1-mini + gpt-5-mini)", "A"], ["B  JEV Choice", "B"], ["C  JEV Noul statements", "C"], ["D  JEV hybrid (guards)", "D"], ["B′ Choice, untuned defaults", "B0"], ["C′ Noul, untuned defaults", "C0"], ["D′ hybrid, untuned defaults", "D0"]];
const decs = (split, id, filter) => id === "A" ? baselineDecisions(raw[split].bl, filter) : id.endsWith("0") ? jevDecisions(id[0], raw[split].jev, DEFAULT_TH[id[0]], filter) : jevDecisions(id, raw[split].jev, TH[id], filter);
const L = [], out = (...s) => L.push(...s); const R = { frozen: F, tables: {}, failures: [] };
const filters = { all: () => true, undisputed: (c) => !c.disputed, disputed: (c) => c.disputed };
out("# JEV Phase 1B — Automatic Connections comparative benchmark", "",
  `Corpus \`graph-p1b-1\` sha256 \`${corpus.sha256.slice(0, 16)}…\`: ${corpus.cases.length} events (${corpus.cases.filter((c) => c.split === "dev").length} dev / ${corpus.cases.filter((c) => c.split === "holdout").length} holdout), ${corpus.cases.filter((c) => c.disputed).length} disputed, 22 categories, all seven kinds + NONE. Frozen ${F.frozen_at} before any holdout request. JEV \`jev-1.13.0\`; baseline = production M04.7A prompts/gates ported verbatim (prompt hashes ${JSON.stringify(F.baseline.prompt_hashes.sources)}), Stage A \`gpt-4.1-mini\` (temperature 0), Stage B \`gpt-5-mini\` (reasoning effort low), 1 proposal + 2 votes.`, "",
  "Rates are over unique events (one primary run per event); Wilson 95% CI. Edge precision uses predicted edges as denominator. 'Dangerous' = false edges + wrongful removals + user-edge violations.", "");
const row = (name, a) => `| ${name} | ${a.events} | ${fmtRate(a.strict_precision)} | ${fmtRate(a.semantic_precision)} | ${fmtRate(a.strict_recall)} | ${fmtRate(a.direction_accuracy)} | ${a.false_edges_total} (${a.reversed_edges_admitted} reversed) | ${fmtRate(a.none_correct)} | ${fmtRate(a.stale_retention_unsafe)} | ${fmtRate(a.wrongful_removals)} | ${a.user_edge_violations} | ${a.failed_runs} | **${a.dangerous_total}** |`;
const HEAD = "| Config | Events | Strict precision | Semantic precision | Strict recall | Direction accuracy | False edges | Correct NONE | Stale kept (unsafe) | Wrongful removals | User-edge violations | Failed runs | Dangerous |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|";
for (const split of ["holdout", "dev"]) for (const f of ["undisputed", "disputed", "all"]) {
  if (split === "dev" && f !== "undisputed") continue;
  out(`## ${split === "holdout" ? "Holdout (blind)" : "Dev (thresholds fitted here — optimistic)"} — ${f}`, "", HEAD);
  R.tables[`${split}/${f}`] = {};
  for (const [name, id] of CFG) { const a = aggregate(scoreAll(decs(split, id, filters[f]))); R.tables[`${split}/${f}`][id] = a; out(row(name, a)); }
  out("");
}
// ---- decisions: creation / rejection / revalidation (holdout, undisputed)
out("## Creation, rejection and revalidation, separately (holdout, undisputed)", "", "| Config | Creation: correct edges / gold edges | Creation: false edges | Rejection: NONE events kept clean | Rejection: false admissions | Revalidation: stale removed | Revalidation: stale kept (unsafe) | Revalidation: valid kept / wrongly removed |", "|---|---|---|---|---|---|---|---|");
for (const [name, id] of CFG.slice(0, 4)) { const sc = scoreAll(decs("holdout", id, filters.undisputed)), a = aggregate(sc), sum = (k) => sc.reduce((s, x) => s + x.s[k], 0);
  const keepExp = sum("keep_expected"), wr = sum("wrongful_removals");
  out(`| ${name} | ${sum("recalled_strict")}/${sum("gold_edges")} | ${sum("false_edges")} | ${fmtRate(a.none_correct)} | ${fmtRate(a.none_false_admission)} | ${sum("stale_removed")}/${sum("stale_expected")} | ${sum("stale_retained")}/${sum("stale_expected")} | ${keepExp - wr}/${keepExp} kept, ${wr} wrongly removed |`); }
out("");
// ---- per relation kind
const KINDS = ["related_to", "extends", "depends_on", "contradicts", "derived_from", "duplicates", "supersedes"];
out("## By relation kind (holdout, undisputed): gold edges recovered exactly (kind + direction) / predicted edges of that kind that were correct", "", "| Kind | " + CFG.slice(0, 4).map(([n]) => n.split("  ")[0]).join(" recall | ") + " recall | " + CFG.slice(0, 4).map(([n]) => n.split("  ")[0]).join(" precision | ") + " precision |", "|---|" + "---|".repeat(8));
const perKind = {};
for (const [, id] of CFG.slice(0, 4)) { const sc = scoreAll(decs("holdout", id, filters.undisputed)); const m = {}; for (const k of KINDS) m[k] = { g: 0, tp: 0, p: 0, ptp: 0 };
  for (const { c, d } of sc) { const G = c.gold.add, ok = new Set([...c.gold.add, ...c.gold.acceptable].map(canon)), P = d.add; for (const g of G) { m[g.kind].g++; if (P.some((p) => canon(p) === canon(g))) m[g.kind].tp++; } for (const p of P) { m[p.kind].p++; if (ok.has(canon(p))) m[p.kind].ptp++; } } perKind[id] = m; }
for (const k of KINDS) out(`| ${k} | ` + ["A", "B", "C", "D"].map((id) => `${perKind[id][k].tp}/${perKind[id][k].g}`).join(" | ") + " | " + ["A", "B", "C", "D"].map((id) => `${perKind[id][k].ptp}/${perKind[id][k].p}`).join(" | ") + " |");
R.per_kind = perKind; out("");
// ---- by language and category
function breakdown(label, g, cats) {
  out(`## By ${label} (holdout, undisputed)`, "", "| group | " + CFG.slice(0, 4).map(([n]) => n.split("  ")[0] + ": events / correct-edge recall / false edges / wrongful removals / stale kept").join(" | ") + " |", "|---|---|---|---|---|");
  for (const grp of cats) { const cells = CFG.slice(0, 4).map(([, id]) => { const sc = scoreAll(decs("holdout", id, (c) => !c.disputed && g(c) === grp)); const sum = (k) => sc.reduce((s, x) => s + x.s[k], 0); return `${sc.length} / ${sum("recalled_strict")}/${sum("gold_edges")} / ${sum("false_edges")} / ${sum("wrongful_removals")} / ${sum("stale_retained")}`; }); out(`| ${grp} | ${cells.join(" | ")} |`); }
  out("");
}
breakdown("language", (c) => c.lang, ["en", "bg", "mixed"]);
breakdown("category", (c) => c.category, [...new Set(corpus.cases.map((c) => c.category))]);
// ---- dangerous failures
out("## Dangerous failures on the holdout (every false edge, reversed edge, wrongful removal, user-edge violation; frozen configs only)", "", "| Config | Event | Category | Disputed | Failure | Detail |", "|---|---|---|---|---|---|");
const fmtE = (c, e) => `${e.kind} ${c.objects.find((o) => o.key === e.source).title} → ${c.objects.find((o) => o.key === e.target).title}`;
for (const [name, id] of CFG.slice(0, 4)) for (const { c, d, s } of scoreAll(decs("holdout", id, filters.all))) {
  const tag = name.split("  ")[0];
  for (const e of s.false_edge_list) { const rev = c.gold.add.some((g) => canon(g) === canon({ kind: e.kind, source: e.target, target: e.source })) && !["related_to", "contradicts", "duplicates"].includes(e.kind); out(`| ${tag} | ${c.id} | ${c.category} | ${c.disputed ? "yes" : ""} | ${rev ? "REVERSED edge" : "false edge"} | ${fmtE(c, e)} |`); R.failures.push({ id: c.id, cfg: id, type: rev ? "reversed" : "false_edge" }); }
  if (s.wrongful_removals) { out(`| ${tag} | ${c.id} | ${c.category} | ${c.disputed ? "yes" : ""} | wrongful removal | valid ${c.existing[c.gold.keep[0]].kind} removed |`); R.failures.push({ id: c.id, cfg: id, type: "wrongful_removal" }); }
  if (s.user_violations) out(`| ${tag} | ${c.id} | ${c.category} | | USER EDGE REMOVED | |`);
}
out("");
// ---- stability
function stability() {
  const res = {};
  const groups = (recs, key) => { const g = {}; for (const r of recs) (g[r.id] ??= {})[r.rep] = r; return g; };
  const bl = {}; for (const r of cons.bl.records) (bl[r.id] ??= []).push(r);
  const sig = (d) => JSON.stringify([d.add.map(canon).sort(), [...d.remove].sort(), d.failed ? "F" : ""]);
  const sigStable = (decs) => { const per = {}; for (const { id, d } of decs) (per[id] ??= []).push(sig(d)); const ids = Object.keys(per); return { events: ids.length, identical: ids.filter((i) => new Set(per[i]).size === 1).length, unstable: ids.filter((i) => new Set(per[i]).size > 1) }; };
  res.A = sigStable(cons.bl.records.map((r) => ({ id: r.id, d: { add: r.add, remove: r.remove, failed: r.failed } })));
  for (const cfg of ["B", "C", "D"]) { const all = []; for (const rep of [1, 2, 3]) for (const x of jevDecisions(cfg, cons.jev, TH[cfg], () => true, rep)) all.push({ id: x.c.id, d: x.d }); res[cfg] = sigStable(all); }
  // false edges that persist across repeats
  const persist = {}; 
  for (const cfg of ["A", "B", "C", "D"]) { const fe = {}; const seq = cfg === "A" ? cons.bl.records.map((r) => ({ c: byId[r.id], d: { add: r.add, remove: r.remove } })) : [1, 2, 3].flatMap((rep) => jevDecisions(cfg, cons.jev, TH[cfg], () => true, rep)); for (const { c, d } of seq) { const s = scoreEvent(c, d); if (s.false_edges || s.wrongful_removals) fe[c.id] = (fe[c.id] ?? 0) + 1; } persist[cfg] = fe; }
  res.persisting_dangerous = persist;
  // flips of Choice argmax across option orders (3 random orders)
  const rds = readings(cons.jev); let flips = 0, tot = 0; for (const [id, reps] of Object.entries(rds)) for (const k of Object.keys(reps[1] ?? {})) { const ch = [1, 2, 3].map((r) => reps[r]?.[k]?.lo?.choice).filter(Boolean); if (ch.length === 3) { tot++; if (new Set(ch).size > 1) flips++; } }
  res.choice_argmax_flips_across_orders = `${flips}/${tot} pairs`;
  // baseline contract failures
  res.baseline_failed_runs = cons.bl.records.filter((r) => r.failed).length; return res;
}
R.stability = stability(); out("## Repeatability (44-event stratified subset × 3 runs; JEV with 3 different random option orders; events counted once)", "", "```json", JSON.stringify(R.stability, null, 1), "```", "");
// ---- ops
function ops() {
  const allBl = [raw.dev.bl, raw.holdout.bl, cons.bl].flatMap((r) => r.records), usage = allBl.flatMap((r) => r.usage ?? []);
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const lat = usage.map((u) => u.latency_ms), ev = allBl.filter((r) => !r.failed).map((r) => r.wall_ms);
  const by = {}; for (const u of usage) { (by[u.model] ??= { requests: 0, prompt: 0, completion: 0, reasoning: 0 }); by[u.model].requests++; by[u.model].prompt += u.prompt; by[u.model].completion += u.completion; by[u.model].reasoning += u.reasoning; }
  const cost = Object.entries(by).reduce((s, [m, v]) => s + v.prompt * PRICES[m].in + v.completion * PRICES[m].out, 0);
  const jr = [raw.dev.jev, raw.holdout.jev, cons.jev].flatMap((r) => r.records), jlat = jr.filter((r) => r.response).map((r) => r.latency_ms), jin = jr.reduce((s, r) => s + (r.response?.usage?.input_tokens ?? 0), 0);
  const evBl = (split) => raw[split].bl.records.length;
  return { baseline: { events_run: allBl.length, failed_runs: allBl.filter((r) => r.failed).map((r) => ({ id: r.id, error: r.error })), provider_requests: usage.length, requests_per_event_mean: usage.length / allBl.length, retried_transport: usage.filter((u) => u.attempts > 1).length, per_model: by, per_call_latency_ms: { p50: q(lat, 0.5), p95: q(lat, 0.95), max: Math.max(...lat) }, per_event_wall_ms_sequential: { p50: q(ev, 0.5), p95: q(ev, 0.95), max: Math.max(...ev) }, cost_usd: cost, cost_per_event_usd: cost / allBl.length },
    jev: { requests: jr.length, ok: jr.filter((r) => r.response).length, api_errors: jr.filter((r) => r.error).length, retried: jr.filter((r) => (r.attempts ?? 1) > 1).length, models: [...new Set(jr.filter((r) => r.response).map((r) => r.response.model))], per_request_latency_ms: { p50: q(jlat, 0.5), p95: q(jlat, 0.95), max: Math.max(...jlat) }, input_tokens: jin, output_tokens: jr.reduce((s, r) => s + (r.response?.usage?.output_tokens ?? 0), 0), cost_usd: jin * JEV_PRICE_IN, requests_per_event_mean: jr.length / ([raw.dev.jev, raw.holdout.jev, cons.jev].reduce((s, r) => s + new Set(r.records.map((x) => x.id + "|" + x.rep)).size, 0)) },
    ledger_spent_usd: ledger().spent_usd, budget_usd: 5.0 };
}
R.ops = ops(); out("## Provider performance", "", "```json", JSON.stringify(R.ops, null, 1), "```");
writeFileSync(join(RES, "report-p1b.md"), L.join("\n")); writeFileSync(join(RES, "report-p1b.json"), JSON.stringify(R, null, 1)); console.log("ok");
