// JEV Phase 0 identity-resolution harness: shared request building + offline scoring.
// Benchmark-only. No dependency on Arthur production code. No credentials handled here.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const PRICE_PER_INPUT_TOKEN = 0.042 / 1e6; // docs.typesafe.ai/models: $42 / Btok, output free

// ---- Fixed, pre-declared decision policy (not tuned on the corpus) ----
export const POLICY = {
  noulRevise: 0.8,        // max-candidate noul >= this AND only one candidate > 0.5  -> REVISE
  noulNew: 0.3,           // max-candidate noul <= this                              -> NEW
  noulMulti: 0.5,         // >=2 candidates above this                               -> UNCERTAIN
  choiceMinConfidence: 0.5, // gated choice: below this -> UNCERTAIN
};

export const ORDERS = {
  A: ["REVISE", "NEW", "UNCERTAIN"],
  B: ["NEW", "UNCERTAIN", "REVISE"],
};

const CHOICE_CRITERIA = {
  REVISE: "`new_capture` continues, corrects, extends or replaces exactly one specific idea in `existing_ideas`, and it is clear which one.",
  NEW: "`new_capture` is a different idea from every idea in `existing_ideas`, even if it shares the topic, project, product, screen or wording.",
  UNCERTAIN: "From the text alone it cannot be determined whether `new_capture` updates an existing idea, or which of several existing ideas it refers to.",
};

export function loadCorpus(path) {
  const raw = readFileSync(path, "utf8");
  const corpus = JSON.parse(raw);
  return { ...corpus, sha256: createHash("sha256").update(raw).digest("hex") };
}

export function buildRequest(c, order, model) {
  const state = {
    existing_ideas: c.existing.map((e, i) => ({ id: `idea_${i}`, project: e.project, text: e.text })),
    new_capture: { project: c.new.project, text: c.new.text },
  };
  const questions = {};
  c.existing.forEach((_, i) => {
    questions[`same_idea_${i}`] = {
      type: "noul",
      instructions: `Is \`new_capture\` a continuation, correction, extension or replacement of the SAME underlying idea as \`existing_ideas[${i}]\`?`,
      criteria: {
        true: "It is about the same specific idea and would update it.",
        false: "It only shares a topic, project, product or vocabulary but is a different idea, task or requirement, or the link is unclear.",
      },
    };
  });
  const criteria = {};
  for (const k of ORDERS[order]) criteria[k] = CHOICE_CRITERIA[k];
  questions.relation = {
    type: "choice",
    instructions: "How does `new_capture` relate to `existing_ideas`?",
    criteria,
  };
  return { state, model, questions };
}

// ---- Decisions ----
export function noulDecision(answers, nCand, p = POLICY) {
  const scores = [];
  for (let i = 0; i < nCand; i++) scores.push(answers?.[`same_idea_${i}`]?.noul);
  if (scores.some((s) => typeof s !== "number")) return { decision: null, scores };
  const max = Math.max(...scores);
  const above = scores.filter((s) => s > p.noulMulti).length;
  let decision;
  if (max >= p.noulRevise) decision = above >= 2 ? "UNCERTAIN" : "REVISE";
  else if (max <= p.noulNew) decision = "NEW";
  else decision = "UNCERTAIN";
  return { decision, scores, max };
}

export function choiceDecision(answers, p = POLICY) {
  const a = answers?.relation;
  if (!a || typeof a.choice !== "string" || !["REVISE", "NEW", "UNCERTAIN"].includes(a.choice)) return { decision: null };
  const gated = a.confidence < p.choiceMinConfidence ? "UNCERTAIN" : a.choice;
  return { decision: a.choice, gated, confidence: a.confidence, probabilities: a.probabilities };
}

export function hybridDecision(n, c) {
  if (!n || !c) return null;
  if (n === "REVISE" && c === "REVISE") return "REVISE";
  if (n === "NEW" && c === "NEW") return "NEW";
  return "UNCERTAIN";
}

