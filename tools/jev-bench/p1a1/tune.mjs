#!/usr/bin/env node
// Choose guard thresholds on the new DEV split only, then freeze the whole policy. P1A gate thresholds are inherited UNCHANGED.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadCorpus1, guardScores, relevantIdx, P1A_FROZEN, GUARD_OBJECTIVE, RES1, wilson } from "./lib.mjs";
const out = join(RES1, "policy-frozen.json"); if (existsSync(out)) { console.error("already frozen"); process.exit(1); }
const corpus = loadCorpus1(), by = Object.fromEntries(corpus.cases.map((c) => [c.id, c]));
const dev = JSON.parse(readFileSync(join(RES1, "raw-jev-dev.json"), "utf8")).records.filter((r) => r.rep === 1 && r.response && !by[r.id].disputed && relevantIdx(by[r.id]) != null);
const pos = dev.filter((r) => by[r.id].reframing), neg = dev.filter((r) => by[r.id].expected === "REVISE");
const sc = (r, k) => guardScores(r.response.answers, relevantIdx(by[r.id]))[k];
const auc = (k) => { let w = 0, t = 0; for (const p of pos) for (const n of neg) { t++; w += sc(p, k) > sc(n, k) ? 1 : sc(p, k) === sc(n, k) ? 0.5 : 0; } return w / t; };
function pick(k) {
  const grid = []; for (let t = 0.05; t <= 0.951; t += 0.05) grid.push(+t.toFixed(2));
  const rows = grid.map((t) => ({ t, sens: pos.filter((r) => sc(r, k) >= t).length / pos.length, fpr: neg.filter((r) => sc(r, k) >= t).length / neg.length }));
  const ok = rows.filter((r) => r.fpr <= 0.2); if (!ok.length) return { t: null, rows };
  const best = Math.max(...ok.map((r) => r.sens)); const tied = ok.filter((r) => r.sens === best); return { t: tied[tied.length - 1].t, rows, best };
}
const gn = pick("redef"), gc = pick("kindReframing");
const frozen = { frozen_at: new Date().toISOString(), corpus_sha256: corpus.sha256, objective: GUARD_OBJECTIVE,
  gate_thresholds_inherited_unchanged_from_p1a: P1A_FROZEN(), project_boundary: "a REVISE whose target candidate is in a different Project than the capture becomes NEW",
  guard: { noul_redef_block_at_or_above: gn.t, choice_kind_reframing_block_at_or_above: gc.t },
  dev_guard_fit: { n_reframing: pos.length, n_correct_revise: neg.length, auc_noul_redef: auc("redef"), auc_choice_reframing: auc("kindReframing"), noul_rows: gn.rows, choice_rows: gc.rows } };
writeFileSync(out, JSON.stringify(frozen, null, 1));
console.log(JSON.stringify({ gn: gn.t, gc: gc.t, auc: [frozen.dev_guard_fit.auc_noul_redef, frozen.dev_guard_fit.auc_choice_reframing], pos: pos.length, neg: neg.length }));
console.table(gn.rows.map((r) => ({ t: r.t, noul_sens: r.sens.toFixed(2), noul_fpr: r.fpr.toFixed(2), ...Object.fromEntries([["ch_sens", gc.rows.find((x) => x.t === r.t).sens.toFixed(2)], ["ch_fpr", gc.rows.find((x) => x.t === r.t).fpr.toFixed(2)]]) })));
