// JEV configurations B (Choice), C (Noul statements), D (hybrid). Pair-level requests; rubric text is the production rubric (extracted), so definitions are equivalent to the baseline's.
import { RULES, KINDS, isSymmetric } from "./baseline.mjs";
import { shuffled, JEV_MODEL, uuidFor } from "./lib.mjs";
const R = Object.fromEntries(RULES.map((r) => [r.kind, r]));
export const DIRECTIONAL = KINDS.filter((k) => !isSymmetric(k)), SYMMETRIC = KINDS.filter(isSymmetric);
// oriented claims over (first, second)
export const CLAIMS = [...SYMMETRIC.map((k) => ({ id: k, kind: k, src: null })), ...DIRECTIONAL.flatMap((k) => [{ id: `first_${k}_second`, kind: k, src: "first" }, { id: `second_${k}_first`, kind: k, src: "second" }])];
const asAB = (src) => (src === "second" ? "Let A be `second` and B be `first`." : "Let A be `first` and B be `second`.");
const claimText = (cl) => { const r = R[cl.kind]; return `${asAB(cl.src)} Kind: ${cl.kind}. Meaning: ${r.meaning} TEST: ${r.test} Use it only when ${r.accept_when}. Do NOT use it when ${r.reject_when}. ${r.not_instead}`; };
const objView = (o) => ({ title: o.title, body: o.body, kind: o.kind, written_at: o.writtenAt });
// presentation: "lower" = lower id first (like the baseline's first vote), "higher" = reversed
export function pairRequest(first, second, claimedKind, seed) {
  const state = { first: objView(first), second: objView(second) }; if (claimedKind) state.claimed_kind = claimedKind;
  const q = {};
  const choiceKeys = ["none", ...CLAIMS.map((c) => c.id)], order = shuffled(choiceKeys, seed); const criteria = {};
  for (const k of order) criteria[k] = k === "none" ? "No kind's TEST clearly passes for this pair, or two kinds fit and it cannot be told which. Shared topic, project, product or vocabulary is never a relation." : claimText(CLAIMS.find((c) => c.id === k));
  q.relation = { type: "choice", instructions: `Which relation holds between \`first\` and \`second\`, judging only from their own text? Choose none unless a kind's TEST clearly passes.${claimedKind ? " A previous step claimed the kind in `claimed_kind`; do not assume it is right." : ""}`, criteria };
  for (const cl of CLAIMS) q[`n_${cl.id}`] = { type: "noul", instructions: `Does this relation clearly hold? ${claimText(cl)}`, criteria: { true: "The TEST clearly passes using only the two objects' own text.", false: "The TEST does not clearly pass, or the link rests on shared topic, project, product, vocabulary or recency." } };
  q.cancels_first = { type: "noul", instructions: "Does the text of `first` state that ITS OWN plan, task or requirement is cancelled, abandoned or permanently removed?", criteria: { true: "Its own words say it is cancelled, abandoned or permanently removed.", false: "Only postponed, paused, delayed, blocked or lower priority; or merely depends on something cancelled or unavailable; or unsure." } };
  q.cancels_second = { type: "noul", instructions: "Does the text of `second` state that ITS OWN plan, task or requirement is cancelled, abandoned or permanently removed?", criteria: q.cancels_first.criteria };
  q.gone_first = { type: "noul", instructions: "Does the current text of `first` show that its own requirement changed, so that it no longer needs `second`?", criteria: { true: "Its own text shows the requirement itself changed.", false: "`second` is merely unavailable, blocked, rejected, not yet done or failed; or `first` is only postponed, paused or reprioritised; or unsure." } };
  q.gone_second = { type: "noul", instructions: "Does the current text of `second` show that its own requirement changed, so that it no longer needs `first`?", criteria: q.gone_first.criteria };
  q.moot = { type: "noul", instructions: "Does one object's later decision, cancellation, removal of scope or changed priority only make the OTHER object's action or requirement unnecessary, rather than asserting an incompatible current fact?", criteria: { true: "A cancellation or removal makes the other unnecessary; this is not a conflict.", false: "A genuine incompatible assertion, or no cancellation is stated." } };
  return { model: JEV_MODEL, state, questions: q };
}
// ---- reading answers: canonical claims in terms of object keys ----
function claimEdge(cl, firstKey, secondKey) { if (cl.src === null) return { kind: cl.kind, source: firstKey, target: secondKey }; return cl.src === "first" ? { kind: cl.kind, source: firstKey, target: secondKey } : { kind: cl.kind, source: secondKey, target: firstKey }; }
export function read(resp, firstKey, secondKey) {
  const a = resp.answers, ch = a.relation, probs = ch.probabilities, ent = Object.entries(probs).sort((x, y) => y[1] - x[1]);
  const noul = Object.fromEntries(CLAIMS.map((c) => [c.id, a[`n_${c.id}`].noul]));
  return { choice: ch.choice, p1: ent[0][1], p2: ent[1]?.[1] ?? 0, conf: ch.confidence, probs, noul, cancels: { first: a.cancels_first.noul, second: a.cancels_second.noul }, gone: { first: a.gone_first.noul, second: a.gone_second.noul }, moot: a.moot.noul, firstKey, secondKey };
}
const edgeOf = (rd, claimId) => (claimId === "none" ? null : claimEdge(CLAIMS.find((c) => c.id === claimId), rd.firstKey, rd.secondKey));
const reverseId = (cl) => (cl.src === null ? null : cl.src === "first" ? `second_${cl.kind}_first` : `first_${cl.kind}_second`);
const SYMK = new Set(SYMMETRIC);
// Production resolver (resolve.rs) over claim edges for one pair.
function resolveClaims(edges) { let d = []; for (const e of edges) if (!d.some((k) => key(k) === key(e))) d.push(e); if (d.some((e) => e.kind !== "related_to")) d = d.filter((e) => e.kind !== "related_to"); return d.length === 1 ? d[0] : null; }
const key = (e) => { const [s, t] = SYMK.has(e.kind) && e.target < e.source ? [e.target, e.source] : [e.source, e.target]; return `${e.kind}|${s}|${t}`; };

