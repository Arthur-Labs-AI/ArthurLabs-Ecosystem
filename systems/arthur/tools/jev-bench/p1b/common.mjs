import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCorpus, prepare, scoreEvent, aggregate, RES } from "./lib.mjs";
import { read } from "./jev.mjs";
import { decideJev } from "./decide.mjs";
export const rd = (n) => JSON.parse(readFileSync(join(RES, n), "utf8"));
export const corpus = loadCorpus(); export const byId = Object.fromEntries(corpus.cases.map((c) => [c.id, c]));
// jev raw -> { [id]: { [rep]: { [otherKey]: {lo,hi} } } }  (readings only for fully answered pairs)
export function readings(raw) {
  const out = {};
  for (const r of raw.records) { if (!r.response) continue; const rep = ((out[r.id] ??= {})[r.rep] ??= {}); (rep[r.other] ??= {})[r.pres] = read(r.response, r.firstKey, r.secondKey); }
  return out;
}
export function jevDecisions(cfg, raw, th, filter = () => true, rep = 1) {
  const rds = readings(raw), out = [];
  for (const c of corpus.cases.filter(filter)) { const m = rds[c.id]?.[rep]; if (!m) continue; const p = prepare(c); out.push({ c, d: decideJev(cfg, c, p, m, th) }); }
  return out;
}
export function baselineDecisions(raw, filter = () => true, rep = 1) {
  return raw.records.filter((r) => r.rep === rep && filter(byId[r.id])).map((r) => ({ c: byId[r.id], d: { add: r.add, remove: r.remove, failed: r.failed } }));
}
export const scoreAll = (decs) => decs.map(({ c, d }) => ({ c, d, s: scoreEvent(c, d) }));
