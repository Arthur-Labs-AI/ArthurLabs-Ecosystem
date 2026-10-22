'use client';
import { useState } from 'react';
import type { ProductId } from '@/lib/products';
import { ProductMark } from './ProductMark';
import styles from './suite.module.css';
const nodes = {
  studio: { name: 'Arthur Studio', role: 'The knowledge workspace', title: 'Context travels. Your thinking stays yours.', body: 'The intended handoff begins with a structured project brief. Execution summaries and independent findings return through Nexus as updated project knowledge.', input: 'Ideas, requirements & constraints', output: 'A structured brief → Nexus' },
  nexus: { name: 'Nexus', role: 'The orchestration workspace', title: 'One coordination point. Clear responsibilities.', body: 'Nexus receives context from Arthur Studio, coordinates the work, and exchanges review packages with Sentry. It consolidates both execution and verification before returning the record to Arthur Studio.', input: 'Project brief + Sentry review report', output: 'Review package ↔ Sentry · record → Studio' },
  sentry: { name: 'Sentry', role: 'The independent perspective', title: 'An independent review. An explicit return path.', body: 'Sentry examines the work submitted through Nexus. Its findings return to Nexus for consolidation. This experience does not imply a direct connection between Sentry and Arthur Studio.', input: 'Review package from Nexus', output: 'Verification findings → Nexus' },
} as const;
export function ArchitectureDiagram() {
  const [selected, setSelected] = useState<ProductId>('nexus');
  const node = nodes[selected];
  return <section className={styles.architecture} aria-labelledby="architecture-title"><div className={styles.sectionIntro}><div><span className={styles.eyebrow}>02 / UNDER THE HOOD</span><h2 id="architecture-title">Connected by context.<br/><em>Clear by design.</em></h2></div><p>Three independent workspaces. Explicit handoffs. Nexus connects the flow, so each tool can stay focused on its own responsibility.</p></div>
    <div className={styles.architectureCard} data-suite-entry data-selected={selected}>
      <div className={styles.diagram} role="group" aria-label="Explore intended architecture">
        <svg viewBox="0 0 1000 220" preserveAspectRatio="none" className={styles.diagramLines} data-architecture-lines aria-hidden="true"><defs><marker id="suite-arrow" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto-start-reverse"><path d="M1 1 7 4 1 7" fill="none" stroke="currentColor"/></marker></defs><path data-connection d="M280 114H390" markerStart="url(#suite-arrow)" markerEnd="url(#suite-arrow)"/><path data-connection d="M610 114H720" markerStart="url(#suite-arrow)" markerEnd="url(#suite-arrow)"/><circle data-flow cx="280" cy="114" r="4" fill="currentColor" opacity="0"/><circle data-flow cx="610" cy="114" r="4" fill="currentColor" opacity="0"/></svg>
        <svg viewBox="0 0 100 342" preserveAspectRatio="none" className={styles.mobileLines} data-architecture-lines data-vertical aria-hidden="true"><path data-connection d="M50 108V128"/><path data-connection d="M50 214V234"/><circle data-flow cx="50" cy="108" r="2" opacity="0"/><circle data-flow cx="50" cy="214" r="2" opacity="0"/></svg>
        {(Object.keys(nodes) as ProductId[]).map(id => <button key={id} type="button" className={styles.diagramNode} aria-pressed={selected === id} onClick={() => setSelected(id)}><ProductMark product={id}/><strong>{nodes[id].name}</strong><span>{id === 'studio' ? 'CAPTURE & KNOWLEDGE' : id === 'nexus' ? 'ORCHESTRATE & CONSOLIDATE' : 'INDEPENDENT VERIFICATION'}</span></button>)}
      </div>
      <div className={styles.architectureDetail} data-product={selected} aria-live="polite" aria-atomic="true"><div><span className={styles.eyebrow}>{node.role}</span><h3>{node.title}</h3><p>{node.body}</p></div><dl><div><dt>RECEIVES</dt><dd>{node.input}</dd></div><div><dt>HANDS OFF</dt><dd>{node.output}</dd></div></dl></div>
      <div className={styles.architectureDisclaimer}>INTENDED ARCHITECTURE <span>Arthur Studio ↔ Nexus ↔ Sentry. Integration behavior shown here is conceptual.</span></div>
    </div>
  </section>;
}
