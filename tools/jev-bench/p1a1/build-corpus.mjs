import { createHash } from "node:crypto"; import { writeFileSync, readFileSync } from "node:fs";
import g1 from "./src/g1.mjs"; import g2 from "./src/g2.mjs";
const all = [...g1, ...g2], SEED = "jev-p1a1-split-v1", h = (s) => createHash("sha256").update(SEED + s).digest("hex");
const cases = all.map((x, i) => ({ id: `Q${String(i + 1).padStart(3, "0")}`, category: x.cat, lang: x.lang, expected: x.label, target: x.target ?? null, disputed: !!x.disputed, reframing: !!x.reframing,
  candidates: x.cands.map(([project, text], k) => ({ id: `idea_${k}`, project, text })), new_capture: { project: x.nw[0], text: x.nw[1] }, rationale: x.why }));
const by = {}; for (const c of cases) (by[c.category] ??= []).push(c);
for (const l of Object.values(by)) { l.sort((a, b) => h(a.id).localeCompare(h(b.id))); l.forEach((c, i) => (c.split = i % 2 ? "holdout" : "dev")); }
// overlap check with Phase 0 / Phase 1A texts
const prior = new Set([...JSON.parse(readFileSync(new URL("../corpus.json", import.meta.url))).cases.flatMap((x) => [...x.existing.map((e) => e.text), x.new.text]), ...JSON.parse(readFileSync(new URL("../corpus-p1a.json", import.meta.url))).cases.flatMap((x) => [...x.candidates.map((e) => e.text), x.new_capture.text])]);
const dup = cases.filter((c) => [...c.candidates.map((e) => e.text), c.new_capture.text].some((t) => prior.has(t))).map((c) => c.id);
const pairs = new Set(); let selfDup = 0; for (const c of cases) { const k = c.candidates.map((e) => e.text).join("|") + c.new_capture.text; if (pairs.has(k)) selfDup++; pairs.add(k); }
const sorted = cases.sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(new URL("../corpus-p1a1.json", import.meta.url), JSON.stringify({ corpus_version: "identity-p1a1-1", note: "Fresh cases; labels, targets, reframing flags and disputed flags fixed before any model output.", cases: sorted }, null, 1));
const cnt = (f) => sorted.reduce((m, c) => ((m[f(c)] = (m[f(c)] ?? 0) + 1), m), {});
console.log(sorted.length, cnt((c) => c.split), cnt((c) => c.expected), cnt((c) => c.lang), "disputed", sorted.filter((c) => c.disputed).length, "reframing", sorted.filter((c) => c.reframing).length, "prior overlap", dup, "selfdup", selfDup, cnt((c) => c.split + "/" + c.category));
