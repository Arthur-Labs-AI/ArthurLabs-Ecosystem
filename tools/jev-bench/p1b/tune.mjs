#!/usr/bin/env node
// Select thresholds for B, C, D on the DEV split only (non-disputed events), then freeze everything.
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { rd, corpus, jevDecisions, scoreAll } from "./common.mjs";
import { aggregate, RES } from "./lib.mjs";
import { DEFAULT_TH } from "./decide.mjs";
import { PROMPT_HASHES, MODELS } from "./baseline.mjs";
const out = join(RES, "frozen.json"); if (existsSync(out)) { console.error("already frozen"); process.exit(1); }
const raw = rd("raw-jev-dev.json"), dev = (c) => c.split === "dev" && !c.disputed;
function search(cfg, grid) {
  let best = null;
  for (const th of grid) {
    const sc = scoreAll(jevDecisions(cfg, raw, th, dev)); const a = aggregate(sc);
    const rows = sc.map((x) => x.s); const strictTp = rows.reduce((s, r) => s + r.strict_tp, 0), stale = rows.reduce((s, r) => s + r.stale_removed, 0);
    const k = [a.dangerous_total, -strictTp, -stale, -(th.pMin ?? th.tau ?? 0), -(th.nTau ?? 0)];
    const cmp = (x, y) => { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
    if (!best || cmp(k, best.k) < 0) best = { th, k, a };
  }
  return best;
}
const range = (a) => a;
const gridB = []; for (const pMin of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99]) for (const margin of [0, 0.2, 0.4, 0.6, 0.8]) gridB.push({ pMin, margin });
const gridC = []; for (const tau of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) for (const rev of [0.2, 0.3, 0.5]) for (const keep of [0.1, 0.2, 0.35, 0.5]) gridC.push({ tau, rev, keep });
const gridD = []; for (const pMin of [0.5, 0.7, 0.9]) for (const margin of [0, 0.4, 0.7]) for (const nTau of [0.5, 0.7, 0.8, 0.9]) for (const rev of [0.2, 0.3, 0.5]) for (const cancelTau of [0.3, 0.5, 0.7, 0.9]) for (const goneTau of [0.3, 0.5, 0.7, 0.9]) for (const mootTau of [0.3, 0.5, 0.7]) gridD.push({ pMin, margin, nTau, rev, cancelTau, goneTau, mootTau });
const res = { B: search("B", gridB), C: search("C", gridC), D: search("D", gridD) };
const frozen = { frozen_at: new Date().toISOString(), corpus_sha256: corpus.sha256, selection: "dev split, non-disputed events, one JEV run with random option order", objective: "min (false edges + wrongful removals + user-edge violations), then max strict true positives, then max correct stale removals, then most conservative thresholds",
  thresholds: { B: res.B.th, C: res.C.th, D: res.D.th }, default_before_tuning: DEFAULT_TH, dev_fit: Object.fromEntries(Object.entries(res).map(([k, v]) => [k, { dangerous: v.a.dangerous_total, strict_precision: v.a.strict_precision, strict_recall: v.a.strict_recall, stale_removed: v.a.stale_removed_correct, events: v.a.events }])),
  baseline: { models: MODELS, prompt_hashes: PROMPT_HASHES, note: "production prompts/gates, not tuned" } };
writeFileSync(out, JSON.stringify(frozen, null, 1)); console.log(JSON.stringify({ thresholds: frozen.thresholds, dev_fit: frozen.dev_fit }, null, 1));
