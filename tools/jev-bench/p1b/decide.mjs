// Offline event-level decisions for the JEV configurations from cached pair readings.
import { assessB, assessC, assessD, edgeKey, depSignal, CLAIMS, claimEdge } from "./jev.mjs";
const same = (a, b) => edgeKey(a) === edgeKey(b);
// readings: { [otherKey]: { lo, hi } }  (read() objects). cfg in "B"|"C"|"D".
export function decideJev(cfg, c, prep, readings, th) {
  const add = [], remove = [], keyOf = prep.keyOf; const objAt = Object.fromEntries(prep.objects.map((o) => [o.key, o.writtenAt]));
  const exEdge = (r) => ({ kind: r.kind, source: keyOf[r.source_object_id], target: keyOf[r.target_object_id], idx: r.idx, origin: r.origin });
  const exAll = prep.existing.map(exEdge);
  const known = new Set(exAll.map(edgeKey));
  for (const [k, rd] of Object.entries(readings)) {
    const { lo, hi } = rd; if (!lo) continue;
    const here = exAll.filter((r) => r.origin === "model" && ((r.source === "F" && r.target === k) || (r.target === "F" && r.source === k)));
    const typedExisting = exAll.some((r) => r.kind !== "related_to" && ((r.source === "F" && r.target === k) || (r.target === "F" && r.source === k)));
    let e = null, why = null, held = false;
    if (cfg === "B") e = assessB(lo, th).edge;
    else if (cfg === "C") e = assessC(lo, th).edge;
    else { const a = assessD(lo, hi, th); e = a.edge; why = a.why; }
    if (cfg === "D" && e && e.kind === "supersedes" && !(Date.parse(objAt[e.source]) >= Date.parse(objAt[e.target]))) e = null;
    // --- revalidation of existing model edges on this pair
    for (const r of here) {
      let keepIt;
      if (cfg === "C") { const cl = CLAIMS.find((x) => edgeKey(claimEdge(x, lo.firstKey, lo.secondKey)) === edgeKey(r)); keepIt = !!cl && lo.noul[cl.id] >= th.keep && !(cl.src && lo.noul[(cl.src === "first" ? `second_${cl.kind}_first` : `first_${cl.kind}_second`)] >= th.rev); }
      else if (cfg === "B") keepIt = !!e && same(e, r) || (assessB(lo, { pMin: 0, margin: 0 }).edge && same(assessB(lo, { pMin: 0, margin: 0 }).edge, r));
      else if (r.kind === "depends_on") {
        const sup = [lo, hi].filter((x) => { const q = assessB(x, { pMin: th.pMin, margin: th.margin }).edge; return q && same(q, r); }).length;
        const cancelBoth = depSignal(lo, r, "cancel") >= th.cancelTau && depSignal(hi, r, "cancel") >= th.cancelTau;
        const goneBoth = sup === 0 && depSignal(lo, r, "gone") >= th.goneTau && depSignal(hi, r, "gone") >= th.goneTau;
        if (sup === 2) keepIt = true; else if (cancelBoth || goneBoth) keepIt = false; else { keepIt = true; held = true; }
      } else keepIt = !!e && same(e, r);
      if (!keepIt) remove.push(r.idx);
    }
    // --- new edge
    if (!e) continue;
    if (known.has(edgeKey(e))) continue;
    if (e.kind === "related_to" && typedExisting) continue;
    if (cfg === "D") {
      if (held) continue;
      if (e.kind === "depends_on" && (depSignal(lo, e, "cancel") >= th.cancelTau || depSignal(hi, e, "cancel") >= th.cancelTau)) continue; // never a new dependency of a plan its own text cancels
    }
    add.push({ kind: e.kind, source: e.source, target: e.target });
  }
  return { add: add.slice(0, 8), remove, failed: false };
}
export const DEFAULT_TH = { B: { pMin: 0.5, margin: 0 }, C: { tau: 0.8, rev: 0.3, keep: 0.5 }, D: { pMin: 0.7, margin: 0.4, nTau: 0.8, rev: 0.3, cancelTau: 0.7, goneTau: 0.7, mootTau: 0.5 } };
