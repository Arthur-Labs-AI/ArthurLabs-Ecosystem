import { RELATION_KINDS, type CognitiveRelationKind } from "@arthur/contracts";
import { RELATION_GEOMETRY } from "../features/graph/relation-style";

const colour = (kind: CognitiveRelationKind): string => `var(--rel-${kind})`;

/** Arrowheads and end-bars for every relation kind. Render once inside any <svg> that draws edges. */
export function RelationMarkers({ prefix = "m" }: { prefix?: string }) {
  return (
    <defs>
      {RELATION_KINDS.map((kind) => {
        const arrow = RELATION_GEOMETRY[kind].arrow;
        const c = colour(kind);
        const common = { id: `${prefix}-${kind}`, viewBox: "0 0 12 12", refY: 6, markerHeight: 12, markerUnits: "userSpaceOnUse" as const };
        if (arrow === "chevron") {
          return (
            <marker key={kind} {...common} refX={9} markerWidth={12} orient="auto">
              <path d="M2 1.5 9 6 2 10.5" fill="none" stroke={c} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </marker>
          );
        }
        if (arrow === "triangle") {
          return (
            <marker key={kind} {...common} refX={9} markerWidth={12} orient="auto">
              <path d="M1 1.5 10 6 1 10.5z" fill={c} />
            </marker>
          );
        }
        if (arrow === "hollow") {
          return (
            <marker key={kind} {...common} refX={9} markerWidth={12} orient="auto">
              <path d="M1.5 2 9.5 6 1.5 10z" fill="var(--ground)" stroke={c} strokeWidth="1.5" strokeLinejoin="round" />
            </marker>
          );
        }
        if (arrow === "stop") {
          return (
            <marker key={kind} {...common} refX={11} markerWidth={12} orient="auto">
              <path d="M1 1.5 8.5 6 1 10.5z" fill={c} />
              <path d="M11 1.5v9" stroke={c} strokeWidth="1.8" strokeLinecap="round" />
            </marker>
          );
        }
        if (arrow === "bars") {
          return (
            <marker key={kind} {...common} refX={7} markerWidth={12} orient="auto-start-reverse">
              <path d="M7 1v10" stroke={c} strokeWidth="2" strokeLinecap="round" />
            </marker>
          );
        }
        return null;
      })}
    </defs>
  );
}

/** A small line drawn with exactly the geometry the graph uses. Decorative: the kind is always named in text beside it. */
export function RelationSwatch({ kind, width = 34 }: { kind: CognitiveRelationKind; width?: number }) {
  const g = RELATION_GEOMETRY[kind];
  const c = colour(kind);
  const e = width - 2;
  const lineEnd = g.arrow && g.arrow !== "bars" ? width - 9 : width - 1;
  return (
    <svg className="relsw" viewBox={`0 0 ${width} 12`} width={width} height={12} aria-hidden="true" focusable="false">
      {g.double ? (
        <>
          <path d={`M1 6H${width - 1}`} stroke={c} strokeWidth="4.2" />
          <path d={`M1 6H${width - 1}`} stroke="var(--ground)" strokeWidth="1.6" />
        </>
      ) : (
        <path d={`M${g.arrow === "bars" ? 2 : 1} 6H${g.arrow === "bars" ? width - 2 : lineEnd}`} stroke={c} strokeWidth={g.width} strokeDasharray={g.dash || undefined} strokeLinecap={g.round ? "round" : "butt"} fill="none" />
      )}
      {g.arrow === "chevron" && <path d={`M${e - 6} 2 ${e} 6 ${e - 6} 10`} fill="none" stroke={c} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />}
      {g.arrow === "triangle" && <path d={`M${e - 8} 2 ${e} 6 ${e - 8} 10z`} fill={c} />}
      {g.arrow === "hollow" && <path d={`M${e - 8} 2.5 ${e} 6 ${e - 8} 9.5z`} fill="var(--ground)" stroke={c} strokeWidth="1.5" strokeLinejoin="round" />}
      {g.arrow === "stop" && (
        <>
          <path d={`M${e - 8} 2 ${e - 2} 6 ${e - 8} 10z`} fill={c} />
          <path d={`M${e + 0.5} 2v8`} stroke={c} strokeWidth="1.8" strokeLinecap="round" />
        </>
      )}
      {g.arrow === "bars" && (
        <>
          <path d="M1.5 1.5v9" stroke={c} strokeWidth="2" strokeLinecap="round" />
          <path d={`M${width - 1.5} 1.5v9`} stroke={c} strokeWidth="2" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}
