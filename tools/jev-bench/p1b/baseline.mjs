// Faithful JS port of the M04.7A multiclass pipeline (graph/integrate.rs + verify.rs + resolve.rs + validate.rs + openai.rs/chat.rs wire format).
// Prompts and kind rubric are EXTRACTED at runtime from the production Rust sources (never retyped), so they cannot drift. Production code is read, never modified.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ROOT } from "../p1a/lib.mjs";

const SRC = join(ROOT, "apps/arthur/src-tauri/src/graph");
const read = (f) => readFileSync(join(SRC, f), "utf8");

// ---- Rust string-literal extraction ----
function literalAfter(src, marker, nth = 0) {
  let i = src.indexOf(marker); if (i < 0) throw new Error("marker not found: " + marker);
  for (let n = 0; n <= nth; n++) { i = src.indexOf('"', i); if (n < nth) { i = endOfLiteral(src, i) + 1; } }
  const end = endOfLiteral(src, i); return unescape(src.slice(i + 1, end));
}
function endOfLiteral(src, start) { for (let j = start + 1; j < src.length; j++) { if (src[j] === "\\") { j++; continue; } if (src[j] === '"') return j; } throw new Error("unterminated literal"); }
function unescape(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]; if (c !== "\\") { out += c; continue; }
    const n = s[++i];
    if (n === "\n") { while (i + 1 < s.length && /\s/.test(s[i + 1])) i++; }
    else if (n === "n") out += "\n"; else if (n === "t") out += "\t"; else if (n === '"') out += '"'; else if (n === "\\") out += "\\"; else if (n === "'") out += "'"; else out += "\\" + n;
  }
  return out;
}
const fmt = (tpl, vars) => tpl.replace(/\{\{|\}\}|\{(\w*)\}/g, (m, k) => (m === "{{" ? "{" : m === "}}" ? "}" : k in vars ? vars[k] : m));

// ---- rubric from semantics.rs ----
export const KINDS = ["related_to", "extends", "depends_on", "contradicts", "derived_from", "duplicates", "supersedes"];
export const SYMMETRIC = ["related_to", "contradicts", "duplicates"];
export const isSymmetric = (k) => SYMMETRIC.includes(k);
const sem = read("semantics.rs");
export const RULES = [...sem.matchAll(/KindRule\s*\{\s*kind:\s*"(\w+)",\s*meaning:\s*(".*?[^\\]"),\s*accept_when:\s*(".*?[^\\]"),\s*reject_when:\s*(".*?[^\\]"),\s*test:\s*(".*?[^\\]"),\s*not_instead:\s*(".*?[^\\]"),\s*\}/gs)].map((m) => ({ kind: m[1], meaning: unescape(m[2].slice(1, -1)), accept_when: unescape(m[3].slice(1, -1)), reject_when: unescape(m[4].slice(1, -1)), test: unescape(m[5].slice(1, -1)), not_instead: unescape(m[6].slice(1, -1)) }));
if (RULES.length !== 7 || RULES.map((r) => r.kind).join() !== KINDS.join()) throw new Error("rubric extraction failed");
export const rubric = () => RULES.map((r) => `- ${r.kind} = ${r.meaning}\n  (${isSymmetric(r.kind) ? "symmetric: the order of A and B does not matter" : "directional: A and B are NOT interchangeable"})\n  Use it only when ${r.accept_when}.\n  Do NOT use it when ${r.reject_when}.\n  TEST: ${r.test}\n  NOT INSTEAD OF: ${r.not_instead}`).join("\n");

