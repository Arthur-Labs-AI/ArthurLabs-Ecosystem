#!/usr/bin/env node
// node tools/jev-bench/p1a1/run.mjs --provider jev|openai-class|openai-guard --split dev|holdout|consistency [--reps N] [--order random|fixed] [--tag t]
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCorpus1, jevRequest1, llmRequest, llmGuardRequest, relevantIdx, post, pool, getSecret, JEV_ENDPOINT, OPENAI_ENDPOINT, JEV_MODEL, OPENAI_MODEL, JEV_PRICE_IN, OPENAI_PRICE_IN, OPENAI_PRICE_OUT, chargeCheck1, charge1, RES1, HERE1 } from "./lib.mjs";
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const provider = arg("provider"), split = arg("split"), reps = Number(arg("reps", 1)), orderMode = arg("order", "random"), tag = arg("tag", `${provider}-${split}`);
const corpus = loadCorpus1();
if (split !== "dev" && !existsSync(join(RES1, "policy-frozen.json"))) { console.error("Refusing to touch holdout/consistency before policy-frozen.json exists."); process.exit(4); }
let cases = split === "consistency" ? corpus.cases.filter((c) => JSON.parse(readFileSync(join(HERE1, "consistency-ids.json"), "utf8")).includes(c.id)) : corpus.cases.filter((c) => c.split === split);
if (provider === "openai-guard") cases = cases.filter((c) => relevantIdx(c) != null);
const name = provider === "jev" ? "TYPESAFE_API_KEY" : "OPENAI_API_KEY"; const key = getSecret(name);
if (!key) { console.error(`${name} is not set (env or root .env). Stopping.`); process.exit(2); }
const est = cases.length * reps * (provider === "jev" ? 2600 * JEV_PRICE_IN : 650 * OPENAI_PRICE_IN + 40 * OPENAI_PRICE_OUT);
console.log(`${provider} ${split}: ${cases.length} cases × ${reps}, est ≤ $${est.toFixed(4)}`); chargeCheck1(est);
const jobs = []; for (let r = 1; r <= reps; r++) for (const c of cases) jobs.push({ r, c }); const recs = [];
await pool(jobs, async ({ r, c }) => {
  if (provider === "jev") { const seed = orderMode === "fixed" ? "FIXED" : `${tag}|rep${r}`; const { body, option_order } = jevRequest1(c, seed); const o = await post(JEV_ENDPOINT, { authorization: `Bearer ${key}` }, body); recs.push({ id: c.id, rep: r, order_seed: seed, option_order, response: o.json ?? null, error: o.error ?? null, latency_ms: o.latency_ms, attempts: o.attempts }); }
  else { const req = provider === "openai-class" ? llmRequest(c) : llmGuardRequest(c, relevantIdx(c), OPENAI_MODEL); const o = await post(OPENAI_ENDPOINT, { authorization: `Bearer ${key}` }, req); recs.push({ id: c.id, rep: r, response: o.json ?? null, error: o.error ?? null, latency_ms: o.latency_ms, attempts: o.attempts }); }
});
recs.sort((a, b) => a.rep - b.rep || a.id.localeCompare(b.id));
let usd = 0; for (const x of recs) if (x.response) usd += provider === "jev" ? (x.response.usage?.input_tokens ?? 0) * JEV_PRICE_IN : (x.response.usage?.prompt_tokens ?? 0) * OPENAI_PRICE_IN + (x.response.usage?.completion_tokens ?? 0) * OPENAI_PRICE_OUT;
const path = join(RES1, `raw-${tag}.json`);
writeFileSync(path, JSON.stringify({ meta: { provider, split, reps, tag, order_mode: orderMode, model_requested: provider === "jev" ? JEV_MODEL : OPENAI_MODEL, corpus_sha256: corpus.sha256, at: new Date().toISOString(), cost_usd: usd }, records: recs }, null, 1));
charge1(tag, usd, recs.length); console.log(`wrote ${path} ok=${recs.filter((x) => x.response).length}/${recs.length} cost=$${usd.toFixed(5)}`);
