#!/usr/bin/env node
// node tools/jev-bench/p1a/run.mjs --provider jev|openai --split dev|holdout|all|<subset-file> [--reps N] [--order random|fixed] [--tag name]
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadCorpus, getSecret, jevRequest, llmRequest, post, pool, RESULTS, JEV_ENDPOINT, OPENAI_ENDPOINT, JEV_MODEL, OPENAI_MODEL, JEV_PRICE_IN, OPENAI_PRICE_IN, OPENAI_PRICE_OUT, chargeCheck, charge } from "./lib.mjs";
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const provider = arg("provider"), split = arg("split"), reps = Number(arg("reps", 1)), orderMode = arg("order", "random"), tag = arg("tag", `${provider}-${split}`);
const corpus = loadCorpus();
if (split === "holdout" || split === "all" || split === "consistency") {
  if (!existsSync(join(RESULTS, "thresholds-frozen.json"))) { console.error("Refusing to touch holdout/all/consistency before thresholds-frozen.json exists."); process.exit(4); }
}
let cases = split === "dev" || split === "holdout" ? corpus.cases.filter((c) => c.split === split) : split === "all" ? corpus.cases : corpus.cases.filter((c) => c.consistency);
if (split === "consistency") { const { default: ids } = await import("./consistency-ids.json", { with: { type: "json" } }); cases = corpus.cases.filter((c) => ids.includes(c.id)); }
const key = getSecret(provider === "jev" ? "TYPESAFE_API_KEY" : "OPENAI_API_KEY");
if (!key) { console.error(`${provider === "jev" ? "TYPESAFE_API_KEY" : "OPENAI_API_KEY"} is not set (env or root .env). Stopping.`); process.exit(2); }
const est = cases.length * reps * (provider === "jev" ? 900 * JEV_PRICE_IN : 650 * OPENAI_PRICE_IN + 40 * OPENAI_PRICE_OUT);
console.log(`${provider} ${split}: ${cases.length} cases × ${reps} reps, est ≤ $${est.toFixed(4)}`);
chargeCheck(est);
const jobs = []; for (let r = 1; r <= reps; r++) for (const c of cases) jobs.push({ r, c });
const recs = [];
await pool(jobs, async ({ r, c }) => {
  if (provider === "jev") {
    const seed = orderMode === "fixed" ? "FIXED" : `${tag}|rep${r}`;
    const { body, option_order } = jevRequest(c, seed);
    const out = await post(JEV_ENDPOINT, { authorization: `Bearer ${key}` }, body);
    recs.push({ id: c.id, rep: r, order_seed: seed, option_order, response: out.json ?? null, error: out.error ?? null, latency_ms: out.latency_ms, attempts: out.attempts, request_id: out.request_id ?? null });
  } else {
    const out = await post(OPENAI_ENDPOINT, { authorization: `Bearer ${key}` }, llmRequest(c));
    recs.push({ id: c.id, rep: r, response: out.json ?? null, error: out.error ?? null, latency_ms: out.latency_ms, attempts: out.attempts, request_id: out.request_id ?? null });
  }
});
recs.sort((a, b) => a.rep - b.rep || a.id.localeCompare(b.id));
let usd = 0;
for (const x of recs) if (x.response) usd += provider === "jev" ? (x.response.usage?.input_tokens ?? 0) * JEV_PRICE_IN : (x.response.usage?.prompt_tokens ?? 0) * OPENAI_PRICE_IN + (x.response.usage?.completion_tokens ?? 0) * OPENAI_PRICE_OUT;
const meta = { provider, split, reps, tag, order_mode: orderMode, model_requested: provider === "jev" ? JEV_MODEL : OPENAI_MODEL, corpus_sha256: corpus.sha256, at: new Date().toISOString(), cost_usd: usd };
const path = join(RESULTS, `raw-${tag}.json`);
writeFileSync(path, JSON.stringify({ meta, records: recs }, null, 1)); // no headers or credentials stored
charge(tag, usd, recs.length);
console.log(`wrote ${path}  ok=${recs.filter((x) => x.response).length}/${recs.length}  cost=$${usd.toFixed(5)}`);
