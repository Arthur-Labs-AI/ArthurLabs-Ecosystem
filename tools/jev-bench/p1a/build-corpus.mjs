// Builds corpus-p1a.json from p1a/src/g*.mjs. Split assignment is a seeded hash stratified by category (fixed here, before any outputs).
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import g1 from "./src/g1.mjs"; import g2 from "./src/g2.mjs"; import g3 from "./src/g3.mjs";
const all = [...g1, ...g2, ...g3];
const SEED = "jev-p1a-split-v1";
const h = (s) => createHash("sha256").update(SEED + s).digest("hex");
const cases = all.map((x, i) => ({
  id: `P${String(i + 1).padStart(3, "0")}`, category: x.cat, lang: x.lang, expected: x.label, target: x.target ?? null, disputed: !!x.disputed,
  candidates: x.cands.map(([project, text], k) => ({ id: `idea_${k}`, project, text })), new_capture: { project: x.nw[0], text: x.nw[1] }, rationale: x.why,
}));
// stratified: within each category, sort by hash, alternate dev/holdout
const byCat = {};
for (const c of cases) (byCat[c.category] ??= []).push(c);
for (const list of Object.values(byCat)) { list.sort((a, b) => h(a.id).localeCompare(h(b.id))); list.forEach((c, i) => (c.split = i % 2 === 0 ? "dev" : "holdout")); }
const sorted = cases.sort((a, b) => a.id.localeCompare(b.id));
const out = { corpus_version: "identity-p1a-1", note: "Labels, targets, rationales and disputed flags fixed before any model output. Phase 0 canary cases are not reused.", cases: sorted };
writeFileSync(new URL("../corpus-p1a.json", import.meta.url), JSON.stringify(out, null, 1));
const cnt = (f) => sorted.reduce((m, c) => ((m[f(c)] = (m[f(c)] ?? 0) + 1), m), {});
console.log(sorted.length, cnt((c) => c.split), cnt((c) => c.expected), cnt((c) => c.lang), "disputed", sorted.filter((c) => c.disputed).length, cnt((c) => c.split + "/" + c.expected));