// ---- prompts (extracted) ----
const promptRs = read("prompt.rs"), verifyRs = read("verify_prompt.rs");
const MAX_RELATION_PROPOSALS = 20;
export const stageASystem = fmt(literalAfter(promptRs, "pub fn system_prompt() -> String {"), { rubric: rubric(), max: MAX_RELATION_PROPOSALS });
export const stageAFocusSystem = fmt(literalAfter(promptRs, "pub fn focus_system_prompt() -> String {"), { "": stageASystem });
export const stageBSystem = fmt(literalAfter(verifyRs, "pub fn system_prompt() -> String {"), { rubric: rubric() });
export const PROMPT_HASHES = { stageA_focus: sha(stageAFocusSystem), stageB: sha(stageBSystem), rubric: sha(rubric()), sources: { "prompt.rs": sha(promptRs), "verify_prompt.rs": sha(verifyRs), "semantics.rs": sha(sem) } };
function sha(s) { return createHash("sha256").update(s).digest("hex").slice(0, 16); }

// serde_json (BTreeMap): object keys sorted, compact.
function sj(v) { if (Array.isArray(v)) return "[" + v.map(sj).join(",") + "]"; if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + sj(v[k])).join(",") + "}"; return JSON.stringify(v); }
const userMessage = (objects, existing) => `Knowledge objects:\n<<<OBJECTS\n${sj(objects.map((o) => ({ id: o.id, kind: o.kind, title: o.title, body: o.body })))}\nOBJECTS>>>\n\nRelations that already exist:\n<<<EXISTING\n${sj(existing.map((r) => ({ kind: r.kind, sourceObjectId: r.source_object_id, targetObjectId: r.target_object_id })))}\nEXISTING>>>`;
const focusedUserMessage = (objects, existing, focusId) => `${userMessage(objects, existing)}\n\nFocus object id:\n<<<FOCUS\n${JSON.stringify(focusId)}\nFOCUS>>>`;
const KINDS_ENUM = { type: "string", enum: KINDS };
export const stageASchema = { type: "object", additionalProperties: false, required: ["relations"], properties: { relations: { type: "array", items: { type: "object", additionalProperties: false, required: ["sourceObjectId", "targetObjectId", "kind", "reason"], properties: { sourceObjectId: { type: "string" }, targetObjectId: { type: "string" }, kind: KINDS_ENUM, reason: { type: "string" } } } } } };
const SUP = { type: "string", enum: ["strong", "weak", "none"] };
export const stageBSchema = { type: "object", additionalProperties: false, required: ["verdicts"], properties: { verdicts: { type: "array", items: { type: "object", additionalProperties: false, required: ["index", "decision", "kind", "confidence", "firstToSecond", "secondToFirst", "explicitLink", "cancelsOrObsoletes", "cancelledPlan", "dependencyNoLongerRequired", "temporalEvidence"], properties: { index: { type: "integer" }, decision: { type: "string", enum: ["accept", "reclassify", "reject"] }, kind: KINDS_ENUM, confidence: { type: "string", enum: ["high", "medium", "low"] }, firstToSecond: SUP, secondToFirst: SUP, explicitLink: { type: "boolean" }, cancelsOrObsoletes: { type: "boolean" }, cancelledPlan: { type: "string", enum: ["first", "second", "none"] }, dependencyNoLongerRequired: { type: "boolean" }, temporalEvidence: { type: "string" } } } } } };

export const MODELS = { stageA: { model: "gpt-4.1-mini", sampling: { temperature: 0 } }, stageB: { model: "gpt-5-mini", sampling: { reasoning_effort: "low" } } };
export const chatBody = (m, system, user, name, schema) => ({ model: m.model, messages: [{ role: "system", content: system }, { role: "user", content: user }], response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }, ...m.sampling });

