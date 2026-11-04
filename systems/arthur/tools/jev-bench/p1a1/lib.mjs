// Phase 1A.1: P1A request + reframing-guard questions; policy composition (gate -> project boundary -> guard).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
export * from "../p1a/lib.mjs";
import { jevRequest, noulDecide, choiceDecide, hybridDecide, BENCH, shuffled } from "../p1a/lib.mjs";

export const HERE1 = dirname(fileURLToPath(import.meta.url));
export const RES1 = join(BENCH, "results", "p1a1"); mkdirSync(RES1, { recursive: true });
export const BUDGET1_USD = 0.25; // fixed Phase 1A.1 ceiling (own ledger)
const LEDGER1 = join(RES1, "ledger.json");
export const ledger1 = () => (existsSync(LEDGER1) ? JSON.parse(readFileSync(LEDGER1, "utf8")) : { spent_usd: 0, entries: [] });
export function chargeCheck1(est) { const l = ledger1(); if (l.spent_usd + est > BUDGET1_USD) { console.error(`Budget guard: $${l.spent_usd.toFixed(4)} + est $${est.toFixed(4)} > $${BUDGET1_USD}. Stopping.`); process.exit(3); } }
export function charge1(label, usd, requests) { const l = ledger1(); l.spent_usd += usd; l.entries.push({ label, usd, requests, at: new Date().toISOString() }); writeFileSync(LEDGER1, JSON.stringify(l, null, 1)); }
export function loadCorpus1() { const raw = readFileSync(join(BENCH, "corpus-p1a1.json"), "utf8"); return { ...JSON.parse(raw), sha256: createHash("sha256").update(raw).digest("hex") }; }
export const P1A_FROZEN = () => JSON.parse(readFileSync(join(BENCH, "results", "p1a", "thresholds-frozen.json"), "utf8")).thresholds;

// ---- guard questions (added to the unchanged P1A identity request) ----
const REDEF_TRUE = "It changes what the existing idea fundamentally is, what it is for, who it is for, or how broadly it applies; or it inverts the role of the idea.";
const REDEF_FALSE = "It only continues, corrects or replaces a detail, value, date, name, vendor or implementation choice of the idea, or it is about a different idea.";
const KIND = {
  detail_update: "`new_capture` continues, corrects or replaces a detail, value, date, name, vendor or implementation choice of `existing_ideas[I]`; the idea stays what it was.",
  reframing: "`new_capture` changes what `existing_ideas[I]` fundamentally is, what it is for, who it is for, or how broadly it applies; or inverts its role.",
  other: "`new_capture` is about a different idea, or its relation to `existing_ideas[I]` is unclear.",
};
export function jevRequest1(c, orderSeed) {
  const { body, option_order } = jevRequest(c, orderSeed);
  c.candidates.forEach((_, i) => {
    body.questions[`redef_${i}`] = { type: "noul", instructions: `Does \`new_capture\` substantially redefine the identity, purpose or scope of \`existing_ideas[${i}]\`, such that updating that idea automatically would change what it fundamentally is?`, criteria: { true: REDEF_TRUE, false: REDEF_FALSE } };
    const keys = shuffled(Object.keys(KIND), `${c.id}|${orderSeed}|kind${i}`);
    const criteria = {}; for (const k of orderSeed === "FIXED" ? Object.keys(KIND) : keys) criteria[k] = KIND[k].replaceAll("[I]", `[${i}]`);
    body.questions[`kind_${i}`] = { type: "choice", instructions: `What kind of change does \`new_capture\` make to \`existing_ideas[${i}]\`?`, criteria };
  });
  return { body, option_order };
}
export const guardScores = (answers, i) => ({ redef: answers?.[`redef_${i}`]?.noul ?? null, kindReframing: answers?.[`kind_${i}`]?.probabilities?.reframing ?? null });

// ---- LLM reframing question (exploratory comparison only) ----
export const LLM_GUARD_SYSTEM = `You judge one thing. Given an existing idea and a new capture, does the new capture substantially redefine the identity, purpose or scope of the existing idea (what it fundamentally is, what it is for, who it is for, how broadly it applies, or its role), as opposed to only continuing, correcting or replacing a detail, value, date, name, vendor or implementation choice? Answer JSON only: {"redefines": true|false}.`;
export function llmGuardRequest(c, i, model) { return { model, temperature: 0, max_tokens: 20, response_format: { type: "json_object" }, messages: [{ role: "system", content: LLM_GUARD_SYSTEM }, { role: "user", content: JSON.stringify({ existing_idea: c.candidates[i], new_capture: c.new_capture }) }] }; }
export const relevantIdx = (c) => (c.expected === "REVISE" ? c.target : c.reframing ? 0 : null);

// ---- policy: gate -> project boundary -> reframing guard ----
// P = { base: "hybrid"|"choice", boundary: bool, gn: number|null, gc: number|null }
export function policy(c, answers, P, th) {
  const n = noulDecide(answers, c.candidates.length, th), ch = choiceDecide(answers, th);
  const g = P.base === "hybrid" ? hybridDecide(n, ch) : { decision: ch.decision, target: ch.target };
  if (g.decision == null) return { decision: null, target: null };
  if (g.decision !== "REVISE") return { decision: g.decision, target: null, by: "gate" };
  const t = g.target;
  if (P.boundary && c.candidates[t].project !== c.new_capture.project) return { decision: "NEW", target: null, by: "project_boundary" };
  const gs = guardScores(answers, t);
  if (P.gn != null && gs.redef != null && gs.redef >= P.gn) return { decision: "UNCERTAIN", target: null, by: "guard_noul" };
  if (P.gc != null && gs.kindReframing != null && gs.kindReframing >= P.gc) return { decision: "UNCERTAIN", target: null, by: "guard_choice" };
  return { decision: "REVISE", target: t, by: "accepted" };
}

export const GUARD_OBJECTIVE = "On dev, undisputed cases, first request per case: choose the threshold with the highest sensitivity on reframing=true cases subject to a false-alarm rate <= 20% on correct-target REVISE cases; ties -> higher threshold (more recall). Declared before any data was seen.";
