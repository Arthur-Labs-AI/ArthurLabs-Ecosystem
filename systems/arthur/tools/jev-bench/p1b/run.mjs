#!/usr/bin/env node
// node tools/jev-bench/p1b/run.mjs --config baseline|jev --split dev|holdout|consistency [--reps N] [--tag t]
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCorpus, prepare, post, pool, getSecret, RES, HERE, JEV_ENDPOINT, OPENAI_ENDPOINT, JEV_PRICE_IN, PRICES, chargeCheck, charge } from "./lib.mjs";
import { decide, PROMPT_HASHES, MODELS, InvalidOutput } from "./baseline.mjs";
import { pairRequest, CLAIMS } from "./jev.mjs";
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const config = arg("config"), split = arg("split"), reps = Number(arg("reps", 1)), tag = arg("tag", `${config}-${split}`);
const corpus = loadCorpus();
if (split !== "dev" && !existsSync(join(RES, "frozen.json"))) { console.error("Refusing to touch holdout/consistency before frozen.json exists."); process.exit(4); }
const ids = split === "consistency" ? JSON.parse(readFileSync(join(HERE, "consistency-ids.json"), "utf8")) : null;
const cases = corpus.cases.filter((c) => (split === "consistency" ? ids.includes(c.id) : c.split === split));
const name = config === "baseline" ? "OPENAI_API_KEY" : "TYPESAFE_API_KEY"; const key = getSecret(name);
if (!key) { console.error(`${name} is not set (env or root .env). Stopping.`); process.exit(2); }
const only = arg("only", null); const jobs = []; for (let r = 1; r <= reps; r++) for (const c of cases) if (!only || only.split(",").includes(c.id)) jobs.push({ r, c });
const est = config === "baseline" ? jobs.length * 0.016 : jobs.length * 2.4 * 2 * 4500 * JEV_PRICE_IN;
console.log(`${config} ${split}: ${cases.length} events × ${reps}, est ≤ $${est.toFixed(3)}`); chargeCheck(est);
const recs = [];
if (config === "baseline") {
  await pool(jobs, async ({ r, c }) => {
    const p = prepare(c); const usageLog = [];
    const call = async (role, body) => {
      const o = await post(OPENAI_ENDPOINT, { authorization: `Bearer ${key}` }, body, { timeoutMs: 120000 });
      if (o.error) { if (o.error.startsWith("schema_error")) throw new InvalidOutput("unreadable"); throw Object.assign(new Error(o.error), { kind: "provider" }); }
      const ch = o.json.choices?.[0]; const refused = ch?.message?.refusal; if (refused || ch?.finish_reason === "length" || ch?.finish_reason === "content_filter" || typeof ch?.message?.content !== "string") throw refused || ch?.finish_reason === "content_filter" ? Object.assign(new Error("refused"), { kind: "provider" }) : new InvalidOutput("unreadable");
      usageLog.push({ model: body.model, prompt: o.json.usage?.prompt_tokens ?? 0, completion: o.json.usage?.completion_tokens ?? 0, reasoning: o.json.usage?.completion_tokens_details?.reasoning_tokens ?? 0, latency_ms: o.latency_ms, attempts: o.attempts });
      return { content: ch.message.content, usage: { model: body.model, prompt: o.json.usage?.prompt_tokens ?? 0, completion: o.json.usage?.completion_tokens ?? 0, reasoning: o.json.usage?.completion_tokens_details?.reasoning_tokens ?? 0 }, meta: { latency_ms: o.latency_ms, attempts: o.attempts, model_reported: o.json.model } };
    };
    const t0 = performance.now(); let out;
    try { const d = await decide({ focus: p.focus, objects: p.objects, existing: p.existing }, call); out = { add: d.add.map((e) => ({ kind: e.kind, source: p.keyOf[e.source], target: p.keyOf[e.target] })), remove: d.remove.map((id) => p.existing.find((x) => x.id === id).idx), failed: false, report: d.report }; }
    catch (e) { out = { add: [], remove: [], failed: true, error: String(e?.message ?? e).slice(0, 160), report: null }; }
    recs.push({ id: c.id, rep: r, ...out, usage: usageLog, wall_ms: Math.round(performance.now() - t0) });
  }, 3);
} else {
  const items = [];
  for (const { r, c } of jobs) { const p = prepare(c); const F = p.objects.find((o) => o.key === "F");
    for (const X of p.objects.filter((o) => o.key !== "F")) { const modelEx = p.existing.find((e) => e.origin === "model" && [e.source_object_id, e.target_object_id].includes(X.id) && [e.source_object_id, e.target_object_id].includes(F.id)); const [lowO, highO] = F.id <= X.id ? [F, X] : [X, F];
      for (const [pres, first, second] of [["lo", lowO, highO], ["hi", highO, lowO]]) items.push({ r, c, other: X.key, pres, first, second, claimed: modelEx?.kind ?? null }); } }
  await pool(items, async (it) => { const seed = `${tag}|${it.c.id}|${it.other}|${it.pres}|r${it.r}`; const req = pairRequest(it.first, it.second, it.claimed, seed); const o = await post(JEV_ENDPOINT, { authorization: `Bearer ${key}` }, req); recs.push({ id: it.c.id, rep: it.r, other: it.other, pres: it.pres, firstKey: it.first.key, secondKey: it.second.key, claimed: it.claimed, response: o.json ?? null, error: o.error ?? null, latency_ms: o.latency_ms, attempts: o.attempts }); }, 6);
}
recs.sort((a, b) => a.rep - b.rep || a.id.localeCompare(b.id));
let usd = 0;
if (config === "baseline") { for (const r of recs) if (r.report) {} }
const path = join(RES, `raw-${tag}.json`);
// cost: baseline usage is carried in report.usage; jev from response.usage
if (config === "baseline") for (const r of recs) for (const u of r.usage ?? []) usd += u.prompt * PRICES[u.model].in + u.completion * PRICES[u.model].out;
else for (const r of recs) usd += (r.response?.usage?.input_tokens ?? 0) * JEV_PRICE_IN;
writeFileSync(path, JSON.stringify({ meta: { config, split, reps, tag, corpus_sha256: corpus.sha256, prompt_hashes: config === "baseline" ? PROMPT_HASHES : undefined, models: config === "baseline" ? MODELS : { model: "jev-1.13.0" }, at: new Date().toISOString(), cost_usd: usd }, records: recs }, null, 1));
charge1(tag, usd, recs.length); function charge1(l, u, n) { charge(l, u, n); }
console.log(`wrote ${path} ok=${recs.filter((x) => (x.response ?? !x.failed)).length}/${recs.length} cost=$${usd.toFixed(4)}`);