// ---- helpers mirroring Rust ----
const canonicalEnds = (kind, s, t) => (isSymmetric(kind) && t < s ? [t, s] : [s, t]);
const identity = (kind, s, t) => { const [a, b] = canonicalEnds(kind, s, t); return `${kind}|${a}|${b}`; };
class InvalidOutput extends Error {}
const norm = (t) => t.normalize("NFD").replace(/́/g, "").normalize("NFC").toLowerCase().normalize("NFC");
const tokens = (t) => norm(t).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const words = (t) => new Set(tokens(t).filter((w) => [...w].length >= 4));
const groundedIn = (ev, obj) => { ev = (ev ?? "").trim(); if (!ev || [...ev].length > 300) return false; const own = words(`${obj.title} ${obj.body}`); return [...words(ev)].filter((w) => own.has(w)).length >= Math.min(own.size, 2); };
const mootGrounded = (ev, s, t) => { ev = (ev ?? "").trim(); if (!ev || [...ev].length > 300) return false; const objs = words(`${s.title} ${s.body} ${t.title} ${t.body}`); return [...words(ev)].some((w) => objs.has(w)); };
function orient(kind, f2s, s2f) {
  if (isSymmetric(kind)) return [true, f2s === "strong" || s2f === "strong" ? "strong" : (f2s === "weak" || s2f === "weak" ? "weak" : "none"), "none"];
  const a = f2s === "strong", b = s2f === "strong";
  if (a && !b) return [true, f2s, s2f]; if (!a && b) return [false, s2f, f2s]; return [true, f2s, s2f];
}
const presented = (c, pres) => { const asc = c.source.id <= c.target.id; const [low, high] = asc ? [c.source, c.target] : [c.target, c.source]; return pres === "lower" ? [low, high] : [high, low]; };
function verifierMessage(cands, pres) {
  const items = cands.map((c) => { const obj = (o) => { const at = o.id === c.source.id ? c.sourceAt : c.targetAt; const v = { id: o.id, kind: o.kind, title: o.title, body: o.body }; if (at) v.writtenAt = at; return v; }; const [first, second] = presented(c, pres); return { index: c.index, first: obj(first), second: obj(second), proposedKind: c.kind }; });
  return `Candidates:\n<<<CANDIDATES\n${sj(items)}\nCANDIDATES>>>`;
}
function parseVerdicts(content, cands, pres) {
  let out; try { out = JSON.parse(content); } catch { throw new InvalidOutput("not the requested structure"); }
  const keys = ["index", "decision", "kind", "confidence", "firstToSecond", "secondToFirst", "explicitLink", "cancelsOrObsoletes", "cancelledPlan", "dependencyNoLongerRequired", "temporalEvidence"];
  if (!out || !Array.isArray(out.verdicts) || Object.keys(out).length !== 1) throw new InvalidOutput("not the requested structure");
  return out.verdicts.map((raw) => {
    if (!raw || Object.keys(raw).length !== keys.length || keys.some((k) => !(k in raw))) throw new InvalidOutput("not the requested structure");
    const c = cands[raw.index]; if (!c) throw new InvalidOutput("index not asked about");
    if (!KINDS.includes(raw.kind)) throw new InvalidOutput("unknown relation kind");
    const [first, second] = presented(c, pres); const [firstIsSource, fwd, rev] = orient(raw.kind, raw.firstToSecond, raw.secondToFirst);
    const [source, target] = firstIsSource ? [first, second] : [second, first];
    const cancelled = raw.cancelledPlan === "first" ? first.id : raw.cancelledPlan === "second" ? second.id : null;
    const lacks = (() => { if ((raw.temporalEvidence ?? "").trim() || (c.kind !== "depends_on" && raw.kind !== "depends_on")) return false; const depCancelled = cancelled && (cancelled === c.source.id || cancelled === source.id); return !!(depCancelled || raw.dependencyNoLongerRequired); })();
    if (lacks) throw new InvalidOutput("actionable signal without evidence");
    return { index: raw.index, decision: raw.decision, kind: raw.kind, sourceId: source.id, targetId: target.id, confidence: raw.confidence, fwd, rev, explicitLink: raw.explicitLink, cancelsOrObsoletes: raw.cancelsOrObsoletes, evidence: (raw.temporalEvidence ?? "").trim() || null, cancelledId: cancelled, noLongerRequired: raw.dependencyNoLongerRequired };
  });
}
const notOlder = (rep, replaced) => { const a = Date.parse(rep.createdAt), b = Date.parse(replaced.createdAt); return Number.isFinite(a) && Number.isFinite(b) && a >= b; };
function judgeAll(cands, verdicts) {
  if (verdicts.length !== cands.length) throw new InvalidOutput("verdict count");
  const by = new Array(cands.length).fill(null);
  for (const v of verdicts) { if (v.index >= by.length || v.index < 0) throw new InvalidOutput("index"); if (by[v.index]) throw new InvalidOutput("duplicate verdict"); by[v.index] = v; }
  return cands.map((c, i) => {
    const v = by[i]; if (!v) throw new InvalidOutput("missing verdict");
    const [a, b] = [c.source.id, c.target.id];
    if (!((v.sourceId === a && v.targetId === b) || (v.sourceId === b && v.targetId === a))) throw new InvalidOutput("object not in candidate");
    const selfContra = v.decision === "accept" ? v.kind !== c.kind : v.decision === "reclassify" ? v.kind === c.kind : false;
    const source = v.sourceId === a ? c.source : c.target, target = v.sourceId === a ? c.target : c.source;
    let rej = null;
    if (v.decision === "reject") rej = "decided"; else if (selfContra) rej = "inconsistent";
    else if (v.kind === "contradicts" && v.cancelsOrObsoletes && mootGrounded(v.evidence, c.source, c.target)) rej = "obsoleted";
    else if (v.confidence !== "high") rej = "not_high"; else if (!v.explicitLink) rej = "no_link"; else if (v.fwd !== "strong") rej = "dir_unsupported";
    else if (!isSymmetric(v.kind) && v.rev === "strong") rej = "dir_ambiguous"; else if (v.kind === "supersedes" && !notOlder(source, target)) rej = "not_newer";
    if (rej) return { keep: false, why: rej };
    const [es, et] = canonicalEnds(v.kind, v.sourceId, v.targetId); return { keep: true, edge: { kind: v.kind, source: es, target: et } };
  });
}
const same = (a, b) => a.keep === b.keep && (a.keep ? identity(a.edge.kind, a.edge.source, a.edge.target) === identity(b.edge.kind, b.edge.source, b.edge.target) : a.why === b.why);
const combine = (votes) => (votes.every((v) => same(v, votes[0])) ? (votes[0].keep ? { t: "keep", edge: votes[0].edge } : { t: "reject" }) : { t: "disagree" });

