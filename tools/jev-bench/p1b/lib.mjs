// Phase 1B shared: corpus/event prep, scoring, metrics, ledger. Benchmark-only.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export { post, pool, getSecret, wilson, shuffled, JEV_ENDPOINT, JEV_MODEL, JEV_PRICE_IN, OPENAI_ENDPOINT } from "../p1a/lib.mjs";
import { wilson } from "../p1a/lib.mjs";

export const HERE = dirname(fileURLToPath(import.meta.url)), BENCH = resolve(HERE, "..");
export const RES = join(BENCH, "results", "p1b"); mkdirSync(RES, { recursive: true });
export const BUDGET_USD = 5.0; // fixed Phase 1B cap (OpenAI + JEV combined), enforced by ledger
export const PRICES = { "gpt-4.1-mini": { in: 0.4e-6, out: 1.6e-6 }, "gpt-5-mini": { in: 0.25e-6, out: 2e-6 } }; // developers.openai.com model pages
const LEDGER = join(RES, "ledger.json");
export const ledger = () => (existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : { spent_usd: 0, entries: [] });
export function chargeCheck(est) { const l = ledger(); if (l.spent_usd + est > BUDGET_USD) { console.error(`Budget guard: $${l.spent_usd.toFixed(3)} + est $${est.toFixed(3)} > $${BUDGET_USD}. Stopping.`); process.exit(3); } }
export function charge(label, usd, requests) { const l = ledger(); l.spent_usd += usd; l.entries.push({ label, usd, requests, at: new Date().toISOString() }); writeFileSync(LEDGER, JSON.stringify(l, null, 1)); }

