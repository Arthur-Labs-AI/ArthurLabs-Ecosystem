// Phase 1A shared code: requests, seeded option shuffling, decision rules, metrics, CIs, transport, budget ledger.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const BENCH = resolve(HERE, "..");
export const ROOT = resolve(BENCH, "../..");
export const RESULTS = join(BENCH, "results", "p1a");
mkdirSync(RESULTS, { recursive: true });

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-1.13.0";
export const JEV_PRICE_IN = 0.042 / 1e6; // output free
export const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
export const OPENAI_MODEL = "gpt-4.1-mini-2025-04-14";
export const OPENAI_PRICE_IN = 0.4 / 1e6, OPENAI_PRICE_OUT = 1.6 / 1e6; // developers.openai.com model page
export const BUDGET_USD = 1.0; // fixed Phase 1A ceiling, enforced via ledger

export function loadCorpus() {
  const raw = readFileSync(join(BENCH, "corpus-p1a.json"), "utf8");
  return { ...JSON.parse(raw), sha256: createHash("sha256").update(raw).digest("hex") };
}

// ---- env: read exactly one named variable from process env or root .env ----
export function getSecret(name) {
  if (process.env[name]) return process.env[name];
  const f = join(ROOT, ".env");
  if (existsSync(f)) {
    const m = readFileSync(f, "utf8").match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`, "m"));
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, "");
  }
  return null;
}

// ---- budget ledger ----
const LEDGER = join(RESULTS, "ledger.json");
export const ledger = () => (existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : { spent_usd: 0, entries: [] });
export function chargeCheck(est) { const l = ledger(); if (l.spent_usd + est > BUDGET_USD) { console.error(`Budget guard: spent $${l.spent_usd.toFixed(4)} + est $${est.toFixed(4)} > $${BUDGET_USD}. Stopping.`); process.exit(3); } }
export function charge(label, usd, requests) { const l = ledger(); l.spent_usd += usd; l.entries.push({ label, usd, requests, at: new Date().toISOString() }); writeFileSync(LEDGER, JSON.stringify(l, null, 1)); }

// ---- seeded shuffle ----
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function shuffled(arr, seedStr) {
  const rnd = mulberry32(parseInt(createHash("sha256").update(seedStr).digest("hex").slice(0, 8), 16));
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---- JEV request ----
const CRIT = {
  NEW: "`new_capture` is a different idea from every idea in `existing_ideas`, even if it shares the topic, project, product, screen or wording.",
  UNCERTAIN: "From the text alone it cannot be determined whether `new_capture` updates an existing idea, or which of several existing ideas it refers to.",
};
const revCrit = (i) => `\`new_capture\` continues, corrects, extends or replaces \`existing_ideas[${i}]\` specifically, and no other idea in \`existing_ideas\` is an equally plausible target.`;

export function stateOf(c) { return { existing_ideas: c.candidates.map((e) => ({ id: e.id, project: e.project, text: e.text })), new_capture: c.new_capture }; }

// orderSeed: string -> deterministic random option order; "FIXED" -> declared order revise_0..k, NEW, UNCERTAIN
export function jevRequest(c, orderSeed) {
  const keys = [...c.candidates.map((_, i) => `revise_idea_${i}`), "new", "uncertain"];
  const order = orderSeed === "FIXED" ? keys : shuffled(keys, `${c.id}|${orderSeed}`);
  const criteria = {};
  for (const k of order) criteria[k] = k === "new" ? CRIT.NEW : k === "uncertain" ? CRIT.UNCERTAIN : revCrit(Number(k.split("_").pop()));
  const questions = {};
  c.candidates.forEach((_, i) => {
    questions[`same_idea_${i}`] = {
      type: "noul",
      instructions: `Is \`new_capture\` a continuation, correction, extension or replacement of the SAME underlying idea as \`existing_ideas[${i}]\`?`,
      criteria: { true: "It is about the same specific idea and would update it.", false: "It only shares a topic, project, product or vocabulary but is a different idea, task or requirement, or the link is unclear." },
    };
  });
  questions.relation = { type: "choice", instructions: "How does `new_capture` relate to `existing_ideas`?", criteria };
  return { body: { state: stateOf(c), model: JEV_MODEL, questions }, option_order: order };
}

// ---- OpenAI baseline request (same information; same definitions) ----
export const LLM_SYSTEM = `You decide how a new capture relates to existing ideas in a personal knowledge base. Answer with JSON only: {"decision":"REVISE"|"NEW"|"UNCERTAIN","target_id":"<idea id>"|null}.
REVISE: the new capture continues, corrects, extends or replaces exactly one specific existing idea, and no other existing idea is an equally plausible target. Set target_id to that idea's id.
NEW: the new capture is a different idea from every existing idea, even if it shares the topic, project, product, screen or wording. target_id must be null.
UNCERTAIN: from the text alone it cannot be determined whether the new capture updates an existing idea, or which of several existing ideas it refers to. target_id must be null.`;
export function llmRequest(c) {
  return { model: OPENAI_MODEL, temperature: 0, max_tokens: 40, response_format: { type: "json_object" },
    messages: [{ role: "system", content: LLM_SYSTEM }, { role: "user", content: JSON.stringify(stateOf(c)) }] };
}

// ---- decision rules ----
export function noulDecide(answers, n, th) {
  const s = []; for (let i = 0; i < n; i++) s.push(answers?.[`same_idea_${i}`]?.noul);
  if (s.some((x) => typeof x !== "number")) return { decision: null };
  const idx = s.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  const top1 = idx[0][0], top2 = idx[1]?.[0] ?? 0, gap = top1 - top2;
  let decision = "UNCERTAIN", target = null;
  if (top1 >= th.noul.revise && gap >= th.noul.gap && top2 < th.noul.ambig) { decision = "REVISE"; target = idx[0][1]; }
  else if (top1 <= th.noul.new) decision = "NEW";
  return { decision, target, scores: s, top1, top2, gap };
}
export function choiceDecide(answers, th) {
  const a = answers?.relation;
  if (!a?.probabilities) return { decision: null };
  const ent = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]);
  const [k1, p1] = ent[0], p2 = ent[1]?.[1] ?? 0;
  let decision = "UNCERTAIN", target = null;
  if (k1.startsWith("revise_idea_") && p1 >= th.choice.revise && p1 - p2 >= th.choice.margin) { decision = "REVISE"; target = Number(k1.split("_").pop()); }
  else if (k1 === "new" && p1 >= th.choice.new) decision = "NEW";
  return { decision, target, argmax: k1, p1, p2, conf: a.confidence, probs: a.probabilities };
}
export function hybridDecide(n, c) {
  if (!n.decision || !c.decision) return { decision: null };
  if (n.decision === "REVISE" && c.decision === "REVISE" && n.target === c.target) return { decision: "REVISE", target: n.target };
  if (n.decision === "NEW" && c.decision === "NEW") return { decision: "NEW", target: null };
  return { decision: "UNCERTAIN", target: null };
}
export function llmDecide(resp, n) {
  try {
    const j = JSON.parse(resp.choices[0].message.content);
    if (!["REVISE", "NEW", "UNCERTAIN"].includes(j.decision)) return { decision: null, schema_error: "bad decision" };
    let target = null;
    if (j.decision === "REVISE") { const m = /^idea_(\d+)$/.exec(j.target_id ?? ""); if (!m || Number(m[1]) >= n) return { decision: null, schema_error: "bad target_id" }; target = Number(m[1]); }
    return { decision: j.decision, target };
  } catch { return { decision: null, schema_error: "parse" }; }
}
export const DEFAULT_TH = { noul: { revise: 0.8, gap: 0.3, ambig: 0.5, new: 0.3 }, choice: { revise: 0.7, margin: 0.4, new: 0.7 } };