// ---- Scoring (offline, deterministic) ----
const LABELS = ["REVISE", "NEW", "UNCERTAIN"];
const pct = (x) => (x == null ? "n/a" : (100 * x).toFixed(1) + "%");
export { pct };

export function confusion(rows) {
  const m = Object.fromEntries(LABELS.map((e) => [e, Object.fromEntries([...LABELS, "ERROR"].map((p) => [p, 0]))]));
  for (const r of rows) m[r.expected][r.predicted ?? "ERROR"]++;
  return m;
}

export function metrics(rows) {
  const m = confusion(rows);
  const predicted = (l) => LABELS.reduce((s, e) => s + m[e][l], 0);
  const expectedN = (l) => Object.values(m[l]).reduce((a, b) => a + b, 0);
  const falseMerges = rows.filter((r) => r.predicted === "REVISE" && r.expected !== "REVISE");
  const nonRevise = rows.filter((r) => r.expected !== "REVISE").length;
  const ratio = (a, b) => (b === 0 ? null : a / b);
  return {
    n: rows.length,
    confusion: m,
    revise_precision: ratio(m.REVISE.REVISE, predicted("REVISE")),
    revise_recall: ratio(m.REVISE.REVISE, expectedN("REVISE")),
    new_precision: ratio(m.NEW.NEW, predicted("NEW")),
    new_recall: ratio(m.NEW.NEW, expectedN("NEW")),
    uncertain_precision: ratio(m.UNCERTAIN.UNCERTAIN, predicted("UNCERTAIN")),
    uncertain_recall: ratio(m.UNCERTAIN.UNCERTAIN, expectedN("UNCERTAIN")),
    false_merges: falseMerges.length,
    false_merge_rate: ratio(falseMerges.length, nonRevise), // of all expected NEW/UNCERTAIN rows
    false_merge_on_new: rows.filter((r) => r.predicted === "REVISE" && r.expected === "NEW").length,
    false_merge_on_uncertain: rows.filter((r) => r.predicted === "REVISE" && r.expected === "UNCERTAIN").length,
    errors: rows.filter((r) => r.predicted == null).length,
    accuracy: ratio(rows.filter((r) => r.predicted === r.expected).length, rows.length),
  };
}

// Flatten raw records -> per-mechanism rows
export function flatten(records, corpus) {
  const byId = Object.fromEntries(corpus.cases.map((c) => [c.id, c]));
  const out = [];
  for (const rec of records) {
    const c = byId[rec.case_id];
    const row = { run: rec.run, order: rec.order, case_id: rec.case_id, expected: c.expected, lang: c.lang, ok: !!rec.response };
    if (rec.response) {
      const n = noulDecision(rec.response.answers, c.existing.length);
      const ch = choiceDecision(rec.response.answers);
      Object.assign(row, {
        noul: n.decision, noul_scores: n.scores, noul_max: n.max,
        choice: ch.decision, choice_gated: ch.gated, choice_conf: ch.confidence, choice_probs: ch.probabilities,
        hybrid: hybridDecision(n.decision, ch.decision),
        model: rec.response.model, input_tokens: rec.response.usage?.input_tokens, output_tokens: rec.response.usage?.output_tokens,
      });
    }
    row.latency_ms = rec.latency_ms; row.attempts = rec.attempts; row.error = rec.error ?? null;
    out.push(row);
  }
  return out;
}

const MECHS = { noul: "Noul", choice: "Choice (raw argmax)", choice_gated: "Choice (conf<0.5 -> UNCERTAIN)", hybrid: "Hybrid (Noul∧Choice agree, else UNCERTAIN)" };
const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };

