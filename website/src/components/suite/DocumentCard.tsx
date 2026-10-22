import styles from './suite.module.css';
export function DocumentCard({ title, lines, compact = false }: { title: string; lines: readonly string[]; compact?: boolean }) {
  return <div className={`${styles.document} ${compact ? styles.compactDocument : ''}`}>
    <div className={styles.documentTop}><svg width="18" height="21" viewBox="0 0 18 21" fill="none" aria-hidden="true"><path d="M3 1h8l4 4v15H3V1Z M10 1v5h5 M6 10h6 M6 13h6 M6 16h4" stroke="currentColor" strokeWidth="1.2"/></svg><span>OFFLINE / 001</span><span className={styles.documentStar}>✳</span></div>
    <span className={styles.documentKind}>{title}</span>
    <strong>Offline-first<br/>task manager.</strong>
    <ul>{lines.map(line => <li key={line}>{line}</li>)}</ul>
    <div className={styles.documentFoot}>ILLUSTRATIVE ARTIFACT <span>↗</span></div>
  </div>;
}