// ---- per-pair assessment under each configuration ----
// A reading `lo`/`hi` = read() of the two presentations. Returns { edge|null, signals }.
export function assessB(lo, th) { const claim = lo.choice; if (claim === "none" || lo.p1 < th.pMin || lo.p1 - lo.p2 < th.margin) return { edge: null, claim }; return { edge: edgeOf(lo, claim), claim }; }
export function assessC(lo, th) {
  const surv = []; for (const cl of CLAIMS) { const s = lo.noul[cl.id]; if (s < th.tau) continue; const rid = reverseId(cl); if (rid && lo.noul[rid] >= th.rev) continue; surv.push(claimEdge(cl, lo.firstKey, lo.secondKey)); }
  return { edge: resolveClaims(surv), survivors: surv };
}
export function assessD(lo, hi, th) {
  const e1 = assessB(lo, { pMin: th.pMin, margin: th.margin }).edge, e2 = assessB(hi, { pMin: th.pMin, margin: th.margin }).edge;
  if (!e1 || !e2 || key(e1) !== key(e2)) return { edge: null, why: e1 || e2 ? "votes_disagree" : "none" };
  const confirm = (rd) => { const cl = CLAIMS.find((c) => edgeKeyOfClaim(c, rd) === key(e1)); if (!cl) return false; if (rd.noul[cl.id] < th.nTau) return false; const rid = reverseId(cl); return !(rid && rd.noul[rid] >= th.rev); };
  if (!confirm(lo) || !confirm(hi)) return { edge: null, why: "noul_guard" };
  if (e1.kind === "contradicts" && (lo.moot >= th.mootTau || hi.moot >= th.mootTau)) return { edge: null, why: "moot_veto" };
  return { edge: e1, why: "accepted" };
}
const edgeKeyOfClaim = (cl, rd) => key(claimEdge(cl, rd.firstKey, rd.secondKey));
// dependent-cancel/gone signals for an edge (depends_on source = dependent), in one reading
const depSignal = (rd, e, which) => { const depIsFirst = e.source === rd.firstKey; return which === "cancel" ? (depIsFirst ? rd.cancels.first : rd.cancels.second) : depIsFirst ? rd.gone.first : rd.gone.second; };
export { key as edgeKey, depSignal, claimEdge };