export function analyse(records, corpus) {
  const rows = flatten(records, corpus);
  const res = { mechanisms: {}, by_language: {}, consistency: {}, agreement: {}, ops: {}, false_merge_cases: [] };
  for (const mech of Object.keys(MECHS)) {
    const mrows = rows.map((r) => ({ expected: r.expected, predicted: r[mech] ?? null, lang: r.lang, r }));
    res.mechanisms[mech] = metrics(mrows);
    res.by_language[mech] = {};
    for (const lang of ["en", "bg", "mixed"]) res.by_language[mech][lang] = (({ n, accuracy, false_merges }) => ({ n, accuracy, false_merges }))(metrics(mrows.filter((x) => x.lang === lang)));
    for (const x of mrows) if (x.predicted === "REVISE" && x.expected !== "REVISE") {
      res.false_merge_cases.push({ mech, case_id: x.r.case_id, expected: x.expected, run: x.r.run, order: x.r.order, noul_scores: x.r.noul_scores, choice_probs: x.r.choice_probs, choice_conf: x.r.choice_conf });
    }
  }
  // consistency across repeated runs (same order): identical decision in every run?
  const key = (r) => `${r.case_id}|${r.order}`;
  const groups = {};
  for (const r of rows.filter((x) => x.ok)) (groups[key(r)] ??= []).push(r);
  for (const mech of ["noul", "choice"]) {
    let same = 0, tot = 0, maxNoulDiff = 0, maxProbDiff = 0, bitIdentical = 0;
    for (const g of Object.values(groups)) {
      if (g.length < 2) continue;
      tot++;
      if (new Set(g.map((r) => r[mech])).size === 1) same++;
      if (mech === "noul") for (const i in g[0].noul_scores) { const v = g.map((r) => r.noul_scores[i]); maxNoulDiff = Math.max(maxNoulDiff, Math.max(...v) - Math.min(...v)); }
      if (mech === "choice") for (const k of ["REVISE", "NEW", "UNCERTAIN"]) { const v = g.map((r) => r.choice_probs?.[k] ?? 0); maxProbDiff = Math.max(maxProbDiff, Math.max(...v) - Math.min(...v)); }
      if (g.every((r) => JSON.stringify([r.noul_scores, r.choice_probs]) === JSON.stringify([g[0].noul_scores, g[0].choice_probs]))) bitIdentical++;
    }
    res.consistency[mech] = { groups: tot, identical_decision: same, ...(mech === "noul" ? { max_noul_range: maxNoulDiff } : { max_prob_range: maxProbDiff }), bit_identical_groups: bitIdentical };
  }
  // order sensitivity (choice A vs B, same run & case)
  const ab = {};
  for (const r of rows.filter((x) => x.ok)) (ab[`${r.run}|${r.case_id}`] ??= {})[r.order] = r;
  const pairs = Object.values(ab).filter((p) => p.A && p.B);
  res.agreement.choice_order_AB = { pairs: pairs.length, same: pairs.filter((p) => p.A.choice === p.B.choice).length, flipped_cases: [...new Set(pairs.filter((p) => p.A.choice !== p.B.choice).map((p) => p.A.case_id))] };
  const ok = rows.filter((r) => r.ok);
  res.agreement.noul_vs_choice = { n: ok.length, same: ok.filter((r) => r.noul === r.choice).length, disagreements: {} };
  for (const r of ok.filter((r) => r.noul !== r.choice)) { const k = r.case_id; (res.agreement.noul_vs_choice.disagreements[k] ??= []).push(`${r.run}${r.order}:noul=${r.noul}/choice=${r.choice}`); }
  // ops
  const lat = ok.map((r) => r.latency_ms);
  const inTok = ok.reduce((s, r) => s + (r.input_tokens ?? 0), 0);
  res.ops = {
    requests: rows.length, ok: ok.length, failed: rows.length - ok.length,
    errors: rows.filter((r) => r.error).map((r) => ({ case_id: r.case_id, run: r.run, order: r.order, error: r.error })),
    retried_requests: rows.filter((r) => (r.attempts ?? 1) > 1).length,
    models: [...new Set(ok.map((r) => r.model))],
    latency_ms: { p50: q(lat, 0.5), p95: q(lat, 0.95), max: lat.length ? Math.max(...lat) : null, mean: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null },
    input_tokens: inTok, output_tokens: ok.reduce((s, r) => s + (r.output_tokens ?? 0), 0),
    cost_usd: inTok * PRICE_PER_INPUT_TOKEN,
  };
  return { rows, ...res };
}