// resolve.rs
function compat(a, b) {
  if (a === b) return "incompatible"; if (a === "related_to" || b === "related_to") return "subsumes";
  if (a === "duplicates" || b === "duplicates") return "incompatible";
  const p = (x, y) => (a === x && b === y) || (a === y && b === x); if (p("supersedes", "contradicts")) return "overlapping";
  const oneOf = (x, os) => (a === x && os.includes(b)) || (b === x && os.includes(a));
  if (oneOf("supersedes", ["extends", "depends_on", "derived_from"]) || oneOf("contradicts", ["extends", "depends_on", "derived_from"])) return "incompatible"; return "overlapping";
}
function resolve(survivors) {
  let d = []; for (const e of survivors) if (!d.some((k) => identity(k.kind, k.source, k.target) === identity(e.kind, e.source, e.target))) d.push(e);
  if (d.some((e) => e.kind !== "related_to")) d = d.filter((e) => e.kind !== "related_to");
  return d.length === 0 ? { t: "none" } : d.length === 1 ? { t: "persist", edge: d[0] } : { t: "ambiguous", list: d };
}
function validateEdges(objs, edges) {
  const known = new Set(objs.map((o) => o.id)); const seen = new Set(); const out = [];
  for (const e of edges) { if (!KINDS.includes(e.kind)) throw new InvalidOutput("unknown kind"); for (const id of [e.source, e.target]) if (!known.has(id)) throw new InvalidOutput("not supplied"); if (e.source === e.target) throw new InvalidOutput("self relation");
    const [s, t] = canonicalEnds(e.kind, e.source, e.target); const k = `${e.kind}|${s}|${t}`; if (seen.has(k)) throw new InvalidOutput("more than once"); seen.add(k); out.push({ kind: e.kind, source: s, target: t }); }
  return out;
}