// ---- metrics ----
export function wilson(k, n, z = 1.96) { if (!n) return [null, null]; const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n); return [(c - m) / d, (c + m) / d]; }
export const pct = (x) => (x == null ? "n/a" : (100 * x).toFixed(1) + "%");
const ci = (k, n) => { const [a, b] = wilson(k, n); return n ? `${k}/${n} = ${pct(k / n)} [${pct(a)}–${pct(b)}]` : "n/a"; };
export { ci };

// row: {expected, exp_target, decision, target, ...}
export function score(rows) {
  const L = ["REVISE", "NEW", "UNCERTAIN"];
  const conf = Object.fromEntries(L.map((e) => [e, { REVISE: 0, NEW: 0, UNCERTAIN: 0, ERROR: 0 }]));
  for (const r of rows) conf[r.expected][r.decision ?? "ERROR"]++;
  const predR = rows.filter((r) => r.decision === "REVISE");
  const expR = rows.filter((r) => r.expected === "REVISE");
  const trueR = predR.filter((r) => r.expected === "REVISE" && r.target === r.exp_target);
  const wrongTarget = predR.filter((r) => r.expected === "REVISE" && r.target !== r.exp_target);
  const fmNew = predR.filter((r) => r.expected === "NEW"), fmUnc = predR.filter((r) => r.expected === "UNCERTAIN");
  const nN = rows.filter((r) => r.expected === "NEW").length, nU = rows.filter((r) => r.expected === "UNCERTAIN").length;
  const predN = rows.filter((r) => r.decision === "NEW"), predU = rows.filter((r) => r.decision === "UNCERTAIN");
  const ok = (r) => r.decision === r.expected && (r.expected !== "REVISE" || r.target === r.exp_target);
  const danger = fmNew.length + fmUnc.length + wrongTarget.length;
  return {
    n: rows.length, confusion: conf, errors: rows.filter((r) => r.decision == null).length,
    accuracy: ci(rows.filter(ok).length, rows.length),
    revise_precision: ci(trueR.length, predR.length), revise_recall: ci(trueR.length, expR.length),
    new_precision: ci(predN.filter((r) => r.expected === "NEW").length, predN.length), new_recall: ci(predN.filter((r) => r.expected === "NEW").length, nN),
    uncertain_precision: ci(predU.filter((r) => r.expected === "UNCERTAIN").length, predU.length), uncertain_recall: ci(predU.filter((r) => r.expected === "UNCERTAIN").length, nU),
    false_merge_on_new: ci(fmNew.length, nN), false_merge_on_uncertain: ci(fmUnc.length, nU),
    wrong_target: ci(wrongTarget.length, expR.length), dangerous_merges_total: danger,
    _fm_ids: [...fmNew, ...fmUnc].map((r) => r.id), _wt_ids: wrongTarget.map((r) => r.id),
  };
}