export function loadCorpus() { const raw = readFileSync(join(BENCH, "corpus-p1b.json"), "utf8"); return { ...JSON.parse(raw), sha256: createHash("sha256").update(raw).digest("hex") }; }
export const uuidFor = (s) => { const x = createHash("sha256").update("p1b-rel|" + s).digest("hex"); return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-8${x.slice(17, 20)}-${x.slice(20, 32)}`; };
// Production-shaped input for one event (project-local pool; focus first). The previous focus text is NOT included (production does not send it).
export function prepare(c) {
  const idOf = Object.fromEntries(c.objects.map((o) => [o.key, o.id])), keyOf = Object.fromEntries(c.objects.map((o) => [o.id, o.key]));
  const objects = [...c.objects].sort((a, b) => (a.key === "F" ? -1 : b.key === "F" ? 1 : a.key.localeCompare(b.key))).map((o) => ({ id: o.id, key: o.key, kind: o.kind, title: o.title, body: o.body, createdAt: o.writtenAt, writtenAt: o.writtenAt }));
  const existing = c.existing.map((e, i) => ({ idx: i, id: uuidFor(c.id + "e" + i), kind: e.kind, source_object_id: idOf[e.source], target_object_id: idOf[e.target], origin: e.origin ?? "model" }));
  return { focus: idOf.F, objects, existing, idOf, keyOf };
}

// ---- identities / scoring ----
const SYM = ["related_to", "contradicts", "duplicates"];
export const canon = (e) => { const [s, t] = SYM.includes(e.kind) && e.target < e.source ? [e.target, e.source] : [e.source, e.target]; return `${e.kind}|${s}|${t}`; };
export const unordered = (e) => `${e.kind}|${[e.source, e.target].sort().join("|")}`;
const DIRECTIONAL = (k) => !SYM.includes(k);
// decision: { add:[{kind,source,target}] (object KEYS), remove:[existing idx], failed? }
export function scoreEvent(c, d) {
  const G = c.gold.add.map(canon), A = c.gold.acceptable.map(canon), P = d.add.map(canon);
  const ok = new Set([...G, ...A]);
  const strictTp = P.filter((p) => G.includes(p)).length, semTp = P.filter((p) => ok.has(p)).length, falseEdges = P.filter((p) => !ok.has(p));
  const goldUnordered = new Set(c.gold.add.concat(c.gold.acceptable).map(unordered));
  const reversed = d.add.filter((p) => DIRECTIONAL(p.kind) && !ok.has(canon(p)) && ok.has(canon({ kind: p.kind, source: p.target, target: p.source }))).length;
  const dirDen = d.add.filter((p) => DIRECTIONAL(p.kind) && goldUnordered.has(unordered(p))).length;
  const dirOk = d.add.filter((p) => DIRECTIONAL(p.kind) && ok.has(canon(p))).length;
  const modelIdx = c.existing.map((e, i) => i).filter((i) => (c.existing[i].origin ?? "model") === "model");
  const userIdx = c.existing.map((e, i) => i).filter((i) => c.existing[i].origin && c.existing[i].origin !== "model");
  const removedSet = new Set(d.remove);
  return {
    gold_edges: G.length, pred_edges: P.length, strict_tp: strictTp, semantic_tp: semTp, false_edges: falseEdges.length, false_edge_list: d.add.filter((p) => !ok.has(canon(p))), reversed_edges: reversed, dir_den: dirDen, dir_ok: dirOk,
    recalled_strict: G.filter((g) => P.includes(g)).length, recalled_event_semantic: G.length ? (P.some((p) => ok.has(p)) ? 1 : 0) : null,
    none_event: G.length === 0 ? 1 : 0, none_correct: G.length === 0 && P.length === 0 ? 1 : 0, none_false_admit: G.length === 0 && P.length > 0 ? 1 : 0,
    stale_expected: c.gold.remove.filter((i) => modelIdx.includes(i)).length, stale_removed: c.gold.remove.filter((i) => removedSet.has(i)).length, stale_retained: c.gold.remove.filter((i) => !removedSet.has(i)).length,
    keep_expected: c.gold.keep.filter((i) => modelIdx.includes(i)).length, wrongful_removals: c.gold.keep.filter((i) => modelIdx.includes(i) && removedSet.has(i)).length,
    user_violations: userIdx.filter((i) => removedSet.has(i)).length, failed: d.failed ? 1 : 0,
  };
}
const sum = (rows, k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
const rate = (n, d) => (d ? { n, d, p: n / d, ci: wilson(n, d) } : { n, d, p: null, ci: [null, null] });
export const fmtRate = (r) => (r.d ? `${r.n}/${r.d} = ${(100 * r.p).toFixed(1)}% [${(100 * r.ci[0]).toFixed(1)}–${(100 * r.ci[1]).toFixed(1)}]` : "n/a");
export function aggregate(scored) { // scored: [{c, s}]
  const rows = scored.map((x) => x.s);
  return {
    events: scored.length, failed_runs: sum(rows, "failed"),
    strict_precision: rate(sum(rows, "strict_tp"), sum(rows, "pred_edges")), semantic_precision: rate(sum(rows, "semantic_tp"), sum(rows, "pred_edges")),
    strict_recall: rate(sum(rows, "recalled_strict"), sum(rows, "gold_edges")), semantic_recall_events: rate(sum(rows.filter((r) => r.recalled_event_semantic != null), "recalled_event_semantic"), rows.filter((r) => r.recalled_event_semantic != null).length),
    direction_accuracy: rate(sum(rows, "dir_ok"), sum(rows, "dir_den")), reversed_edges_admitted: sum(rows, "reversed_edges"),
    false_edge_admission_events: rate(scored.filter((x) => x.s.false_edges > 0).length, scored.length), false_edges_total: sum(rows, "false_edges"),
    none_correct: rate(sum(rows, "none_correct"), sum(rows, "none_event")), none_false_admission: rate(sum(rows, "none_false_admit"), sum(rows, "none_event")),
    stale_retention_unsafe: rate(sum(rows, "stale_retained"), sum(rows, "stale_expected")), stale_removed_correct: rate(sum(rows, "stale_removed"), sum(rows, "stale_expected")),
    wrongful_removals: rate(sum(rows, "wrongful_removals"), sum(rows, "keep_expected")), user_edge_violations: sum(rows, "user_violations"),
    dangerous_total: sum(rows, "false_edges") + sum(rows, "wrongful_removals") + sum(rows, "user_violations"),
  };
}