// ---- the pipeline. `call(role, body)` -> { content, usage, latency_ms } or throws {kind:"contract"|"provider"} ----
export const MAX_PROPOSALS = 8, MAX_CONTRACT_RETRIES = 2;
export async function decide(ev, call) {
  // ev: { focus, objects:[{id,kind,title,body,createdAt,writtenAt}], existing:[{id,kind,source_object_id,target_object_id,origin}] } (project already filtered)
  const R = { provider_requests: 0, retry_requests: 0, contract_invalid: 0, usage: [], calls: [], proposed: 0, verified: 0, related_suppressed: 0, moot_blocked: 0, moot_removed: 0, dependency_invalidated: 0, dependency_unresolved: 0, ambiguous_pairs: 0 };
  const focusId = ev.focus, objects = ev.objects, byId = Object.fromEntries(objects.map((o) => [o.id, o]));
  const known = new Set(ev.existing.map((r) => identity(r.kind, r.source_object_id, r.target_object_id)));
  const otherEnd = (e) => (e.source === focusId ? e.target : e.source);
  const revalidate = ev.existing.filter((r) => r.origin === "model" && (r.source_object_id === focusId || r.target_object_id === focusId)).slice(0, 8);
  const typedExisting = new Set(ev.existing.filter((r) => r.kind !== "related_to" && (r.source_object_id === focusId || r.target_object_id === focusId)).map((r) => (r.source_object_id === focusId ? r.target_object_id : r.source_object_id)));
  let fresh = [], typedClaimed = new Set();
  const note = (role, out) => { R.calls.push({ role, ...out.meta }); if (out.usage) R.usage.push({ role, ...out.usage }); };
  if (objects.length >= 2) {
    R.provider_requests++;
    const out = await call("A", chatBody(MODELS.stageA, stageAFocusSystem, focusedUserMessage(objects, ev.existing, focusId), "relations", stageASchema)); note("A", out);
    let parsed; try { parsed = JSON.parse(out.content); if (!Array.isArray(parsed.relations)) throw 0; } catch { throw new InvalidOutput("stage A not the requested structure"); }
    if (parsed.relations.length > MAX_RELATION_PROPOSALS) throw new InvalidOutput("too many proposals");
    const claims = validateEdges(objects, parsed.relations.map((p) => ({ kind: p.kind, source: p.sourceObjectId, target: p.targetObjectId })));
    const onFocus = claims.filter((e) => e.source === focusId || e.target === focusId); R.proposed = onFocus.length; R.stageA_edges = onFocus;
    for (const e of onFocus) if (e.kind !== "related_to") typedClaimed.add(otherEnd(e));
    const nw = onFocus.filter((e) => !known.has(identity(e.kind, e.source, e.target))); fresh = nw.slice(0, MAX_PROPOSALS);
  }
  const toVerify = []; const mk = (e, kind) => ({ index: toVerify.length, source: byId[e.source], target: byId[e.target], kind, sourceAt: byId[e.source].writtenAt, targetAt: byId[e.target].writtenAt });
  for (const e of fresh) toVerify.push(mk(e, e.kind));
  const firstReval = toVerify.length;
  for (const r of revalidate) toVerify.push(mk({ source: r.source_object_id, target: r.target_object_id }, r.kind));
  R.verified = toVerify.length;
  if (!toVerify.length) return { add: [], remove: [], report: R };
  async function pass(pres) {
    let retries = 0;
    for (;;) {
      R.provider_requests += retries === 0 ? 1 : 0;
      try { const out = await call("B", chatBody(MODELS.stageB, stageBSystem, verifierMessage(toVerify, pres), "relation_verdicts", stageBSchema)); note("B", out); return parseVerdicts(out.content, toVerify, pres); }
      catch (e) { if (e instanceof InvalidOutput || e.kind === "contract") { if (retries < MAX_CONTRACT_RETRIES) { retries++; R.contract_invalid++; R.retry_requests++; continue; } throw new InvalidOutput("stage B contract failures exhausted"); } throw e; }
    }
  }
  const first = await pass("lower"), second = await pass("higher");
  const signals = [[], []];
  [first, second].forEach((verdicts, vote) => { toVerify.forEach((_, i) => (signals[vote][i] = { cancelled: false, gone: false })); for (const v of verdicts) { const c = toVerify[v.index]; if (!c || v.kind !== "depends_on") continue; const dep = v.index >= firstReval ? c.source : v.sourceId === c.source.id ? c.source : c.target; signals[vote][v.index] = { cancelled: v.cancelledId === dep.id && groundedIn(v.evidence, dep), gone: v.noLongerRequired && groundedIn(v.evidence, dep) }; } });
  const votes = [judgeAll(toVerify, first), judgeAll(toVerify, second)];
  const survivors = new Map(), supported = new Set(), removedDeps = new Set(), heldDeps = new Set(), noNew = new Set();
  const push = (k, e) => { if (!survivors.has(k)) survivors.set(k, []); survivors.get(k).push(e); };
  for (let p = 0; p < toVerify.length; p++) {
    const outcome = combine(votes.map((v) => v[p]));
    if (p < firstReval) {
      if (outcome.t === "keep") {
        const e = outcome.edge;
        if (e.kind === "related_to" && toVerify[p].kind !== "related_to") { R.related_suppressed++; continue; }
        if (e.kind === "depends_on" && (signals[0][p].cancelled || signals[1][p].cancelled)) { R.moot_blocked++; continue; }
        push(otherEnd(e), e);
      }
      continue;
    }
    const rel = revalidate[p - firstReval]; const pair = rel.source_object_id === focusId ? rel.target_object_id : rel.source_object_id;
    if (rel.kind !== "depends_on") { if (outcome.t === "keep") { if (identity(outcome.edge.kind, outcome.edge.source, outcome.edge.target) === identity(rel.kind, rel.source_object_id, rel.target_object_id)) supported.add(rel.id); push(otherEnd(outcome.edge), outcome.edge); } continue; }
    const mine = identity(rel.kind, rel.source_object_id, rel.target_object_id);
    const supports = votes.filter((v) => v[p].keep && identity(v[p].edge.kind, v[p].edge.source, v[p].edge.target) === mine).length;
    const cancelledBoth = signals[0][p].cancelled && signals[1][p].cancelled, goneBoth = supports === 0 && signals[0][p].gone && signals[1][p].gone;
    if (cancelledBoth) { removedDeps.add(rel.id); noNew.add(pair); R.moot_removed++; }
    else if (goneBoth) { removedDeps.add(rel.id); R.dependency_invalidated++; }
    else if (supports === votes.length) { supported.add(rel.id); if (outcome.t === "keep") push(otherEnd(outcome.edge), outcome.edge); }
    else { heldDeps.add(rel.id); noNew.add(pair); R.dependency_unresolved++; }
  }
  const pairs = new Set([...survivors.keys(), ...revalidate.map((r) => (r.source_object_id === focusId ? r.target_object_id : r.source_object_id))]);
  const add = [], remove = [];
  for (const pair of [...pairs].sort()) {
    const here = revalidate.filter((r) => (r.source_object_id === focusId ? r.target_object_id : r.source_object_id) === pair);
    const res = resolve(survivors.get(pair) ?? []); const kept = [];
    if (res.t === "persist") {
      const e = res.edge; const same = here.find((r) => identity(r.kind, r.source_object_id, r.target_object_id) === identity(e.kind, e.source, e.target));
      if (same) kept.push(same); else if (e.kind === "related_to" && (typedClaimed.has(pair) || typedExisting.has(pair))) R.related_suppressed++; else if (!known.has(identity(e.kind, e.source, e.target)) && !noNew.has(pair)) add.push(e);
    } else if (res.t === "ambiguous") { R.ambiguous_pairs++; kept.push(...here.filter((r) => supported.has(r.id))); }
    for (const r of here) { if (removedDeps.has(r.id)) remove.push(r.id); else if (heldDeps.has(r.id) || kept.some((k) => k.id === r.id)) continue; else remove.push(r.id); }
  }
  return { add: validateEdges(objects, add), remove, report: R };
}
export { InvalidOutput };