// ---- transport (transport-only retries) ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function post(url, headers, body, { timeoutMs = 25000, attempts = 3 } = {}) {
  let last;
  for (let a = 1; a <= attempts; a++) {
    const t0 = performance.now();
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      const lat = Math.round(performance.now() - t0), text = await res.text();
      if (res.ok) { try { return { json: JSON.parse(text), latency_ms: lat, attempts: a, request_id: res.headers.get("x-typesafe-request-id") ?? res.headers.get("x-request-id") }; } catch { return { error: "schema_error: non-JSON body", latency_ms: lat, attempts: a }; } }
      last = `http_${res.status}: ${text.slice(0, 200).replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")}`;
      if (!(res.status === 429 || res.status === 529 || res.status >= 500)) return { error: last, latency_ms: lat, attempts: a };
      const ra = Number(res.headers.get("retry-after")); await sleep(ra > 0 ? ra * 1000 : 500 * 2 ** (a - 1));
    } catch (e) { last = `transport: ${e?.name ?? "Error"}`; await sleep(500 * 2 ** (a - 1)); }
  }
  return { error: last, latency_ms: null, attempts };
}
export async function pool(jobs, fn, conc = 4) { let i = 0; await Promise.all(Array.from({ length: conc }, async () => { while (i < jobs.length) await fn(jobs[i++]); })); }
