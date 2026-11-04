// Graph benchmark DSL. An EVENT = one changed (focus) object F, a project-local pool of other objects, existing edges, and gold decisions.
// o(key, kind, title, body, at?)  — focus defaults to a later writtenAt than the others.
export const o = (k, kind, t, b, at) => ({ k, kind, t, b, at: at ?? (k === "F" ? "2026-10-05T10:00:00Z" : "2026-09-25T10:00:00Z") });
// E(cat, lang, objs, spec). spec: ex=[[kind,src,tgt,origin]] existing edges; add=[[kind,src,tgt]] expected NEW edges; alt=[[...]] semantically acceptable alternatives (rubric);
// remove=[existing idx] model edges that should be removed; keep=[existing idx] edges that must stay; d=true disputed; prev=previous focus text; why=rationale.
export const E = (cat, lang, objs, s = {}) => ({ cat, lang, project: s.project ?? "P", objs, ex: s.ex ?? [], add: s.add ?? [], alt: s.alt ?? [], remove: s.remove ?? [], keep: s.keep ?? [], disputed: !!s.d, prev: s.prev ?? null, why: s.why ?? "" });
