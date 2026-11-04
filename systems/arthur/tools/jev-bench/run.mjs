#!/usr/bin/env node
// Live runner. Usage: node tools/jev-bench/run.mjs [--runs 3] [--model jev-1.13.0] [--dry] [--yes]
// Requires TYPESAFE_API_KEY in the environment (or in repo-root .env; only that one variable is read).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorpus, buildRequest, analyse, renderMarkdown, PRICE_PER_INPUT_TOKEN } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : (process.argv[i + 1]?.startsWith("--") || i + 1 >= process.argv.length ? true : process.argv[i + 1]); };
const RUNS = Number(arg("runs", 3)), MODEL = String(arg("model", "jev-1.13.0")), DRY = !!arg("dry", false);
const MAX_BUDGET_USD = Number(arg("budget", 0.05));
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 20_000, MAX_ATTEMPTS = 3;

function getKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  const envFile = join(ROOT, ".env");
  if (existsSync(envFile)) { // read ONLY this one variable; nothing else from .env is touched
    const m = readFileSync(envFile, "utf8").match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*)$/m);
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, "");
  }
  return null;
}
const KEY = DRY ? "dry" : getKey();
if (!KEY) { console.error("TYPESAFE_API_KEY is not set (environment or repo-root .env). Stopping."); process.exit(2); }

const corpus = loadCorpus(join(HERE, "corpus.json"));
const orders = ["A", "B"];
const total = corpus.cases.length * RUNS * orders.length;
// conservative estimate: ~700 input tokens/request upper bound (state+3 questions+criteria)
const estTokens = total * 700, estCost = estTokens * PRICE_PER_INPUT_TOKEN;
console.log(`Plan: ${total} requests, model=${MODEL}, est. <= ${estTokens} input tokens, est. cost <= $${estCost.toFixed(4)} (price $0.042/Mtok input, output free)`);
if (estCost > MAX_BUDGET_USD) { console.error(`Estimated cost exceeds budget $${MAX_BUDGET_USD}. Stopping.`); process.exit(3); }
if (DRY) { console.log(JSON.stringify(buildRequest(corpus.cases[0], "A", MODEL), null, 1)); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Retries ONLY genuine transport failures (network/timeout/429/529/5xx). Never retries on wrong answers or 4xx validation/auth.
async function call(body) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const t0 = performance.now();
    try {
      const res = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
      const latency = performance.now() - t0, text = await res.text();
      if (res.ok) {
        try { return { response: JSON.parse(text), latency_ms: Math.round(latency), attempts: attempt, request_id: res.headers.get("x-typesafe-request-id") }; }
        catch { return { error: `parse_error: non-JSON body (${text.slice(0, 120)})`, latency_ms: Math.round(latency), attempts: attempt }; }
      }
      const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
      lastErr = `http_${res.status}: ${text.slice(0, 300)}`;
      if (!retryable) return { error: lastErr, latency_ms: Math.round(latency), attempts: attempt };
      const ra = Number(res.headers.get("retry-after"));
      await sleep(ra > 0 ? ra * 1000 : 500 * 2 ** (attempt - 1));
    } catch (e) { // network / timeout
      lastErr = `transport: ${e?.name ?? "Error"}`;
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
  return { error: lastErr, latency_ms: null, attempts: MAX_ATTEMPTS };
}

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const records = [];
const CONC = 4;
const jobs = [];
for (let run = 1; run <= RUNS; run++) for (const order of orders) for (const c of corpus.cases) jobs.push({ run, order, c });
let next = 0, done = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < jobs.length) {
    const { run, order, c } = jobs[next++];
    const req = buildRequest(c, order, MODEL);
    const out = await call(req);
    records.push({ run, order, case_id: c.id, request: req, ...out });
    if (++done % 30 === 0) console.log(`  ${done}/${jobs.length}`);
  }
}));
records.sort((a, b) => a.run - b.run || a.order.localeCompare(b.order) || a.case_id.localeCompare(b.case_id));

mkdirSync(join(HERE, "results"), { recursive: true });
const meta = { run_id: runId, model: MODEL, runs: RUNS, orders, endpoint: ENDPOINT, corpus_sha256: corpus.sha256 };
const rawPath = join(HERE, "results", `raw-${runId}.json`);
writeFileSync(rawPath, JSON.stringify({ meta, records }, null, 1)); // no headers/credentials are ever stored
const a = analyse(records, corpus);
writeFileSync(join(HERE, "results", `analysis-${runId}.json`), JSON.stringify({ meta, ...a }, null, 1));
writeFileSync(join(HERE, "results", `report-${runId}.md`), renderMarkdown(a, meta, corpus));
console.log(`Done. ok=${a.ops.ok}/${a.ops.requests} cost≈$${a.ops.cost_usd.toFixed(5)}  raw: ${rawPath}`);
