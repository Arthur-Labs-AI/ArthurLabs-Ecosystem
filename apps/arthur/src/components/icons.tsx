import type { ReactNode } from "react";
import type { CaptureSourceKind, KnowledgeObjectKind } from "@arthur/contracts";

/**
 * Generic UI icons: 1.5px stroke on a 24 grid, Lucide-compatible. Arthur's own vocabulary (idea kinds, relation
 * kinds, the mark) is drawn separately below and in RelationSwatch, and must not be swapped for a stock set.
 */
const PATHS = {
  home: <path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" />,
  ideas: <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z" />,
  connections: (
    <>
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="8" r="2" />
      <circle cx="10" cy="18" r="2" />
      <path d="m8 6.4 8 1.2M7.2 7.8l2.1 8.2M16.6 9.6l-5.2 6.8" />
    </>
  ),
  evolution: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="7" r="2" />
      <path d="M6 7v10M18 9c0 5-6 5-11 9" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  text: <path d="M4 7h16M4 12h16M4 17h10" />,
  emg: <path d="M4 12h3l2-5 3 10 2-5h6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  chev: <path d="m9 6 6 6-6 6" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  link: (
    <>
      <circle cx="6" cy="12" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M8 11.2l8-4M8 12.8l8 4" />
    </>
  ),
  rev: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="9" r="2" />
      <path d="M6 7v10M18 11c0 4-5 4-10 6" />
    </>
  ),
  branch: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="12" r="2" />
      <path d="M6 7v10M16 12H11a5 5 0 0 0-5 5" />
    </>
  ),
  merge: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="14" r="2" />
      <path d="M6 7v10M6 9c0 4 4 5 10 5" />
    </>
  ),
  edit: <path d="M4 20h4L19 9l-4-4L4 16z" />,
  graph: (
    <>
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="8" r="2" />
      <circle cx="10" cy="18" r="2" />
      <path d="m8 6.4 8 1.2M7.2 7.8l2.1 8.2" />
    </>
  ),
  list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  wand: <path d="m5 19 9-9M14 6l1-2 1 2 2 1-2 1-1 2-1-2-2-1z" />,
  warn: <path d="M12 4 3 20h18zM12 10v4M12 17h.01" />,
  check: <path d="m5 12 4 4 10-10" />,
  retry: <path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5" />,
  keyboard: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" />
    </>
  ),
  back: <path d="M15 5l-7 7 7 7" />,
  minus: <path d="M5 12h14" />,
  filter: <path d="M4 6h16M7 12h10M10 18h4" />,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, small = false }: { name: IconName; small?: boolean }) {
  return (
    <svg className={small ? "ic sm" : "ic"} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}

/** Where a capture came from. */
export function SourceIcon({ source }: { source: CaptureSourceKind }) {
  return <Icon name={source === "voice" ? "mic" : source === "emg" ? "emg" : "text"} small />;
}

export const SOURCE_LABELS: Record<CaptureSourceKind, string> = { text: "Typed", voice: "Voice", emg: "Wristband" };

const KIND_SHAPES: Record<KnowledgeObjectKind, ReactNode> = {
  idea: <circle cx="8" cy="8" r="4.6" />,
  task: <rect x="3.4" y="3.4" width="9.2" height="9.2" rx="2.2" />,
  decision: <path d="M8 2.4 13.6 8 8 13.6 2.4 8z" />,
  question: <path d="M8 2.2l4.8 2.8v6L8 13.8 3.2 11V5z" />,
  note: <path d="M4.2 3.4h7.6a.8.8 0 0 1 .8.8v7.6a.8.8 0 0 1-.8.8H4.2a.8.8 0 0 1-.8-.8V4.2a.8.8 0 0 1 .8-.8zM5.6 6.6h4.8M5.6 9.4h3" />,
};

export const KIND_LABELS: Record<KnowledgeObjectKind, string> = { idea: "Idea", task: "Task", decision: "Decision", question: "Question", note: "Note" };
export const KIND_PLURALS: Record<KnowledgeObjectKind, string> = { idea: "Ideas", task: "Tasks", decision: "Decisions", question: "Questions", note: "Notes" };

/** Kind is told by shape, never by colour. */
export function KindGlyph({ kind }: { kind: KnowledgeObjectKind }) {
  return (
    <svg className="kind" viewBox="0 0 16 16" role="img" aria-label={KIND_LABELS[kind]}>
      {KIND_SHAPES[kind]}
    </svg>
  );
}

/** Two legs meet at one node: a letter, or a thought that branches. The node is the only accent-coloured part. */
export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true" focusable="false">
      <path d="M5 23 14 6l9 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.6 16.2h8.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity=".38" />
      <circle cx="14" cy="6" r="3.1" fill="var(--accent)" />
    </svg>
  );
}