export function renderMarkdown(a, meta, corpus) {
  const L = [];
  L.push(`# JEV Phase 0 — Identity Resolution Canary Report`, "");
  L.push(`- Run id: \`${meta.run_id}\`  |  Models resolved: ${a.ops.models.map((m) => `\`${m}\``).join(", ") || "none"}  |  Requested: \`${meta.model}\``);
  L.push(`- Corpus: ${corpus.corpus_version}, sha256 \`${corpus.sha256.slice(0, 16)}…\`, ${corpus.cases.length} cases × ${meta.runs} runs × ${meta.orders.length} choice-orders`);
  L.push(`- Policy (fixed before running, not tuned): ${JSON.stringify(POLICY)}`, "");
  L.push(`## Headline (all runs pooled; ${a.rows.length} requests)`, "", `| Mechanism | Accuracy | REVISE prec. | NEW prec. | UNCERTAIN recall | False merges (of non-REVISE rows) | on NEW | on UNCERTAIN |`, `|---|---|---|---|---|---|---|---|`);
  for (const [k, name] of Object.entries(MECHS)) { const m = a.mechanisms[k]; L.push(`| ${name} | ${pct(m.accuracy)} | ${pct(m.revise_precision)} | ${pct(m.new_precision)} | ${pct(m.uncertain_recall)} | ${m.false_merges} (${pct(m.false_merge_rate)}) | ${m.false_merge_on_new} | ${m.false_merge_on_uncertain} |`); }
  L.push("", "## Confusion matrices (rows = expected, columns = predicted)", "");
  for (const [k, name] of Object.entries(MECHS)) { const m = a.mechanisms[k].confusion; L.push(`**${name}**`, "", `| expected \\ predicted | REVISE | NEW | UNCERTAIN | ERROR |`, `|---|---|---|---|---|`); for (const e of ["REVISE", "NEW", "UNCERTAIN"]) L.push(`| ${e} | ${m[e].REVISE} | ${m[e].NEW} | ${m[e].UNCERTAIN} | ${m[e].ERROR} |`); L.push(""); }
  L.push("## False merges (predicted REVISE, expected NEW/UNCERTAIN)", "");
  if (!a.false_merge_cases.length) L.push("None.", ""); else { L.push(`| mechanism | case | expected | run/order | noul scores | choice probs | choice conf |`, `|---|---|---|---|---|---|---|`); for (const f of a.false_merge_cases) L.push(`| ${f.mech} | ${f.case_id} | ${f.expected} | ${f.run}${f.order} | ${JSON.stringify(f.noul_scores)} | ${JSON.stringify(f.choice_probs)} | ${f.choice_conf} |`); L.push(""); }
  L.push("## By language (accuracy, false merges)", "", `| Mechanism | en | bg | mixed |`, `|---|---|---|---|`);
  for (const [k, name] of Object.entries(MECHS)) { const b = a.by_language[k]; L.push(`| ${name} | ${["en", "bg", "mixed"].map((l) => `${pct(b[l].accuracy)} (FM ${b[l].false_merges})`).join(" | ")} |`); }
  L.push("", "## Consistency & agreement", "", "```json", JSON.stringify({ consistency: a.consistency, agreement: a.agreement }, null, 1), "```", "");
  L.push("## Per-case scores (run 1, order A)", "", `| id | exp | lang | noul scores | noul→ | choice P(R/N/U) | conf | choice→ |`, `|---|---|---|---|---|---|---|---|`);
  for (const r of a.rows.filter((x) => x.run === 1 && x.order === "A" && x.ok)) { const p = r.choice_probs ?? {}; L.push(`| ${r.case_id} | ${r.expected} | ${r.lang} | ${r.noul_scores.map((s) => s.toFixed(2)).join(", ")} | ${r.noul} | ${["REVISE", "NEW", "UNCERTAIN"].map((k) => (p[k] ?? 0).toFixed(2)).join("/")} | ${r.choice_conf?.toFixed(2)} | ${r.choice} |`); }
  L.push("", "## Operations", "", "```json", JSON.stringify(a.ops, null, 1), "```", "");
  return L.join("\n");
}
