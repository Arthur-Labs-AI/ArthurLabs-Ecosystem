// Extra offline analyses (no new API calls): first-stage filter coverage and agreement between baseline and hybrid. Holdout, undisputed.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { rd, corpus, byId, readings, jevDecisions, baselineDecisions } from "./common.mjs";
import { canon, RES } from "./lib.mjs";
const F = rd("frozen.json").thresholds, raw = rd("raw-jev-holdout.json"), bl = rd("raw-baseline-holdout.json"), rds = readings(raw);
const und = (c) => c.split === "holdout" && !c.disputed;
let goldPairs = 0, covered = 0, covered05 = 0, nonGold = 0, passNonGold = 0, passNonGold05 = 0, passes = 0, allPairs = 0;
for (const c of corpus.cases.filter(und)) {
  const m = rds[c.id]?.[1]; if (!m) continue;
  const goldKeys = new Set(c.gold.add.concat(c.gold.acceptable).map((e) => [e.source, e.target].sort().join("|")));
  for (const [k, rd1] of Object.entries(m)) { const lo = rd1.lo, pair = ["F", k].sort().join("|"); const pNone = lo.probs.none ?? 0; const pass = lo.choice !== "none" || pNone < 0.9; const pass05 = pNone < 0.5; allPairs++; if (pass) passes++;
    if (goldKeys.has(pair)) { goldPairs++; if (pass) covered++; if (pass05) covered05++; } else { nonGold++; if (pass) passNonGold++; if (pass05) passNonGold05++; } }
}
// agreement
const A = Object.fromEntries(baselineDecisions(bl, und).map((x) => [x.c.id, x.d])), D = Object.fromEntries(jevDecisions("D", raw, F.D, und).map((x) => [x.c.id, x.d]));
const sig = (d) => JSON.stringify([d.add.map(canon).sort(), d.remove.slice().sort()]);
let agree = 0, n = 0, aOnly = 0, dOnly = 0, both = 0, bothTrue = 0, aOnlyTrue = 0, dOnlyTrue = 0;
for (const id of Object.keys(A)) { const c = byId[id]; if (!D[id]) continue; n++; if (sig(A[id]) === sig(D[id])) agree++;
  const gold = new Set(c.gold.add.map(canon)); const a = new Set(A[id].add.map(canon)), d = new Set(D[id].add.map(canon));
  for (const e of a) { if (d.has(e)) { both++; if (gold.has(e)) bothTrue++; } else { aOnly++; if (gold.has(e)) aOnlyTrue++; } } for (const e of d) if (!a.has(e)) { dOnly++; if (gold.has(e)) dOnlyTrue++; } }
const out = { first_stage_filter_B_frozen_pair_level: { gold_pairs: goldPairs, covered_argmax_not_none_or_pnone_lt_0_9: covered, covered_pnone_lt_0_5: covered05, non_gold_pairs: nonGold, passed_non_gold: passNonGold, passed_non_gold_pnone_lt_0_5: passNonGold05, total_pairs: allPairs, pass_rate: passes / allPairs },
  agreement_A_vs_D: { events: n, identical_decisions: agree, edges_both: both, both_correct: bothTrue, A_only: aOnly, A_only_correct: aOnlyTrue, D_only: dOnly, D_only_correct: dOnlyTrue } };
writeFileSync(join(RES, "extra-analysis.json"), JSON.stringify(out, null, 1)); console.log(JSON.stringify(out, null, 1));
