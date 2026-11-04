import { createHash } from "node:crypto"; import { writeFileSync } from "node:fs";
import c1 from "./src/c1.mjs"; import c2 from "./src/c2.mjs"; import c3 from "./src/c3.mjs";
const all = [...c1, ...c2, ...c3], SEED = "jev-p1b-split-v1", h = (s) => createHash("sha256").update(SEED + s).digest("hex");
const uuid = (key) => { const x = createHash("sha256").update("p1b-id|" + key).digest("hex"); return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-8${x.slice(17, 20)}-${x.slice(20, 32)}`; };
const cases = all.map((e, i) => { const id = `G${String(i + 1).padStart(3, "0")}`; const ids = Object.fromEntries(e.objs.map((x) => [x.k, uuid(id + x.k)]));
  const edge = ([kind, s, t, origin]) => ({ kind, source: s, target: t, ...(origin ? { origin } : {}) });
  return { id, category: e.cat, lang: e.lang, project: "p-" + id, focus: "F", objects: e.objs.map((x) => ({ key: x.k, id: ids[x.k], kind: x.kind, title: x.t, body: x.b, writtenAt: x.at })), existing: e.ex.map(edge),
    gold: { add: e.add.map(edge), acceptable: e.alt.map(edge), remove: e.remove, keep: e.keep }, disputed: e.disputed, previous_focus: e.prev, rationale: e.why }; });
const by = {}; for (const c of cases) (by[c.category.split("_")[0] + (c.category.startsWith("CR_") ? "_" + c.category.slice(3) : "")] ??= []).push(c);
for (const l of Object.values(by)) { l.sort((a, b) => h(a.id).localeCompare(h(b.id))); l.forEach((c, i) => (c.split = i % 2 ? "holdout" : "dev")); }
const out = { corpus_version: "graph-p1b-1", note: "Labels, gold edges, acceptable alternatives and disputed flags fixed before any model output. previous_focus is for rationale only and is NOT sent to any configuration.", cases };
writeFileSync(new URL("../corpus-p1b.json", import.meta.url), JSON.stringify(out, null, 1));
const cnt = (f) => cases.reduce((m, c) => ((m[f(c)] = (m[f(c)] ?? 0) + 1), m), {});
console.log(cases.length, cnt((c) => c.split), cnt((c) => c.lang), "disputed", cases.filter((c) => c.disputed).length, cnt((c) => c.category));
const kinds = {}; for (const c of cases) for (const g of c.gold.add) kinds[g.kind] = (kinds[g.kind] ?? 0) + 1; console.log("gold add kinds", kinds, "NONE events", cases.filter((c) => !c.gold.add.length).length, "events with existing", cases.filter((c) => c.existing.length).length);
