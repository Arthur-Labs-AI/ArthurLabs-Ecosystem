#!/usr/bin/env node
// Select thresholds on the DEV split only (non-disputed cases, both random-order reps pooled), then freeze.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadCorpus, noulDecide, choiceDecide, score, RESULTS, DEFAULT_TH } from "./lib.mjs";
const out = join(RESULTS, "thresholds-frozen.json");
if (existsSync(out)) { console.error("thresholds-frozen.json already exists; refusing to re-tune."); process.exit(1); }
const corpus = loadCorpus(); const byId = Object.fromEntries(corpus.cases.map((c) => [c.id, c]));
const raw = JSON.parse(readFileSync(join(RESULTS, "raw-jev-dev.json"), "utf8"));
const recs = raw.records.filter((r) => r.response && byId[r.id].split === "dev" && !byId[r.id].disputed);
const row = (r, d) => ({ id: r.id, expected: byId[r.id].expected, exp_target: byId[r.id].target, decision: d.decision, target: d.target });
const rank = (s) => [s.dangerous_merges_total, -s._correct, -s._acc];
function best(cands, mk) {
  let b = null;
  for (const th of cands) {
    const rows = recs.map((r) => row(r, mk(r, th)));
    const s = score(rows);
    const correctR = rows.filter((x) => x.decision === "REVISE" && x.expected === "REVISE" && x.target === x.exp_target).length;
    const acc = rows.filter((x) => x.decision === x.expected && (x.expected !== "REVISE" || x.target === x.exp_target)).length;
    const k = [s.dangerous_merges_total, -correctR, -acc, -(th.revise ?? 0), -(th.gap ?? th.margin ?? 0)];
    if (!b || k.some((v, i) => (v !== b.k[i] ? (v < b.k[i] ? (b.k.slice(0, i).every((q, j) => q === k[j]) ? (b = null, true) : false) : false) : false)) || !b) { /* handled below */ }
    if (!b || cmp(k, b.k) < 0) b = { th, k, dangerous: s.dangerous_merges_total, correctR, acc, n: rows.length };
  }
  return b;
}
const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const R = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95], G = [0, 0.1, 0.2, 0.3, 0.4, 0.5], A = [0.4, 0.5, 0.6, 0.7], N = [0.1, 0.2, 0.3, 0.4, 0.5];
const noulGrid = []; for (const revise of R) for (const gap of G) for (const ambig of A) for (const nw of N) noulGrid.push({ revise, gap, ambig, new: nw });
const nb = best(noulGrid, (r, th) => noulDecide(r.response.answers, byId[r.id].candidates.length, { noul: th }));
const CR = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99], CM = [0, 0.2, 0.4, 0.6, 0.8], CN = [0.5, 0.6, 0.7, 0.8, 0.9];
const chGrid = []; for (const revise of CR) for (const margin of CM) for (const nw of CN) chGrid.push({ revise, margin, new: nw });
const cb = best(chGrid, (r, th) => choiceDecide(r.response.answers, { choice: th }));
const frozen = { frozen_at: new Date().toISOString(), selection_data: "dev split, non-disputed cases, 2 random-order JEV reps pooled", objective: "min dangerous merges (false merge on NEW/UNCERTAIN + wrong target), then max correct REVISE, then max accuracy, then most conservative", corpus_sha256: corpus.sha256,
  thresholds: { noul: nb.th, choice: cb.th, hybrid: "REVISE only if Noul and Choice both REVISE with the same target; NEW only if both NEW; otherwise UNCERTAIN" },
  dev_fit: { noul: { dangerous: nb.dangerous, correct_revise: nb.correctR, correct: nb.acc, n: nb.n }, choice: { dangerous: cb.dangerous, correct_revise: cb.correctR, correct: cb.acc, n: cb.n } },
  default_before_tuning: DEFAULT_TH };
writeFileSync(out, JSON.stringify(frozen, null, 1));
console.log(JSON.stringify(frozen, null, 1)); console.log("sha256", createHash("sha256").update(JSON.stringify(frozen)).digest("hex"));
